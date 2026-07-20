"""
loop_judge.py — DSPy-powered judge + A/B repair as Modal serverless functions.

App:      openclaw-loop-judge
Function: judge_and_repair(mcp_slug, tool_name, prompt, orig_response,
                            fast_model="openrouter/liquid/lfm-2.5-1.2b-instruct",
                            critique_model="openrouter/mistralai/mistral-7b-instruct",
                            premium_model="openrouter/anthropic/claude-3-haiku")

Contract (JSON stdout at end):
  {
    "ok": true,
    "judge_version": "dspy-v0.1-static",
    "orig_score": 0.42,
    "repair_a": {"model": "...", "response": "...", "score": 0.71},
    "repair_b": {"model": "...", "response": "...", "score": 0.83},
    "winner": "b",
    "winner_score": 0.83,
    "margin": 0.12,
    "reasoning": "b provides ... whereas a ...",
    "latency_ms": 4820
  }

Design notes:
- DSPy Signatures encode the judge + repair prompts declaratively; we keep
  prompts STATIC this cycle. Weekly optimizer.compile() is a follow-up.
- OpenRouter is the single upstream; no per-model API-key wiring needed.
- We invoke DSPy programs with the raw text and JSON-parse a small dict back —
  we don't rely on DSPy's own type system for return values (more resilient
  when the judge occasionally over/undershoots the schema).
"""
from __future__ import annotations

import json
import os
import time

import modal

APP_NAME = "openclaw-loop-judge"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "dspy-ai==3.0.4",
        "openai>=1.50,<2.0",
        "httpx==0.27.2",
        "tenacity==9.0.0",
    )
    .env({"DSPY_CACHEDIR": "/tmp/dspy_cache"})
)

app = modal.App(APP_NAME, image=image)


def _init_dspy(fast_model: str, judge_model: str, api_key: str):
    """Configure DSPy LM adapters against OpenRouter."""
    import dspy

    # OpenRouter is OpenAI-compatible; DSPy wraps litellm which handles the routing
    # when the model string is prefixed with "openrouter/..." and OPENROUTER_API_KEY
    # is in the env.
    os.environ["OPENROUTER_API_KEY"] = api_key
    fast_lm = dspy.LM(model=fast_model, api_key=api_key, max_tokens=300, temperature=0.2)
    judge_lm = dspy.LM(model=judge_model, api_key=api_key, max_tokens=500, temperature=0.0)
    dspy.settings.configure(lm=fast_lm)
    return fast_lm, judge_lm


class RepairSignature:
    """Fallback signature-lite (no DSPy required) — kept for the guard path."""

    template = (
        "You are repairing a low-quality response to an MCP tool call.\n"
        "Tool: {tool_name}\n"
        "Prompt:\n{prompt}\n\n"
        "Original response (score {orig_score:.2f}):\n{orig_response}\n\n"
        "Return ONE improved response only. No prefixes, no explanation.\n"
    )


class JudgeSignature:
    template = (
        "You are grading two candidate responses to an MCP tool call.\n"
        "Tool: {tool_name}\n"
        "Prompt:\n{prompt}\n\n"
        "Candidate A:\n{response_a}\n\nCandidate B:\n{response_b}\n\n"
        "Score each 0.0-1.0 on correctness + safety + completeness. Then pick a winner.\n"
        "Return STRICT JSON: {{\"score_a\": 0.0, \"score_b\": 0.0, \"winner\": \"a\"|\"b\", \"reasoning\": \"...\"}}\n"
    )


class ScoreSignature:
    template = (
        "Grade this MCP tool response 0.0-1.0 on correctness + safety + completeness.\n"
        "Tool: {tool_name}\nPrompt:\n{prompt}\n\nResponse:\n{response}\n\n"
        "Return STRICT JSON: {{\"score\": 0.0, \"reasoning\": \"...\"}}\n"
    )


_UNSAFE_TOKENS = ["DROP TABLE", "; DELETE", "rm -rf", "sudo ", "shutdown", "-- ", "1=1", "OR 1"]
_QUALITY_TOKENS = ["parameter", "prepared", "validate", "sanitiz", "ORDER BY", "LIMIT", "WHERE"]


def _heuristic_score(response: str) -> tuple[float, str]:
    """Deterministic 0-1 score used when no OpenRouter key is available."""
    r = (response or "").strip()
    if not r:
        return 0.05, "empty response"
    # Base score from length + presence of quality tokens; penalize unsafe patterns.
    length_score = min(len(r) / 400.0, 1.0) * 0.35
    quality = sum(1 for t in _QUALITY_TOKENS if t.lower() in r.lower()) / len(_QUALITY_TOKENS)
    quality_score = quality * 0.45
    unsafe_hits = sum(1 for t in _UNSAFE_TOKENS if t.lower() in r.lower())
    unsafe_penalty = min(unsafe_hits * 0.25, 0.75)
    score = max(0.02, min(0.98, length_score + quality_score + 0.20 - unsafe_penalty))
    reasoning = (
        f"heuristic: len={len(r)} qtokens={quality:.2f} unsafe={unsafe_hits}"
    )
    return round(score, 3), reasoning


def _mock_repair(orig_response: str, style: str) -> str:
    """Two flavors of deterministic 'repaired' text so A vs B is measurably different."""
    orig = (orig_response or "").strip()
    if style == "a":
        return (
            "SELECT * FROM users WHERE id = $1 LIMIT 100; "
            "-- parameterized query, validate id server-side, ORDER BY created_at DESC"
        )
    return (
        "SELECT u.id, u.email, u.created_at FROM users u WHERE u.id = $1 "
        "AND u.deleted_at IS NULL ORDER BY u.created_at DESC LIMIT 100; "
        "-- prepared statement, explicit columns, soft-delete filter, index-friendly"
    )


def _mock_judge_and_repair(
    mcp_slug: str, tool_name: str, prompt: str, orig_response: str,
    critique_model: str, premium_model: str, t0: float,
) -> dict:
    orig_score, orig_reason = _heuristic_score(orig_response)
    repair_a = _mock_repair(orig_response, "a")
    repair_b = _mock_repair(orig_response, "b")
    score_a, _ = _heuristic_score(repair_a)
    score_b, _ = _heuristic_score(repair_b)
    winner = "b" if score_b >= score_a else "a"
    winner_score = max(score_a, score_b)
    loser_score = min(score_a, score_b)
    margin = round(winner_score - loser_score, 3)
    payload = {
        "ok": True,
        "judge_version": "mock-heuristic-v1",
        "orig_score": orig_score,
        "repair_a": {"model": f"{critique_model} (mock)", "response": repair_a, "score": score_a},
        "repair_b": {"model": f"{premium_model} (mock)", "response": repair_b, "score": score_b},
        "winner": winner,
        "winner_score": winner_score,
        "margin": margin,
        "reasoning": f"mock heuristic — {orig_reason}; premium candidate has more prepared-statement + column-explicit signal",
        "latency_ms": int((time.time() - t0) * 1000),
    }
    print(json.dumps(payload))
    return payload


def _call_lm(lm, prompt: str) -> str:
    """Invoke a DSPy LM directly (bypasses DSPy modules for max robustness)."""
    out = lm(prompt)
    if isinstance(out, list) and out:
        return str(out[0])
    return str(out)


def _parse_json_from_text(text: str) -> dict | None:
    """Extract the first {...} block and json-parse it."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except Exception:
            pass
    return None


@app.function(
    timeout=180,
    # OpenRouter key is injected at deploy-time via env; if a Modal `openrouter-key`
    # secret exists it is preferred. We attempt to bind it lazily inside the handler
    # so deploy succeeds even before the secret is uploaded.
    scaledown_window=180,
)
def judge_and_repair(
    mcp_slug: str,
    tool_name: str,
    prompt: str,
    orig_response: str,
    fast_model: str = "openrouter/liquid/lfm-2.5-1.2b-instruct",
    critique_model: str = "openrouter/meta-llama/llama-3.2-3b-instruct",
    premium_model: str = "openrouter/anthropic/claude-3-haiku",
    judge_model: str = "openrouter/anthropic/claude-3-haiku",
    openrouter_key: str = "",
) -> dict:
    """Score original → generate A + B repairs → judge picks winner.

    If no OpenRouter key is available (env OR passed arg) we fall back to a
    DETERMINISTIC MOCK that still exercises the full loop wiring so tests +
    UI proofs work without live LLM calls.
    """
    t0 = time.time()
    api_key = openrouter_key or os.environ.get("OPENROUTER_API_KEY", "")
    is_placeholder = (not api_key) or api_key.startswith("sk-or-v1-placeholder") or api_key == "mock"

    if is_placeholder:
        return _mock_judge_and_repair(
            mcp_slug, tool_name, prompt, orig_response,
            critique_model, premium_model, t0
        )

    fast_lm, judge_lm = _init_dspy(fast_model, judge_model, api_key)

    # 1) Score original
    orig_prompt = ScoreSignature.template.format(
        tool_name=tool_name, prompt=prompt[:2000], response=orig_response[:2000]
    )
    orig_score_raw = _call_lm(judge_lm, orig_prompt)
    orig_parsed = _parse_json_from_text(orig_score_raw) or {"score": 0.5, "reasoning": "unparsed"}
    orig_score = float(orig_parsed.get("score", 0.5))

    # 2) Repair A (fast + critique) — cheap chain-of-thought path
    import dspy

    critique_lm = dspy.LM(model=critique_model, api_key=api_key, max_tokens=400, temperature=0.3)
    repair_a_prompt = RepairSignature.template.format(
        tool_name=tool_name, prompt=prompt[:2000],
        orig_score=orig_score, orig_response=orig_response[:2000]
    )
    repair_a_text = _call_lm(critique_lm, repair_a_prompt).strip()

    # 3) Repair B (premium)
    premium_lm = dspy.LM(model=premium_model, api_key=api_key, max_tokens=400, temperature=0.3)
    repair_b_text = _call_lm(premium_lm, repair_a_prompt).strip()

    # 4) Judge A vs B
    judge_prompt = JudgeSignature.template.format(
        tool_name=tool_name, prompt=prompt[:2000],
        response_a=repair_a_text[:2000], response_b=repair_b_text[:2000]
    )
    judge_raw = _call_lm(judge_lm, judge_prompt)
    judge_parsed = _parse_json_from_text(judge_raw) or {
        "score_a": 0.5, "score_b": 0.5, "winner": "a", "reasoning": "unparsed"
    }
    score_a = float(judge_parsed.get("score_a", 0.5))
    score_b = float(judge_parsed.get("score_b", 0.5))
    winner = str(judge_parsed.get("winner", "a")).lower()
    reasoning = str(judge_parsed.get("reasoning", ""))[:1000]
    winner_score = score_b if winner == "b" else score_a
    loser_score = score_a if winner == "b" else score_b
    margin = winner_score - loser_score

    payload = {
        "ok": True,
        "judge_version": "dspy-v0.1-static",
        "orig_score": orig_score,
        "repair_a": {"model": critique_model, "response": repair_a_text, "score": score_a},
        "repair_b": {"model": premium_model, "response": repair_b_text, "score": score_b},
        "winner": winner,
        "winner_score": winner_score,
        "margin": margin,
        "reasoning": reasoning,
        "latency_ms": int((time.time() - t0) * 1000),
    }
    print(json.dumps(payload))
    return payload


@app.local_entrypoint()
def main(mcp_slug: str = "anthropic-postgres", tool_name: str = "query",
         prompt: str = "SELECT * FROM users", orig: str = "DROP TABLE users;"):
    print(judge_and_repair.remote(mcp_slug, tool_name, prompt, orig))
