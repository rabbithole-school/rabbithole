# Attribution — vendored Learning Commons rubric content

The files under [`rubrics/`](./rubrics/) are copied from Learning Commons'
open evaluators so this cross-check can run **offline, telemetry-free, on our
own models**, without depending on the `@learning-commons/evaluators` SDK.

## Source

- **Project:** Learning Commons Evaluators (Chan Zuckerberg Initiative)
- **Repository:** https://github.com/learning-commons-org/evaluators
- **Commit:** `fcdf01c006a347e09aee042f986b95cac9f59456` (2026-06-30)
- **Checksums:** every vendored file's sha256 is pinned in
  [`rubrics/MANIFEST.json`](./rubrics/MANIFEST.json) and verified by
  `__tests__/rubrics.test.ts`.

## Licences

Per the upstream `LICENSE.md`:

- **Evaluator _code_** is licensed **MIT**.
- **Evaluator _content_ (prompts + settings)** is provided by Learning Commons
  under **CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>).

The files we vendor here are **prompt/settings content**, so they are used under
**CC BY 4.0**. CC BY 4.0 requires attribution and an indication of any changes —
both provided below.

> Rubric prompts © Learning Commons (Chan Zuckerberg Initiative), used under
> CC BY 4.0. Changes: see "Modifications" below. This attribution does not imply
> endorsement by Learning Commons of Rabbithole or of these modifications.

## Vendored files

| Vendored path | Upstream path | Verbatim? |
|---|---|---|
| `rubrics/productive-coaching/manageable/system.txt` | `evals/feedback/productive-coaching-writing-feedback/manageable/system.txt` | yes |
| `rubrics/productive-coaching/manageable/user.txt` | …/`manageable/user.txt` | yes |
| `rubrics/productive-coaching/manageable/output_schema.json` | …/`manageable/output_schema.json` | yes |
| `rubrics/productive-coaching/acknowledges-strength/system.txt` | …/`acknowledges-strength/system.txt` | yes |
| `rubrics/productive-coaching/acknowledges-strength/user.txt` | …/`acknowledges-strength/user.txt` | yes |
| `rubrics/productive-coaching/acknowledges-strength/output_schema.json` | …/`acknowledges-strength/output_schema.json` | yes |
| `rubrics/grade-level-appropriateness/system.txt` | `evals/prompts/grade-level-appropriateness/system.txt` | yes |
| `rubrics/grade-level-appropriateness/user.txt` | `evals/prompts/grade-level-appropriateness/user.txt` | yes |
| `rubrics/grade-level-appropriateness/output_schema.json` | _(transcribed — see below)_ | transcription |

## Modifications

The vendored **`.txt` prompt files are byte-for-byte copies** (the coaching
`system.txt`/`user.txt` sha256 values here even match the hashes recorded in
upstream's own `config.json`). What differs is only how we *consume* them; the
files on disk are unchanged:

1. **`{format_instructions}` placeholder** (grade-level `user.txt`) is replaced
   with an empty string at runtime — the forced tool schema already pins the
   output shape. The vendored file still contains the placeholder.
2. **Local `$ref`/`$defs` in the output schemas** are dereferenced *in memory*
   at load time (`lib/rubrics.ts`) because the Anthropic tool API doesn't follow
   `$ref`. The vendored `output_schema.json` files are unchanged.
3. **`grade-level-appropriateness/output_schema.json` is a transcription**, not
   a copy: upstream ships this schema only as a TypeScript Zod object
   (`sdks/typescript/src/schemas/grade-level-appropriateness.ts`). We transcribed
   it faithfully to JSON Schema so the vendored prompt can drive a structured
   tool call. Fields, descriptions, and the grade-band enum match the Zod source.

To **re-sync** from a newer upstream: re-copy the file(s), update the sha256 in
`rubrics/MANIFEST.json`, and bump `upstreamCommit`. The drift-guard test will
otherwise fail, which is the point.
