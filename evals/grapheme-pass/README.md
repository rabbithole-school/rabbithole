# Grapheme-pass — mechanical eval for the reading-ramp annotator

Scores the grapheme-team annotation pass (`convex/lib/graphemeAnnotate.ts` +
`convex/graphemeActions.ts`) against a fixture of hand-segmented words and short
sentences. **No LLM judge** — correctness here is objective (a span is either at
the right offsets for the right team or it isn't), so this is a plain
precision/recall harness.

Background: the young-learners reading ramp (`review/young-learners-plan.html`
§10) colors grapheme teams (digraphs / vowel teams / doubled letters like "sh",
"th", "ea", "oo") inside on-screen tutor text — Mentava-style training wheels so
a pre-reader sees the letters of a team as one sound-unit. English
grapheme→phoneme mapping is context-dependent, so the annotator is a cheap Haiku
judgment pass, not a rule engine — and *because* it's a model, it needs an eval.

## The contract being tested

A **grapheme team** is a contiguous multi-letter spelling a beginning reader
learns as ONE sound-unit (digraph, trigraph, vowel team, or doubled letters).
The team string is its letters, lowercased (`"sh"`, `"th"`, `"ch"`, `"ea"`,
`"oo"`, `"ll"`, `"ck"`, …).

`annotate({ text, teams })` returns `{ start, end, team }[]` — the character
offsets where an occurrence of a team's letters TRULY functions as that team's
single **target sound**. An occurrence is **FALSE** (not annotated) when either:

1. **Syllable / morpheme boundary** — the letters sit in different syllables and
   are pronounced separately: `sh` in *mis·hap*, `th` in *hot·house*, `oo` in
   *co·operate*.
2. **Different sound** — the letters make a sound other than the team's target
   phoneme. With `ch` trained as /tʃ/ (*chair*), the `ch` in *school* (/k/) and
   *chef* (/ʃ/) are FALSE. `th` is the one team whose target covers BOTH the
   voiced (*then*) and unvoiced (*thin*) dental fricative.

Guarantees enforced in `graphemeAnnotate.ts` (not by the model):

- **Offsets are computed locally** from the source text; the model only *judges*
  a pre-enumerated candidate list (it returns candidate ids, never raw offsets).
- **The text is never altered.** Every emitted span provably matches the team's
  letters at those offsets (`validateSpans`), overlaps are dropped, and an empty
  inventory / no-candidate case short-circuits with **no model call**.

**Out of v1 scope:** the split/discontinuous **silent-e (magic-e)** pattern
(vowel … consonant … silent *e*) — it isn't a contiguous `[start, end)` substring
and would need a different span shape. It never appears in the fixtures.

## Run

```bash
ANTHROPIC_API_KEY=... npx tsx evals/grapheme-pass/run.ts
```

| Flag | Default | Meaning |
|---|---|---|
| `--model <id>` | `MODELS.HAIKU` | model under test (what ships) |
| `--fixtures <path>` | `./fixtures/segmentations.json` | fixture file |
| `--concurrency N` | `6` | parallel API calls |
| `--threshold F` | `0.92` | min overall F1; exit non-zero below it |
| `--out DIR` | `./out` | writes `results.json` (gitignored) |
| `--verbose` | off | print every case's diff, not just failures |

The runner imports the EXACT prompt, tool schema, and validation logic the
production action uses (from `convex/lib/graphemeAnnotate.ts`) — the eval can't
drift from what ships. It calls the Anthropic API inline (no Convex deployment
needed), the same way `evals/observer/` and `evals/spot-eval/` do.

## How the gold is authored

Each fixture case declares the scholar's `inventory` (the teams currently
trained) and a `marked` string: the tutor text with every TRUE team occurrence
wrapped in square brackets, e.g. `"The [sh]ip is near [th]e [sh]ore."` The runner
strips the brackets to recover the plain text and derives the gold span offsets —
**nothing is hand-counted**. An unbracketed occurrence of an inventory team is
gold-negative (the model must NOT annotate it), which is how false surface
matches (*mishap*, *school*) are tested. A bracketed team not in the case's
inventory fails the run loudly (authoring guard).

Scoring keys each span by `start:end:team` and reports precision / recall / F1
per team and overall (`tp` = correct spans, `fp` = over-annotations, `fn` =
missed teams).

## Baseline (observed)

`MODELS.HAIKU` (`claude-haiku-4-5-20251001`), 70 cases / 64 gold spans, temp 0,
after three prompt-iteration rounds:

| | precision | recall | F1 |
|---|---:|---:|---:|
| **Overall** | **98.5%** | **100.0%** | **99.2%** |

Per-team every team scores 100% except `th` (P 91.7%, R 100%) — see below. The
iteration arc (why the eval earns its keep):

| round | change | P | R | F1 |
|---|---|---:|---:|---:|
| 1 | initial prompt | 93.8% | 95.3% | 94.6% |
| 2 | + "capitals are the same team", + precision bias, + proper-noun caution | 98.3% | 92.2% | 95.2% |
| 3 | recalibrated: names decode normally except *named* irregulars; softened bias | **98.5%** | **100.0%** | **99.2%** |

Round 2 shows the classic over-correction: blunt "proper nouns break the rules"
guidance fixed *Thomas*/*Chicago* (FP↓) but scared the model off regular names
*Josh*/*Beth*/*Rachel* (recall↓). Round 3 split the difference — "most names
decode normally; mark FALSE only for a known irregular where the letters plainly
make a different sound (Thomas /t/, Chicago /ʃ/, Christmas /k/)."

The threshold is **0.92** — comfortably below the 99.2% baseline, so a genuine
regression (≈5+ new errors) fails CI while the one known hard case and minor
run-to-run variance don't flake it.

## Known failure modes

- **Compound morpheme boundaries** are the one soft spot. `th` in *sweetheart*
  (sweet·heart → t+h, pronounced separately) is consistently over-annotated even
  though the prompt lists it as FALSE — it's the sole failing case at baseline.
  *lighthouse* (light·house) and *hothouse* (hot·house) are handled correctly, so
  the boundary rule mostly works; deep compounds are the residue.
- **Silent-e is not attempted** (out of scope, above).
- **`ng`** is treated as TRUE for clear /ŋ/ endings (*ring*, *-ing*); the murkier
  /ŋɡ/ (*finger*) and /ndʒ/ (*ranger*) cases are deliberately kept out of the
  fixture rather than asserting a debatable gold.
- Numbers are a small sample per team (many teams have 1–4 gold spans), so a
  single miss swings a per-team rate hard — read the **overall** row as the
  signal and per-team as a diagnostic.
