/**
 * components.tsx — presentational pieces for the Trust Certification page.
 *
 *   TrustDial      — SVG arc gauge for the 0-100 trust score, colored by grade.
 *   AxisBars       — the three weighted trust axes with sub-scores + reasons.
 *   EvalGrid       — the 20 red-team prompts as a live status grid by category.
 *   CertCard       — the signed certificate: badge, verify URL, embed snippet.
 */
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { certifyClient, type TrustGrade, type EvalItem, type StoredCertificate, type SignedCertificate } from "@/lib/certifyClient";

const GRADE_COLOR: Record<TrustGrade, string> = {
  TRUSTED: "#2e7d32",
  CONDITIONAL: "#ed6c02",
  UNTRUSTED: "#c62828",
};
// Colorblind-safe status hues (blue/orange/grey rather than green/red only).
const STATUS_COLOR: Record<string, string> = {
  blocked: "#0279EE",
  leaked: "#c62828",
  partial: "#ed6c02",
};

export function gradeColor(g: TrustGrade): string {
  return GRADE_COLOR[g] ?? "#616161";
}

export function TrustDial({ score, grade }: { score: number; grade: TrustGrade }) {
  const r = 70;
  const c = Math.PI * r; // half-circle circumference
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = c * pct;
  const color = gradeColor(grade);
  return (
    <div className="flex flex-col items-center" data-testid="trust-dial">
      <svg width="180" height="110" viewBox="0 0 180 110">
        <path d="M 20 100 A 70 70 0 0 1 160 100" fill="none" stroke="#e0e0e0" strokeWidth="14" strokeLinecap="round" />
        <path
          d="M 20 100 A 70 70 0 0 1 160 100"
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
        />
        <text x="90" y="88" textAnchor="middle" fontSize="34" fontWeight="700" fill={color} data-testid="trust-score-value">
          {score}
        </text>
        <text x="90" y="104" textAnchor="middle" fontSize="11" fill="#888">
          / 100
        </text>
      </svg>
      <Badge style={{ backgroundColor: color, color: "white" }} data-testid="trust-grade-badge">
        {grade}
      </Badge>
    </div>
  );
}

interface Axis {
  score: number;
  weight: number;
  evidence: string;
  reasons: string[];
}

export function AxisBars({ axes }: { axes: { behavioral_safety: Axis; capability_containment: Axis; track_record: Axis } }) {
  const rows: Array<{ key: string; label: string; axis: Axis }> = [
    { key: "behavioral_safety", label: "Behavioral safety", axis: axes.behavioral_safety },
    { key: "capability_containment", label: "Capability containment", axis: axes.capability_containment },
    { key: "track_record", label: "Track record", axis: axes.track_record },
  ];
  return (
    <div className="space-y-3" data-testid="axis-bars">
      {rows.map(({ key, label, axis }) => (
        <div key={key} data-testid={`axis-${key}`}>
          <div className="flex justify-between text-xs font-mono mb-1">
            <span>
              {label}{" "}
              <span className="text-muted-foreground">({Math.round(axis.weight * 100)}% weight · {axis.evidence})</span>
            </span>
            <span className="font-semibold">{axis.score}</span>
          </div>
          <div className="h-2 bg-secondary rounded overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${axis.score}%` }} />
          </div>
          {axis.reasons?.length > 0 && (
            <p className="text-[10px] text-muted-foreground mt-1">{axis.reasons[0]}</p>
          )}
        </div>
      ))}
    </div>
  );
}

const CATEGORIES = ["governance_trap", "injection", "privilege_abuse", "exfiltration"] as const;

export function EvalGrid({ items }: { items: EvalItem[] }) {
  const byCat = useMemo(() => {
    const m: Record<string, EvalItem[]> = {};
    for (const it of items) (m[it.category] ??= []).push(it);
    return m;
  }, [items]);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="eval-grid">
      {CATEGORIES.map((cat) => (
        <Card key={cat} className="p-3">
          <div className="text-xs font-mono font-semibold mb-2 capitalize">{cat.replace("_", " ")}</div>
          <div className="flex flex-wrap gap-1.5">
            {(byCat[cat] ?? []).map((it) => (
              <span
                key={it.id}
                title={`${it.id}: ${it.reason}`}
                data-testid={`eval-item-${it.id}`}
                data-status={it.status}
                className="inline-block w-6 h-6 rounded text-[9px] text-white flex items-center justify-center font-mono"
                style={{ backgroundColor: STATUS_COLOR[it.status] ?? "#999" }}
              >
                {it.status === "blocked" ? "✓" : it.status === "leaked" ? "✗" : "~"}
              </span>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

export function CertCard({ cert, signature }: { cert: StoredCertificate | SignedCertificate["payload"]; signature?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const certId = "cert_id" in cert ? cert.cert_id : (cert as StoredCertificate).cert_id;
  const grade = cert.grade as TrustGrade;
  const score = cert.trust_score;
  const badgeUrl = certifyClient.badgeUrl(certId);
  const verifyUrl = `${((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "")}/api/v1/certify/cert/${certId}/verify`;
  const embed = `[![MCP Trust](${badgeUrl})](${verifyUrl})`;

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Card className="p-4 space-y-3" data-testid="cert-card">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-mono font-semibold" data-testid="cert-slug">{cert.slug}</div>
          <div className="text-[10px] text-muted-foreground">v{cert.version} · {certId}</div>
        </div>
        <img src={badgeUrl} alt="trust badge" height={20} data-testid="cert-badge-img" />
      </div>

      <div className="flex items-center gap-2 text-xs font-mono">
        <Badge style={{ backgroundColor: gradeColor(grade), color: "white" }}>{grade}</Badge>
        <span className="font-semibold">Trust {score}/100</span>
        <span className="text-muted-foreground">· eval: {cert.eval_mode}{cert.model_evaluated ? ` (${cert.model_evaluated})` : ""}</span>
      </div>

      <div className="space-y-2">
        <div>
          <div className="text-[10px] text-muted-foreground mb-0.5">Verify URL (shareable, tamper-evident)</div>
          <div className="flex gap-1">
            <code className="flex-1 text-[10px] bg-secondary px-2 py-1 rounded truncate" data-testid="cert-verify-url">{verifyUrl}</code>
            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => copy("verify", verifyUrl)} data-testid="button-copy-verify">
              {copied === "verify" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground mb-0.5">Embed badge (Markdown)</div>
          <div className="flex gap-1">
            <code className="flex-1 text-[10px] bg-secondary px-2 py-1 rounded truncate" data-testid="cert-embed">{embed}</code>
            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => copy("embed", embed)} data-testid="button-copy-embed">
              {copied === "embed" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        {signature && (
          <div>
            <div className="text-[10px] text-muted-foreground mb-0.5">HMAC-SHA256 signature</div>
            <code className="block text-[10px] bg-secondary px-2 py-1 rounded truncate" data-testid="cert-signature">{signature}</code>
          </div>
        )}
      </div>
    </Card>
  );
}
