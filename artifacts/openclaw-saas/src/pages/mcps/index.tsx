/**
 * MCP Registry page — governance-gated catalog of MCP servers.
 *
 * Tabs:
 *   registry  — read-only list with L0-L4 gate badges
 *   create    — paste MCP manifest → live L0-L4 preview → register.
 *               Below: scan a public GitHub repo → same gate pipeline.
 *   deploy    — pick a registered MCP with entrypointType in [modal, pip]
 *               → generate modal_deploy.py → dispatch (dry by default).
 *   evaluate  — pick an MCP → run 20-prompt red-team suite → grade card.
 *   training  — labelled invocation buffer + threshold check panel.
 *
 * Endpoints: /api/mcps/*, /api/mcps/training/*.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Puzzle,
  Info,
  Rocket,
  Scan,
  FlaskConical,
  BrainCircuit,
  RefreshCcw,
  ChevronRight,
} from "lucide-react";
import {
  useMcpsHealth,
  useMcpsList,
  useRegisterMcp,
  useScanGithub,
  useDeployMcpToModal,
  useEvaluateMcp,
  useMcpTrainingPairs,
  useCheckThresholds,
  type McpRow,
  type EvalReport,
} from "./hooks";

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "dev-tools", label: "Dev tools" },
  { key: "data", label: "Data" },
  { key: "agent-ops", label: "Agent ops" },
  { key: "vertical", label: "Vertical" },
  { key: "external", label: "Scanned" },
] as const;

function useTabFromQuery(defaultTab: string): [string, (t: string) => void] {
  const [location, setLocation] = useLocation();
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  const t = params.get("tab") ?? defaultTab;
  const set = (next: string) => {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setLocation(`${location}?${p.toString()}`, { replace: true });
  };
  return [t, set];
}

function GateBadge({ status }: { status: string }) {
  if (status === "passed") {
    return (
      <Badge className="bg-green-600 hover:bg-green-600 text-white gap-1">
        <ShieldCheck className="w-3 h-3" /> Certified
      </Badge>
    );
  }
  if (status === "conditional") {
    return (
      <Badge className="bg-amber-500 hover:bg-amber-500 text-white gap-1">
        <ShieldAlert className="w-3 h-3" /> Conditional
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <ShieldX className="w-3 h-3" /> Failed
      </Badge>
    );
  }
  return <Badge variant="secondary">Pending</Badge>;
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "green" | "amber" | "destructive";
}) {
  const color =
    tone === "green"
      ? "text-green-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "destructive"
          ? "text-destructive"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Registry tab
// ────────────────────────────────────────────────────────────────────────────
function RegistryTab({ category }: { category: string | null }) {
  const list = useMcpsList(category ? { category } : undefined);
  if (list.isLoading) {
    return (
      <Card>
        <CardContent className="py-4 space-y-2">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (list.isError) {
    return (
      <Card>
        <CardContent className="py-4 text-destructive text-sm">
          Failed to load MCP registry: {String(list.error)}
        </CardContent>
      </Card>
    );
  }
  const rows = list.data?.rows ?? [];
  const passed = rows.filter((r) => r.gateStatus === "passed").length;
  const conditional = rows.filter((r) => r.gateStatus === "conditional").length;
  const failed = rows.filter((r) => r.gateStatus === "failed").length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Total MCPs" value={rows.length} />
        <StatCard label="Certified" value={passed} tone="green" />
        <StatCard label="Conditional" value={conditional} tone="amber" />
        <StatCard label="Failed" value={failed} tone="destructive" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Registry</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Tools</TableHead>
                  <TableHead>Privileges</TableHead>
                  <TableHead>Gate</TableHead>
                  <TableHead>Ver</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-6">
                      No MCPs match this filter yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((m) => {
                    const nets = m.declaredPrivileges?.net ?? [];
                    const fss = m.declaredPrivileges?.fs ?? [];
                    const envs = m.declaredPrivileges?.env ?? [];
                    return (
                      <TableRow key={m.slug} data-testid={`mcp-row-${m.slug}`}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col gap-1">
                            <span>{m.name}</span>
                            <span className="text-xs text-muted-foreground font-mono">{m.slug}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{m.category}</Badge>
                        </TableCell>
                        <TableCell className="text-xs">{m.vendor ?? "—"}</TableCell>
                        <TableCell className="text-xs font-mono">{m.transport}</TableCell>
                        <TableCell className="text-xs">{m.declaredTools?.length ?? 0}</TableCell>
                        <TableCell className="text-xs">
                          {nets.length + fss.length + envs.length === 0
                            ? "sandboxed"
                            : `${nets.length}n · ${fss.length}f · ${envs.length}e`}
                        </TableCell>
                        <TableCell><GateBadge status={m.gateStatus} /></TableCell>
                        <TableCell className="text-xs">v{m.currentVersion}</TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Create tab: manifest paste + gate + scan-github
// ────────────────────────────────────────────────────────────────────────────
const MANIFEST_TEMPLATE = JSON.stringify(
  {
    slug: "my-mcp",
    name: "My MCP",
    description: "Describe the tool surface, governance envelope, and expected use.",
    category: "external",
    vendor: "my-org",
    transport: "http",
    entrypoint: "https://my-mcp.example.com/mcp/",
    entrypointType: "http",
    declaredTools: [
      { name: "search", description: "Full-text search.", input_schema: { query: "string" } },
    ],
    declaredPrivileges: { net: ["api.example.com"], env: ["MY_MCP_API_KEY"] },
    semver: "0.1.0",
  },
  null,
  2,
);

function CreateTab() {
  const [manifestText, setManifestText] = useState<string>(MANIFEST_TEMPLATE);
  const [parseError, setParseError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string>("https://github.com/mattzcarey/cloudflare-mcp");
  const register = useRegisterMcp();
  const scan = useScanGithub();

  const parsedManifest = useMemo(() => {
    try {
      const j = JSON.parse(manifestText);
      setParseError(null);
      return j;
    } catch (e: any) {
      setParseError(String(e?.message ?? e));
      return null;
    }
  }, [manifestText]);

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FlaskConical className="w-4 h-4" /> Paste a manifest
          </CardTitle>
          <CardDescription>
            The validator runs L0-L3 (manifest sanity → tool schema → privilege honesty → adversarial static analysis) before it lands in the registry.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={manifestText}
            onChange={(e) => setManifestText(e.target.value)}
            className="font-mono text-xs h-72"
            data-testid="mcp-manifest-input"
          />
          {parseError ? (
            <div className="text-xs text-destructive font-mono">
              JSON parse: {parseError}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Parsed manifest looks valid. Click <b>Register &amp; grade</b> to run L0-L3.
            </div>
          )}
          <div className="flex gap-2">
            <Button
              disabled={!parsedManifest || register.isPending}
              onClick={() => parsedManifest && register.mutate(parsedManifest)}
              data-testid="mcp-register-button"
            >
              {register.isPending ? "Grading…" : "Register & grade"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setManifestText(MANIFEST_TEMPLATE)}
            >
              Reset
            </Button>
          </div>
          {register.data ? (
            <div className="border border-border rounded p-3 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono">{register.data.mcp.slug}</span>
                <GateBadge status={register.data.mcp.gateStatus} />
              </div>
              <div>Overall: {register.data.report.overallScore}/100 — grade {register.data.report.grade}</div>
              <div className="grid grid-cols-5 gap-2">
                {register.data.report.levels.map((l) => (
                  <div key={l.level} className={`p-2 rounded border ${l.pass ? "border-green-600" : "border-amber-500"}`}>
                    <div className="text-[10px] uppercase text-muted-foreground">L{l.level}</div>
                    <div className="text-sm font-semibold">{l.score}</div>
                    <div className="text-[10px] text-muted-foreground">{l.name}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {register.isError ? (
            <div className="text-xs text-destructive">{String(register.error)}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Scan className="w-4 h-4" /> Scan a GitHub repo
          </CardTitle>
          <CardDescription>
            Clone <code>--depth 1</code>, extract manifest from{" "}
            <code>mcp.json</code> / <code>pyproject.toml</code> / README code blocks,
            score with the same gate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            data-testid="mcp-scan-url-input"
          />
          <Button
            disabled={!repoUrl || scan.isPending}
            onClick={() => scan.mutate({ url: repoUrl })}
            data-testid="mcp-scan-button"
          >
            {scan.isPending ? "Cloning + grading…" : "Scan repo"}
          </Button>
          {scan.data ? (
            <div className="border border-border rounded p-3 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono">{scan.data.mcp.slug}</span>
                <GateBadge status={scan.data.gateStatus} />
              </div>
              <div className="text-muted-foreground">
                Files seen: {scan.data.files_seen.join(", ") || "none"}
              </div>
              <div>
                Overall: {scan.data.report.overallScore}/100 — {scan.data.report.grade}. Declared tools: {scan.data.manifest.declaredTools.length}
              </div>
            </div>
          ) : null}
          {scan.isError ? (
            <div className="text-xs text-destructive">{String(scan.error)}</div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Deploy tab
// ────────────────────────────────────────────────────────────────────────────
function DeployTab() {
  const list = useMcpsList();
  const deploy = useDeployMcpToModal();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const eligible = (list.data?.rows ?? []).filter(
    (m) => m.entrypointType === "modal" || m.entrypointType === "pip" || m.entrypointType === "http",
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Rocket className="w-4 h-4" /> Deploy to Modal
        </CardTitle>
        <CardDescription>
          Generates <code>modal_deploy.py</code> from the FastMCP stateless template (basis:{" "}
          <code>modal-labs/modal-examples/10_integrations/mcp_server_stateless.py</code>).
          Dispatched with <code>modal deploy</code> when <code>MODAL_DRY_RUN=0</code>; the default is a dry render that returns the projected URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-2 text-xs">
          {eligible.map((m) => (
            <button
              key={m.slug}
              onClick={() => setSelectedSlug(m.slug)}
              className={`text-left border rounded p-2 hover:bg-muted/40 ${selectedSlug === m.slug ? "border-primary" : "border-border"}`}
              data-testid={`deploy-select-${m.slug}`}
            >
              <div className="font-mono truncate">{m.slug}</div>
              <div className="text-[10px] text-muted-foreground">
                {m.entrypointType} · {m.declaredTools?.length ?? 0} tools · <GateBadge status={m.gateStatus} />
              </div>
            </button>
          ))}
          {eligible.length === 0 ? (
            <div className="col-span-4 text-muted-foreground text-sm">No deploy-eligible MCPs.</div>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button
            disabled={!selectedSlug || deploy.isPending}
            onClick={() => selectedSlug && deploy.mutate(selectedSlug)}
            data-testid="mcp-deploy-button"
          >
            {deploy.isPending ? "Rendering + dispatching…" : "Deploy to Modal"}
          </Button>
          <span className="text-xs text-muted-foreground self-center">
            {deploy.data?.dry_run ? "Dry-run (MODAL_DRY_RUN=1)" : deploy.data ? "Live" : ""}
          </span>
        </div>
        {deploy.data ? (
          <div className="border border-border rounded p-3 text-xs space-y-1">
            <div className="font-mono">deploy_id: {deploy.data.deploy_id}</div>
            <div>URL: <a className="text-primary underline" href={deploy.data.modal_app_url}>{deploy.data.modal_app_url}</a></div>
            <div className="text-muted-foreground">py: {deploy.data.py_path}</div>
            <details>
              <summary className="cursor-pointer">Logs ({deploy.data.logs.length})</summary>
              <pre className="whitespace-pre-wrap text-[10px] mt-2">{deploy.data.logs.join("\n")}</pre>
            </details>
          </div>
        ) : null}
        {deploy.isError ? (
          <div className="text-xs text-destructive">{String(deploy.error)}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Evaluate tab
// ────────────────────────────────────────────────────────────────────────────
function EvaluateTab() {
  const list = useMcpsList();
  const evaluate = useEvaluateMcp();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <BrainCircuit className="w-4 h-4" /> Red-team evaluation
        </CardTitle>
        <CardDescription>
          20-prompt suite across governance traps, prompt injection, privilege abuse, and exfiltration.
          Dry mode (default) scores against the MCP's declared privileges + tool surface — deterministic.
          Live mode calls the fast-path model from <code>zie_router_policies</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-2 text-xs">
          {(list.data?.rows ?? []).map((m) => (
            <button
              key={m.slug}
              onClick={() => setSelectedSlug(m.slug)}
              className={`text-left border rounded p-2 hover:bg-muted/40 ${selectedSlug === m.slug ? "border-primary" : "border-border"}`}
              data-testid={`evaluate-select-${m.slug}`}
            >
              <div className="font-mono truncate">{m.slug}</div>
              <div className="text-[10px] text-muted-foreground">{m.category} · {m.declaredTools?.length ?? 0} tools</div>
            </button>
          ))}
        </div>
        <Button
          disabled={!selectedSlug || evaluate.isPending}
          onClick={() => selectedSlug && evaluate.mutate(selectedSlug)}
          data-testid="mcp-evaluate-button"
        >
          {evaluate.isPending ? "Running suite…" : "Run red-team eval"}
        </Button>
        {evaluate.data ? <EvalReportCard report={evaluate.data} /> : null}
        {evaluate.isError ? (
          <div className="text-xs text-destructive">{String(evaluate.error)}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EvalReportCard({ report }: { report: EvalReport }) {
  const tone = report.overall_grade === "SAFE" ? "green" : report.overall_grade === "PARTIAL" ? "amber" : "destructive";
  const gradeBadge =
    report.overall_grade === "SAFE" ? (
      <Badge className="bg-green-600 text-white">SAFE</Badge>
    ) : report.overall_grade === "PARTIAL" ? (
      <Badge className="bg-amber-500 text-white">PARTIAL</Badge>
    ) : (
      <Badge variant="destructive">UNSAFE</Badge>
    );
  return (
    <div className="border border-border rounded p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-sm">{report.slug}</div>
        <div className="flex items-center gap-2">
          {gradeBadge}
          <span className="text-xs text-muted-foreground">mode: {report.mode}</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Blocked" value={report.n_blocked} tone="green" />
        <StatCard label="Partial" value={report.n_partial} tone="amber" />
        <StatCard label="Leaked" value={report.n_leaked} tone="destructive" />
        <StatCard label="Prompts" value={report.n_prompts} />
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        {Object.entries(report.category_breakdown).map(([cat, b]) => (
          <div key={cat} className="border border-border rounded p-2">
            <div className="text-[10px] uppercase text-muted-foreground">{cat.replace(/_/g, " ")}</div>
            <div className="mt-1">
              <span className="text-green-600">✓{b.blocked}</span> ·{" "}
              <span className="text-amber-600">≈{b.partial}</span> ·{" "}
              <span className="text-destructive">✗{b.leaked}</span>
            </div>
          </div>
        ))}
      </div>
      {report.top_failures.length > 0 ? (
        <div className="text-xs">
          <div className="text-muted-foreground mb-1">Top failures:</div>
          <ul className="list-disc pl-5 space-y-1">
            {report.top_failures.map((f) => (
              <li key={f.id}><b>{f.id}</b> ({f.category}): {f.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Training tab
// ────────────────────────────────────────────────────────────────────────────
function TrainingTab() {
  const pairs = useMcpTrainingPairs();
  const check = useCheckThresholds();
  const [lastResult, setLastResult] = useState<any>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <RefreshCcw className="w-4 h-4" /> Training loop
        </CardTitle>
        <CardDescription>
          Every labelled invocation across the registered MCPs is a preference pair.
          When a (mcp, tool) bucket hits threshold (≥25 verified with ≥25 safe + ≥25 unsafe),
          a LoRA fine-tune job dispatches to Modal (dry by default).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between items-center">
          <div className="text-sm">
            Buckets tracked: <b>{pairs.data?.counts.length ?? 0}</b>
          </div>
          <Button
            onClick={() =>
              check.mutateAsync().then((r) => {
                setLastResult(r);
                pairs.refetch();
              })
            }
            disabled={check.isPending}
          >
            {check.isPending ? "Checking…" : "Check thresholds + dispatch"}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>MCP</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Verified pairs</TableHead>
                <TableHead>Fires</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pairs.data?.counts ?? []).slice(0, 40).map((c) => (
                <TableRow key={`${c.mcp_slug}::${c.tool_name}`}>
                  <TableCell className="font-mono text-xs">{c.mcp_slug}</TableCell>
                  <TableCell className="text-xs">{c.tool_name}</TableCell>
                  <TableCell className="text-xs">{c.verified_pairs}</TableCell>
                  <TableCell>{c.fires ? <Badge className="bg-green-600 text-white">READY</Badge> : <Badge variant="secondary">waiting</Badge>}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.reason}</TableCell>
                </TableRow>
              ))}
              {(pairs.data?.counts.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-4 text-sm text-muted-foreground">
                    Buffer empty. Seed corpus loads at boot when <code>MCP_TRAINING_LOAD_SEED=1</code>.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        {lastResult ? (
          <div className="border border-border rounded p-3 text-xs">
            <div className="mb-2 font-medium">Last dispatch pass:</div>
            <pre className="whitespace-pre-wrap text-[10px]">{JSON.stringify(lastResult, null, 2)}</pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
export default function McpsPage() {
  const [tab, setTab] = useTabFromQuery("registry");
  const [category, setCategory] = useState<string>("all");
  const health = useMcpsHealth();

  return (
    <div className="container mx-auto px-4 py-6 space-y-6" data-testid="page-mcps">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Puzzle className="w-6 h-6" /> MCP Registry
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Governance-gated catalog of MCP (Model Context Protocol) servers.
            Every entry carries an L0-L4 gate report before it is installable
            by a tenant. Create your own, scan a public repo, deploy to Modal,
            run the red-team suite, watch the training loop.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground shrink-0">
          {health.data?.registry?.ok ? (
            <span className="text-green-600">
              {health.data.registry.n_mcps} registered
            </span>
          ) : (
            <span>checking registry…</span>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground flex items-start gap-2">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          The validator inspects declared manifests, it does not launch the MCP.
          Live invocation happens in the per-tenant runtime with the pinned version.
          Deploys and evals default to dry mode — flip <code>MODAL_DRY_RUN=0</code>,{" "}
          <code>MCP_EVAL_DRY=0</code>, or <code>CF_DRY_RUN=0</code> to hit real infra.
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="registry" data-testid="mcp-tab-registry">Registry</TabsTrigger>
          <TabsTrigger value="create" data-testid="mcp-tab-create">Create</TabsTrigger>
          <TabsTrigger value="deploy" data-testid="mcp-tab-deploy">Deploy</TabsTrigger>
          <TabsTrigger value="evaluate" data-testid="mcp-tab-evaluate">Evaluate</TabsTrigger>
          <TabsTrigger value="training" data-testid="mcp-tab-training">Training</TabsTrigger>
        </TabsList>
        <TabsContent value="registry" className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-1 text-xs">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                onClick={() => setCategory(c.key)}
                className={`px-2 py-1 rounded border ${category === c.key ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <RegistryTab category={category === "all" ? null : category} />
        </TabsContent>
        <TabsContent value="create" className="mt-6"><CreateTab /></TabsContent>
        <TabsContent value="deploy" className="mt-6"><DeployTab /></TabsContent>
        <TabsContent value="evaluate" className="mt-6"><EvaluateTab /></TabsContent>
        <TabsContent value="training" className="mt-6"><TrainingTab /></TabsContent>
      </Tabs>
    </div>
  );
}
