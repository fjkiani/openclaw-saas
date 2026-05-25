# Release Checklist — Coverage Layer + Company-Protection Layer

**Version:** JR Corrective Pass (post-JR-review)
**Status:** READY FOR RELEASE (all blockers resolved)
**Last updated:** 2025-01-01

---

## Release Bar

The following commands must both exit cleanly before any release:

```bash
# 1. api-server typecheck — must exit 0
pnpm --filter api-server exec tsc -p tsconfig.json --noEmit

# 2. api-server test suite — all tests must pass
pnpm --filter api-server test
```

**Note on workspace-level typecheck:** `pnpm run typecheck` (repo root) produces pre-existing
TS6305 (workspace lib not built) and TS7006 (implicit-any in other packages) errors that are
not introduced by this work and are non-blocking. The release bar is scoped to `api-server` only.

---

## Acceptance Criteria

All cases must pass in `pnpm --filter api-server test` before release.

| Case | Description | Status |
|------|-------------|--------|
| 1–20 | Draft generation, revision loop, governance, NL revision | ✅ Pass |
| 21–28 | Coverage layer: normalization, detection, threshold escalation | ✅ Pass |
| 35 | `draft_generation_gate` is authoritative gate object | ✅ Pass |
| 36 | Negation-aware detection: negated IP/non-compete not false-positively detected | ✅ Pass |
| 37 | Contradiction detection: dual governing law raises threshold + blocks gate | ✅ Pass |
| 38 | Mixed-document detection: contractor-class clauses in co-founder agreement | ✅ Pass |
| 39 | Coverage summary honesty: no "no material gaps" when warnings present | ✅ Pass |

**Case 35 UI proof:** See `docs/verification/gate-ui-proof.md` for manual verification
artifact confirming the UI reads `draft_generation_gate.allowed` from the backend and does
not reconstruct the gate locally.

---

## Negation Regression Pack

The following phrases must NOT produce false-positive clause detections.
Verified in Case 36 (integration test) and Python smoke tests.

| Phrase | Expected | Verified |
|--------|----------|---------|
| `"no IP assignment shall be made"` | `ip_assignment` not detected | ✅ |
| `"party shall not assign IP"` | `ip_assignment` not detected | ✅ |
| `"without indemnification obligations"` | unsupported section not fired | ✅ |
| `"non-compete shall not apply"` | `non_compete` not detected | ✅ |
| `"no confidentiality obligation except..."` | `confidentiality` not detected | ✅ |
| Positive alongside negation: `"no IP assignment... hereby assigns all right..."` | `ip_assignment` detected | ✅ |

---

## Residual Risks

### RR-01: Contradiction detection scope (known limitation)

**Scope:** `detectContradictions()` currently detects:
1. Multiple distinct governing law jurisdictions (regex-based, e.g. "laws of Delaware" + "laws of California")
2. Repeated section headings (e.g. two "GOVERNING LAW" headings)

**Not in scope:**
- Semantic contradictions within a single clause (e.g., "vesting is 4 years" in §3 vs "vesting is 2 years" in §7)
- Cross-clause logical contradictions (e.g., IP assignment in §4 contradicted by carve-out in §9)
- Multi-jurisdiction detection beyond governing law (e.g., conflicting arbitration venues)

**Risk level:** Medium. Contracts with semantic contradictions outside governing law will not
trigger `contradiction_warnings` and will not receive threshold elevation for that reason.
Human review is still required at `counsel_review_required` threshold for all material contracts.

**Mitigation:** The coverage threshold system ensures that complex contracts (high missing-clause
count, low coverage score) are escalated to `counsel_review_required` or `blocked` regardless
of contradiction detection. Contradiction detection is an additive signal, not the sole gate.

### RR-02: Negation lookback window (40-char heuristic)

**Scope:** `isNegated()` uses a 40-character lookback window before the matched term.

**Known gap:** Constructs like `"no IP assignment except as provided in Schedule A, which
hereby assigns..."` — the positive clause is described later in the same sentence, beyond
the 40-char window. The negation prefix `"no "` would suppress the positive detection.

**Risk level:** Low. The `hasNonNegatedOccurrence()` function scans ALL occurrences of a
keyword, so a positive occurrence elsewhere in the document will still be detected. The gap
only applies when the sole positive occurrence is in the same sentence as a negation prefix,
more than 40 chars after it.

**Mitigation:** High-specificity phrases (e.g., `"hereby assigns"`, `"assigns all right, title
and interest"`) are checked independently and are not subject to the same false-negative risk.

### RR-03: Heading-alone detection guard

**Scope:** `detectClause()` now requires at least one corroborating phrase or keyword match
alongside a heading match. A section heading alone (e.g., `"2. INTELLECTUAL PROPERTY"`) is
not sufficient to detect a clause.

**Known gap:** A contract that has a section heading but whose body is entirely negated will
correctly not be detected. However, a contract with a heading and a single non-negated keyword
(but no high-specificity phrase) will still be detected at `low` confidence.

**Risk level:** Low. Single-keyword detection at `low` confidence is expected behavior for
sparse contracts. The threshold system escalates appropriately.

---

## Files Modified in This Release

| File | Change |
|------|--------|
| `artifacts/api-server/src/lib/documentCoverage.ts` | Full rewrite: negation-aware detection, contradiction detection, mixed-document detection, summary honesty, raised specificity, heading-alone guard |
| `artifacts/api-server/src/routes/legal.draft.addendum.ts` | `draft_generation_gate` object, `contradiction_warnings`, `mixed_document_warnings` in response |
| `artifacts/openclaw-saas/src/pages/startup-counsel.tsx` | Types updated, local gate reconstruction deleted, backend gate used |
| `artifacts/api-server/src/routes/__tests__/startup.counsel.integration.test.ts` | Cases 35–39 added |
| `docs/release-checklist.md` | This file |
| `docs/verification/gate-ui-proof.md` | Manual verification artifact for Case 35 |
| `README.md` | Testing & Release section added |
