"""
swapcard_session_crawler.py
===========================
Authenticates to a Swapcard-powered event portal (AACR 2026: connect.aacr26.org)
using Playwright, then enumerates all sessions via the GraphQL API using Apollo
Persisted Queries (APQ).

Key discoveries:
  - FullStory cookie `_fs_cd_cp_pRdRgnTnF68pCV2F` causes GraphQL to return HTML
    instead of JSON — must be stripped from all GraphQL requests.
  - Login modal renders in a React portal after JS hydration (~2s delay).
  - Cookie banner must be dismissed before the login button is clickable.
  - APQ hash for AACR 2026 session list:
      24b2095fe6b1d0c26e88eb28b19cca633e423a77c135a3da52798bb6935c1340
  - Event ID (base64): RXZlbnRfNDMzMDk2Nw== → Event_4330967

Usage:
    python swapcard_session_crawler.py \
        --email your@email.com \
        --password yourpassword \
        --output sessions.csv
"""

import argparse
import csv
import json
import re
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# ── Constants ────────────────────────────────────────────────────────────────
BASE_URL = "https://connect.aacr26.org"
GRAPHQL_URL = f"{BASE_URL}/api/graphql"
EVENT_SLUG = "aacr2026"
EVENT_ID_B64 = "RXZlbnRfNDMzMDk2Nw=="  # Event_4330967

# Apollo Persisted Query hash for the session list query
APQ_HASH = "24b2095fe6b1d0c26e88eb28b19cca633e423a77c135a3da52798bb6935c1340"

# Cookie that breaks GraphQL — must be stripped
FULLSTORY_COOKIE = "_fs_cd_cp_pRdRgnTnF68pCV2F"

# Selectors
COOKIE_BANNER_BTN = '[data-hook="cookie-banner-accept-all-button"]'
LOGIN_BTN = 'button[data-hook="login-top"]'
EMAIL_INPUT = 'input[type="email"]'
PASSWORD_INPUT = 'input[type="password"]'
SUBMIT_BTN = 'button[type="submit"]'

AUTH_FILE = Path("auth.json")


# ── Authentication ────────────────────────────────────────────────────────────

def authenticate(email: str, password: str) -> dict:
    """
    Launches a headed Playwright browser, logs in to the Swapcard portal,
    and returns the session cookies as a dict.

    The auth state is also saved to auth.json for reuse.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        print(f"[auth] Navigating to {BASE_URL} ...")
        page.goto(BASE_URL, wait_until="networkidle")

        # Dismiss cookie banner if present
        try:
            page.wait_for_selector(COOKIE_BANNER_BTN, timeout=5000)
            page.click(COOKIE_BANNER_BTN)
            print("[auth] Cookie banner dismissed")
        except Exception:
            print("[auth] No cookie banner found")

        # Click login button
        page.wait_for_selector(LOGIN_BTN, timeout=10000)
        page.click(LOGIN_BTN)

        # Wait for React portal to hydrate (~2s)
        time.sleep(2)

        # Fill credentials
        page.wait_for_selector(EMAIL_INPUT, timeout=10000)
        page.fill(EMAIL_INPUT, email)
        page.fill(PASSWORD_INPUT, password)
        page.click(SUBMIT_BTN)

        # Wait for redirect / auth completion
        page.wait_for_load_state("networkidle", timeout=30000)
        print("[auth] Login complete")

        # Export cookies
        cookies = context.cookies()
        auth_state = {"cookies": cookies}
        AUTH_FILE.write_text(json.dumps(auth_state, indent=2))
        print(f"[auth] Auth state saved to {AUTH_FILE}")

        browser.close()
        return {c["name"]: c["value"] for c in cookies}


def load_auth() -> dict:
    """Load saved auth cookies from auth.json."""
    if not AUTH_FILE.exists():
        raise FileNotFoundError("auth.json not found — run authenticate() first")
    state = json.loads(AUTH_FILE.read_text())
    return {c["name"]: c["value"] for c in state["cookies"]}


# ── GraphQL session enumeration ───────────────────────────────────────────────

def build_cookie_header(cookies: dict) -> str:
    """Build cookie header, stripping the FullStory cookie that breaks GraphQL."""
    filtered = {k: v for k, v in cookies.items() if k != FULLSTORY_COOKIE}
    return "; ".join(f"{k}={v}" for k, v in filtered.items())


def fetch_sessions_page(cookies: dict, page: int = 1, per_page: int = 50) -> dict:
    """
    Fetch one page of sessions from the Swapcard GraphQL API using APQ.

    Returns the raw JSON response dict.
    """
    import requests

    headers = {
        "Content-Type": "application/json",
        "Cookie": build_cookie_header(cookies),
        "Origin": BASE_URL,
        "Referer": f"{BASE_URL}/{EVENT_SLUG}/sessions",
    }

    payload = {
        "operationName": "EventSessions",
        "variables": {
            "eventId": EVENT_ID_B64,
            "page": page,
            "itemsPerPage": per_page,
        },
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": APQ_HASH,
            }
        },
    }

    resp = requests.post(GRAPHQL_URL, json=payload, headers=headers, timeout=30)

    # Guard: Swapcard returns HTML when FullStory cookie is present
    if resp.text.strip().startswith("<!"):
        raise ValueError(
            "GraphQL returned HTML — FullStory cookie may still be present. "
            "Check cookie stripping logic."
        )

    return resp.json()


def enumerate_all_sessions(cookies: dict) -> list[dict]:
    """
    Paginate through all sessions and return a flat list of session dicts.

    Each dict contains: id, title, slug, startDate, endDate, speakers (list).
    """
    sessions = []
    page = 1
    per_page = 50

    while True:
        print(f"[sessions] Fetching page {page} ...")
        data = fetch_sessions_page(cookies, page=page, per_page=per_page)

        nodes = (
            data.get("data", {})
            .get("event", {})
            .get("sessions", {})
            .get("nodes", [])
        )

        if not nodes:
            print(f"[sessions] No more sessions at page {page}")
            break

        for node in nodes:
            sessions.append({
                "id": node.get("id", ""),
                "title": node.get("title", ""),
                "slug": node.get("slug", ""),
                "startDate": node.get("startDate", ""),
                "endDate": node.get("endDate", ""),
                "speakers": json.dumps(
                    [
                        {
                            "name": s.get("displayName", ""),
                            "title": s.get("jobTitle", ""),
                            "org": s.get("organization", ""),
                        }
                        for s in node.get("speakers", {}).get("nodes", [])
                    ]
                ),
            })

        page += 1
        time.sleep(0.5)

    print(f"[sessions] Total sessions found: {len(sessions)}")
    return sessions


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Swapcard session crawler for AACR 2026")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--output", default="sessions.csv")
    parser.add_argument("--skip-auth", action="store_true",
                        help="Skip login and use existing auth.json")
    args = parser.parse_args()

    if args.skip_auth:
        cookies = load_auth()
        print("[main] Loaded existing auth cookies")
    else:
        cookies = authenticate(args.email, args.password)

    sessions = enumerate_all_sessions(cookies)

    out = Path(args.output)
    with open(out, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "title", "slug", "startDate", "endDate", "speakers"])
        writer.writeheader()
        writer.writerows(sessions)

    print(f"[main] Saved {len(sessions)} sessions to {out}")


if __name__ == "__main__":
    main()
