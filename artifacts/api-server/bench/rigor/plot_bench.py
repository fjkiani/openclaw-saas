#!/usr/bin/env python3
"""Render Rigor-Gate benchmark charts (PNG) from benchmark_metrics.json."""
import json
import sys

import matplotlib
matplotlib.use("Agg")
matplotlib.rcParams["font.family"] = ["Liberation Sans", "Arimo", "DejaVu Sans"]
import matplotlib.pyplot as plt

SRC = sys.argv[1] if len(sys.argv) > 1 else "/mnt/results/rigor_gate/benchmark_metrics.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/mnt/results/rigor_gate"

m = json.load(open(SRC))

# Colorblind-friendly (Okabe-Ito)
BLUE = "#0072B2"
ORANGE = "#E69F00"
GREEN = "#009E73"
RED = "#D55E00"
GREY = "#999999"

# ---- Chart 1: Panel vs naive baseline (the headline contrast) ----------------
# Zero-value bars get a visible outlined stub so the comparison is never invisible,
# and value labels are dodged per-series so each maps unambiguously to its bar.
fig, ax = plt.subplots(figsize=(7.5, 4.5))
groups = ["Slop rejection\n(recall, higher=better)", "False-reject\n(clean blocked, lower=better)"]
panel = [m["overall"]["slop_rejection_rate"], m["overall"]["false_reject_rate"]]
base = [m["baseline_self_judge"]["slop_rejection_rate"], m["baseline_self_judge"]["false_reject_rate"]]
x = range(len(groups))
w = 0.36


def draw_bars(ax, xs, vals, width, color, label):
    bars = ax.bar(xs, vals, width, label=label, color=color,
                  edgecolor="black", linewidth=0.8)
    # give exact-zero bars a thin visible stub outline at y=0 so they read as "a bar, value 0"
    for bar, v in zip(bars, vals):
        if v == 0:
            bar.set_height(0.012)
            bar.set_facecolor("white")
            bar.set_edgecolor(color if color != GREY else "#555555")
            bar.set_linewidth(1.4)
    return bars


b1 = draw_bars(ax, [i - w / 2 for i in x], panel, w, GREEN, "Rigor-Gate panel")
b2 = draw_bars(ax, [i + w / 2 for i in x], base, w, GREY, "Naive self-judge baseline")
ax.set_ylim(0, 1.15)
ax.set_ylabel("Rate")
ax.set_title("Rigor-Gate vs naive baseline (n=%d fixtures, mode=%s)" % (m["n_fixtures"], m["mode"]))
ax.set_xticks(list(x))
ax.set_xticklabels(groups)
ax.legend(frameon=False, loc="upper center")
# dodge labels per series, positioned by the TRUE value (not the stub height)
for xs, vals, col in (([i - w / 2 for i in x], panel, GREEN),
                      ([i + w / 2 for i in x], base, "#555555")):
    for xi, v in zip(xs, vals):
        ax.annotate(f"{v:.2f}", (xi, max(v, 0.012)), ha="center", va="bottom",
                    fontsize=9, color=col, fontweight="bold")
ax.axhline(0, color="black", linewidth=0.8)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
fig.savefig(f"{OUT}/chart_panel_vs_baseline.png", dpi=150)
plt.close(fig)

# ---- Chart 2: Per-guardian slop-rejection + false-reject ---------------------
guards = list(m["by_guardian"].keys())
rec = [m["by_guardian"][g]["slop_rejection_rate"] for g in guards]
fr = [m["by_guardian"][g]["false_reject_rate"] for g in guards]
fig, ax = plt.subplots(figsize=(8, 4.5))
x = range(len(guards))
w = 0.36
draw_bars(ax, [i - w / 2 for i in x], rec, w, BLUE, "Slop-rejection (recall)")
draw_bars(ax, [i + w / 2 for i in x], fr, w, RED, "False-reject")
ax.set_ylim(0, 1.15)
ax.set_ylabel("Rate")
ax.set_title("Per-guardian detection (each guardian evaluated on all fixtures)")
ax.set_xticks(list(x))
ax.set_xticklabels([g.capitalize() for g in guards])
ax.legend(frameon=False, loc="upper right")
for i, (r, f) in enumerate(zip(rec, fr)):
    ax.annotate(f"{r:.2f}", (i - w / 2, max(r, 0.012)), ha="center", va="bottom", fontsize=9, color=BLUE, fontweight="bold")
    ax.annotate(f"{f:.2f}", (i + w / 2, max(f, 0.012)), ha="center", va="bottom", fontsize=9, color="#a03000", fontweight="bold")
ax.axhline(0, color="black", linewidth=0.8)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
fig.savefig(f"{OUT}/chart_per_guardian.png", dpi=150)
plt.close(fig)

# ---- Chart 3: Catch rates on each guardian's own slop category (by_mode) -----
if "by_mode" in m:
    modes = list(m["by_mode"].keys())
    catch = [m["by_mode"][mm]["slop_rejection_rate"] for mm in modes]
    fig, ax = plt.subplots(figsize=(7, 4.5))
    bars = ax.bar([mm.capitalize() for mm in modes], catch, color=ORANGE, width=0.6)
    ax.set_ylim(0, 1.15)
    ax.set_ylabel("Catch rate on own category")
    ax.set_title("Guardian catch rate within its own slop category")
    for bar in bars:
        h = bar.get_height()
        ax.annotate(f"{h:.2f}", (bar.get_x() + bar.get_width() / 2, h),
                    ha="center", va="bottom", fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(f"{OUT}/chart_catch_by_category.png", dpi=150)
    plt.close(fig)

# ---- Chart 4: Confusion matrix (overall panel) -------------------------------
c = m["overall"]["confusion"]
fig, ax = plt.subplots(figsize=(5, 4.5))
mat = [[c["tp"], c["fn"]], [c["fp"], c["tn"]]]
im = ax.imshow(mat, cmap="Blues", vmin=0, vmax=max(m["n_fixtures"], 1))
ax.set_xticks([0, 1]); ax.set_xticklabels(["Rejected", "Passed"])
ax.set_yticks([0, 1]); ax.set_yticklabels(["Actually slop", "Actually clean"])
ax.set_xlabel("Panel decision"); ax.set_ylabel("Ground truth")
ax.set_title("Panel confusion matrix (overall)")
labels = [["TP", "FN"], ["FP", "TN"]]
for i in range(2):
    for j in range(2):
        val = mat[i][j]
        ax.annotate(f"{labels[i][j]}\n{val}", (j, i), ha="center", va="center",
                    color="white" if val > m["n_fixtures"] / 2 else "black", fontsize=12)
fig.tight_layout()
fig.savefig(f"{OUT}/chart_confusion.png", dpi=150)
plt.close(fig)

print("charts written to", OUT)
for f in ["chart_panel_vs_baseline.png", "chart_per_guardian.png",
          "chart_catch_by_category.png", "chart_confusion.png"]:
    print(" -", f)
