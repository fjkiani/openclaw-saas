/**
 * prompts/versions.ts — Prompt and policy version registry.
 *
 * Single source of truth for all prompt and policy version strings.
 * Import from here; never define version constants inline in engine files.
 *
 * ── Versioning rules ──────────────────────────────────────────────────────────
 *
 *   MAJOR  (e.g. "2a" → "3a")
 *     Prompt intent changes, output schema changes, or any change that
 *     invalidates prior verification results or issue_resolution_map entries.
 *     Required: new CHANGELOG entry, manager sign-off, full integration test
 *     re-run. Phase 2B and downstream consumers must explicitly opt in.
 *
 *   MINOR  (e.g. "2a.1" → "2a.2")
 *     Wording improvements, clarifications, or additional safety instructions
 *     that do not change output schema or issue coverage logic.
 *     Required: new CHANGELOG entry, integration test suite pass.
 *
 *   PATCH  (e.g. "2a.1" → "2a.1.1")
 *     Typo fixes, whitespace, comment-only changes.
 *     Required: CHANGELOG note only.
 *
 * ── Rollback discipline ───────────────────────────────────────────────────────
 *
 *   - Never delete a version constant. Mark deprecated versions with a comment.
 *   - To roll back: set the active constant to the prior version string and add
 *     a CHANGELOG entry explaining the rollback reason and date.
 *   - Phase 2B and downstream consumers must pin to a specific version and
 *     explicitly opt in to version bumps (do not silently inherit).
 *
 * ── Adding a new prompt ───────────────────────────────────────────────────────
 *
 *   1. Add the constant here with a comment naming the introducing commit/phase.
 *   2. Add a CHANGELOG entry in prompts/CHANGELOG.md.
 *   3. Import the constant in the engine file — never hardcode the string.
 */

// ── Phase 2A prompts (draft letter, clause pack, verification) ────────────────

/** Draft letter generation prompt — introduced Phase 2A, commit 34ea6e5 */
export const DRAFT_PROMPT_VERSION = "2a.1";

/** Two-source verification prompt — introduced Phase 2A, commit 34ea6e5 */
export const VERIFY_PROMPT_VERSION = "2a.1";

/** Action governance policy — introduced Phase 2A, commit 34ea6e5 */
export const ACTION_POLICY_VERSION = "legal-action-v1";

/** Cofounder corpus version used for RAG context — introduced Phase 2A */
export const CORPUS_VERSION = "legal-corpus-pg-v1";

// ── Phase 2B prompts (redline plan) ──────────────────────────────────────────

/** Redline plan generation prompt — introduced Phase 2B.
 *  "2b" is a new major series (not "2a.2") because the prompt intent is
 *  fundamentally different: diff generation vs. draft generation.
 *  Output schema (RedlineEdit[]) is incompatible with DraftLetterArtifact. */
export const REDLINE_PROMPT_VERSION = "2b.1";
