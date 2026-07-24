"""
rigor-dspy — real DSPy Executor sidecar for the Rigor-Gate wrapper.

This is NOT a reimplementation of DSPy's refinement loop. It runs a genuine
`dspy.Refine(program, N, reward_fn, threshold)` program whose LM is OpenRouter
(via LiteLLM's `openrouter/<id>` routing) and whose `reward_fn` calls back into
the TypeScript guardian panel (`POST {RIGOR_SCORE_URL}`) so DSPy's own accept/
reject/feedback loop is driven by OUR guardians. The first envelope scoring at
or above `threshold` is returned; otherwise the best of N is returned with
`passed=false` and the orchestrator escalates / swaps models.

Endpoints:
  GET  /health   -> { ok, dspy_version, lm_ready, model? }
  POST /refine   -> runs dspy.Refine; returns the executor envelope + trace.

Honest degradation: with no OpenRouter key the sidecar CANNOT run a live LM, so
/refine returns 200 with {ok:false, mode:"dry", reason:...}. The TS orchestrator
treats that as "sidecar unavailable for live work" and falls back to its native
modelRouter executor, recording executor_path="native". No fabricated LM output.
"""

from __future__ import annotations

import json
import os
from typing import Any

import dspy
import httpx
from fastapi import FastAPI
from pydantic import BaseModel, Field

# ── Config (env, with safe defaults matching the TS side) ──────────────────────
RIGOR_SCORE_URL = os.environ.get(
    "RIGOR_SCORE_URL", "http://127.0.0.1:3001/api/v1/rigor/_score"
)
DEFAULT_THRESHOLD = float(os.environ.get("RIGOR_MIN_SCORE", "80")) / 100.0
DEFAULT_MAX_N = int(os.environ.get("RIGOR_MAX_ATTEMPTS", "6"))
# resolveApiKey parity: try the OR key pool in order.
_OR_KEY_ENVS = [
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY_2",
    "OPENROUTER_API_KEY_3",
    "OPENROUTER_API_KEY_4",
]


def resolve_openrouter_key() -> str:
    for k in _OR_KEY_ENVS:
        v = (os.environ.get(k) or "").strip()
        if v:
            return v
    return ""


# ── The executor signature — emits the Rigor-Gate envelope fields ─────────────
class ExecutorSignature(dspy.Signature):
    """Produce a rigorous, materially-grounded answer to a task.

    Never claim a fix, pass, or result you cannot back with a concrete artifact
    or an exactly-applicable code edit. If you produce or modify code, include it
    as an artifact and express edits as SEARCH/REPLACE blocks. Be decisive: do not
    hedge around a binary requirement. Any number you state must match your
    artifacts. If prior attempts were rejected, the feedback explains why —
    address it directly rather than restating the previous answer.
    """

    task: str = dspy.InputField(desc="The task / prompt the agent must satisfy.")
    contract: str = dspy.InputField(
        desc="Hard requirements the answer must satisfy (JSON)."
    )
    answer_text: str = dspy.OutputField(
        desc="The decisive answer. No hedging around binary requirements."
    )
    artifacts_json: str = dspy.OutputField(
        desc='JSON array of artifacts: [{"name","mime","content"}]. Code goes here.'
    )
    edit_blocks: str = dspy.OutputField(
        desc="Aider-style <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks, or empty."
    )
    claims_json: str = dspy.OutputField(
        desc='JSON array of claims: [{"text","kind"}] where kind in '
        '["success","numeric","factual"].'
    )


# ── Request / response models ─────────────────────────────────────────────────
class RefineRequest(BaseModel):
    prompt: str
    house_model: str = "zeta-rigor-balanced"
    openrouter_id: str = "meta-llama/llama-3.3-70b-instruct:free"
    contract: dict[str, Any] = Field(default_factory=dict)
    threshold: float | None = None
    max_n: int | None = None
    task_type: str = "rigor_generic"
    prompt_hash: str = ""
    # correlation id so the TS /_score endpoint can tie a reward call to this run
    run_id: str = ""


def _score_via_guardians(
    envelope: dict[str, Any], req: RefineRequest
) -> dict[str, Any]:
    """Call the TS guardian panel loopback. Returns {score, verdicts, pass}."""
    payload = {
        "envelope": envelope,
        "task_type": req.task_type,
        "prompt": req.prompt,
        "prompt_hash": req.prompt_hash,
        "house_model": req.house_model,
        "run_id": req.run_id,
        "source": "dspy_sidecar",
    }
    try:
        with httpx.Client(timeout=60.0) as client:
            r = client.post(RIGOR_SCORE_URL, json=payload)
            r.raise_for_status()
            return r.json()
    except Exception as exc:  # noqa: BLE001 — degrade, don't crash the reward loop
        # If the scorer is unreachable, return a neutral-low score so Refine keeps
        # trying but never treats an unscored envelope as passing.
        return {"score": 0.0, "verdicts": [], "pass": False, "error": str(exc)}


def _parse_envelope(pred: dspy.Prediction) -> dict[str, Any]:
    """Normalize a DSPy prediction into the canonical executor envelope."""

    def _loads(v: Any, fallback: Any) -> Any:
        if isinstance(v, (list, dict)):
            return v
        if not v:
            return fallback
        try:
            return json.loads(v)
        except Exception:  # noqa: BLE001
            return fallback

    return {
        "answer_text": getattr(pred, "answer_text", "") or "",
        "artifacts": _loads(getattr(pred, "artifacts_json", ""), []),
        "edit_blocks": _blocks_to_list(getattr(pred, "edit_blocks", "")),
        "claims": _loads(getattr(pred, "claims_json", ""), []),
    }


def _blocks_to_list(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return raw
    if not raw or not str(raw).strip():
        return []
    return [str(raw)]


class GuardianReward:
    """Module-level callable reward for dspy.Refine.

    dspy.Refine calls `inspect.getsource(reward_fn)` at construction time to build
    its auto-feedback (OfferFeedback) module, so the reward MUST be a source-
    retrievable top-level object — a nested closure defined inside the request
    handler fails `getsource`. This class is that stable, module-level callable;
    it carries per-request state (the guardian-score trace + the request) as
    instance attributes while keeping `__call__` a real, inspectable method.
    """

    def __init__(self, req: "RefineRequest") -> None:
        self.req = req
        self.attempts: list[dict[str, Any]] = []

    def __call__(self, args: dict[str, Any], pred: "dspy.Prediction") -> float:
        envelope = _parse_envelope(pred)
        scored = _score_via_guardians(envelope, self.req)
        score = float(scored.get("score", 0.0))
        self.attempts.append(
            {
                "attempt": len(self.attempts) + 1,
                "score": score,
                "passed": bool(scored.get("pass", False)),
                "verdicts": scored.get("verdicts", []),
            }
        )
        return score


app = FastAPI(title="rigor-dspy", version="1.0.0")


@app.get("/health")
def health() -> dict[str, Any]:
    key = resolve_openrouter_key()
    return {
        "ok": True,
        "service": "rigor-dspy",
        "dspy_version": dspy.__version__,
        "lm_ready": bool(key),
        "score_url": RIGOR_SCORE_URL,
        "default_threshold": DEFAULT_THRESHOLD,
        "default_max_n": DEFAULT_MAX_N,
    }


@app.post("/refine")
def refine(req: RefineRequest) -> dict[str, Any]:
    key = resolve_openrouter_key()
    if not key:
        # Honest dry: cannot run a live LM. Orchestrator falls back to native.
        return {
            "ok": False,
            "mode": "dry",
            "executor_path": "dspy",
            "reason": "no OpenRouter API key in sidecar env; live DSPy refine unavailable",
            "dspy_version": dspy.__version__,
        }

    threshold = req.threshold if req.threshold is not None else DEFAULT_THRESHOLD
    max_n = req.max_n if req.max_n is not None else DEFAULT_MAX_N

    # Configure DSPy LM → OpenRouter via LiteLLM. temp 1.0 so Refine explores.
    lm = dspy.LM(
        model=f"openrouter/{req.openrouter_id}",
        api_key=key,
        api_base="https://openrouter.ai/api/v1",
        temperature=1.0,
        max_tokens=1600,
        num_retries=2,
    )
    dspy.configure(lm=lm)

    program = dspy.ChainOfThought(ExecutorSignature)

    # Module-level, source-retrievable reward callable (holds the attempt trace).
    reward = GuardianReward(req)

    refiner = dspy.Refine(
        module=program,
        N=max_n,
        reward_fn=reward,
        threshold=threshold,
    )

    try:
        final = refiner(task=req.prompt, contract=json.dumps(req.contract))
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "mode": "live",
            "executor_path": "dspy",
            "reason": f"dspy.Refine raised: {exc}",
            "attempts": reward.attempts,
            "dspy_version": dspy.__version__,
        }

    envelope = _parse_envelope(final)
    best_score = max((a["score"] for a in reward.attempts), default=0.0)
    passed = any(a["passed"] for a in reward.attempts) or best_score >= threshold

    return {
        "ok": True,
        "mode": "live",
        "executor_path": "dspy",
        "envelope": envelope,
        "passed": passed,
        "best_score": best_score,
        "threshold": threshold,
        "attempts": reward.attempts,
        "n_attempts": len(reward.attempts),
        "dspy_version": dspy.__version__,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("RIGOR_DSPY_PORT", "8088"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
