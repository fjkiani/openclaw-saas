#!/usr/bin/env python3
"""Build the versioned AACR Evidence Explorer ingestion bundle.

This script never treats model extraction or registry existence as abstract linkage.
It re-fetches ClinicalTrials.gov records, stores complete response bodies, and
applies conservative deterministic linkage rules with auditable evidence objects.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RULE_VERSION = "aacr-linkage-v1.0.0"
NCT_RE = re.compile(r"^NCT\d{8}$", re.I)
TOKEN_RE = re.compile(r"[a-z0-9]+")
STOP = {
    "study", "trial", "phase", "patients", "patient", "cancer", "advanced",
    "solid", "tumor", "tumors", "disease", "treatment", "therapy", "with",
    "without", "adult", "adults", "evaluation", "safety", "efficacy", "the",
    "and", "for", "of", "in", "a", "an", "to", "or", "plus", "regimen",
}
GENERIC_INTERVENTIONS = {
    "placebo", "radiotherapy", "chemotherapy", "immunotherapy", "blood sample",
    "quality of life assessment", "computed tomography", "magnetic resonance imaging",
}


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def norm(text: Any) -> str:
    return " ".join(TOKEN_RE.findall(str(text or "").lower()))


def meaningful_terms(text: Any) -> set[str]:
    return {x for x in TOKEN_RE.findall(str(text or "").lower()) if len(x) >= 4 and x not in STOP}


def split_pipe(text: Any) -> list[str]:
    return [x.strip() for x in str(text or "").split("|") if x.strip()]


def nested(obj: dict[str, Any], *keys: str, default: Any = None) -> Any:
    cur: Any = obj
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def registry_fields(study: dict[str, Any]) -> dict[str, Any]:
    protocol = study.get("protocolSection", {})
    ident = protocol.get("identificationModule", {})
    status = protocol.get("statusModule", {})
    sponsor = protocol.get("sponsorCollaboratorsModule", {})
    conditions = protocol.get("conditionsModule", {})
    interventions = protocol.get("armsInterventionsModule", {})
    design = protocol.get("designModule", {})
    return {
        "nct_id": ident.get("nctId"),
        "brief_title": ident.get("briefTitle"),
        "official_title": ident.get("officialTitle"),
        "conditions": conditions.get("conditions", []),
        "interventions": [x.get("name") for x in interventions.get("interventions", []) if x.get("name")],
        "lead_sponsor": nested(sponsor, "leadSponsor", "name"),
        "collaborators": [x.get("name") for x in sponsor.get("collaborators", []) if x.get("name")],
        "phases": design.get("phases", []),
        "overall_status": status.get("overallStatus"),
        "start_date": nested(status, "startDateStruct", "date"),
        "primary_completion_date": nested(status, "primaryCompletionDateStruct", "date"),
    }


def source_excerpt(text: str, needle: str, window: int = 220) -> str:
    if not text:
        return ""
    pos = text.lower().find(needle.lower()) if needle else -1
    if pos < 0:
        return text[: window * 2].strip()
    lo, hi = max(0, pos - window), min(len(text), pos + len(needle) + window)
    return text[lo:hi].strip()


def intervention_matches(names: list[str], source_text: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    source_norm = norm(source_text)
    for name in names:
        n = norm(name)
        if len(n) < 4 or n in GENERIC_INTERVENTIONS:
            continue
        # Exact normalized phrase is intentionally strict. For combinations,
        # test individual alphanumeric drug/device tokens as additional evidence.
        if n in source_norm:
            out.append({"registry_value": name, "matched_value": n, "match_type": "EXACT_NORMALIZED_PHRASE"})
            continue
        pieces = [p for p in n.split() if len(p) >= 5 and p not in STOP]
        unique = [p for p in pieces if any(c.isdigit() for c in p) or "-" in str(name)]
        for p in unique:
            if re.search(rf"\b{re.escape(p)}\b", source_norm):
                out.append({"registry_value": name, "matched_value": p, "match_type": "UNIQUE_IDENTIFIER_TOKEN"})
                break
    return out


def disease_overlap(conditions: list[str], source_text: str) -> dict[str, Any]:
    source_terms = meaningful_terms(source_text)
    cond_terms = meaningful_terms(" ".join(conditions))
    shared = sorted(source_terms & cond_terms)
    # Require at least one reasonably specific disease term. Generic cancer terms
    # are removed by STOP and cannot establish contextual linkage.
    return {"shared_terms": shared, "count": len(shared), "registry_terms": sorted(cond_terms)}


def sponsor_matches(sponsors: list[str], source_text: str) -> list[str]:
    src = norm(source_text)
    return [s for s in sponsors if len(norm(s)) >= 5 and norm(s) in src]


def temporal_plausibility(start_date: str | None, source_year: int = 2026) -> dict[str, Any]:
    if not start_date:
        return {"result": "UNKNOWN", "start_date": None, "source_year": source_year}
    m = re.match(r"(\d{4})", start_date)
    if not m:
        return {"result": "UNKNOWN", "start_date": start_date, "source_year": source_year}
    year = int(m.group(1))
    return {"result": "PASS" if year <= source_year + 1 else "CONTRADICTION", "start_date": start_date, "source_year": source_year}


def classify_linkage(candidate: dict[str, Any], records: list[dict[str, Any]], fields: dict[str, Any] | None) -> dict[str, Any]:
    nct = candidate["normalized_candidate"].upper()
    source_parts: list[str] = []
    source_records: list[dict[str, Any]] = []
    for record in records:
        title = str(record.get("title") or "")
        abstract = str(record.get("abstract") or "")
        text = f"{title}\n{abstract}".strip()
        source_parts.append(text)
        source_records.append({
            "record_id": record.get("id"),
            "doi": record.get("doi"),
            "title": title,
            "source_sha256": sha256_text(canonical_json(record)),
        })
    source_text = "\n\n".join(source_parts)
    direct = bool(re.search(rf"(?<![A-Z0-9]){re.escape(nct)}(?![A-Z0-9])", source_text, re.I))

    if fields is None:
        decision = "NOT_FOUND"
        features: dict[str, Any] = {"direct_nct_token": False}
        excerpt = source_excerpt(source_text, nct)
        contradictions = ["REGISTRY_RECORD_NOT_FOUND"]
    else:
        interventions = intervention_matches(fields["interventions"], source_text)
        diseases = disease_overlap(fields["conditions"], source_text)
        sponsors = sponsor_matches([x for x in [fields.get("lead_sponsor"), *fields.get("collaborators", [])] if x], source_text)
        temporal = temporal_plausibility(fields.get("start_date"))
        features = {
            "direct_nct_token": direct,
            "intervention_matches": interventions,
            "disease_overlap": diseases,
            "sponsor_matches": sponsors,
            "temporal_plausibility": temporal,
        }
        contradictions = []
        if temporal["result"] == "CONTRADICTION":
            contradictions.append("STUDY_STARTS_AFTER_AACR_SOURCE_WINDOW")
        if direct:
            decision = "CONFIRMED_DIRECT_LINK"
        elif interventions and diseases["count"] >= 1 and temporal["result"] != "CONTRADICTION" and (sponsors or len(interventions) >= 2):
            # Contextual promotion requires intervention identity + disease concordance
            # + sponsor or a second distinct intervention. This is deliberately strict.
            decision = "CONFIRMED_CONTEXTUAL_LINK"
        elif not interventions and diseases["count"] == 0 and not sponsors:
            decision = "REAL_NCT_UNLINKED_TO_ABSTRACT"
        else:
            decision = "AMBIGUOUS_REVIEW_REQUIRED"
        needle = nct if direct else (interventions[0]["matched_value"] if interventions else "")
        excerpt = source_excerpt(source_text, needle)

    evidence = {
        "rule_version": RULE_VERSION,
        "candidate_nct_id": nct,
        "source_records": source_records,
        "registry_response_sha256": candidate.get("new_response_sha256") or candidate.get("response_sha256"),
        "features": features,
        "contradictions": contradictions,
        "source_excerpt": excerpt,
        "source_excerpt_sha256": sha256_text(excerpt),
        "decision": decision,
        "permitted_use": "INTERNAL_VALIDATED_SUBSET" if decision in {"CONFIRMED_DIRECT_LINK", "CONFIRMED_CONTEXTUAL_LINK"} else "INTERNAL_FORENSIC_ONLY",
        "human_qc_status": "NOT_STARTED",
    }
    evidence["receipt_id"] = "lnk_" + sha256_text(canonical_json(evidence))[:24]
    return evidence


def fetch_study(nct: str, raw_dir: Path, delay: float = 0.12) -> tuple[int, dict[str, Any] | None, dict[str, Any]]:
    url = f"https://clinicaltrials.gov/api/v2/studies/{urllib.parse.quote(nct)}"
    fetched_at = utcnow()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AACR-Evidence-Explorer/1.0"})
        with urllib.request.urlopen(req, timeout=30) as response:
            status = response.status
            body = response.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = exc.read()
    time.sleep(delay)
    sha = sha256_bytes(body)
    raw_path = raw_dir / f"{nct}_{fetched_at.replace(':', '').replace('-', '')}.json"
    raw_path.write_bytes(body)
    parsed = json.loads(body) if body and status == 200 else None
    meta = {"nct_id": nct, "url": url, "http_status": status, "fetched_at_utc": fetched_at, "response_sha256": sha, "raw_path": str(raw_path)}
    return status, parsed, meta


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(canonical_json(row) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--trial-ledger", type=Path, required=True)
    ap.add_argument("--disposition-ledger", type=Path, required=True)
    ap.add_argument("--conflict-ledger", type=Path, required=True)
    ap.add_argument("--gold-set", type=Path, required=True)
    ap.add_argument("--target-results", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--no-fetch", action="store_true", help="Use prior normalized registry fields only; for tests")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    raw_dir = args.out / "registry_raw" / "clinicaltrials-gov-v2"
    raw_dir.mkdir(parents=True, exist_ok=True)

    corpus = load_jsonl(args.corpus)
    by_id = {r["id"]: r for r in corpus}
    trial_rows = load_csv(args.trial_ledger)
    dispositions = load_csv(args.disposition_ledger)
    conflicts = load_csv(args.conflict_ledger)
    gold = load_csv(args.gold_set)
    targets = load_csv(args.target_results)

    registry_meta: list[dict[str, Any]] = []
    linkage_rows: list[dict[str, Any]] = []
    studies: list[dict[str, Any]] = []
    for i, row in enumerate(trial_rows, start=1):
        nct = row["normalized_candidate"].upper()
        source_ids = split_pipe(row.get("source_record_id"))
        source_records = [by_id[x] for x in source_ids if x in by_id]
        fields: dict[str, Any] | None = None
        prior_status = str(row.get("api_http_status") or "")
        status = int(prior_status) if prior_status.isdigit() else 0
        if NCT_RE.fullmatch(nct) and nct not in {"NCT00000000", "NCT12345678"}:
            if args.no_fetch:
                if status == 200:
                    fields = {
                        "nct_id": row.get("registry_nct_id"), "brief_title": row.get("registry_title"), "official_title": None,
                        "conditions": split_pipe(row.get("registry_conditions")), "interventions": split_pipe(row.get("registry_interventions")),
                        "lead_sponsor": row.get("registry_sponsor"), "collaborators": [], "phases": split_pipe(row.get("registry_phase")),
                        "overall_status": row.get("registry_status"), "start_date": None, "primary_completion_date": None,
                    }
            else:
                status, body, meta = fetch_study(nct, raw_dir)
                registry_meta.append(meta)
                row["new_response_sha256"] = meta["response_sha256"]
                if status == 200 and body:
                    fields = registry_fields(body)
                    studies.append({"registry": fields, "raw_response": body, "receipt": meta})
        candidate = dict(row)
        candidate["api_http_status_v2"] = status
        source_linkages: list[dict[str, Any]] = []
        if nct in {"NCT00000000", "NCT12345678"}:
            evidence = {
                "rule_version": RULE_VERSION, "candidate_nct_id": nct, "source_records": source_ids,
                "registry_response_sha256": None, "features": {}, "contradictions": ["MALFORMED_PLACEHOLDER"],
                "source_excerpt": "", "source_excerpt_sha256": sha256_text(""), "decision": "NOT_FOUND",
                "permitted_use": "INTERNAL_FORENSIC_ONLY", "human_qc_status": "NOT_STARTED",
            }
            evidence["receipt_id"] = "lnk_" + sha256_text(canonical_json(evidence))[:24]
        elif fields is None and status not in (404, 0):
            # A transient registry failure cannot be called NOT_FOUND.
            evidence = {
                "rule_version": RULE_VERSION, "candidate_nct_id": nct, "source_records": source_ids,
                "registry_response_sha256": candidate.get("new_response_sha256"), "features": {},
                "contradictions": ["REGISTRY_UNAVAILABLE"], "source_excerpt": "", "source_excerpt_sha256": sha256_text(""),
                "decision": "AMBIGUOUS_REVIEW_REQUIRED", "permitted_use": "INTERNAL_FORENSIC_ONLY", "human_qc_status": "NOT_STARTED",
            }
            evidence["receipt_id"] = "lnk_" + sha256_text(canonical_json(evidence))[:24]
        elif source_records:
            # Classify each abstract–study pair independently. Never allow evidence
            # in one source abstract to confirm a second abstract that shared a candidate.
            for source_record in source_records:
                pair_evidence = classify_linkage(candidate, [source_record], fields)
                source_linkages.append(pair_evidence)
            priority = {
                "CONFIRMED_DIRECT_LINK": 5, "CONFIRMED_CONTEXTUAL_LINK": 4,
                "AMBIGUOUS_REVIEW_REQUIRED": 3, "REAL_NCT_UNLINKED_TO_ABSTRACT": 2, "NOT_FOUND": 1,
            }
            aggregate_decision = max((x["decision"] for x in source_linkages), key=lambda x: priority[x])
            evidence = {
                "rule_version": RULE_VERSION, "candidate_nct_id": nct,
                "source_records": [x["source_records"][0] for x in source_linkages],
                "registry_response_sha256": candidate.get("new_response_sha256") or candidate.get("response_sha256"),
                "features": {"pair_receipts": [x["receipt_id"] for x in source_linkages]}, "contradictions": [],
                "source_excerpt": "", "source_excerpt_sha256": sha256_text(""), "decision": aggregate_decision,
                "permitted_use": "INTERNAL_VALIDATED_SUBSET" if aggregate_decision in {"CONFIRMED_DIRECT_LINK", "CONFIRMED_CONTEXTUAL_LINK"} else "INTERNAL_FORENSIC_ONLY",
                "human_qc_status": "NOT_STARTED",
            }
            evidence["receipt_id"] = "lnk_" + sha256_text(canonical_json(evidence))[:24]
        else:
            evidence = {
                "rule_version": RULE_VERSION, "candidate_nct_id": nct, "source_records": [],
                "registry_response_sha256": candidate.get("new_response_sha256") or candidate.get("response_sha256"),
                "features": {}, "contradictions": ["SOURCE_RECORD_NOT_RESOLVED"], "source_excerpt": "",
                "source_excerpt_sha256": sha256_text(""), "decision": "AMBIGUOUS_REVIEW_REQUIRED",
                "permitted_use": "INTERNAL_FORENSIC_ONLY", "human_qc_status": "NOT_STARTED",
            }
            evidence["receipt_id"] = "lnk_" + sha256_text(canonical_json(evidence))[:24]
        linkage_rows.append({"candidate": candidate, "registry": fields, "linkage_evidence": evidence, "source_linkages": source_linkages})
        if i % 25 == 0:
            print(f"processed {i}/{len(trial_rows)}")

    target_rows: list[dict[str, Any]] = []
    for row in targets:
        facts = {
            "nct_id": row.get("nct_id"), "title": row.get("title"), "conditions": split_pipe(row.get("conditions")),
            "interventions": split_pipe(row.get("interventions")), "sponsor": row.get("sponsor"), "phase": split_pipe(row.get("phase")),
            "status": row.get("status"),
        }
        fact_receipt = "reg_" + sha256_text(canonical_json(facts))[:24]
        target_rows.append({
            "target_query": row.get("target"), "registry_facts": facts, "registry_fact_receipt_id": fact_receipt,
            "registry_fact_state": "VERIFIED_REGISTRY_FACT",
            "target_association_state": "QUERY_RETRIEVAL_ONLY_LINKAGE_UNVERIFIED",
            "aacr_abstract_linkage_state": "LINKAGE_UNVERIFIED",
            "query_protocol": row.get("query_protocol"), "search_timestamp_utc": row.get("search_timestamp_utc"),
            "permitted_use": "INTERNAL_FORENSIC_ONLY",
        })

    cohort_counts: dict[str, dict[str, int]] = {}
    for old_state in sorted({x["candidate"].get("final_classification", "UNKNOWN") for x in linkage_rows}):
        cohort_counts[old_state] = dict(Counter(
            x["linkage_evidence"]["decision"] for x in linkage_rows
            if x["candidate"].get("final_classification", "UNKNOWN") == old_state
        ))
    pair_counts = dict(Counter(
        ev["decision"] for row in linkage_rows for ev in row.get("source_linkages", [])
    ))
    bundle_manifest = {
        "bundle_version": "aacr-evidence-v1", "created_at_utc": utcnow(), "rule_version": RULE_VERSION,
        "inputs": {str(p): sha256_bytes(p.read_bytes()) for p in [args.corpus, args.trial_ledger, args.disposition_ledger, args.conflict_ledger, args.gold_set, args.target_results]},
        "counts": {
            "abstracts": len(corpus), "trial_candidates": len(trial_rows), "registry_responses": len(registry_meta),
            "candidate_linkage_states": dict(Counter(x["linkage_evidence"]["decision"] for x in linkage_rows)),
            "abstract_study_pair_linkage_states": pair_counts,
            "linkage_states_by_prior_cohort": cohort_counts,
            "dispositions": len(dispositions), "conflicts": len(conflicts), "gold_set": len(gold), "target_search_results": len(target_rows),
        },
        "scientific_boundary": "Registry existence verifies registry fields only; target and AACR abstract linkage require separate receipts.",
    }
    write_jsonl(args.out / "abstracts.jsonl", corpus)
    write_jsonl(args.out / "registry_studies.jsonl", studies)
    write_jsonl(args.out / "trial_linkages.jsonl", linkage_rows)
    write_jsonl(args.out / "target_search_results.jsonl", target_rows)
    write_jsonl(args.out / "record_dispositions.jsonl", dispositions)
    write_jsonl(args.out / "conflicts.jsonl", conflicts)
    write_jsonl(args.out / "review_seed.jsonl", gold)
    write_jsonl(args.out / "registry_response_index_v2.jsonl", registry_meta)
    manifest_text = canonical_json(bundle_manifest)
    bundle_manifest["manifest_sha256"] = sha256_text(manifest_text)
    (args.out / "manifest.json").write_text(json.dumps(bundle_manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(bundle_manifest, indent=2))


if __name__ == "__main__":
    main()
