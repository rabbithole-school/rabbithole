# Observer Mastery-Rigor — Findings & Decisions

_Pass 2026-06-24. Triggered by a hunch that the Learning Observer over-scores
mastery. Spot-checked the three most active **production** scholars, built a
focused regression gate (`rigor-check.ts` + fixtures 09/10), and tuned the
mastery-calibration + consolidation rules in `OBSERVER_SYSTEM_PROMPT`._

> Real prod transcripts are NOT committed (PII; `data/` is gitignored). Scholars
> are referenced anonymously below; only aggregate stats and (non-identifying)
> concept-label patterns are quoted.

## TL;DR

1. **The shipped mastery record IS inflated** — across the 3 most active scholars'
   current observations (n=431): **mean Bloom 3.85/5**, **69% at Analyze–Create
   (4–5)**, **78% tagged the top-credit `direct_demonstration`**. For elementary
   tutoring chat that's implausibly high. One 271-message session carried **77
   current observations averaging 4.74**, including ~50 straight 5.0s; another
   carried 78 at 4.42.
2. **But a fresh single observer run is reasonably calibrated.** Re-running the
   *production* observer once on those same transcripts produced **3–5
   observations averaging ~2.6–3.3** — a fraction of what shipped. So the
   inflation is **not** single-pass over-scoring; it's **accumulation across many
   incremental runs + failed consolidation at scale**: each run adds 2–3 new
   observations, near-duplicate labels pile up un-superseded, and long
   creative/build sessions skew the additions high.
3. **Two real, smaller over-scoring patterns** that ARE single-pass and ARE
   fixable in the prompt: (a) tutor-supplied concepts credited to the scholar at
   high Bloom (a kid *directing* the AI to build a Rube Goldberg machine logged as
   Create(5) "Pulley systems and mechanical advantage", "Dramatic irony", "Villain
   psychology"); (b) low-effort moments scored Apply+ (fixing a value you set to 0
   → 3.5). Both got tightened.
4. **Emotional/behavioral signals miscategorized as concept mastery** — e.g.
   "Hyper-responsibility and preemptive self-blame" and "Persistence through
   productive struggle" logged as masteryLevel-5 *observations* (they belong in
   sessionSignals, not the mastery record).
5. **Calibration is uneven, not uniform.** One scholar's sessions were already
   well-calibrated (avg 1.8–2.6); the worst inflation was on long creative/build
   sessions. A blanket "everything is too high" framing would be wrong — the
   failure concentrates in accumulation + creative work.

## What shipped in this pass

### A regression gate: `evals/observer/rigor-check.ts`

Runs the **production** observer on the "modest-expectation" fixtures (sessions
where a rigorous observer should stay LOW and FEW) and gates on the anti-inflation
behaviours, each against a numeric ceiling the fixture declares in `rigorGold`:

| check | what it catches |
|---|---|
| granularity | observation count stays at/under the cap (consolidated, not 35–78) |
| calibration | Analyze+ (≥4.0) rate on modest sessions stays ~0 |
| tutor-credit | no observation exceeds its fixture's mastery ceiling |
| misconception | a planted wrong belief is surfaced as its own signal |
| dedup | no near-duplicate labels within a single run |
| **consolidation** | given a pre-existing near-duplicate pile, the model SUPERSEDES instead of adding a 6th near-duplicate (the prod failure, reproduced) |

Two new fixtures encode the real failure modes found in prod:
- `09-directed-build-inflation` — a kid directs the AI to build a chain-reaction
  animation; the tutor does the conceptual lifting. Gold: ≤3 observations, modest
  Bloom, tutor-supplied physics NOT credited, the "heavier falls faster"
  misconception surfaced.
- `10-consolidation-pile` — a transcript fed alongside a pre-existing pile of 5
  near-duplicate "debugging"/"pricing" observations (mirroring a production
  session). Gold: reuse + supersede, don't pile on; let the inflated old 5.0s be
  corrected DOWN.

Run it after any observer-prompt edit: `evals/observer/rigor-check.sh`
(`MODEL=opus RUNS=3 …`). Exits non-zero on regression.

### The prompt fix (`OBSERVER_SYSTEM_PROMPT`)

1. **"Calibrate honestly"** block under the Bloom anchors: most real chat is
   Understand(2)–Apply(3); Analyze(4)+ requires the SCHOLAR to do the cognitive
   work in their own words; Evaluate/Create(5) is rare and earns ≤1–2 observations
   even in a rich creative session. An explicit "does NOT earn high Bloom" list
   (being told a term, the tutor explaining, directing the AI to build, fixing
   one's own typo, excitement, picking an option) and a tie-break-LOWER rule.
2. **Supersession rewritten to "maintain a SMALL, STABLE record, don't append to
   a pile."** The current-observation list is a record to MAINTAIN; near-variant
   labels are the SAME concept (reuse + supersede, never add a near-duplicate);
   when the list is already long/duplicative, the turn's main job is to
   CONSOLIDATE, and superseding a stale 5.0 with a truthful 3.0 is exactly right.

### Before / after (rigor gate, Sonnet 4.6, 3 runs/fixture)

| metric | before | after |
|---|---|---|
| per-fixture mastery-ceiling breaches | **6** | **0** |
| consolidation pile-ons | 1 | **0** |
| Analyze+ rate on modest sessions | 0% | 0% |
| misconception capture | 100% | 100% |
| near-duplicate labels within a run | 0 | 0 |
| **gate** | **FAIL ❌** | **PASS ✅** |

Concretely, the consolidation fixture's debugging observation dropped 3.5 → 3.0
and the pricing 3.8 → 2.5–3.0, all now superseding the inflated pre-existing rows
instead of piling on. The existing `fluency-check` gate still passes (100% recall,
0% false positives) — the calibration edits didn't disturb fluency behaviour.

## Write-path dedup backstop (the follow-up — now shipped)

The prompt fix bounds consolidation at the *fixture* scale; the worst prod case
(**77 current observations**) is accumulation at a scale a single eval run can't
reproduce, and relies on the model consolidating a long list every turn. So a
model-independent **write-path safety net** was added: when
`masteryObservations.record` writes an observation whose label is a near-duplicate
of an existing CURRENT one for the same scholar **and domain** and the model did
NOT supersede it, the older row is auto-superseded (kept newest, stamped
`autoSuperseded` for audit). Misconceptions are exempt (own lifecycle). Mode via
`OBSERVER_DEDUP_MODE` env (`enforce` default / `shadow` / `off`).

The matcher (`convex/lib/conceptLabels.ts`) is shared with the eval gate, but the
two uses take **different thresholds**: detection (the gate flagging pile-ons)
stays loose (0.7 — a false positive just nudges the model); **enforcement** (the
net + the backfill, which auto-supersede real records) uses a conservative
`AUTO_MERGE_THRESHOLD = 0.85` — effectively "the shorter label's words are a
subset of the longer's". A pure lexical heuristic can't tell a same-concept twin
("…reproduction" vs "…reporting") from a different-concept twin ("Addition of
fractions…" vs "Subtraction of fractions…") at one threshold, so enforcement stays
subset-only and leaves semantic consolidation to the prompt.

**Shadow-validated against real prod (read-only).** Running the matcher over all
**914 current prod observations** at 0.85: it would collapse **371 (41%)** —
overwhelmingly exact duplicates the model re-emitted every run without superseding
(e.g. "Sensor-actuated mechanisms" ×10, "Dose-response relationships in
toxicology" ×7) plus qualifier/suffix variants. At the loose 0.7 it wrongly merged
"Addition of fractions with like denominators" into "Subtraction of fractions…";
0.85 keeps them apart (each only collapses its own exact dups). No cross-concept
false merges remained at 0.85.

**Backfill is owed.** The net only bounds NEW observations; the existing 41% of
duplicate rows still need the one-time
`migrations:consolidateMasteryDuplicates` (dry-run by default — review, snapshot,
then `{"dryRun":false}`). Tracked in `TODO.html` for Andy to run after a closer look.

## How to reproduce / iterate

`evals/observer/README.md` → the rigor gate. To regenerate the prod evidence
(read-only, requires approval — real kids' data, keep it local/gitignored):
`npx convex run evalExport:transcripts '{"minMessages":6,"limit":400}' --prod`.
