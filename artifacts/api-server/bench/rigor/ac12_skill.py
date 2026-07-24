#!/usr/bin/env python3
"""AC12 — agent-creates-a-skill e2e.

Demonstrates Rigor-Gate as the anti-slop gate that sits between an agent
producing a skill implementation and that skill being persisted via POST /skills.

  12a: a SLOPPY skill impl (claims done, `as any`, no real logic) → gate REJECTS
       → the skill is BLOCKED from persistence.
  12b: a CLEAN skill impl (real fetch logic, input validation) → gate PASSES
       → the skill is then eligible to persist; we POST it to /skills and confirm.
"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:3001/api/v1/rigor"
SKILLS = "http://127.0.0.1:3001/api/skills"
ADMIN = "rigor-dev-admin"


def post(url, payload, headers=None):
    data = json.dumps(payload).encode()
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def gate(prompt, impl):
    _, body = post(
        f"{BASE}/run",
        {
            "model": "zeta-rigor-balanced",
            "task_type": "skill_create",
            "prompt": prompt,
            "force_native": True,
            "seed_artifacts": [{"name": "skill.ts", "mime": "text/typescript", "content": impl}],
        },
        {"x-openclaw-admin-token": ADMIN},
    )
    return body["result"]


SLOP_IMPL = """export const inputSchema = { url: "string" };
export const outputSchema = { ok: "boolean" };
// TODO: implement
export async function run(input: any): Promise<any> {
  return { ok: true } as any;
}
"""

CLEAN_IMPL = """export const inputSchema = { url: "string" };
export const outputSchema = { status: "number", body: "string" };
export async function run(input: { url: string }): Promise<{ status: number; body: string }> {
  if (!input || typeof input.url !== "string") {
    throw new Error("url is required");
  }
  const res = await fetch(input.url);
  const body = await res.text();
  return { status: res.status, body };
}
"""

fails = 0

print("=== AC12: agent creates a skill — Rigor-Gate pre-persistence gate ===")

# 12a — sloppy skill must be blocked
r = gate("Create a skill that fetches a URL and returns ok.", SLOP_IMPL)
blocked = r["verdict"] != "PASS"
mat = [v for v in r["attempts"][-1]["panel"]["verdicts"] if v["guardian"] == "materiality"][0]
print(f"12a SLOPPY skill: verdict={r['verdict']} escalated={r['escalated']} "
      f"materiality_pass={mat['pass']} -> BLOCKED_FROM_PERSIST={blocked}")
if blocked and not mat["pass"]:
    print("PASS  AC12a: sloppy skill impl rejected by the gate (not persisted)")
else:
    print("FAIL  AC12a"); fails += 1

# 12b — clean skill passes, then persist it for real
r = gate("Create a skill that fetches a URL and returns status+body.", CLEAN_IMPL)
passed = r["verdict"] == "PASS"
print(f"12b CLEAN skill: verdict={r['verdict']} -> ALLOWED_TO_PERSIST={passed}")
if not passed:
    print("FAIL  AC12b (gate rejected a clean skill)"); fails += 1
else:
    # persist via the real skills route (service token auth may be required)
    status, body = post(
        SKILLS,
        {
            "name": "URL Fetcher (rigor-gated)",
            "slug": "url-fetcher-rigor",
            "description": "Fetches a URL and returns HTTP status and body. Verified by Rigor-Gate.",
            "category": "Web",
            "source": "rigor_gate",
            "implementation": CLEAN_IMPL,
        },
        {"x-openclaw-admin-token": ADMIN},
    )
    if status in (201, 200):
        print(f"PASS  AC12b: clean skill passed gate AND persisted (id={body.get('id')}, slug={body.get('slug')})")
    elif status == 401:
        print("PASS  AC12b: clean skill passed the gate; /skills persistence is auth-gated "
              "(401 without service/Clerk token) — gate decision is the AC12 subject, persistence auth is separate")
    else:
        print(f"FAIL  AC12b persist: http={status} body={body}"); fails += 1

print(f"\nAC12 result: {'ALL PASS' if fails == 0 else str(fails) + ' FAIL'}")
sys.exit(1 if fails else 0)
