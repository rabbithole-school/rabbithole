# Physical-Task Appropriateness Eval

Verifies the tutor uses the **physical environment** feature *appropriately* —
the `suggest_physical_task` tool + the `PHYSICAL ENVIRONMENT` prompt section
(see `review/physical-environment-teaching-tool-plan.html`,
`convex/prompts.ts → buildPhysicalEnvironmentSection`, and the tool in
`convex/http.ts`).

Same approach as [`evals/introspection-redirect/`](../introspection-redirect/)
and [`evals/non-human-intro/`](../non-human-intro/): it assembles the **real**
tutor system prompt (`convex/sessionHelpers.ts → buildSystemPrompt`, with a real
`physicalEnvironmentContext`) **and** offers the **real** `suggest_physical_task`
tool, then an Opus judge scores the reply + any tool call. No paraphrased
prompt — what's scored is what ships.

## Run

```bash
bash evals/physical-task/run.sh --samples 3        # regression gate (exits non-zero on regression)
ANTHROPIC_API_KEY=... npx tsx evals/physical-task/run.ts --samples 3 --no-gate   # report only
```

Flags: `--samples N` (per case, default 3), `--out DIR`, `--no-gate` (report
without failing). Output: `out/report.md`, `out/runs.json` (gitignored).

## Why this eval exists

The physical-task loop can fail two ways that break the pedagogy:

1. **Over-triggering** — shoehorning a "go touch the bells" detour into a moment
   where it doesn't belong (a multiplication-fluency drill, a narrative-writing
   beat, an abstract history question). This is a scavenger hunt, not curiosity.
2. **Leaking the result** — telling the kid what they'll find ("you'll see it's a
   3:2 ratio") turns a real experiment into cognitive offloading. A completed
   experiment is worthless if the tutor already gave away the answer.

Plus **inventing gear** the school doesn't have. So the guarded numbers are the
**result-leak rate**, the **invented-gear rate**, and the **over-trigger rate**
on the "should NOT suggest" cases. Under-triggering (missing an apt moment) is
the softer miss — reported as a warning, not a hard fail.

## Gates (regression guards)

`run.sh` exits **non-zero** when a **hard** gate regresses:

| Gate | Threshold | Rationale |
|---|---|---|
| result-leak | ≤ 5% of all runs | anti-offloading core |
| invented-gear | ≤ 5% of all runs | only reference listed gear |
| over-trigger (inapt cases) | ≤ 25% | don't force a physical detour |
| apt-suggest (soft ⚠︎) | ≥ 60% | warn only — under-trigger is the softer miss |

## Cases

| Case | Kind | Expect suggest? |
|---|---|---|
| `music-consonance` | apt (bells) | **yes** |
| `resonance-hum` | apt (singing bowl) | **yes** |
| `hexagon-construct` | apt (compass) | **yes** |
| `arithmetic-fluency` | inapt (fluency drill) | **no** (over-trigger guard) |
| `narrative-writing` | inapt (writing beat) | **no** (over-trigger guard) |
| `history-rivers` | inapt (abstract, no gear) | **no** (over-trigger guard) |

The fixture inventory (hand bells · singing bowl · compass & straight-edge) is
injected into every case and handed to the judge, so **invented gear** is
detectable and availability never confounds aptness.

## When to re-run

After any edit to `buildPhysicalEnvironmentSection` (`convex/prompts.ts`), the
`suggest_physical_task` tool/description (`convex/http.ts`), or the tutor base
prompt. A regression here means the tutor is either nagging kids with
irrelevant physical detours or handing them the answer.

## Tuning levers

- **Over-triggers** → tighten the section's "Only suggest something when it
  genuinely fits THIS moment's concept … don't force a physical detour" bullet.
- **Leaks** → strengthen "NEVER tell the scholar the result they're meant to
  discover" and the tool description's open-invitation requirement.
- **Invented gear** → strengthen "don't suggest gear that isn't listed above" /
  the tool's "only reference equipment by the exact name listed".
