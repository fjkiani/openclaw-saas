/**
 * registerAll.ts — one call to register every built-in domain adapter.
 *
 * An application does:  import { registerAllDomains } from "./verification/registerAll.js";
 *                       registerAllDomains();
 *                       const verdict = await verify("legal_draft", { result, intake });
 */
import { registerDomain } from "./verificationCore.js";
import { legalDraftAdapter } from "./domains/legalDraft.js";
import { mcpServerAdapter } from "./domains/mcpServer.js";
import { genericLlmAdapter } from "./domains/genericLlm.js";
import { sqlGenAdapter } from "./domains/sqlGen.js";

export function registerAllDomains(): void {
  registerDomain(legalDraftAdapter);
  registerDomain(mcpServerAdapter);
  registerDomain(genericLlmAdapter);
  registerDomain(sqlGenAdapter);
}

export { legalDraftAdapter, mcpServerAdapter, genericLlmAdapter, sqlGenAdapter };
