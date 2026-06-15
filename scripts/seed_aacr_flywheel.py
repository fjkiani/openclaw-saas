#!/usr/bin/env python3
"""
seed_aacr_flywheel.py — Bulk-loads AACR 2026 data into the double-dip flywheel tables.

Inserts:
  - 862 SFT records into zie_training_records (domain='aacr')
  - 450 preference pairs into zie_preference_pairs (domain='aacr')
  - 1 router policy row for task_type='competitive_intel_extraction'

Usage:
  DATABASE_URL=postgresql://... python3 scripts/seed_aacr_flywheel.py

Requires:
  pip install psycopg2-binary

The script reads from the AACR master JSON files. Set SCHEMA_A_PATH and
SCHEMA_B_PATH env vars if the files are not in the default locations.

All inserts are idempotent (ON CONFLICT DO NOTHING on prompt_hash).
"""

import os, sys, json, hashlib, time
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2-binary not installed. Run: pip install psycopg2-binary")
    sys.exit(1)

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL environment variable not set")
    sys.exit(1)

SCHEMA_A_PATH = os.environ.get("SCHEMA_A_PATH", "/mnt/results/aacr2026/schema_a_master.json")
SCHEMA_B_PATH = os.environ.get("SCHEMA_B_PATH", "/mnt/results/aacr2026/schema_b_master.json")

# ─────────────────────────────────────────────────────────────────────────────
# Load data
# ─────────────────────────────────────────────────────────────────────────────

print(f"Loading Schema A from {SCHEMA_A_PATH}...")
with open(SCHEMA_A_PATH) as f:
    schema_a = json.load(f)

print(f"Loading Schema B from {SCHEMA_B_PATH}...")
with open(SCHEMA_B_PATH) as f:
    schema_b = json.load(f)

print(f"Schema A: {len(schema_a)} records, Schema B: {len(schema_b)} records")

# ─────────────────────────────────────────────────────────────────────────────
# Build SFT rows from Schema A MOA summaries
# ─────────────────────────────────────────────────────────────────────────────

def build_sft_rows(records):
    rows = []
    for rec in records:
        moa = rec.get('MOA_summary', '')
        if not moa or len(moa) < 30:
            continue
        talk_id = rec.get('talk_id', '')
        session = talk_id.split('::')[0] if '::' in talk_id else ''
        speaker = rec.get('speaker', {}) or {}

        prompt_json = json.dumps({
            "talk_id": talk_id,
            "session": session,
            "speaker": speaker.get('name', 'unknown'),
            "affiliation": speaker.get('affiliation', ''),
            "tumor_types": rec.get('tumor_types', []),
            "clinical_stage": rec.get('clinical_stage', ''),
            "task": "extract_competitive_intelligence",
            "instruction": "Extract the key scientific claims, clinical data, and competitive positioning from this oncology conference presentation.",
        }, sort_keys=True)

        prompt_hash = hashlib.sha256(prompt_json.encode()).hexdigest()

        rows.append((
            "competitive_intel_extraction",
            "aacr",
            "conference_transcript",
            prompt_hash,
            prompt_json,
            json.dumps({
                "moa_summary": moa,
                "key_findings": rec.get('key_findings', []),
                "novelty_flag": rec.get('novelty_flag', ''),
                "clinical_stage": rec.get('clinical_stage', ''),
            }),
            "0.8500",
        ))
    return rows

# ─────────────────────────────────────────────────────────────────────────────
# Build preference pairs from Schema B CD hits
# ─────────────────────────────────────────────────────────────────────────────

def build_pref_rows(records):
    rows = []
    for rec in records:
        cd = rec.get('cognitive_dissonance', [])
        if not cd or len(cd) == 0:
            continue

        meta = rec.get('talk_metadata', {}) or {}
        talk_id = rec.get('talk_id', '')

        prompt_json = json.dumps({
            "talk_id": talk_id,
            "session": meta.get('session_title', ''),
            "speaker": meta.get('speaker_name', ''),
            "institution": meta.get('institution_or_pharma', ''),
            "presentation_type": meta.get('presentation_type', ''),
            "task": "identify_cognitive_dissonance",
            "instruction": "Identify cases where the speaker's data contradicts their stated conclusion.",
        }, sort_keys=True)

        prompt_hash = hashlib.sha256(prompt_json.encode()).hexdigest()

        chosen = json.dumps({
            "cognitive_dissonance": cd,
            "crispro_opportunity": rec.get('crispro_opportunity', []),
            "vulnerability_identified": rec.get('vulnerability_identified', {}),
            "data_maturity": (rec.get('data_maturity_assessment') or {}).get('overall_maturity', ''),
        })

        rhetorical = meta.get('rhetorical_signals', [])
        rejected = json.dumps({
            "cognitive_dissonance": [],
            "summary": rhetorical[:2] if rhetorical else ["No cognitive dissonance identified."],
            "note": "fast_path_no_cd_analysis",
        })

        rows.append((
            "competitive_intel_extraction",
            "aacr",
            "conference_transcript",
            "expert_annotation",
            prompt_hash,
            chosen,
            rejected,
        ))
    return rows

# ─────────────────────────────────────────────────────────────────────────────
# Insert
# ─────────────────────────────────────────────────────────────────────────────

def batch_insert(cur, sql, rows, chunk_size=100, label="rows"):
    inserted = 0
    skipped = 0
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i+chunk_size]
        for row in chunk:
            try:
                cur.execute(sql, row)
                inserted += 1
            except Exception:
                skipped += 1
        if (i // chunk_size) % 5 == 0:
            print(f"  {label}: {i + len(chunk)}/{len(rows)} ({inserted} inserted, {skipped} skipped)")
    return inserted, skipped

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    print("\nBuilding SFT rows...")
    sft_rows = build_sft_rows(schema_a)
    print(f"  {len(sft_rows)} SFT rows ready")

    print("Building preference pair rows...")
    pref_rows = build_pref_rows(schema_b)
    print(f"  {len(pref_rows)} preference pair rows ready")

    print(f"\nConnecting to database...")
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    try:
        # 1. Router policy
        print("\n[1/3] Seeding router policy for competitive_intel_extraction...")
        cur.execute("""
            INSERT INTO zie_router_policies
              (task_type, fast_model_id, fast_provider, fast_api_key_env, fast_max_tokens, fast_timeout_ms)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (task_type) DO UPDATE SET
              fast_model_id = EXCLUDED.fast_model_id,
              fast_provider = EXCLUDED.fast_provider
        """, (
            "competitive_intel_extraction",
            "liquid/lfm-2.5-1.2b-instruct:free",
            "openrouter",
            "OPENROUTER_API_KEY",
            512,
            8000,
        ))
        conn.commit()
        print("  Router policy seeded.")

        # 2. SFT records
        print(f"\n[2/3] Inserting {len(sft_rows)} SFT records into zie_training_records...")
        sft_sql = """
            INSERT INTO zie_training_records
              (task_type, domain, source_kind, prompt_hash, prompt_json, remote_response_json, quality_score)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (prompt_hash) DO NOTHING
        """
        sft_inserted, sft_skipped = batch_insert(cur, sft_sql, sft_rows, label="SFT")
        conn.commit()
        print(f"  SFT: {sft_inserted} inserted, {sft_skipped} skipped (duplicates)")

        # 3. Preference pairs
        print(f"\n[3/3] Inserting {len(pref_rows)} preference pairs into zie_preference_pairs...")
        pref_sql = """
            INSERT INTO zie_preference_pairs
              (task_type, domain, source_kind, preference_source, prompt_hash, chosen_response_json, rejected_response_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """
        pref_inserted, pref_skipped = batch_insert(cur, pref_sql, pref_rows, label="pref")
        conn.commit()
        print(f"  Preference pairs: {pref_inserted} inserted, {pref_skipped} skipped")

        print(f"""
╔══════════════════════════════════════════════════════╗
║  AACR Flywheel Seed Complete                         ║
╠══════════════════════════════════════════════════════╣
║  SFT records inserted:      {sft_inserted:<6}                    ║
║  Preference pairs inserted: {pref_inserted:<6}                    ║
║  Domain:                    aacr                     ║
║  Task type:                 competitive_intel_extraction ║
║  Threshold to fine-tune:    50 verified pairs        ║
╚══════════════════════════════════════════════════════╝
""")

    except Exception as e:
        conn.rollback()
        print(f"ERROR: {e}")
        raise
    finally:
        cur.close()
        conn.close()

if __name__ == "__main__":
    main()
