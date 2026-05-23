# Prompt Version Changelog

## Versioning rules

| Bump | When | Required |
|------|------|----------|
| **MAJOR** (e.g. `2a` → `3a`) | Prompt intent changes, output schema changes, or any change that invalidates prior verification results | New CHANGELOG entry + manager sign-off + full integration test re-run |
| **MINOR** (e.g. `2a.1` → `2a.2`) | Wording improvements, clarifications, additional safety instructions — no schema or coverage logic change | New CHANGELOG entry + integration test suite pass |
| **PATCH** (e.g. `2a.1` → `2a.1.1`) | Typo fixes, whitespace, comment-only changes | CHANGELOG note only |

**Rollback:** set the active constant in `versions.ts` to the prior version string; add a CHANGELOG entry with rollback reason and date. Never delete a constant.

---

## 2b.1 — 2026-05-23 (Phase 2B initial release)

**Constant:** `REDLINE_PROMPT_VERSION = "2b.1"`  
**Introducing commit:** Phase 2B (Commit C)  
**Change:** Redline plan generation prompt. Produces `RedlineEdit[]` entries for
`unresolved` and `partially_addressed` issues from a verified Phase 2A artifact.
Issues with `human_only_blocker` status go into `unaddressable_issues` (no edit generated).
Issues with `addressed` status produce no edit.  
**Why new major series (2b, not 2a.2):** Output schema (`RedlinePlanArtifact`) is
incompatible with `DraftLetterArtifact`; prompt intent is diff generation, not draft generation.  
**Tests:** receipts 15–17 (17/17 + new cases green)

---

## 2a.1 — 2026-04-28 (Phase 2A initial release)

**Constants:** `DRAFT_PROMPT_VERSION = "2a.1"`, `VERIFY_PROMPT_VERSION = "2a.1"`  
**Policy:** `ACTION_POLICY_VERSION = "legal-action-v1"`  
**Corpus:** `CORPUS_VERSION = "cofounder-corpus-v1"`  
**Introducing commit:** `34ea6e5`  
**Change:** Initial release. Draft letter and clause pack generation prompts with
two-source verification. Cofounder specialist corpus v1.  
**Tests:** receipts 1–13 + AC-8 (15/15 green, commit `57ef38d`)  
**Gap closures:** expiry + replay nonce (`76fcee2`), `partially_addressed_issues` AC-8 fix (`65a7cfa`)
