"""
vimeo_vtt_pipeline.py
=====================
Downloads VTT captions from Vimeo-embedded session recordings and converts
them to clean plain-text transcripts.

Pipeline:
  1. Fetch the Swapcard session page to extract the Vimeo embed URL
  2. Hit the Vimeo player config endpoint to get a signed VTT URL
  3. Download and parse the VTT file
  4. Clean: deduplicate lines, strip timestamps, normalize whitespace

Key discoveries:
  - Vimeo player config endpoint:
      https://player.vimeo.com/video/{video_id}/config?h={h_hash}
  - VTT URLs are signed and expire ~24h after generation
  - Some sessions have multiple language tracks — always pick 'en'
  - Sessions without captions return an empty `textTracks` array

Usage:
    python vimeo_vtt_pipeline.py \
        --sessions sessions.csv \
        --auth auth.json \
        --output-dir transcripts/
"""

import argparse
import csv
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import requests


# ── Vimeo config endpoint ─────────────────────────────────────────────────────

VIMEO_CONFIG_URL = "https://player.vimeo.com/video/{video_id}/config"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://connect.aacr26.org/",
}


# ── Vimeo embed extraction ────────────────────────────────────────────────────

def extract_vimeo_embed(session_page_html: str) -> tuple[str, str] | None:
    """
    Extract (video_id, h_hash) from a Swapcard session page HTML.

    Vimeo embeds appear as:
        https://player.vimeo.com/video/123456789?h=abcdef1234&...
    """
    pattern = r'player\.vimeo\.com/video/(\d+)\?h=([a-f0-9]+)'
    match = re.search(pattern, session_page_html)
    if match:
        return match.group(1), match.group(2)

    # Fallback: look for data-vimeo-id attributes
    pattern2 = r'data-vimeo-id=["\'](\d+)["\']'
    match2 = re.search(pattern2, session_page_html)
    if match2:
        return match2.group(1), None

    return None


def fetch_session_page(slug: str, cookies: dict) -> str:
    """Fetch the Swapcard session page HTML."""
    url = f"https://connect.aacr26.org/aacr2026/session/{slug}"
    resp = requests.get(url, cookies=cookies, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


# ── Vimeo player config ───────────────────────────────────────────────────────

def fetch_vimeo_config(video_id: str, h_hash: str | None = None) -> dict:
    """
    Fetch the Vimeo player config JSON for a given video_id.

    Returns the full config dict including textTracks.
    """
    url = VIMEO_CONFIG_URL.format(video_id=video_id)
    params = {}
    if h_hash:
        params["h"] = h_hash

    resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def extract_vtt_url(config: dict, lang: str = "en") -> str | None:
    """
    Extract the signed VTT URL from a Vimeo player config.

    Prefers the specified language; falls back to the first available track.
    """
    tracks = (
        config.get("request", {})
        .get("text_tracks", [])
    )

    if not tracks:
        return None

    # Prefer English
    for track in tracks:
        if track.get("lang", "").startswith(lang):
            return "https://captions.vimeo.com" + track["url"]

    # Fallback to first track
    return "https://captions.vimeo.com" + tracks[0]["url"]


# ── VTT parsing ───────────────────────────────────────────────────────────────

def download_vtt(vtt_url: str) -> str:
    """Download a VTT file and return its raw text."""
    resp = requests.get(vtt_url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def parse_vtt(vtt_text: str) -> list[str]:
    """
    Parse a WebVTT file and return a list of caption lines (no timestamps).

    Deduplicates consecutive identical lines (common in auto-captions).
    """
    lines = []
    seen_last = None

    for line in vtt_text.splitlines():
        line = line.strip()

        # Skip WebVTT header, timestamps, and empty lines
        if not line:
            continue
        if line.startswith("WEBVTT"):
            continue
        if re.match(r'^\d{2}:\d{2}', line):  # timestamp line
            continue
        if re.match(r'^\d+$', line):  # cue number
            continue
        if line.startswith("NOTE") or line.startswith("STYLE"):
            continue

        # Strip HTML tags (e.g., <c>, <b>, speaker tags)
        line = re.sub(r'<[^>]+>', '', line).strip()
        if not line:
            continue

        # Deduplicate consecutive identical lines
        if line != seen_last:
            lines.append(line)
            seen_last = line

    return lines


def clean_transcript(lines: list[str]) -> str:
    """
    Join caption lines into a clean transcript string.

    Merges lines that are clearly continuations (no sentence-ending punctuation
    at the end of the previous line).
    """
    if not lines:
        return ""

    paragraphs = []
    current = []

    for line in lines:
        current.append(line)
        # Start a new paragraph after sentence-ending punctuation
        if line.endswith(('.', '?', '!')):
            paragraphs.append(' '.join(current))
            current = []

    if current:
        paragraphs.append(' '.join(current))

    return '\n'.join(paragraphs)


# ── Full pipeline ─────────────────────────────────────────────────────────────

def process_session(slug: str, cookies: dict, output_dir: Path) -> bool:
    """
    Full pipeline for one session: fetch page → extract embed → download VTT
    → clean → save transcript.

    Returns True on success, False on failure.
    """
    out_file = output_dir / f"{slug}.txt"
    if out_file.exists():
        print(f"[skip] {slug} — transcript already exists")
        return True

    try:
        # 1. Fetch session page
        html = fetch_session_page(slug, cookies)

        # 2. Extract Vimeo embed
        embed = extract_vimeo_embed(html)
        if not embed:
            print(f"[warn] {slug} — no Vimeo embed found")
            return False
        video_id, h_hash = embed

        # 3. Fetch player config
        config = fetch_vimeo_config(video_id, h_hash)

        # 4. Extract VTT URL
        vtt_url = extract_vtt_url(config)
        if not vtt_url:
            print(f"[warn] {slug} — no text tracks in Vimeo config")
            return False

        # 5. Download and parse VTT
        vtt_text = download_vtt(vtt_url)
        lines = parse_vtt(vtt_text)

        if len(lines) < 10:
            print(f"[warn] {slug} — very short transcript ({len(lines)} lines)")

        # 6. Clean and save
        transcript = clean_transcript(lines)
        out_file.write_text(transcript, encoding="utf-8")
        print(f"[ok] {slug} — {len(transcript):,} chars saved")
        return True

    except Exception as e:
        print(f"[error] {slug} — {e}")
        return False


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Vimeo VTT pipeline for AACR 2026")
    parser.add_argument("--sessions", default="sessions.csv",
                        help="CSV with session slugs (from swapcard_session_crawler.py)")
    parser.add_argument("--auth", default="auth.json",
                        help="Auth cookies JSON (from swapcard_session_crawler.py)")
    parser.add_argument("--output-dir", default="transcripts/")
    parser.add_argument("--sleep", type=float, default=1.0,
                        help="Seconds to sleep between sessions")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load auth cookies
    auth_state = json.loads(Path(args.auth).read_text())
    cookies = {c["name"]: c["value"] for c in auth_state["cookies"]}

    # Load sessions
    with open(args.sessions) as f:
        sessions = list(csv.DictReader(f))

    print(f"[main] Processing {len(sessions)} sessions → {output_dir}")

    ok, fail = 0, 0
    for i, session in enumerate(sessions, 1):
        slug = session.get("slug", "")
        if not slug:
            continue
        print(f"[{i}/{len(sessions)}] {slug}")
        if process_session(slug, cookies, output_dir):
            ok += 1
        else:
            fail += 1
        time.sleep(args.sleep)

    print(f"\n[done] {ok} succeeded, {fail} failed")


if __name__ == "__main__":
    main()
