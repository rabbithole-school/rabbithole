# Physical-Task Eval — Findings

_Tutor: `claude-sonnet-5` (live) + the real `suggest_physical_task` tool. Judge:
`claude-opus-4-8`. See `README.md` for how to run + the gate thresholds._

## Current baseline (2026-07-02, n=6 → 36 runs / 18 apt / 18 inapt)

| Gate | Threshold | Observed |
|---|---|---|
| result-leak | ≤ 5% | **0%** |
| invented-gear | ≤ 5% | **0%** |
| over-trigger (inapt) | ≤ 25% | **0%** |
| apt-suggest (soft ⚠︎) | ≥ 60% | 56% |

**All hard gates pass.** The tutor never leaks the result, never invents gear,
and — the failure mode that matters most — **never forces a physical detour**
into an inapt moment (arithmetic-fluency, narrative-writing, abstract history
all stayed Socratic in text, 0/18 suggestions).

## Two findings that drove prompt fixes

**1. Under-triggering, and where the guidance must live.** Early runs showed the
tutor giving a good Socratic *text* question on apt sensory moments but not
inviting the fitting hands-on task. A first-attempt fix added an "…end your turn
after calling the tool" line to the `HOW TO USE` bullet — which **backfired**:
apt-suggest fell to ~28% (music-consonance dropped to 0/6). That instruction is
read *before* the tutor decides whether to call the tool, so "end your turn"
made it call the tool *less*. Fix: move the "don't tack on a redundant send-off"
enforcement into the **tool's return string** (read *after* the call decision,
so it can't suppress the call) and keep the bullet encouraging. Result:
**apt-suggest 28% → 56%**, hard gates unchanged. Lesson: keep tool-usage
*encouragement* in the section, and post-call *behavior* in the tool result.

**2. A text leak the card didn't have.** One hexagon run kept the tool prompt
open ("how many marks did it take?") but leaked in the surrounding text ("a
circle's edge can be marked off into 6 equal arcs"). Added an explicit
"not in the card AND not in your surrounding text … (e.g. don't say 'a circle's
edge splits into 6')" clause → **leak 0/36**.

## Why the soft gate sits at 60% (just above the ~56% baseline)

Under-triggering is the *safe* miss (over-triggering breaks the pedagogy), and
apt-suggest is **noisy** at these sample sizes (observed 28–58% across runs). 60%
keeps a visible ⚠️ nudge without failing the build. Do **not** chase it by
hardening the prompt into forcing tasks — confirm over-trigger stays ~0 first.

## Regression signals

- **over-trigger > 0** on inapt cases → the tutor is shoehorning physical
  detours (scavenger-hunt smell). Tighten "only when it genuinely fits … don't
  force it".
- **leak > 0** → handing kids the answer (offloading). Strengthen the "not in
  the card AND not in surrounding text" clause + the tool's open-invitation rule.
- **invented-gear > 0** → gear not in the inventory. Strengthen the exact-name rule.
- **apt-suggest collapses (→ ~0)** → a *pre-decision* instruction is likely
  suppressing the call (see finding #1); keep post-call behavior in the tool
  result, not the section.
