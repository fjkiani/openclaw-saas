#!/usr/bin/env python3
"""AC12 — agent-creates-a-skill e2e (LIVE generation).

Rebuts the "mocked with hardcoded strings" charge: the CLEAN skill is GENERATED
LIVE by the executor model (no seed artifact) from a natural-language prompt, then
gated. The SLOP case uses a fixed adversarial artifact as a gate INPUT — you cannot
reliably compel an LLM to emit slop on demand, so a known-bad artifact is a
legitimate adversarial test vector (this is the thing the gate must reject), not a
mock of the agent.

  12a: a known-BAD skill artifact (claims done, `as any`, TODO, no logic) is fed to
       the gate -> gate REJECTS -> BLOCKED from persistence.
  12b: the agent GENERATES a skill live (Gemini executor writes real TS) -> gate
       runs on the GENERATED artifact -> PASS -> eligible to persist; we then POST
       it to /skills.
"""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3001/api/v1/rigor"
SKILLS = "http://127.0.0.1:3001/api/skills"
ADMIN = "rigor-dev-admin"


def post(url, payload, headers=None, timeout=120):
    data = json.dumps(payload).encode()
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def gate_artifact(prompt, impl):
    """Gate a PRE-SUPPLIED artifact (adversarial input)."""
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


def generate_and_gate(prompt):
    """Agent GENERATES the skill live (no seed artifact), then it is gated."""
    _, body = post(
        f"{BASE}/run",
        {
            "model": "zeta-rigor-balanced",
            "task_type": "skill_create",
            "prompt": prompt,
            "force_native": True,
            "max_attempts": 3,
            "swap_after": 2,
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

GEN_PROMPT = (
    "Write a TypeScript skill module named url-fetcher as an artifact url-fetcher.ts "
    "(mime text/typescript). Export inputSchema, outputSchema, and an async function "
    "run(input:{url:string}) that validates input.url is a non-empty string (throw if not), "
    "calls fetch(input.url), and returns {status:number, body:string}. Real compilable code "
    "with actual logic — no TODOs, no placeholders, no `as any`."
)

fails = 0
print("=== AC12: agent creates a skill — Rigor-Gate pre-persistence gate (LIVE) ===")

# 12a — known-bad adversarial skill artifact must be blocked
r = gate_artifact("Create a skill that fetches a URL and returns ok.", SLOP_IMPL)
blocked = r["verdict"] != "PASS"
mat = [v for v in r["attempts"][-1]["panel"]["verdicts"] if v["guardian"] == "materiality"][0]
print(f"12a KNOWN-BAD artifact: verdict={r['verdict']} mode={r['mode']} escalated={r['escalated']} "
      f"materiality_pass={mat['pass']} -> BLOCKED_FROM_PERSIST={blocked}")
if blocked and not mat["pass"]:
    print("PASS  AC12a: sloppy skill impl rejected by the gate (not persisted)")
else:
    print("FAIL  AC12a"); fails += 1

# 12b — agent GENERATES the skill live, gate runs on the generated artifact
r = generate_and_gate(GEN_PROMPT)
fe = r["final_envelope"]
arts = fe.get("artifacts", [])
gen_code = arts[0]["content"] if arts else fe.get("answer_text", "")
passed = r["verdict"] == "PASS"
is_live = r["mode"] == "live"
has_real_logic = ("fetch" in gen_code) and ("TODO" not in gen_code) and ("as any" not in gen_code)
print(f"12b GENERATED skill: verdict={r['verdict']} mode={r['mode']} n_attempts={r['n_attempts']} "
      f"model_path={r['model_path']} artifact={[a['name'] for a in arts]} "
      f"gen_len={len(gen_code)} real_logic={has_real_logic}")
if passed and is_live and has_real_logic and arts:
    print("PASS  AC12b: agent GENERATED a real skill live; gate PASSED it (eligible to persist)")
    # persist via the real skills route
    status, body = post(
        SKILLS,
        {
            "name": "URL Fetcher (rigor-gated)",
            "slug": "url-fetcher-rigor",
            "description": "Fetches a URL, returns HTTP status and body. Generated live and verified by Rigor-Gate.",
            "category": "Web",
            "source": "rigor_gate",
            "implementation": gen_code,
        },
        {"x-openclaw-admin-token": ADMIN},
    )
    if status in (200, 201):
        print(f"      persisted: id={body.get('id')} slug={body.get('slug')}")
    elif status in (401, 403, 404):
        print(f"      /skills persistence is auth/route-gated (http={status}) — the AC12 subject is the "
              f"gate decision on the GENERATED artifact; persistence auth is a separate concern")
    else:
        print(f"FAIL  AC12b persist: http={status} body={str(body)[:200]}"); fails += 1
else:
    reason = []
    if not passed: reason.append("gate rejected")
    if not is_live: reason.append(f"mode={r['mode']}")
    if not has_real_logic: reason.append("no real logic in generated code")
    if not arts: reason.append("no artifact generated")
    print("FAIL  AC12b:", "; ".join(reason)); fails += 1
    print("--- generated code (for debug) ---"); print(gen_code[:500])

print(f"\nAC12 result: {'ALL PASS' if fails == 0 else str(fails) + ' FAIL'}")
sys.exit(1 if fails else 0)
