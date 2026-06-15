"""
aggregate.py
============
Merges all per-session Schema A and Schema B JSON extractions into unified
master files and generates a quality report.

Outputs:
  - schema_a_master.json   — all 862 speaker records
  - schema_b_master.json   — all 926 speaker records
  - schema_a_master.csv    — flat CSV, 19 columns
  - schema_b_master.csv    — flat CSV, 23 columns
  - clinical_data_all.csv  — 1,480 clinical data entries
  - cognitive_dissonance_all.csv — 464 CD hits
  - crispro_opportunities_all.csv — 1,763 CrisPRO opportunities
  - nct_numbers_all.csv    — extracted NCT numbers (verify before use)
  - quality_report.txt     — summary statistics

Usage:
    python aggregate.py \
        --schema-a-dir extractions/schema_a/ \
        --schema-b-dir extractions/schema_b/ \
        --output-dir outputs/
"""

import argparse
import csv
import json
from collections import Counter
from pathlib import Path


# ── Loaders ───────────────────────────────────────────────────────────────────

def load_all(directory: Path) -> list[dict]:
    """Load and merge all JSON files in a directory into a flat list."""
    records = []
    errors = []
    for f in sorted(directory.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, list):
                records.extend(data)
            elif isinstance(data, dict):
                records.append(data)
        except Exception as e:
            errors.append((f.name, str(e)))
    if errors:
        print(f"[warn] {len(errors)} files failed to load:")
        for name, err in errors:
            print(f"  {name}: {err}")
    return records


# ── Schema A CSV ──────────────────────────────────────────────────────────────

def schema_a_to_csv(records: list[dict], out_path: Path):
    rows = []
    for rec in records:
        speaker = rec.get("speaker", {})
        cd_list = rec.get("clinical_data", [])
        row = {
            "talk_id": rec.get("talk_id", ""),
            "session_title": rec.get("session_title", ""),
            "talk_title": rec.get("talk_title", ""),
            "speaker_name": speaker.get("name", ""),
            "affiliation": speaker.get("affiliation", ""),
            "role": speaker.get("role", ""),
            "tumor_types": "; ".join(rec.get("tumor_types", [])),
            "clinical_stage": rec.get("clinical_stage", ""),
            "topic_categories": "; ".join(rec.get("topic_categories", [])),
            "novelty_flag": rec.get("novelty_flag", ""),
            "moa_summary": rec.get("MOA_summary", ""),
            "key_findings": " | ".join(rec.get("key_findings", [])),
            "n_targets": len(rec.get("targets", [])),
            "n_clinical_data": len(cd_list),
            "n_combination_strategies": len(rec.get("combination_strategies", [])),
            "primary_metric": cd_list[0].get("metric", "") if cd_list else "",
            "primary_value": cd_list[0].get("value", "") if cd_list else "",
            "primary_n": cd_list[0].get("n", "") if cd_list else "",
            "primary_population": cd_list[0].get("population", "") if cd_list else "",
        }
        rows.append(row)

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"[ok] {out_path.name}: {len(rows)} rows")


# ── Schema B CSV ──────────────────────────────────────────────────────────────

def schema_b_to_csv(records: list[dict], out_path: Path):
    rows = []
    for rec in records:
        meta = rec.get("talk_metadata", {})
        dma = rec.get("data_maturity_assessment", {})
        vuln = rec.get("vulnerability_identified", [])
        opps = rec.get("crispro_opportunity", [])
        row = {
            "talk_id": rec.get("talk_id", ""),
            "speaker_name": meta.get("speaker_name", ""),
            "institution": meta.get("institution_or_pharma", ""),
            "session_title": meta.get("session_title", ""),
            "talk_title": meta.get("talk_title", ""),
            "presentation_type": meta.get("presentation_type", ""),
            "rhetorical_signals": " | ".join(meta.get("rhetorical_signals", [])),
            "cognitive_dissonance": " | ".join(rec.get("cognitive_dissonance", [])),
            "n_vulnerabilities": len(vuln),
            "vulnerability_type": vuln[0].get("failure_type", "") if vuln else "",
            "failing_target": vuln[0].get("failing_compound_or_target", "") if vuln else "",
            "mechanistic_blindspot": vuln[0].get("mechanistic_blindspot", "") if vuln else "",
            "evidence_strength": vuln[0].get("evidence_strength", "") if vuln else "",
            "n_trial_dilution_risks": len(rec.get("trial_dilution_risk", [])),
            "n_crispro_opportunities": len(opps),
            "crispro_top_type": opps[0].get("opportunity_type", "") if opps else "",
            "crispro_top_priority": opps[0].get("priority", "") if opps else "",
            "crispro_top_description": opps[0].get("description", "") if opps else "",
            "data_maturity": dma.get("overall_maturity", ""),
            "sample_size_adequacy": dma.get("sample_size_adequacy", ""),
            "cited_competitors": "; ".join(c.get("name", "") for c in rec.get("cited_competitors", [])),
            "nct_numbers": "; ".join(rec.get("external_follow_up", {}).get("nct_numbers_to_check", [])),
            "companies_to_monitor": "; ".join(rec.get("external_follow_up", {}).get("companies_to_monitor", [])),
        }
        rows.append(row)

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"[ok] {out_path.name}: {len(rows)} rows")


# ── Specialty tables ──────────────────────────────────────────────────────────

def clinical_data_table(schema_a: list[dict], out_path: Path):
    rows = []
    for rec in schema_a:
        speaker = rec.get("speaker", {})
        for cd in rec.get("clinical_data", []):
            rows.append({
                "talk_id": rec.get("talk_id", ""),
                "speaker_name": speaker.get("name", ""),
                "affiliation": speaker.get("affiliation", ""),
                "session_title": rec.get("session_title", ""),
                "tumor_types": "; ".join(rec.get("tumor_types", [])),
                "clinical_stage": rec.get("clinical_stage", ""),
                "metric": cd.get("metric", ""),
                "value": cd.get("value", ""),
                "confidence_interval": cd.get("confidence_interval", ""),
                "n": cd.get("n", ""),
                "population": cd.get("population", ""),
                "comparator": cd.get("comparator", ""),
                "maturity": cd.get("maturity", ""),
            })
    if rows:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    print(f"[ok] {out_path.name}: {len(rows)} rows")


def cd_table(schema_b: list[dict], out_path: Path):
    rows = []
    for rec in schema_b:
        meta = rec.get("talk_metadata", {})
        for cd in rec.get("cognitive_dissonance", []):
            if cd.strip():
                rows.append({
                    "talk_id": rec.get("talk_id", ""),
                    "speaker_name": meta.get("speaker_name", ""),
                    "institution": meta.get("institution_or_pharma", ""),
                    "session_title": meta.get("session_title", ""),
                    "presentation_type": meta.get("presentation_type", ""),
                    "cognitive_dissonance": cd,
                    "data_maturity": rec.get("data_maturity_assessment", {}).get("overall_maturity", ""),
                    "n_crispro_opps": len(rec.get("crispro_opportunity", [])),
                })
    if rows:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    print(f"[ok] {out_path.name}: {len(rows)} rows")


def crispro_table(schema_b: list[dict], out_path: Path):
    rows = []
    for rec in schema_b:
        meta = rec.get("talk_metadata", {})
        for opp in rec.get("crispro_opportunity", []):
            rows.append({
                "talk_id": rec.get("talk_id", ""),
                "speaker_name": meta.get("speaker_name", ""),
                "institution": meta.get("institution_or_pharma", ""),
                "session_title": meta.get("session_title", ""),
                "opportunity_type": opp.get("opportunity_type", ""),
                "priority": opp.get("priority", ""),
                "description": opp.get("description", ""),
                "transcript_evidence": opp.get("transcript_evidence", ""),
                "crispro_angle": opp.get("crispro_angle", ""),
            })
    if rows:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    print(f"[ok] {out_path.name}: {len(rows)} rows")


def nct_table(schema_b: list[dict], out_path: Path):
    rows = []
    for rec in schema_b:
        meta = rec.get("talk_metadata", {})
        for nct in rec.get("external_follow_up", {}).get("nct_numbers_to_check", []):
            if nct.strip():
                rows.append({
                    "nct": nct.strip(),
                    "speaker": meta.get("speaker_name", ""),
                    "institution": meta.get("institution_or_pharma", ""),
                    "session": meta.get("session_title", ""),
                })
    if rows:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["nct", "speaker", "institution", "session"])
            w.writeheader()
            w.writerows(rows)
    print(f"[ok] {out_path.name}: {len(rows)} rows  ⚠️  verify NCTs before use")


# ── Quality report ────────────────────────────────────────────────────────────

def quality_report(schema_a: list[dict], schema_b: list[dict], out_path: Path):
    stages = Counter(r.get("clinical_stage", "") for r in schema_a)
    novelty = Counter(r.get("novelty_flag", "") for r in schema_a)
    opp_types = Counter(
        opp.get("opportunity_type", "")
        for rec in schema_b
        for opp in rec.get("crispro_opportunity", [])
    )
    priorities = Counter(
        opp.get("priority", "")
        for rec in schema_b
        for opp in rec.get("crispro_opportunity", [])
    )
    cd_count = sum(len(r.get("cognitive_dissonance", [])) for r in schema_b)
    clin_count = sum(len(r.get("clinical_data", [])) for r in schema_a)

    lines = [
        "AACR 2026 Extraction Quality Report",
        "=" * 40,
        f"Schema A records: {len(schema_a)}",
        f"Schema B records: {len(schema_b)}",
        f"Clinical data entries: {clin_count}",
        f"Cognitive dissonance hits: {cd_count}",
        f"CrisPRO opportunities: {sum(opp_types.values())}",
        "",
        "Clinical stage breakdown:",
        *[f"  {s}: {c}" for s, c in stages.most_common()],
        "",
        "Novelty flags:",
        *[f"  {n}: {c}" for n, c in novelty.most_common()],
        "",
        "CrisPRO opportunity types:",
        *[f"  {t}: {c}" for t, c in opp_types.most_common()],
        "",
        "CrisPRO priority breakdown:",
        *[f"  {p}: {c}" for p, c in priorities.most_common()],
        "",
        "NOTE: NCT numbers extracted by LLM — verify against ClinicalTrials.gov",
        "      before downstream use. Round-number suffixes (e.g. NCT04512345)",
        "      are likely hallucinated placeholders.",
    ]

    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[ok] {out_path.name} written")
    print("\n".join(lines))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Aggregate AACR 2026 extractions")
    parser.add_argument("--schema-a-dir", default="extractions/schema_a/")
    parser.add_argument("--schema-b-dir", default="extractions/schema_b/")
    parser.add_argument("--output-dir", default="outputs/")
    args = parser.parse_args()

    a_dir = Path(args.schema_a_dir)
    b_dir = Path(args.schema_b_dir)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    print(f"[load] Schema A from {a_dir} ...")
    schema_a = load_all(a_dir)
    print(f"[load] Schema B from {b_dir} ...")
    schema_b = load_all(b_dir)

    # Master JSONs
    (out / "schema_a_master.json").write_text(
        json.dumps(schema_a, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (out / "schema_b_master.json").write_text(
        json.dumps(schema_b, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"[ok] schema_a_master.json: {len(schema_a)} records")
    print(f"[ok] schema_b_master.json: {len(schema_b)} records")

    # CSVs
    schema_a_to_csv(schema_a, out / "schema_a_master.csv")
    schema_b_to_csv(schema_b, out / "schema_b_master.csv")
    clinical_data_table(schema_a, out / "clinical_data_all.csv")
    cd_table(schema_b, out / "cognitive_dissonance_all.csv")
    crispro_table(schema_b, out / "crispro_opportunities_all.csv")
    nct_table(schema_b, out / "nct_numbers_all.csv")
    quality_report(schema_a, schema_b, out / "quality_report.txt")

    print(f"\n[done] All outputs in {out}/")


if __name__ == "__main__":
    main()
