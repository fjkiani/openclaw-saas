/**
 * bench/routerProbe.ts — diagnose the judge chain by dumping the router's attempt log.
 * Prints attempt status/error per entry. Never prints key material.
 */

import { invokeWithFallback, RouterExhaustedError, type ModelRouteConfig } from "../../modelRouter.js";

const CHAIN: ModelRouteConfig[] = [
  { id: "llama-3.3-70b-versatile", provider: "groq", apiKeyEnv: "GROQ_API_KEY", maxTokens: 300, timeoutMs: 20_000 },
  { id: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 300, timeoutMs: 55_000 },
];

const scrub = (s: string) => s.replace(/(gsk_|sk-or-v1-)[A-Za-z0-9]+/g, "[REDACTED]");

async function main() {
  try {
    const res = await invokeWithFallback(
      {
        systemPrompt: 'Respond ONLY as compact JSON: {"overall":n,"axes":{"correctness":n}}.',
        userContent: "AXES: correctness\n\nOUTPUT TO JUDGE:\nThe migration completed in 3 phases with zero downtime.",
        title: "rigor-router-probe",
        maxTokens: 300,
        temperature: 0,
      },
      CHAIN,
      { routeChainId: "rigor-probe" },
    );
    console.log("SUCCESS via", res.model_used, `(${res.provider_used})`, `${res.latency_ms}ms`);
    console.log("raw:", scrub(res.raw).slice(0, 300));
    console.log("attempts:");
    for (const a of res.attempt_log) console.log(`  ${a.provider}/${a.model_id} -> ${a.status} ${a.latency_ms}ms ${a.error ? scrub(a.error).slice(0, 300) : ""}`);
  } catch (e) {
    if (e instanceof RouterExhaustedError) {
      console.log("EXHAUSTED. attempt log:");
      for (const a of e.attempt_log) {
        console.log(`  ${a.provider}/${a.model_id} -> ${a.status} ${a.latency_ms}ms`);
        if (a.error) console.log(`      error: ${scrub(a.error).slice(0, 500)}`);
      }
    } else {
      console.log("OTHER ERROR:", scrub(e instanceof Error ? e.message : String(e)));
    }
  }
}

main();
