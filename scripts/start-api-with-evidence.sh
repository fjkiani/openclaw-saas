#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${EVIDENCE_BUNDLE_ARCHIVE:-artifacts/evidence-seed/aacr-evidence-v1-8f2e0c155651.tar.gz}"
EXPECTED_ARCHIVE_SHA256="788c2624460360f2dbf5d8e2232be020cec488b674260e9ff7afca0db4949230"
SEED_DIR="${EVIDENCE_SEED_DIR:-/tmp/aacr-evidence-v1}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Evidence bundle archive not found: $ARCHIVE" >&2
  exit 1
fi
actual_sha256="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
if [[ "$actual_sha256" != "$EXPECTED_ARCHIVE_SHA256" ]]; then
  echo "Evidence bundle archive checksum mismatch" >&2
  exit 1
fi

node scripts/apply-aacr-evidence-migration.mjs
rm -rf "$SEED_DIR"
mkdir -p "$SEED_DIR"
tar -xzf "$ARCHIVE" -C "$SEED_DIR"
node scripts/import-aacr-evidence.mjs "$SEED_DIR"
exec node artifacts/api-server/dist/index.mjs
