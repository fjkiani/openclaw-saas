import { useState } from "react";
import { Shield, ShieldCheck, ShieldX, ShieldAlert, ChevronDown, ChevronUp, Cpu, AlertTriangle, CheckCircle2, XCircle, Clock } from "lucide-react";

export type BenchmarkGrade = "CERTIFIED" | "CONDITIONAL" | "FAILED" | "INCONCLUSIVE" | null;

export interface LevelResult {
  level: string;
  score: number;
  passed: number;
  total: number;
  weight: number;
  llms_used?: string[];
  details?: Record<string, unknown>[];
}

export interface BenchmarkResult {
  benchmark_id?: string;
  grade: BenchmarkGrade;
  overall_score: number | null;
  level_scores?: Record<string, LevelResult> | null;
  llm_results?: Record<string, unknown>;
  duration_ms?: number | null;
  status?: string;
}

interface BenchmarkPanelProps {
  result: BenchmarkResult | null;
  isRunning?: boolean;
  onRunBenchmark?: () => void;
}

const GRADE_CONFIG = {
  CERTIFIED: {
    label: "CERTIFIED",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    icon: ShieldCheck,
  },
  CONDITIONAL: {
    label: "CONDITIONAL",
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    icon: ShieldAlert,
  },
  FAILED: {
    label: "FAILED",
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    icon: ShieldX,
  },
  INCONCLUSIVE: {
    label: "INCONCLUSIVE",
    color: "text-zinc-400",
    bg: "bg-zinc-500/10",
    border: "border-zinc-500/30",
    icon: Shield,
  },
};

const LEVEL_LABELS: Record<string, { name: string; desc: string }> = {
  L1: { name: "Syntax & Tools", desc: "Valid tool calls & JSON" },
  L2: { name: "Resilience", desc: "Error handling & retries" },
  L3: { name: "Protocol", desc: "Adversarial trap resistance" },
  L4: { name: "End-to-End", desc: "Full workflow completion" },
};

function ScoreBar({ score, level }: { score: number; level: string }) {
  const color =
    score >= 80 ? "bg-emerald-500" : score >= 60 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-mono text-muted-foreground w-4">{level}</span>
      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-[9px] font-mono text-foreground w-8 text-right">{score}%</span>
    </div>
  );
}

export function BenchmarkGradeBadge({ grade }: { grade: BenchmarkGrade }) {
  if (!grade) {
    return (
      <span className="text-[9px] font-mono text-zinc-500 border border-zinc-700 bg-zinc-800/50 px-1.5 py-0.5 rounded">
        NOT TESTED
      </span>
    );
  }
  const cfg = GRADE_CONFIG[grade];
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[9px] font-mono ${cfg.color} border ${cfg.border} ${cfg.bg} px-1.5 py-0.5 rounded`}
    >
      <Icon className="w-2.5 h-2.5" />
      {cfg.label}
    </span>
  );
}

export function BenchmarkPanel({ result, isRunning, onRunBenchmark }: BenchmarkPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (isRunning) {
    return (
      <div className="mt-2 p-2 bg-primary/5 border border-primary/20 rounded text-[10px] font-mono text-primary flex items-center gap-2">
        <div className="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin" />
        Running benchmark across multiple LLMs...
      </div>
    );
  }

  if (!result) {
    return (
      <div className="mt-2">
        {onRunBenchmark && (
          <button
            onClick={onRunBenchmark}
            className="w-full py-1 text-[9px] font-mono text-zinc-400 border border-zinc-700 rounded hover:border-primary/40 hover:text-primary transition-colors"
          >
            Run Benchmark
          </button>
        )}
      </div>
    );
  }

  const grade = result.grade;
  const cfg = grade ? GRADE_CONFIG[grade] : null;
  const levels = result.level_scores ? Object.entries(result.level_scores) : [];

  return (
    <div className="mt-2 space-y-1">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <BenchmarkGradeBadge grade={grade} />
        <div className="flex items-center gap-2">
          {result.overall_score !== null && result.overall_score !== undefined && (
            <span className="text-[9px] font-mono text-muted-foreground">
              {result.overall_score}/100
            </span>
          )}
          {result.duration_ms && (
            <span className="text-[9px] font-mono text-zinc-600 flex items-center gap-0.5">
              <Clock className="w-2.5 h-2.5" />
              {(result.duration_ms / 1000).toFixed(1)}s
            </span>
          )}
          {levels.length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-zinc-500 hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && levels.length > 0 && (
        <div className="p-2 bg-card border border-border rounded space-y-2">
          {/* Score bars */}
          <div className="space-y-1">
            {levels.map(([key, lvl]) => (
              <div key={key}>
                <ScoreBar score={lvl.score} level={key} />
                {LEVEL_LABELS[key] && (
                  <p className="text-[8px] font-mono text-zinc-600 ml-6 mt-0.5">
                    {LEVEL_LABELS[key].name} — {lvl.passed}/{lvl.total} passed
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* LLMs used */}
          {levels.some(([, lvl]) => lvl.llms_used?.length) && (
            <div>
              <p className="text-[8px] font-mono text-zinc-600 mb-1 flex items-center gap-1">
                <Cpu className="w-2.5 h-2.5" /> Models tested
              </p>
              <div className="flex flex-wrap gap-1">
                {Array.from(
                  new Set(levels.flatMap(([, lvl]) => lvl.llms_used || []))
                ).map((model) => (
                  <span
                    key={model}
                    className="text-[8px] font-mono text-zinc-500 border border-zinc-700 px-1 py-0.5 rounded"
                  >
                    {model.split("/").pop()?.replace(":free", "") || model}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Re-run button */}
          {onRunBenchmark && (
            <button
              onClick={onRunBenchmark}
              className="w-full py-1 text-[9px] font-mono text-zinc-400 border border-zinc-700 rounded hover:border-primary/40 hover:text-primary transition-colors"
            >
              Re-run Benchmark
            </button>
          )}
        </div>
      )}
    </div>
  );
}
