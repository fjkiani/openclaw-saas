/**
 * Trust Certification page (/certify).
 *
 * The demo-able flagship surface: run a REAL behavioral red-team against an
 * MCP, watch the 20 prompts score across four attack categories, see the fused
 * Trust Score, and get back a signed, publicly verifiable certificate + badge.
 *
 * Three tabs:
 *   Certify     — pick an MCP → issue → dial + axes + eval grid + signed cert.
 *   Verify      — paste a cert_id → tamper-evident verification result.
 *   Leaderboard — certified MCPs ranked by Trust Score.
 *
 * Honest by construction: when the platform has no live model key, issuance
 * runs in dry mode and the UI labels it as such (never a fake "live" score).
 */
import { useState } from "react";
import { ShieldCheck, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TrustDial, AxisBars, EvalGrid, CertCard, gradeColor } from "./components";
import { useMcpList, useCertify, useVerify, useLeaderboard, useCertifyHealth } from "./hooks";
import type { IssueResponse, TrustGrade, VerifyResponse } from "@/lib/certifyClient";

function CertifyTab() {
  const { data: mcps } = useMcpList();
  const { data: health } = useCertifyHealth();
  const certify = useCertify();
  const [slug, setSlug] = useState<string>("");
  const [result, setResult] = useState<IssueResponse | null>(null);

  const run = async () => {
    if (!slug) return;
    const r = await certify.mutateAsync({ slug });
    setResult(r);
  };

  const p = result?.certificate?.payload;

  return (
    <div className="space-y-4">
      {/* Live/dry status banner — honest about whether scores are behavioral. */}
      {health && (
        <Card className="p-3 flex items-center gap-2 text-xs font-mono" data-testid="eval-mode-banner">
          {health.live ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-primary" />
              <span>Live behavioral eval enabled — scoring real model responses ({health.model}).</span>
            </>
          ) : (
            <>
              <XCircle className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                Dry mode ({health.reason}). Certificates are signed and verifiable but the behavioral axis is a static
                fallback until a live model key is set + MCP_EVAL_LIVE=1.
              </span>
            </>
          )}
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="text-xs font-mono text-muted-foreground mb-1 block">MCP to certify</label>
            <select
              className="w-full h-9 px-2 rounded border bg-background text-sm font-mono"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              data-testid="select-mcp"
            >
              <option value="">Select an MCP…</option>
              {(mcps ?? []).map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name} ({m.slug})
                </option>
              ))}
            </select>
          </div>
          <Button onClick={run} disabled={!slug || certify.isPending} data-testid="button-run-certify">
            {certify.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            <span className="ml-1">Run certification</span>
          </Button>
        </div>
        {certify.isError && (
          <p className="text-xs text-red-600 mt-2" data-testid="certify-error">{certify.error.message}</p>
        )}
      </Card>

      {result?.ok && p && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" data-testid="certify-result">
          <Card className="p-4 flex flex-col items-center justify-center">
            <TrustDial score={p.trust_score} grade={p.grade as TrustGrade} />
            <p className="text-[10px] text-muted-foreground mt-2 text-center">
              {result.eval_report.n_blocked} blocked · {result.eval_report.n_leaked} leaked ·{" "}
              {result.eval_report.n_partial} partial
            </p>
          </Card>
          <Card className="p-4 lg:col-span-2">
            <div className="text-xs font-mono font-semibold mb-3">Trust axes (safety-led 50/30/20)</div>
            <AxisBars axes={p.axes} />
          </Card>
          <div className="lg:col-span-3">
            <div className="text-xs font-mono font-semibold mb-2">Red-team suite — {result.eval_report.items.length} prompts</div>
            <EvalGrid items={result.eval_report.items} />
          </div>
          <div className="lg:col-span-3">
            <CertCard cert={p} signature={result.certificate.signature} />
          </div>
        </div>
      )}
    </div>
  );
}

function VerifyTab() {
  const verify = useVerify();
  const [certId, setCertId] = useState("");
  const [res, setRes] = useState<VerifyResponse | null>(null);

  const run = async () => {
    if (!certId) return;
    setRes(await verify.mutateAsync(certId.trim()));
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4">
        <label className="text-xs font-mono text-muted-foreground mb-1 block">Certificate ID</label>
        <div className="flex gap-2">
          <Input placeholder="crt_…" value={certId} onChange={(e) => setCertId(e.target.value)} data-testid="input-cert-id" />
          <Button onClick={run} disabled={!certId || verify.isPending} data-testid="button-verify">
            {verify.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Verify"}
          </Button>
        </div>
      </Card>

      {res && (
        <Card
          className="p-4 flex items-center gap-3"
          data-testid="verify-result"
          data-valid={res.valid ? "true" : "false"}
        >
          {res.valid ? (
            <CheckCircle2 className="w-8 h-8 text-green-600" />
          ) : (
            <XCircle className="w-8 h-8 text-red-600" />
          )}
          <div className="text-sm font-mono">
            <div className="font-semibold" data-testid="verify-verdict">
              {res.valid ? "Valid certificate" : res.revoked ? "Revoked certificate" : "Invalid / tampered"}
            </div>
            {res.slug && (
              <div className="text-xs text-muted-foreground">
                {res.slug} · <Badge style={{ backgroundColor: gradeColor((res.grade ?? "UNTRUSTED") as TrustGrade), color: "white" }}>{res.grade}</Badge>{" "}
                Trust {res.trust_score}/100 · signature {res.signature_valid ? "OK" : "bad"}
                {res.revoked ? " · REVOKED" : ""}
              </div>
            )}
            {res.error && <div className="text-xs text-red-600">{res.error}</div>}
          </div>
        </Card>
      )}
    </div>
  );
}

function LeaderboardTab() {
  const { data: rows, isLoading } = useLeaderboard();
  return (
    <Card className="p-0 overflow-hidden" data-testid="leaderboard">
      <table className="w-full text-sm font-mono">
        <thead className="bg-secondary/50 text-xs">
          <tr>
            <th className="text-left px-3 py-2">#</th>
            <th className="text-left px-3 py-2">MCP</th>
            <th className="text-left px-3 py-2">Grade</th>
            <th className="text-right px-3 py-2">Trust</th>
            <th className="text-left px-3 py-2">Eval</th>
            <th className="text-left px-3 py-2">Cert ID</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr><td colSpan={6} className="px-3 py-4 text-muted-foreground">Loading…</td></tr>
          )}
          {!isLoading && (rows ?? []).length === 0 && (
            <tr><td colSpan={6} className="px-3 py-4 text-muted-foreground" data-testid="leaderboard-empty">No certified MCPs yet — run a certification.</td></tr>
          )}
          {(rows ?? []).map((r, i) => (
            <tr key={r.cert_id} className="border-t" data-testid={`leaderboard-row-${r.slug}`}>
              <td className="px-3 py-2">{i + 1}</td>
              <td className="px-3 py-2">{r.slug} <span className="text-muted-foreground text-xs">v{r.version}</span></td>
              <td className="px-3 py-2">
                <Badge style={{ backgroundColor: gradeColor(r.grade as TrustGrade), color: "white" }}>{r.grade}</Badge>
                {r.revoked && <span className="ml-1 text-[10px] text-red-600">revoked</span>}
              </td>
              <td className="px-3 py-2 text-right font-semibold">{r.trust_score}</td>
              <td className="px-3 py-2 text-xs">{r.eval_mode}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[160px]">{r.cert_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function CertifyPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="certify-page">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-6 h-6 text-primary" />
        <h1 className="text-xl font-mono font-bold">MCP Trust Certification</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Behavioral red-team + signed, verifiable trust certificate for any MCP. The governed supply chain for
        domain-specialized AI.
      </p>
      <Tabs defaultValue="certify">
        <TabsList data-testid="certify-tabs">
          <TabsTrigger value="certify" data-testid="tab-certify">Certify</TabsTrigger>
          <TabsTrigger value="verify" data-testid="tab-verify">Verify</TabsTrigger>
          <TabsTrigger value="leaderboard" data-testid="tab-leaderboard">Leaderboard</TabsTrigger>
        </TabsList>
        <TabsContent value="certify" className="mt-4"><CertifyTab /></TabsContent>
        <TabsContent value="verify" className="mt-4"><VerifyTab /></TabsContent>
        <TabsContent value="leaderboard" className="mt-4"><LeaderboardTab /></TabsContent>
      </Tabs>
    </div>
  );
}
