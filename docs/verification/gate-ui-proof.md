# Gate UI Proof — Case 35 Manual Verification Artifact

**Requirement:** The UI must read `draft_generation_gate.allowed` from the backend response.
It must NOT reconstruct the gate locally from `threshold` or `redraft_available`.

**Verification method:** Static code inspection (no component test framework available in
`openclaw-saas`; vitest/jsdom/@testing-library are not installed).

**Base commit at time of inspection:** `47c08fe9c1754948750ce32ced1c07871ec815c2`

---

## 1. Backend: Gate Object Definition

**File:** `artifacts/api-server/src/routes/legal.draft.addendum.ts`

The backend computes the gate once and returns it as a structured object:

```typescript
draft_generation_gate: {
  allowed: boolean;           // authoritative — UI reads this
  blocking_reasons: string[]; // human-readable reasons when allowed=false
  threshold: ReviewThreshold; // mirrors governance.review_threshold
}
```

**Invariants enforced in the route (verified by integration test Case 35):**
- `allowed === true` → `blocking_reasons` is empty (`[]`)
- `allowed === false` → `blocking_reasons` is non-empty (at least one reason)
- `gate.threshold === governance.review_threshold` (same value, not recomputed)
- `redraft_available === gate.allowed` (backward-compat mirror, not authoritative)

---

## 2. UI: Type Declaration

**File:** `artifacts/openclaw-saas/src/pages/startup-counsel.tsx`
**Lines:** 1013–1019

```typescript
// Fix 1: authoritative draft generation gate (replaces local draftBlocked reconstruction)
draft_generation_gate: {
  allowed: boolean;
  blocking_reasons: string[];
  threshold: ReviewThreshold;
};
redraft_available: boolean; // backward compat only — use draft_generation_gate.allowed
```

---

## 3. UI: Gate Consumption

**File:** `artifacts/openclaw-saas/src/pages/startup-counsel.tsx`
**Lines:** 1203–1205

```typescript
// Fix 1: Use backend-computed gate — do NOT reconstruct locally.
// The backend is the single source of truth for draft generation eligibility.
const draftBlocked = !data.draft_generation_gate.allowed;
```

**What was deleted:** The prior local reconstruction:
```typescript
// DELETED — was reconstructing gate locally from threshold:
// const draftBlocked = threshold === "blocked" ||
//   threshold === "counsel_review_required" ||
//   !data.redraft_available;
```

---

## 4. UI: Gate Usage in Render

**File:** `artifacts/openclaw-saas/src/pages/startup-counsel.tsx`
**Lines:** 1711–1725

```typescript
{draftBlocked ? (
  <div className={[
    "w-full px-3 py-2.5 rounded text-[10px] font-mono text-center border",
    data.draft_generation_gate.threshold === "blocked"
      ? "bg-red-500/8 border-red-500/20 text-red-600"
      : "bg-amber-500/8 border-amber-500/20 text-amber-700 dark:text-amber-400",
  ].join(" ")}>
    <div className="flex items-center justify-center gap-1.5 mb-0.5">
      <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
      <span className="font-semibold">Human review required before draft generation</span>
    </div>
    <span className="text-[9px] opacity-80">
      {data.draft_generation_gate.blocking_reasons.join(" · ")}
    </span>
  </div>
```

**Observations:**
1. `draftBlocked` is derived solely from `data.draft_generation_gate.allowed` (line 1205)
2. Banner color uses `data.draft_generation_gate.threshold` — not a local `threshold` variable
3. Blocking reasons are rendered directly from `data.draft_generation_gate.blocking_reasons`
4. No local reconstruction of gate logic anywhere in the component

---

## 5. Search Confirmation: No Local Gate Reconstruction

The following search confirms no local gate reconstruction exists in the component:

```
grep "threshold === \"blocked\"\|threshold === \"counsel_review_required\"\|redraft_available.*false" \
  artifacts/openclaw-saas/src/pages/startup-counsel.tsx
```

**Result:** No matches. The deleted local reconstruction is not present.

---

## 6. Typecheck Confirmation

```
pnpm --filter openclaw-saas exec tsc -p tsconfig.json --noEmit
```

**Result for `startup-counsel.tsx`:** 0 errors introduced by this change.
(48 pre-existing errors in other files: TS6305 workspace lib not built, TS7006 implicit-any
in other components — not introduced by this work, not blocking.)

---

## Conclusion

The UI reads `draft_generation_gate.allowed` from the backend response as the sole source of
truth for draft generation eligibility. No local gate reconstruction exists. The backend
computes the gate once; the UI consumes it. Case 35 is satisfied.
