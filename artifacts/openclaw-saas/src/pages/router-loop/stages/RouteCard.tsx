/**
 * RouteCard (stage 7) — W4 track. Current router policy + candidate diff +
 * one-click rollback to baseline (destructive, requires admin token).
 */
import { useEffect, useState } from "react";
import { Route } from "lucide-react";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import { useRollbackGate } from "@/pages/intelligence/workflow-hooks";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

function routeStatus(r: DrilldownResponse["route"]): "green" | "amber" | "red" | "grey" {
  if (!r.current_policy.fast_model_id) return "grey";
  if (r.can_rollback) return "amber"; // active candidate distinct from baseline
  return "green";
}

const ADMIN_TOKEN_KEY = "oc-admin-token";

export function RouteCard({ data, onActionChange }: { data: DrilldownResponse; onActionChange: (a: boolean) => void }) {
  const r = data.route;
  const s = routeStatus(r);
  const [adminToken, setAdminToken] = useState<string>(() => (typeof window !== "undefined" ? localStorage.getItem(ADMIN_TOKEN_KEY) ?? "" : ""));
  const mut = useRollbackGate(adminToken);

  useEffect(() => {
    onActionChange(mut.isPending);
  }, [mut.isPending, onActionChange]);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
  }, [adminToken]);

  return (
    <StageCard
      icon={Route}
      title="Route"
      subtitle={`fast: ${r.current_policy.fast_model_id ?? "—"} · deep: ${r.current_policy.deep_model_id ?? "—"}`}
      status={s}
      action={
        r.can_rollback && r.rollback_gate_id ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="destructive" data-testid="btn-open-rollback">
                Revert to baseline
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revert router policy?</AlertDialogTitle>
                <AlertDialogDescription>
                  This flips the active router back to the baseline recorded in gate #{r.rollback_gate_id}. A new rollback row will be appended to the promotion history.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-muted-foreground">admin token (x-openclaw-admin-token)</label>
                <Input
                  type="password"
                  value={adminToken}
                  onChange={(e) => setAdminToken(e.target.value)}
                  className="font-mono text-xs"
                  data-testid="input-admin-token"
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => mut.mutate(r.rollback_gate_id!)}
                  disabled={!adminToken.trim()}
                  data-testid="btn-confirm-rollback"
                >
                  Revert
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null
      }
    >
      {r.candidate_diff && (
        <Alert className="mb-2">
          <AlertTitle className="font-mono text-xs">candidate diff</AlertTitle>
          <AlertDescription className="font-mono text-[11px]">
            fast: {r.candidate_diff.from_fast ?? "—"} → {r.candidate_diff.to_fast ?? "—"} · deep: {r.candidate_diff.from_deep ?? "—"} → {r.candidate_diff.to_deep ?? "—"}
          </AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-border p-2">
          <div className="text-[10px] font-mono text-muted-foreground">policy id</div>
          <div className="text-sm font-mono font-semibold">{r.current_policy.id ?? "—"}</div>
        </div>
        <div className="rounded border border-border p-2">
          <div className="text-[10px] font-mono text-muted-foreground">updated</div>
          <div className="text-xs font-mono">{r.current_policy.updated_at ? new Date(r.current_policy.updated_at).toLocaleString() : "—"}</div>
        </div>
      </div>
      {mut.data && (
        <div className="mt-2 text-[11px] font-mono text-emerald-400">
          reverted → gate #{mut.data.new_gate_id} · policy #{mut.data.new_policy_id} · fast {mut.data.reverted_to.fast_model_id}
        </div>
      )}
      {mut.error && <div className="mt-2 text-[11px] font-mono text-rose-400">{String((mut.error as Error).message)}</div>}
      <AdvancedDrawer>
        <RawJson value={r} />
      </AdvancedDrawer>
    </StageCard>
  );
}
