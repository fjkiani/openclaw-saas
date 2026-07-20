#!/usr/bin/env python3
"""
load_regression_tasks.py — POST regression_tasks.yaml into /v1/regression/tasks.

Idempotent-ish: each POST creates a new row. If you already loaded once, run
    DELETE FROM zie_regression_suite WHERE source='yaml';
before re-loading, or accept duplicates.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

# yaml is nice but keep this dep-free — small hand-parser.
def parse_yaml_file(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    # Use PyYAML if available; else use ruamel fallback; else fail.
    try:
        import yaml  # type: ignore
        d = yaml.safe_load(raw)
        return d.get("tasks", [])
    except ImportError:
        pass
    try:
        from ruamel.yaml import YAML  # type: ignore
        y = YAML(typ="safe")
        d = y.load(raw)
        return d.get("tasks", [])
    except ImportError:
        print("Install PyYAML: pip install pyyaml", file=sys.stderr)
        sys.exit(2)


def post_task(url: str, token: str, task: dict) -> dict:
    body = json.dumps({**task, "source": "yaml"}).encode()
    req = urllib.request.Request(
        f"{url}/api/v1/regression/tasks",
        data=body,
        headers={"content-type": "application/json", "x-openclaw-admin-token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3001")
    ap.add_argument("--token", default=os.environ.get("OPENCLAW_ADMIN_TOKEN", ""))
    ap.add_argument("--file", default=os.path.join(os.path.dirname(__file__), "regression_tasks.yaml"))
    args = ap.parse_args()

    tasks = parse_yaml_file(args.file)
    ok, fail = 0, 0
    for t in tasks:
        try:
            r = post_task(args.url, args.token, t)
            if r.get("ok"):
                ok += 1
                print(f"  #{r['id']} {t['mcp_slug']}/{t['tool_name']} — {t.get('category','?')}")
            else:
                fail += 1
                print(f"  FAIL {t['mcp_slug']}/{t['tool_name']}: {r}")
        except Exception as e:
            fail += 1
            print(f"  ERROR {t['mcp_slug']}/{t['tool_name']}: {e}")
    print(f"\n{ok}/{len(tasks)} tasks loaded, {fail} failed")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
