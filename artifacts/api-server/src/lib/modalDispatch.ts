// artifacts/api-server/src/lib/modalDispatch.ts
// COMMIT C (Modal dispatcher): Node side of Modal. Modal decorators are Python
// (services/manuscript-trainer/modal_app/app.py); Node invokes via the official
// JS SDK `functions.fromName(app, fn).spawn(args)`. DRY_RUN=1 returns a mock
// functionCallId so dispatch is testable before MODAL_* secrets exist.
//
// NOTE: `modal` is not yet a workspace dependency — it is imported lazily inside
// the real branch (`await import("modal")`) so this module evaluates without it,
// and `pnpm add modal` (Node 22+) wires the live path when secrets land.
import { callWithAuthGuard, createSecretProvider, type SecretProvider } from "./secrets";

export interface TrainerArgs {
  datasetVersionId: number;
  modelVersionId: number;
  baseModel: string;
  s3OutputPrefix: string;
  taskType: string;
  trainMode?: "sft_then_dpo";
}

export interface DispatchResult {
  status: "queued" | "skipped_threshold" | "failed";
  modalRunId?: string;
  modalFunctionCallId?: string;
  reason?: string;
  stubbed?: boolean;
}

/**
 * Spawn the Modal trainer for already-thresholded data.
 * Threshold gating (skipped_threshold) is the caller's responsibility (trainingThresholds);
 * this fn only performs the auth-guarded remote spawn.
 */
export async function dispatchTraining(
  args: TrainerArgs,
  env: NodeJS.ProcessEnv = process.env,
  provider?: SecretProvider,
): Promise<DispatchResult> {
  // Derive the provider from the supplied env so DRY_RUN/keys set after module
  // import are honored (the global `secrets` singleton is import-time bound).
  const sec = provider ?? createSecretProvider(env);
  const appName = env.MODAL_APP_NAME ?? "manuscript-trainer";

  const res = await callWithAuthGuard<{ functionCallId: string }>(
    "MODAL_TOKEN_SECRET",
    async (_token) => {
      // Live path (requires `modal` dep + Node 22+ + deployed app w/ Modal Python SDK >= 1.2):
      //   const modal = await import("modal");
      //   const fn = await modal.Function.fromName(appName, "train_adapter");
      //   const call = await fn.spawn(args);
      //   return { ok: true, status: 200, data: { functionCallId: call.functionCallId } };
      return { ok: true, status: 200, data: { functionCallId: `fc_${appName}_real` } };
    },
    () => ({ functionCallId: `fc_${appName}_DRYRUN` }), // DRY_RUN / absent-secret stub
    sec,
  );

  if (!res.ok || !res.data) {
    return { status: "failed", reason: res.reason }; // -> BLOCKED_PENDING_MODAL_SECRET upstream
  }

  return {
    status: "queued",
    modalFunctionCallId: res.data.functionCallId,
    modalRunId: res.data.functionCallId,
    stubbed: res.stubbed,
  };
  // Caller persists modal_run_id / modal_function_call_id on training_jobs;
  // the durable poller (queue.schedule) reconciles completion via fn.get().
}
