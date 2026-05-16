import { useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Circle, ChevronDown, ChevronUp, X } from "lucide-react";

type ChecklistStep = {
  id: string;
  label: string;
  description: string;
  cta: string;
  tab?: string; // forge tab to navigate to
};

const STEPS: ChecklistStep[] = [
  {
    id: "dataset",
    label: "Explore the dataset",
    description: "50 CUAD-style legal clause examples across 5 types. Built and evaluated on this asset.",
    cta: "View Datasets",
    tab: "datasets",
  },
  {
    id: "job",
    label: "Review the eval",
    description: "RAG-augmented extraction. Zero-shot acc=0.925 → RAG acc=1.0 on 10 test examples. Internal regression only — not production-ready.",
    cta: "View Jobs",
    tab: "jobs",
  },
  {
    id: "model",
    label: "Use a model",
    description: "7 agents registered: Legal Clause Extractor, Intake Router, and 5 specialists. Each has a live endpoint.",
    cta: "Open Registry",
    tab: "registry",
  },
  {
    id: "policy",
    label: "Review governance",
    description: "human_review_required=true on all outputs. Privilege warning on every response. Deployment requires approval.",
    cta: "View Policies",
    tab: "policies",
  },
  {
    id: "scenario",
    label: "Run a scenario",
    description: "Try a pre-filled adversarial input in the Registry tab. Injection resistance confirmed across 10 scenarios.",
    cta: "Open Registry",
    tab: "registry",
  },
];

const STORAGE_KEY = "openclaw_onboarding_dismissed";
const COMPLETED_KEY = "openclaw_onboarding_completed";

export function OnboardingChecklist({ wid }: { wid: number }) {
  const [, navigate] = useLocation();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
  });
  const [completed, setCompleted] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COMPLETED_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const [collapsed, setCollapsed] = useState(false);

  if (dismissed) return null;

  const markComplete = (id: string) => {
    const next = new Set(completed);
    next.add(id);
    setCompleted(next);
    try { localStorage.setItem(COMPLETED_KEY, JSON.stringify([...next])); } catch {}
  };

  const handleCta = (step: ChecklistStep) => {
    markComplete(step.id);
    if (step.tab) navigate(`/forge/${wid}/${step.tab}`);
  };

  const handleDismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(STORAGE_KEY, "true"); } catch {}
  };

  const doneCount = completed.size;
  const totalCount = STEPS.length;
  const allDone = doneCount === totalCount;

  return (
    <div className="bg-card border border-primary/20 rounded-lg mb-6">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono font-bold text-foreground">
            Legal AI Operating Layer
          </span>
          <span className="text-[10px] font-mono text-muted-foreground">
            {doneCount}/{totalCount} steps
          </span>
          {allDone && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              ACTIVATED
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          <button
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-border">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${(doneCount / totalCount) * 100}%` }}
        />
      </div>

      {/* Steps */}
      {!collapsed && (
        <div className="divide-y divide-border/50">
          {STEPS.map((step) => {
            const done = completed.has(step.id);
            return (
              <div
                key={step.id}
                className={`flex items-start gap-3 px-4 py-3 transition-colors ${
                  done ? "opacity-60" : "hover:bg-secondary/10"
                }`}
              >
                <button
                  onClick={() => markComplete(step.id)}
                  className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors"
                  title="Mark complete"
                >
                  {done ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Circle className="w-4 h-4" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-mono font-bold ${done ? "line-through text-muted-foreground" : "text-foreground"}`}>
                    {step.label}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground mt-0.5 leading-relaxed">
                    {step.description}
                  </p>
                </div>
                {!done && (
                  <button
                    onClick={() => handleCta(step)}
                    className="shrink-0 font-mono text-[10px] px-2 py-1 rounded border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
                  >
                    {step.cta}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer disclaimer */}
      {!collapsed && (
        <div className="px-4 py-2 border-t border-border/50">
          <p className="text-[10px] font-mono text-muted-foreground">
            This is governed AI infrastructure, not legal advice. All outputs require human review.
            AI interaction does not create attorney-client privilege.
          </p>
        </div>
      )}
    </div>
  );
}
