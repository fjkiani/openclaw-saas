"""
mcp_inference.py — Modal-hosted serving for MCP LoRA adapters trained by
mcp_lora.py. One `serve` function invocation loads distilgpt2 + the requested
(mcp_slug, tool_name) adapter from the shared Modal volume and returns a
completion.

App:      openclaw-mcp-inference
Function: serve(mcp_slug, tool_name, prompt, adapter_id?, max_new_tokens?)
GPU:      T4 (matches the trainer)
Volume:   openclaw-mcp-adapters (shared with mcp_lora.py) mounted at /root/adapters

Invocation from the api-server (see src/lib/modal/inferenceClient.ts):
  modal run --profile <p> openclaw-mcp-inference::serve \\
    --mcp-slug anthropic-postgres --tool-name query --prompt "SELECT ..."

Output: single JSON blob on stdout at the end:
  {"ok": true, "completion": "...", "adapter_used": "anthropic-postgres__query",
   "latency_ms": 480, "cold_start": false}
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import modal

APP_NAME = "openclaw-mcp-inference"
VOLUME_NAME = "openclaw-mcp-adapters"
BASE_MODEL = "distilgpt2"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.5.1",
        "transformers==4.46.3",
        "peft==0.13.2",
        "accelerate==1.1.1",
    )
)

adapters_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

app = modal.App(APP_NAME, image=image)

# Cold-start marker persisted per-container so the api-server can label
# invocations as cold vs warm.
_CONTAINER_STATE = {"warmed": False}


@app.function(
    gpu="T4",
    timeout=120,
    volumes={"/root/adapters": adapters_volume},
    scaledown_window=300,  # keep the container warm ~5 min between calls
)
def serve(
    mcp_slug: str,
    tool_name: str,
    prompt: str,
    adapter_id: str | None = None,
    max_new_tokens: int = 64,
) -> dict:
    """Load base model + adapter, run one completion, return JSON."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    t0 = time.time()
    cold_start = not _CONTAINER_STATE["warmed"]

    adapter_dir = Path(f"/root/adapters/{mcp_slug}__{tool_name}")
    has_adapter = adapter_dir.exists() and (
        (adapter_dir / "adapter_config.json").exists()
        or any(adapter_dir.glob("**/adapter_config.json"))
    )

    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, torch_dtype=torch.float16 if device == "cuda" else torch.float32).to(device)

    adapter_used = "baseline"
    if has_adapter:
        try:
            from peft import PeftModel

            # Adapter may be at adapter_dir or a nested subdir depending on
            # how mcp_lora.py saved it. Find the config.
            cfg = adapter_dir / "adapter_config.json"
            if not cfg.exists():
                cfg = next(adapter_dir.glob("**/adapter_config.json"))
            model = PeftModel.from_pretrained(model, str(cfg.parent))
            adapter_used = adapter_id or f"{mcp_slug}__{tool_name}"
        except Exception as exc:  # pragma: no cover
            # Fall back to baseline on adapter load failure — don't crash the
            # inference request; the api-server records the adapter_used field.
            adapter_used = f"baseline (adapter load failed: {exc})"

    model.eval()
    inputs = tok(prompt, return_tensors="pt", truncation=True, max_length=512).to(device)
    with torch.no_grad():
        out_ids = model.generate(
            **inputs,
            max_new_tokens=int(max_new_tokens),
            do_sample=False,
            pad_token_id=tok.pad_token_id,
        )
    completion = tok.decode(out_ids[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

    _CONTAINER_STATE["warmed"] = True
    latency_ms = int((time.time() - t0) * 1000)

    payload = {
        "ok": True,
        "completion": completion,
        "adapter_used": adapter_used,
        "latency_ms": latency_ms,
        "cold_start": cold_start,
        "mcp_slug": mcp_slug,
        "tool_name": tool_name,
    }
    # Emit JSON blob on stdout so `modal run` can be parsed by the caller.
    print(json.dumps(payload))
    return payload


@app.local_entrypoint()
def main(
    mcp_slug: str = "anthropic-postgres",
    tool_name: str = "query",
    prompt: str = "SELECT * FROM users WHERE id = 1;",
    adapter_id: str = "",
    max_new_tokens: int = 64,
):
    """Local entrypoint so `modal run mcp_inference.py --mcp-slug ... --prompt "..."` works."""
    out = serve.remote(
        mcp_slug=mcp_slug,
        tool_name=tool_name,
        prompt=prompt,
        adapter_id=adapter_id or None,
        max_new_tokens=max_new_tokens,
    )
    # Also print here for the api-server parser (in case the container's
    # print gets buffered).
    print(json.dumps(out))


if __name__ == "__main__":
    # No-op — invoked via `modal run ...`
    pass
