import { useState, useRef } from "react";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/apiFetch";
import {
  Scale,
  TrendingUp,
  Users,
  FlaskConical,
  Loader2,
  ChevronRight,
  Zap,
  Database,
  Plug,
  ArrowRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Vertical {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  skills: string[];
  connectors: string[];
  timeToLive: string;
  status: "live" | "coming" | "custom";
  description: string;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const VERTICALS: Vertical[] = [
  {
    id: "legal",
    icon: Scale,
    label: "Law Firm",
    description: "Clause extraction, matter routing, specialist agents across contract, litigation, IP, employment, and corporate.",
    skills: ["Clause Extractor", "Intake Router", "Contract Analyst"],
    connectors: ["OpenRouter"],
    timeToLive: "~30 seconds",
    status: "live",
  },
  {
    id: "ir",
    icon: TrendingUp,
    label: "Investor Relations",
    description: "Investor research, outreach drafting, and diligence response — grounded on your data room.",
    skills: ["Investor Research", "Outreach Drafter", "Diligence Responder"],
    connectors: ["Crunchbase", "Gmail"],
    timeToLive: "~5 minutes",
    status: "coming",
  },
  {
    id: "hr",
    icon: Users,
    label: "HR & Compliance",
    description: "Policy analysis, offer letter review, and compliance checking across employment law and internal policy.",
    skills: ["Policy Analyzer", "Offer Letter Reviewer", "Compliance Checker"],
    connectors: ["HRIS", "Slack"],
    timeToLive: "~5 minutes",
    status: "coming",
  },
  {
    id: "biotech",
    icon: FlaskConical,
    label: "Biotech / Research",
    description: "Protocol generation, literature review, and regulatory compliance — grounded on your research corpus.",
    skills: ["Protocol Generator", "Literature Reviewer", "Compliance Checker"],
    connectors: ["PubMed", "Internal DB"],
    timeToLive: "~5 minutes",
    status: "coming",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function VerticalPickerPage() {
  const [, navigate] = useLocation();
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitlistEmail, setWaitlistEmail] = useState<Record<string, string>>({});
  const [waitlistDone, setWaitlistDone] = useState<Record<string, boolean>>({});
  const [customDomain, setCustomDomain] = useState("");
  const [customSubmitting, setCustomSubmitting] = useState(false);
  const provisionedRef = useRef(false);
  const { user } = useUser();

  function handleLive() {
    if (provisionedRef.current || provisioning) return;
    provisionedRef.current = true;
    setProvisioning(true);
    setError(null);

    apiFetch("/api/onboarding/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Pass userId explicitly — fallback for Clerk dev instances cross-origin
      // where server-side JWT verification fails (SameSite/CORS on dev FAPI).
      body: JSON.stringify({ userId: user?.id }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Provision failed: ${r.status}`);
        const raw = await r.text();
        if (!raw || !raw.trim()) throw new Error("Service is warming up — please try again in a few seconds.");
        try { return JSON.parse(raw) as { workspace_id: number; provisioned: boolean }; } catch { throw new Error("Invalid response from server. Please retry."); }
      })
      .then((data) => {
        // Store workspace_id in sessionStorage so setup page can read it
        sessionStorage.setItem("oc_onboarding_wid", String(data.workspace_id));
        navigate("/onboarding/setup");
      })
      .catch((err) => {
        setProvisioning(false);
        provisionedRef.current = false;
        setError(err.message ?? "Provisioning failed. Please try again.");
      });
  }

  function handleWaitlist(id: string) {
    const email = waitlistEmail[id] ?? "";
    if (!email.includes("@")) return;
    setWaitlistDone((prev) => ({ ...prev, [id]: true }));
  }

  function handleCustom() {
    if (!customDomain.trim()) return;
    setCustomSubmitting(true);
    apiFetch("/api/forge/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: customDomain.trim(), domain: "custom", description: "" }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        const raw = await r.text();
        if (!raw || !raw.trim()) throw new Error("Service is warming up — please try again in a few seconds.");
        try { return JSON.parse(raw) as { id: number }; } catch { throw new Error("Invalid response from server. Please retry."); }
      })
      .then((ws) => {
        sessionStorage.setItem("oc_onboarding_wid", String(ws.id));
        navigate("/onboarding/setup");
      })
      .catch(() => {
        setCustomSubmitting(false);
        setError("Could not create workspace. Please try again.");
      });
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <span className="text-sm font-mono font-bold text-foreground tracking-tight">OPENCLAW</span>
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Factory Setup</span>
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-3xl">
          {/* Heading */}
          <div className="mb-10 text-center">
            <h1 className="text-2xl font-mono font-bold text-foreground mb-3">
              What does your organization do?
            </h1>
            <p className="text-sm font-mono text-muted-foreground max-w-lg mx-auto">
              We'll provision your workspace, skill bundle, and first governed endpoint.
              Your AI workforce will be live in minutes.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-6 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-xs font-mono text-red-400 text-center">
              {error}
            </div>
          )}

          {/* Vertical cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            {VERTICALS.map((v) => {
              const Icon = v.icon;
              const isLive = v.status === "live";
              const isComing = v.status === "coming";

              return (
                <div
                  key={v.id}
                  className={`bg-card border rounded-lg p-5 flex flex-col gap-4 transition-all ${
                    isLive
                      ? "border-primary/40 hover:border-primary cursor-pointer"
                      : "border-border opacity-70"
                  }`}
                  onClick={isLive && !provisioning ? handleLive : undefined}
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded ${isLive ? "bg-primary/10" : "bg-zinc-500/10"}`}>
                        <Icon className={`w-4 h-4 ${isLive ? "text-primary" : "text-zinc-400"}`} />
                      </div>
                      <div>
                        <div className="text-sm font-mono font-bold text-foreground">{v.label}</div>
                        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                          {isLive ? `Live in ${v.timeToLive}` : "Coming soon"}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                        isLive
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
                      }`}
                    >
                      {isLive ? "LIVE" : "COMING"}
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-xs font-mono text-muted-foreground leading-relaxed">
                    {v.description}
                  </p>

                  {/* Skills + connectors */}
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <Zap className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="flex flex-wrap gap-1">
                        {v.skills.map((s) => (
                          <span key={s} className="text-[10px] font-mono px-1.5 py-0.5 bg-secondary rounded text-muted-foreground">
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Plug className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="flex flex-wrap gap-1">
                        {v.connectors.map((c) => (
                          <span key={c} className="text-[10px] font-mono px-1.5 py-0.5 bg-secondary rounded text-muted-foreground">
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Action */}
                  {isLive && (
                    <button
                      onClick={(e) => { e.stopPropagation(); if (!provisioning) handleLive(); }}
                      disabled={provisioning}
                      className="mt-auto flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-4 py-2 rounded disabled:opacity-50 transition-colors"
                    >
                      {provisioning ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Provisioning workspace...
                        </>
                      ) : (
                        <>
                          Launch this vertical
                          <ChevronRight className="w-3 h-3" />
                        </>
                      )}
                    </button>
                  )}

                  {isComing && (
                    <div className="mt-auto">
                      {waitlistDone[v.id] ? (
                        <div className="text-[10px] font-mono text-emerald-400 text-center py-1">
                          You're on the list.
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <input
                            type="email"
                            placeholder="your@email.com"
                            value={waitlistEmail[v.id] ?? ""}
                            onChange={(e) => setWaitlistEmail((prev) => ({ ...prev, [v.id]: e.target.value }))}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 bg-background border border-border rounded px-2 py-1 text-[10px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
                          />
                          <button
                            onClick={(e) => { e.stopPropagation(); handleWaitlist(v.id); }}
                            className="text-[10px] font-mono px-2 py-1 border border-border rounded text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Notify me
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Custom domain */}
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="flex items-center gap-2 mb-3">
              <Database className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-mono font-bold text-foreground">Custom — describe your domain</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded border bg-zinc-500/10 text-zinc-400 border-zinc-500/20">ADVANCED</span>
            </div>
            <p className="text-xs font-mono text-muted-foreground mb-4">
              Start with a blank workspace. You'll configure your own skill bundle, data, and connectors.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="e.g. Real Estate, Insurance, Supply Chain..."
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCustom(); }}
                className="flex-1 bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
              />
              <button
                onClick={handleCustom}
                disabled={!customDomain.trim() || customSubmitting}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-3 py-1.5 rounded disabled:opacity-50 transition-colors"
              >
                {customSubmitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
                Start
              </button>
            </div>
          </div>

          {/* Skip */}
          <div className="mt-6 text-center">
            <button
              onClick={() => navigate("/dashboard")}
              className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip for now — go to dashboard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
