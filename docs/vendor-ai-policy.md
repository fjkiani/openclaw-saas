# OpenClaw AI Vendor Policy

**Version:** 1.0.0  
**Effective date:** 2025-01-01  
**Owner:** Legal + Security + Privacy  
**Review cycle:** Annual, or within 30 days of any material vendor change

---

## Purpose

This policy governs the use of third-party AI inference providers in the OpenClaw
platform. It establishes minimum contractual, operational, and technical requirements
that any AI vendor must satisfy before customer contract text is transmitted to their
infrastructure.

Customer contract text is sensitive legal material. Its unauthorized use, retention,
or disclosure creates direct legal and reputational risk. This policy is not advisory —
it is a procurement gate. No AI vendor may be added to the model chain without
satisfying all requirements in this document.

---

## Scope

Applies to all external AI inference providers used in:
- `POST /v1/legal/draft/analyze` (LLM extraction lane)
- Any future AI-assisted pipeline that processes customer-uploaded document text

Does **not** apply to Lane B (document coverage review), which is deterministic
regex-only and transmits no data to external providers.

---

## 1. No Training Use

**Requirement:** The vendor contract must include an explicit, unconditional prohibition
on using customer data — including inference inputs, outputs, and metadata — for:
- Model training
- Fine-tuning
- Reinforcement learning from human feedback (RLHF)
- Benchmark evaluation
- Any other model improvement purpose

**Acceptable evidence:** Zero-data-retention (ZDR) API tier enrollment, or a signed
Data Processing Agreement (DPA) with explicit training prohibition clause.

**Current providers:**
- Groq: ZDR available via enterprise agreement — required before production use
- OpenRouter: DPA with training prohibition required — verify per-model subprocessor chain

---

## 2. Retention and Deletion Controls

**Requirement:** Vendor must:
- Delete inference inputs (prompt + completion) within **30 days** of the request, or
  on customer deletion request, whichever is sooner
- Provide a documented deletion mechanism (API endpoint or support ticket SLA ≤ 5 days)
- Not retain inference inputs in backup systems beyond the deletion window

**Preferred:** Zero-retention endpoints where inference inputs are never persisted
beyond the duration of the API call.

**Prohibited:** Any vendor that retains inference inputs indefinitely or uses them
for operational analytics without explicit opt-out.

---

## 3. Audit Logging

**Requirement:** Every model call from the OpenClaw platform must be logged with:

| Field | Value |
|---|---|
| `timestamp` | ISO 8601 UTC |
| `analysis_id` | UUID from the analyze request |
| `model_id` | Exact model identifier used |
| `provider` | Vendor name |
| `doc_class` | Document class (e.g. `co_founder_agreement`) |
| `source_hash` | SHA-256 of contract text (first 16 hex chars) |
| `latency_ms` | Round-trip latency |
| `fallback_used` | Boolean — whether a fallback model was used |
| `vendor_policy_version` | Version of this policy document |

**Prohibited from logs:**
- Contract text (source text)
- Extracted intake fields containing PII
- Party names or identifying information

Logs are retained for **90 days** and accessible to the security team on request.

---

## 4. Subprocessor Disclosure

**Requirement:** Vendor must:
- Maintain a public or contractually accessible subprocessor list
- Provide **30 days advance notice** of any new subprocessor that will touch inference data
- Allow OpenClaw to object to new subprocessors within the notice period

**Rationale:** Inference data may pass through GPU cloud providers, CDN layers, or
inference optimization services operated by parties other than the named vendor.
Each subprocessor in the chain must meet equivalent data protection standards.

---

## 5. AI-Specific Vendor Review

**Requirement:** Before any new AI vendor is added to the model chain, the following
sign-offs are required:

| Reviewer | Scope |
|---|---|
| Legal | DPA review, training prohibition, jurisdiction compliance |
| Security | Technical controls (see Appendix A), penetration test results |
| Privacy | Data minimization, retention controls, subprocessor chain |

**Process:**
1. Vendor submits DPA, security documentation, and subprocessor list
2. Security completes technical controls checklist (Appendix A)
3. Legal reviews DPA and confirms training prohibition
4. Privacy reviews retention and subprocessor chain
5. All three sign off in the vendor review record (committed to this repo under `docs/vendor-reviews/`)
6. Vendor is added to the approved provider allowlist

**Timeline:** Review must complete before any production traffic is routed to the vendor.
Staging/test traffic with synthetic data is permitted during review.

---

## 6. Right to Terminate or Restrict

**Requirement:** The vendor contract must include:
- Right to terminate the agreement within **30 days** written notice if vendor controls
  are found to be inadequate or non-compliant with this policy
- Right to immediately suspend data transmission (without penalty) pending investigation
  of a suspected breach or policy violation
- Vendor obligation to notify OpenClaw within **72 hours** of any security incident
  affecting customer data

---

## Appendix A — Technical Controls Checklist

This checklist must be completed by the Security team for each vendor review.
All items must be confirmed before sign-off.

### A.1 Encryption in Transit

- [ ] All API endpoints use TLS 1.2 or higher (TLS 1.3 preferred)
- [ ] Certificate pinning or HSTS enforced on vendor API endpoints
- [ ] No plaintext fallback permitted
- [ ] Vendor provides TLS configuration documentation or third-party audit

### A.2 Encryption at Rest

- [ ] Inference inputs (if retained at all) are encrypted at rest using AES-256 or equivalent
- [ ] Encryption keys are managed by the vendor's key management service (not shared with subprocessors)
- [ ] Key rotation policy documented (annual minimum)

### A.3 Access Control and Least Privilege

- [ ] API keys are scoped to inference only — no admin, billing, or data export permissions
- [ ] API keys are stored in the platform secret manager (not in environment variables in source code)
- [ ] Vendor access to customer data is restricted to inference pipeline personnel only
- [ ] Vendor provides role-based access control (RBAC) documentation

### A.4 Secret Rotation

- [ ] OpenClaw API keys are rotated at least every **90 days**
- [ ] Rotation is automated or has a documented manual procedure with SLA
- [ ] Compromised keys can be revoked within **1 hour**
- [ ] Key rotation does not require downtime

### A.5 Environment Isolation

- [ ] Customer inference requests are isolated from other customers' data at the inference layer
- [ ] No cross-tenant data leakage is possible in the model serving infrastructure
- [ ] Vendor provides multi-tenancy isolation documentation or SOC 2 Type II report

### A.6 Provider Allowlist

The following providers are approved for use in the OpenClaw model chain.
Any provider not on this list requires a full vendor review before use.

| Provider | Tier | ZDR Available | DPA Signed | Last Reviewed |
|---|---|---|---|---|
| Groq | Primary | Yes (enterprise) | Pending | — |
| OpenRouter | Fallback | Partial | Pending | — |

**Adding a provider:** Submit a PR to this file with the new provider row and attach
the completed vendor review record. PR requires Legal + Security + Privacy approval.

**Removing a provider:** Update this table and rotate any API keys associated with
the removed provider within 24 hours.

### A.7 Source Text Handling

- [ ] Contract text (source text) is **never written to application logs**
- [ ] Only the SHA-256 hash of the source text is logged (first 16 hex characters)
- [ ] Source text is transmitted to the vendor API over TLS only
- [ ] Source text is not stored in the OpenClaw database — only the hash and analysis results
- [ ] Audit log entries are reviewed quarterly to confirm no source text leakage

---

## Enforcement

Violations of this policy by a vendor trigger immediate suspension of data transmission
and escalation to Legal. Violations by OpenClaw personnel (e.g. adding an unapproved
vendor to the model chain) are treated as a security incident.

Questions or exceptions: contact the Security team.
