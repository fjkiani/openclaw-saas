/**
 * server.ts — OpenClaw MCP (Model Context Protocol) server.
 *
 * Exposes OpenClaw's real capabilities as MCP tools over the Streamable HTTP
 * transport, so any MCP client (Claude Desktop, Cloudflare AI Playground, MCP
 * Inspector, mcp-remote) can call them. Built on the official
 * @modelcontextprotocol/sdk — the same SDK Cloudflare's Agents pattern uses —
 * mounted on our Express app so it runs in ANY Node runtime (cloud SaaS or
 * sovereign/on-prem), not locked to a single edge provider.
 *
 * Tools exposed (all backed by real subsystems — no stubs):
 *   legal_corpus_search      — hybrid BM25 + Qdrant semantic retrieval
 *   legal_corpus_stats       — corpus + vector-store statistics
 *   contract_analyze         — run the legal-counsel lens pipeline on contract text
 *   workflow_list            — list registered workflow definitions
 *   workflow_run             — execute a workflow definition
 *   skill_list               — list registered skills
 *   provider_status          — LLM/embed backend status (cloud/local/hybrid)
 *   sovereign_bundle_preview — preview an on-prem deployment bundle
 *
 * Transport: Streamable HTTP (stateless) at POST /mcp. Each request spins up a
 * fresh server+transport pair (the recommended stateless pattern), so no
 * session state is required and it scales horizontally.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Request, Response } from "express";
import { logger } from "../logger.js";

// Real subsystem imports (lazy where heavy).
import { legalCorpusHybridRetrieve } from "../legalCorpus/hybridRetrieve.js";
import { collectionInfo, LEGAL_CORPUS_COLLECTION } from "../qdrantClient.js";
import { pool } from "@workspace/db";
import { workflowEngine } from "../workflowEngine.js";
// providerStatus + sovereign bundle generator are imported lazily inside their
// tool handlers so the MCP server degrades gracefully if those modules are absent.

function text(content: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] };
}

export function createOpenClawMcpServer(): McpServer {
  const server = new McpServer({ name: "openclaw", version: "2.0.0" });

  // ── legal_corpus_search ──────────────────────────────────────────────────
  server.registerTool(
    "legal_corpus_search",
    {
      description:
        "Hybrid semantic + keyword search over the OpenClaw legal corpus (BM25 full-text + Qdrant vectors, RRF-merged). Returns ranked provisions with citations and similarity scores.",
      inputSchema: {
        query: z.string().describe("Natural-language legal query, e.g. 'founder vesting cliff acceleration'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
        domain: z.string().optional().describe("Restrict to a domain tag, e.g. 'contract'"),
      },
    },
    async ({ query, limit, domain }) => {
      const results = await legalCorpusHybridRetrieve({
        query,
        topK: limit ?? 8,
        domains: domain ? [domain] : undefined,
      });
      return text(results);
    },
  );

  // ── legal_corpus_stats ───────────────────────────────────────────────────
  server.registerTool(
    "legal_corpus_stats",
    {
      description: "Statistics about the legal corpus: document/chunk counts by source and Qdrant vector-store status.",
      inputSchema: {},
    },
    async () => {
      const docCount = await pool.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE source_type='cuad')::int AS cuad FROM legal_corpus_documents`,
      );
      const chunkCount = await pool.query(`SELECT count(*)::int AS n FROM legal_corpus_chunks`);
      const bySource = await pool.query(
        `SELECT source_type, count(*)::int AS n FROM legal_corpus_documents GROUP BY source_type ORDER BY n DESC`,
      );
      const qdrant = await collectionInfo(LEGAL_CORPUS_COLLECTION);
      return text({
        documents: docCount.rows[0]?.n ?? 0,
        cuad_documents: docCount.rows[0]?.cuad ?? 0,
        chunks: chunkCount.rows[0]?.n ?? 0,
        by_source: bySource.rows,
        qdrant: qdrant ? { collection: LEGAL_CORPUS_COLLECTION, points: qdrant.points_count, dims: qdrant.dims } : null,
      });
    },
  );

  // ── contract_analyze ─────────────────────────────────────────────────────
  server.registerTool(
    "contract_analyze",
    {
      description:
        "Analyze contract text through the OpenClaw legal-counsel lens pipeline (Delaware corp, IP assignment, regulatory/employment, tax/securities). Returns structured findings with severity and recommendations.",
      inputSchema: {
        contract_text: z.string().min(50).describe("The contract text to analyze"),
        perspective: z.enum(["company", "counterparty", "neutral"]).optional().describe("Which party's perspective to favor (default: neutral)"),
      },
    },
    async ({ contract_text, perspective }) => {
      const { runLegalCounselAnalyze } = await import("../legalCounsel/pipeline.js");
      const result = await runLegalCounselAnalyze({
        text: contract_text,
        perspective: (perspective as "company" | "counterparty" | "neutral" | undefined) ?? "neutral",
        mode: "orchestrator",
      });
      return text(result);
    },
  );

  // ── workflow_list ────────────────────────────────────────────────────────
  server.registerTool(
    "workflow_list",
    {
      description: "List registered OpenClaw workflow definitions and the skills available to compose them.",
      inputSchema: {},
    },
    async () => {
      const defs = await pool.query(
        `SELECT id, name, description, steps, created_at FROM workflow_definitions ORDER BY created_at DESC LIMIT 50`,
      ).catch(() => ({ rows: [] as unknown[] }));
      return text({ definitions: defs.rows, skills: workflowEngine.listSkills() });
    },
  );

  // ── workflow_run ─────────────────────────────────────────────────────────
  server.registerTool(
    "workflow_run",
    {
      description: "Execute a registered OpenClaw workflow definition by id, with a JSON input payload.",
      inputSchema: {
        workflow_id: z.union([z.string(), z.number()]).describe("Workflow definition id"),
        tenant_id: z.string().optional().describe("Tenant id owning the definition (default: 'default')"),
        input: z.record(z.unknown()).optional().describe("Input payload passed to the first step"),
      },
    },
    async ({ workflow_id, input, tenant_id }) => {
      const tenantId = tenant_id ?? "default";
      const runId = await workflowEngine.startRun(String(workflow_id), tenantId, input ?? {});
      return text({ run_id: runId, status: "started", tenant_id: tenantId });
    },
  );

  // ── skill_list ───────────────────────────────────────────────────────────
  server.registerTool(
    "skill_list",
    {
      description: "List all skills registered in the OpenClaw workflow engine.",
      inputSchema: {},
    },
    async () => text({ skills: workflowEngine.listSkills() }),
  );

  // ── provider_status ──────────────────────────────────────────────────────
  server.registerTool(
    "provider_status",
    {
      description:
        "Status of the LLM + embedding provider backends (cloud Groq/Gemini and/or local Ollama), including which backend is effective. Useful for verifying sovereign/air-gapped configuration.",
      inputSchema: {},
    },
    async () => {
      try {
        const { providerStatus } = await import("../providers/index.js");
        return text(await providerStatus());
      } catch {
        return text({ error: "providers module not available on this deployment" });
      }
    },
  );

  // ── sovereign_bundle_preview ─────────────────────────────────────────────
  server.registerTool(
    "sovereign_bundle_preview",
    {
      description:
        "Preview a sovereign (on-prem / air-gapped) OpenClaw deployment bundle: the list of files (compose, env, Dockerfiles, scripts, README) that would be generated for a tenant.",
      inputSchema: {
        tenant_name: z.string().describe("Tenant slug, e.g. 'acme-capital'"),
        llm_backend: z.enum(["local", "hybrid"]).optional().describe("local = air-gapped; hybrid = local-first + cloud fallback"),
        enable_gpu: z.boolean().optional(),
      },
    },
    async ({ tenant_name, llm_backend, enable_gpu }) => {
      try {
        const { generateSovereignBundle, defaultSovereignConfig } = await import("../sovereign/bundleGenerator.js");
        const files = generateSovereignBundle({
          tenantName: tenant_name,
          llmBackend: llm_backend ?? "local",
          enableGpu: enable_gpu ?? false,
        });
        return text({
          tenant: tenant_name,
          default: defaultSovereignConfig(tenant_name),
          file_count: files.length,
          files: files.map((f: { path: string; executable?: boolean; content: string }) => ({ path: f.path, executable: !!f.executable, bytes: f.content.length })),
        });
      } catch {
        return text({ error: "sovereign module not available on this deployment" });
      }
    },
  );

  return server;
}

/**
 * Handle an MCP request over Streamable HTTP (stateless).
 * Mount with: app.post("/mcp", handleMcpRequest) and app.get("/mcp", ...) for SSE.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    const server = createOpenClawMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req as unknown as Parameters<StreamableHTTPServerTransport["handleRequest"]>[0], res as unknown as Parameters<StreamableHTTPServerTransport["handleRequest"]>[1], req.body);
  } catch (err) {
    logger.error({ err }, "[mcp] request handling failed");
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}
