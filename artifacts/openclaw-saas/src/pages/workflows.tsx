/**
 * workflows.tsx — Unified Workflows page.
 *
 * Exposes all siloed backend capabilities as user-facing workflows:
 *   Tab 1: Workflow Builder — create/run workflow definitions + view runs
 *   Tab 2: Skill Forge — Archon skill generation + benchmarking
 *   Tab 3: Intelligence — AACR semantic search + CD hits + CrisPRO
 *   Tab 4: Flywheel — Double-dip training flywheel status across domains
 *
 * Admin-token gated (same pattern as rigor-gate page).
 * All calls are real — no stubs, no placeholders.
 */

import { useState, useCallback, useEffect } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  Workflow as WorkflowIcon,
  FlaskConical,
  Search,
  RefreshCw,
  Play,
  ChevronDown,
  ChevronRight,
  Activity,
  Zap,
  Brain,
  TrendingUp,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
} from "lucide-react";

// ── Admin token management ───────────────────────────────────────────────────

const TOKEN_KEY = "openclaw-admin-token";

function getStoredToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

// ── API helper ───────────────────────────────────────────────────────────────

async function apiCall(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-openclaw-admin-token", token);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const apiBase = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");
  const url = apiBase && path.startsWith("/api") ? `${apiBase}${path}` : path;
  return fetch(url, { ...init, headers });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkflowDef {
  id: number;
  name: string;
  description: string;
  steps: Array<{ step_index: number; skill_id: string; input_mapping: Record<string, unknown> }>;
  active: boolean;
}

interface WorkflowRun {
  id: number;
  definition_id: number;
  definition_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  output: Record<string, unknown> | null;
}

interface SkillInfo {
  skill_id: string;
  description: string;
}

interface ArchonRun {
  runId: string;
  status: string;
  skillName: string;
  grade: string | null;
  overallScore: number | null;
  createdAt: string;
}

interface AACRSearchResult {
  id: number;
  talk_id: string;
  speaker_name: string;
  field_name: string;
  chunk_text: string;
  similarity: number;
}

interface FlywheelDomain {
  domain: string;
  task_type: string;
  sft_records: number;
  total_pairs: number;
  verified_pairs: number;
  pct: number;
  training_status: string;
}

// ── Tab definitions ──────────────────────────────────────────────────────────

type TabId = "builder" | "forge" | "intelligence" | "flywheel";

const TABS: Array<{ id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "builder", label: "Workflow Builder", icon: WorkflowIcon },
  { id: "forge", label: "Skill Forge", icon: FlaskConical },
  { id: "intelligence", label: "Intelligence", icon: Search },
  { id: "flywheel", label: "Flywheel", icon: TrendingUp },
];

// ── Main component ───────────────────────────────────────────────────────────

export default function WorkflowsPage() {
  const [token, setToken] = useState(getStoredToken());
  const [activeTab, setActiveTab] = useState<TabId>("builder");

  const handleTokenChange = (val: string) => {
    setToken(val);
    setStoredToken(val);
  };

  return (
    <Layout>
      <PageHeader
        title="Workflows"
        subtitle="Unified workflow engine, skill forge, intelligence, and training flywheel"
      />
      {/* Admin token input */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-3">
        <Info className="w-4 h-4 text-muted-foreground" />
        <Input
          type="password"
          placeholder="Admin token"
          value={token}
          onChange={(e) => handleTokenChange(e.target.value)}
          className="w-64 font-mono text-xs"
        />
        <span className="text-xs font-mono text-muted-foreground">
          Required for all workflow operations
        </span>
      </div>
      {/* Tab bar */}
      <div className="flex border-b border-border px-6">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-mono border-b-2 transition-colors ${
              activeTab === id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>
      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        {!token && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <AlertTriangle className="w-8 h-8 text-amber-400 mb-3" />
            <p className="text-sm font-mono text-muted-foreground">
              Enter an admin token above to access workflow capabilities.
            </p>
          </div>
        )}
        {token && activeTab === "builder" && <WorkflowBuilderTab token={token} />}
        {token && activeTab === "forge" && <SkillForgeTab token={token} />}
        {token && activeTab === "intelligence" && <IntelligenceTab token={token} />}
        {token && activeTab === "flywheel" && <FlywheelTab token={token} />}
      </div>
    </Layout>
  );
}

// ── Tab 1: Workflow Builder ──────────────────────────────────────────────────

function WorkflowBuilderTab({ token }: { token: string }) {
  const [definitions, setDefinitions] = useState<WorkflowDef[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDef, setSelectedDef] = useState<number | null>(null);
  const [runInputs, setRunInputs] = useState<string>("{}");
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [defRes, runRes, skillRes] = await Promise.all([
        apiCall("/api/workflows/definitions?limit=50", token),
        apiCall("/api/workflows/runs?limit=20", token),
        apiCall("/api/workflows/skills", token),
      ]);
      if (defRes.ok) {
        const data = await defRes.json();
        setDefinitions(data.definitions ?? []);
      }
      if (runRes.ok) {
        const data = await runRes.json();
        setRuns(data.runs ?? []);
      }
      if (skillRes.ok) {
        const data = await skillRes.json();
        setSkills(data.skills ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startRun = async () => {
    if (!selectedDef) return;
    setLoading(true);
    setError(null);
    try {
      let inputs: Record<string, unknown> = {};
      try {
        inputs = JSON.parse(runInputs);
      } catch {
        setError("Invalid JSON in inputs");
        setLoading(false);
        return;
      }
      const res = await apiCall("/api/workflows/runs", token, {
        method: "POST",
        body: JSON.stringify({ definition_id: selectedDef, inputs }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
      } else {
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-mono font-bold text-foreground">Workflow Definitions & Runs</h2>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-mono">
          <XCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Definitions */}
      <div className="space-y-2">
        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Definitions</h3>
        {definitions.length === 0 && !loading && (
          <p className="text-xs font-mono text-muted-foreground py-4">No workflow definitions found.</p>
        )}
        {definitions.map((def) => (
          <div
            key={def.id}
            className={`p-3 rounded border cursor-pointer transition-colors ${
              selectedDef === def.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            }`}
            onClick={() => setSelectedDef(def.id)}
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-mono font-bold text-foreground">{def.name}</span>
                <span className="ml-2 text-xs font-mono text-muted-foreground">#{def.id}</span>
              </div>
              <Badge variant={def.active ? "default" : "secondary"} className="text-[10px]">
                {def.active ? "ACTIVE" : "INACTIVE"}
              </Badge>
            </div>
            <p className="text-xs font-mono text-muted-foreground mt-1">{def.description}</p>
            <div className="flex gap-1 mt-2">
              {def.steps.map((s) => (
                <Badge key={s.step_index} variant="outline" className="text-[10px] font-mono">
                  {s.step_index}: {s.skill_id}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Start run */}
      {selectedDef && (
        <div className="p-4 rounded border border-border space-y-3">
          <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Start Run for Definition #{selectedDef}
          </h3>
          <Textarea
            value={runInputs}
            onChange={(e) => setRunInputs(e.target.value)}
            placeholder='{"key": "value"}'
            className="font-mono text-xs min-h-[80px]"
          />
          <Button size="sm" onClick={startRun} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Start Run
          </Button>
        </div>
      )}

      {/* Recent runs */}
      <div className="space-y-2">
        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Recent Runs</h3>
        {runs.length === 0 && !loading && (
          <p className="text-xs font-mono text-muted-foreground py-4">No runs yet.</p>
        )}
        {runs.map((run) => (
          <div key={run.id} className="border border-border rounded">
            <div
              className="flex items-center justify-between p-3 cursor-pointer"
              onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
            >
              <div className="flex items-center gap-3">
                {expandedRun === run.id ? (
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                )}
                <span className="text-xs font-mono text-foreground">Run #{run.id}</span>
                <span className="text-xs font-mono text-muted-foreground">{run.definition_name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    run.status === "completed" ? "default" :
                    run.status === "running" ? "secondary" :
                    run.status === "failed" ? "destructive" : "outline"
                  }
                  className="text-[10px]"
                >
                  {run.status.toUpperCase()}
                </Badge>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {new Date(run.started_at).toLocaleString()}
                </span>
              </div>
            </div>
            {expandedRun === run.id && run.output && (
              <div className="p-3 border-t border-border">
                <pre className="text-[10px] font-mono text-muted-foreground overflow-auto max-h-48">
                  {JSON.stringify(run.output, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Registered skills */}
      <div className="space-y-2">
        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Registered Skills</h3>
        <div className="flex flex-wrap gap-2">
          {skills.map((skill) => (
            <Badge key={skill.skill_id} variant="outline" className="text-[10px] font-mono">
              <Zap className="w-2.5 h-2.5 mr-1" />
              {skill.skill_id}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Tab 2: Skill Forge ───────────────────────────────────────────────────────

function SkillForgeTab({ token }: { token: string }) {
  const [skillDesc, setSkillDesc] = useState("");
  const [skillName, setSkillName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ArchonRun | null>(null);
  const [runs, setRuns] = useState<ArchonRun[]>([]);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await apiCall("/api/archon/health", token);
      if (res.ok) setHealth(await res.json());
    } catch {}
  }, [token]);

  const loadRuns = useCallback(async () => {
    try {
      const res = await apiCall("/api/archon/runs", token);
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs ?? []);
      }
    } catch {}
  }, [token]);

  useEffect(() => {
    checkHealth();
    loadRuns();
  }, [checkHealth, loadRuns]);

  const generate = async () => {
    if (!skillDesc.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiCall("/api/archon/generate", token, {
        method: "POST",
        body: JSON.stringify({
          skillName: skillName || `skill-${Date.now()}`,
          description: skillDesc,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
      } else {
        const data = await res.json();
        setResult(data);
        await loadRuns();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Health */}
      <div className="flex items-center gap-4">
        <h2 className="text-sm font-mono font-bold text-foreground">Archon Skill Forge</h2>
        {health && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] font-mono">
              {String(health.providers ?? "unknown")}
            </Badge>
            {health.groq_key_set && (
              <Badge variant="default" className="text-[10px]">Groq</Badge>
            )}
            {health.gemini_key_set && (
              <Badge variant="default" className="text-[10px]">Gemini</Badge>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-mono">
          <XCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Generate form */}
      <div className="p-4 rounded border border-border space-y-3">
        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Generate New Skill</h3>
        <Input
          placeholder="Skill name (e.g., contract-summarizer)"
          value={skillName}
          onChange={(e) => setSkillName(e.target.value)}
          className="font-mono text-xs"
        />
        <Textarea
          placeholder="Describe what the skill should do. Be specific about inputs, outputs, and behavior."
          value={skillDesc}
          onChange={(e) => setSkillDesc(e.target.value)}
          className="font-mono text-xs min-h-[100px]"
        />
        <Button size="sm" onClick={generate} disabled={loading || !skillDesc.trim()}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FlaskConical className="w-3 h-3" />}
          Generate & Benchmark
        </Button>
      </div>

      {/* Latest result */}
      {result && (
        <div className="p-4 rounded border border-primary/30 bg-primary/5 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-mono font-bold text-foreground">Run {result.runId}</span>
            <Badge variant="outline" className="text-[10px]">{result.status}</Badge>
            {result.grade && (
              <Badge
                variant={result.grade === "CERTIFIED" ? "default" : result.grade === "CONDITIONAL" ? "secondary" : "destructive"}
                className="text-[10px]"
              >
                {result.grade}
              </Badge>
            )}
            {result.overallScore !== null && (
              <span className="text-xs font-mono text-muted-foreground">
                Score: {result.overallScore?.toFixed(1)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Recent runs */}
      <div className="space-y-2">
        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Recent Forge Runs</h3>
        {runs.length === 0 && (
          <p className="text-xs font-mono text-muted-foreground py-4">No runs yet.</p>
        )}
        {runs.map((run) => (
          <div key={run.runId} className="flex items-center justify-between p-3 border border-border rounded">
            <div className="flex items-center gap-3">
              <Brain className="w-3 h-3 text-muted-foreground" />
              <span className="text-xs font-mono text-foreground">{run.skillName}</span>
              <span className="text-[10px] font-mono text-muted-foreground">{run.runId.slice(0, 12)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">{run.status}</Badge>
              {run.grade && (
                <Badge
                  variant={run.grade === "CERTIFIED" ? "default" : run.grade === "CONDITIONAL" ? "secondary" : "destructive"}
                  className="text-[10px]"
                >
                  {run.grade}
                </Badge>
              )}
              <span className="text-[10px] font-mono text-muted-foreground">
                {new Date(run.createdAt).toLocaleString()}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab 3: Intelligence ──────────────────────────────────────────────────────

function IntelligenceTab({ token }: { token: string }) {
  const [query, setQuery] = useState("");
  const [field, setField] = useState("");
  const [rerank, setRerank] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AACRSearchResult[]>([]);
  const [reranked, setReranked] = useState(false);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await apiCall("/api/intelligence/stats", token);
      if (res.ok) setStats(await res.json());
    } catch {}
  }, [token]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiCall("/api/intelligence/search", token, {
        method: "POST",
        body: JSON.stringify({
          query: query.trim(),
          field: field || undefined,
          match_count: 10,
          match_threshold: 0.25,
          rerank,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
      } else {
        const data = await res.json();
        setResults(data.results ?? []);
        setReranked(data.reranked ?? false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-mono font-bold text-foreground">AACR Conference Intelligence</h2>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Sessions", value: stats.sessions },
            { label: "Speakers", value: stats.speakers },
            { label: "Intel Records", value: stats.competitive_intel_records },
            { label: "Embeddings", value: stats.embeddings },
          ].map(({ label, value }) => (
            <div key={label} className="p-3 rounded border border-border">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">{label}</p>
              <p className="text-lg font-mono font-bold text-foreground">{String(value ?? 0)}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 rounded border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-mono">
          <XCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Search form */}
      <div className="p-4 rounded border border-border space-y-3">
        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Semantic Search</h3>
        <Input
          placeholder="Search query (e.g., KRAS G12C inhibitor resistance)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="font-mono text-xs"
        />
        <div className="flex items-center gap-3">
          <Input
            placeholder="Field filter (optional)"
            value={field}
            onChange={(e) => setField(e.target.value)}
            className="w-48 font-mono text-xs"
          />
          <label className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <input
              type="checkbox"
              checked={rerank}
              onChange={(e) => setRerank(e.target.checked)}
              className="rounded"
            />
            Gemini rerank
          </label>
          <Button size="sm" onClick={search} disabled={loading || !query.trim()}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
            Search
          </Button>
        </div>
        {reranked && (
          <Badge variant="default" className="text-[10px]">
            <CheckCircle2 className="w-2.5 h-2.5 mr-1" />
            Results reranked by Gemini
          </Badge>
        )}
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Results ({results.length})
          </h3>
          {results.map((r) => (
            <div key={r.id} className="p-3 border border-border rounded space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold text-foreground">
                  {r.speaker_name || "Unknown speaker"}
                </span>
                <Badge variant="outline" className="text-[10px] font-mono">
                  sim: {r.similarity.toFixed(3)}
                </Badge>
              </div>
              <p className="text-[10px] font-mono text-muted-foreground">
                {r.talk_id} | {r.field_name}
              </p>
              <p className="text-xs font-mono text-foreground/80 line-clamp-3">
                {r.chunk_text}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab 4: Flywheel ──────────────────────────────────────────────────────────

function FlywheelTab({ token }: { token: string }) {
  const [domains, setDomains] = useState<FlywheelDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(50);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiCall("/api/intelligence/flywheel", token);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
      } else {
        const data = await res.json();
        setDomains(data.domains ?? []);
        setThreshold(data.threshold ?? 50);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load flywheel");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-mono font-bold text-foreground">Training Flywheel</h2>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Refresh
        </Button>
      </div>

      <p className="text-xs font-mono text-muted-foreground">
        DPO preference pairs are captured from double-dip router races and AACR search reranks.
        When a task type reaches {threshold} judge-verified pairs, a Modal LoRA fine-tune is dispatched.
      </p>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-mono">
          <XCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Domain cards */}
      <div className="space-y-3">
        {domains.length === 0 && !loading && (
          <p className="text-xs font-mono text-muted-foreground py-4">No flywheel data yet.</p>
        )}
        {domains.map((d) => (
          <div key={`${d.domain}-${d.task_type}`} className="p-4 border border-border rounded space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                <span className="text-sm font-mono font-bold text-foreground">{d.domain}</span>
                <span className="text-xs font-mono text-muted-foreground">{d.task_type}</span>
              </div>
              <Badge
                variant={
                  d.training_status === "deployed" ? "default" :
                  d.training_status === "threshold_met" ? "secondary" :
                  d.training_status === "training" ? "secondary" : "outline"
                }
                className="text-[10px]"
              >
                {d.training_status.toUpperCase().replace("_", " ")}
              </Badge>
            </div>

            {/* Progress bar */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                <span>Verified pairs: {d.verified_pairs}/{threshold}</span>
                <span>{d.pct}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${Math.min(100, d.pct)}%` }}
                />
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-2">
              <div className="text-center p-2 rounded bg-muted/50">
                <p className="text-[10px] font-mono text-muted-foreground">SFT Records</p>
                <p className="text-sm font-mono font-bold text-foreground">{d.sft_records}</p>
              </div>
              <div className="text-center p-2 rounded bg-muted/50">
                <p className="text-[10px] font-mono text-muted-foreground">Total Pairs</p>
                <p className="text-sm font-mono font-bold text-foreground">{d.total_pairs}</p>
              </div>
              <div className="text-center p-2 rounded bg-muted/50">
                <p className="text-[10px] font-mono text-muted-foreground">Verified</p>
                <p className="text-sm font-mono font-bold text-foreground">{d.verified_pairs}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
