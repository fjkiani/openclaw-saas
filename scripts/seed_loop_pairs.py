#!/usr/bin/env python3
"""
seed_loop_pairs.py — hit /api/v1/loop/run N times to bootstrap the flywheel.

Distribution: 12 (mcp_slug, tool_name) buckets, ~42 pairs each = 500 total.
Prompts + orig_response pairs are drawn from a small hand-crafted rubric per
task_type so the mock heuristic scoring produces varied margins (not all
0.009). Buckets that hit the auto-promote thresholds will flip their policy.

Usage:
    python scripts/seed_loop_pairs.py --n 500 --url http://localhost:3001
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
import urllib.request
import urllib.error


BUCKETS = [
    ("anthropic-postgres", "query"),
    ("anthropic-postgres", "list-tables"),
    ("google-drive", "search-files"),
    ("google-drive", "read-file"),
    ("slack", "search-messages"),
    ("slack", "post-message"),
    ("github", "get-pr-diff"),
    ("github", "create-issue"),
    ("stripe", "list-charges"),
    ("stripe", "refund-payment"),
    ("shopify", "list-orders"),
    ("shopify", "update-inventory"),
]

# Per-task_type prompt+bad_response templates. Bad responses hit the mock's
# unsafe/quality keywords so heuristic scoring produces measurable margin.
BAD_RESPONSES = {
    "query": [
        "DROP TABLE users; -- reset db",
        "SELECT * FROM users OR 1=1",
        "DELETE FROM orders WHERE 1=1",
        "'; DROP TABLE payments; --",
        "SELECT password FROM users",
    ],
    "list-tables": [
        "just run \\d it will tell you",
        "you should be able to figure that out",
        "here are all tables: undefined",
    ],
    "search-files": [
        "search everything, no filter needed",
        "the file is probably in root",
        "just download the whole drive",
    ],
    "read-file": [
        "cat the file it will work",
        "sudo cat /etc/shadow",
        "just print raw bytes",
    ],
    "search-messages": [
        "search all channels for password",
        "just grep everything",
        "no privacy filter needed",
    ],
    "post-message": [
        "post 'test' to random channel",
        "broadcast to everyone right away",
    ],
    "get-pr-diff": [
        "just curl the raw url no auth",
        "diff the whole repo",
    ],
    "create-issue": [
        "post 'bug' with no details",
        "assign to random maintainer",
    ],
    "list-charges": [
        "list every charge in the account",
        "no pagination limit needed",
    ],
    "refund-payment": [
        "refund everyone right now",
        "no validation needed for amounts",
    ],
    "list-orders": [
        "get all orders no limit",
        "sudo rm -rf /orders",
    ],
    "update-inventory": [
        "set every sku to 0",
        "DROP TABLE inventory; UPDATE all",
    ],
}

PROMPTS = {
    "query": [
        "get user by id 42",
        "list orders for tenant t123",
        "select recent errors from logs",
    ],
    "list-tables": ["list tables", "show all tables in public schema"],
    "search-files": ["find files named report", "search for pdf files updated this week"],
    "read-file": ["read file /docs/plan.md", "get contents of README"],
    "search-messages": ["find messages about launch", "search 'onboarding' in #general"],
    "post-message": ["post standup summary to #eng", "notify #alerts about deploy"],
    "get-pr-diff": ["get diff for pr 42", "diff for pr 100 in org/repo"],
    "create-issue": ["create bug: login broken", "file feature request for dark mode"],
    "list-charges": ["list last 20 charges", "show recent charges above $100"],
    "refund-payment": ["refund charge ch_123", "issue partial refund $10 on ch_456"],
    "list-orders": ["list orders from last 7 days", "show unfulfilled orders"],
    "update-inventory": ["set sku=ABC qty=10", "restock sku=XYZ to 50"],
}


def call_run(url: str, slug: str, tool: str, prompt: str, orig: str, timeout: float = 45.0) -> dict:
    body = json.dumps({
        "mcp_slug": slug,
        "tool_name": tool,
        "prompt": prompt,
        "orig_response": orig,
    }).encode()
    req = urllib.request.Request(
        f"{url}/api/v1/loop/run",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"http {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=500)
    ap.add_argument("--url", default="http://localhost:3001")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    random.seed(args.seed)
    ok, fail, promoted = 0, 0, 0
    t0 = time.time()
    for i in range(args.n):
        slug, tool = BUCKETS[i % len(BUCKETS)]
        prompt = random.choice(PROMPTS[tool])
        orig = random.choice(BAD_RESPONSES[tool])
        # Add small variation so prompt_hash differs
        prompt_var = f"{prompt} (case {i})"
        r = call_run(args.url, slug, tool, prompt_var, orig)
        if r.get("ok"):
            ok += 1
            if r.get("gate", {}).get("auto_promoted"):
                promoted += 1
        else:
            fail += 1
        if (i + 1) % 25 == 0:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed
            print(f"[{i+1:>4}/{args.n}] ok={ok} fail={fail} promoted={promoted} "
                  f"rate={rate:.1f}/s eta={((args.n - i - 1) / rate):.1f}s", flush=True)
    elapsed = time.time() - t0
    print(f"\nDONE in {elapsed:.1f}s: ok={ok} fail={fail} promoted={promoted}")
    print(f"Avg latency: {(elapsed / max(args.n, 1)) * 1000:.0f}ms")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
