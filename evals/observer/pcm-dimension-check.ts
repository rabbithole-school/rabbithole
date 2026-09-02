/**
 * PCM-dimension tagging gate — a focused eval for the observer's OPTIONAL
 * `pcmDimension` tag (review/assessment-and-goals-plan.html §11's calibration
 * loop needs this tag reliably present so the right kind of evidence briefs
 * the right dimension of a teacher's course narrative — see the "PCM
 * dimension" section of convex/prompts.ts and convex/lib/pcm.ts's
 * PCM_DIMENSIONS).
 *
 * Four fixtures (evals/observer/fixtures/11..14-pcm-*.json), each
 * hand-engineered to clearly exercise exactly ONE dimension:
 *   - 11-pcm-core-demonstration          → core        (an unprompted,
 *     straight demonstration of essential knowledge — photosynthesis — with
 *     no cross-domain link, no revision, no identity framing)
 *   - 12-pcm-connections-unprompted      → connections (an unprompted
 *     interdisciplinary link — Fibonacci across biology/math/art)
 *   - 13-pcm-practice-revised-hypothesis → practice    (designed an
 *     investigation, revised the conclusion when the data disagreed, cited
 *     a source)
 *   - 14-pcm-identity-harder-path        → identity    (chose the harder
 *     path, named the kind of thinker they want to be)
 *
 * Runs the PRODUCTION observer — reusing evals/observer/lib/runObserver.ts,
 * which imports the real OBSERVER_TOOL schema + parseObserverResponse
 * (convex/lib/observerShared.ts) and the real OBSERVER_SYSTEM_PROMPT
 * (convex/prompts.ts), so this gate can't drift from what actually ships —
 * `RUNS` times per fixture, and checks whether the expected pcmDimension
 * shows up on ANY observation / sessionSignal / crossDomainConnection the
 * observer emits that run.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/observer/pcm-dimension-check.ts
 *   ./evals/observer/pcm-dimension-check.sh              # sonnet, the live observer model
 *   MODEL=opus RUNS=5 npx tsx evals/observer/pcm-dimension-check.ts
 *
 * See README-pcm-dimension-check.md for the full invocation note. Exits
 * non-zero if the live observer's pcmDimension tagging regresses (hit rate
 * below the gate on any fixture). If ANTHROPIC_API_KEY isn't set, prints a
 * clear message and exits 0 — this harness makes real Anthropic calls, it
 * does not mock them.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS } from "../../convex/lib/models";
import { OBSERVER_TOOL, type ObserverResult } from "../../convex/lib/observerShared";
import { PCM_DIMENSIONS, type PcmDimension } from "../../convex/lib/pcm";
import { runObserver, type TranscriptCase } from "./lib/runObserver";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_MAP: Record<string, string> = { sonnet: MODELS.SONNET, opus: MODELS.OPUS, haiku: MODELS.HAIKU };
const model = MODEL_MAP[process.env.MODEL ?? "sonnet"] ?? MODELS.SONNET;
const runs = parseInt(process.env.RUNS ?? "3", 10); // LLMs sample — average a few
const HIT_RATE_GATE = 0.5; // majority of runs must tag the expected dimension somewhere

type PcmGold = { expectedDimension: PcmDimension };
type GatingCase = TranscriptCase & { pcmGold: PcmGold };

const FIXTURE_IDS = [
  "11-pcm-core-demonstration",
  "12-pcm-connections-unprompted",
  "13-pcm-practice-revised-hypothesis",
  "14-pcm-identity-harder-path",
];

function load(id: string): GatingCase {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", `${id}.json`), "utf8"));
  return { ...raw, source: "fixture" as const };
}

/**
 * Sanity-checks that the real tool schema still exposes `pcmDimension` with
 * the enum this gate assumes — fails loudly, before any API calls, if
 * convex/lib/observerShared.ts's OBSERVER_TOOL ever drifts from
 * convex/lib/pcm.ts's PCM_DIMENSIONS.
 */
function assertSchemaInSync(): void {
  const obsProps = OBSERVER_TOOL.input_schema.properties.observations.items.properties as {
    pcmDimension?: { enum?: readonly string[] };
  };
  const enumValues = obsProps.pcmDimension?.enum;
  if (!enumValues) {
    throw new Error(
      "OBSERVER_TOOL.observations no longer exposes a pcmDimension enum — update this gate or convex/lib/observerShared.ts",
    );
  }
  const missing = PCM_DIMENSIONS.filter((d) => !enumValues.includes(d));
  if (missing.length) {
    throw new Error(
      `OBSERVER_TOOL's pcmDimension enum is missing: ${missing.join(", ")} — convex/lib/pcm.ts's PCM_DIMENSIONS drifted from convex/lib/observerShared.ts's OBSERVER_TOOL`,
    );
  }
}

interface EvidenceTag {
  kind: "observation" | "signal" | "connection";
  label: string;
  dimension: PcmDimension | undefined;
}

function collectTags(result: ObserverResult): EvidenceTag[] {
  const tags: EvidenceTag[] = [];
  for (const o of result.observations ?? [])
    tags.push({ kind: "observation", label: o.conceptLabel, dimension: o.pcmDimension });
  for (const s of result.sessionSignals ?? [])
    tags.push({ kind: "signal", label: s.signalType, dimension: s.pcmDimension });
  for (const c of result.crossDomainConnections ?? [])
    tags.push({ kind: "connection", label: c.domains.join("+"), dimension: c.pcmDimension });
  return tags;
}

function tagStr(t: EvidenceTag): string {
  return `${t.kind}:${t.dimension ?? "—"}`;
}

async function main() {
  assertSchemaInSync();
  console.error(`[pcm-dimension-check] model=${model} runs=${runs}`);

  const cases = FIXTURE_IDS.map(load);
  const rows: { id: string; expected: PcmDimension; hits: number; runs: number; tagsSeen: string[] }[] = [];
  const notes: string[] = [];

  for (const c of cases) {
    let hits = 0;
    const tagsSeen = new Set<string>();
    for (let r = 0; r < runs; r++) {
      const out = await runObserver(c, model);
      if (!out.result) {
        notes.push(`${c.id} run ${r}: ERROR ${out.error}`);
        continue;
      }
      const tags = collectTags(out.result);
      for (const t of tags) tagsSeen.add(tagStr(t));
      const hit = tags.some((t) => t.dimension === c.pcmGold.expectedDimension);
      if (hit) hits++;
      else
        notes.push(
          `${c.id} run ${r}: MISS — expected '${c.pcmGold.expectedDimension}', saw [${tags.map(tagStr).join(", ") || "(no evidence emitted)"}]`,
        );
      console.error(`  [${c.id} run ${r}] ${hit ? "hit" : "miss"} — tags: ${tags.map(tagStr).join(", ") || "(none)"}`);
    }
    rows.push({ id: c.id, expected: c.pcmGold.expectedDimension, hits, runs, tagsSeen: [...tagsSeen] });
  }

  // ── pass/miss table ──
  console.error(`\n[pcm-dimension-check] results (gate: hit rate >= ${Math.round(HIT_RATE_GATE * 100)}%)\n`);
  console.error(`| fixture | expected | hit rate | tags seen |`);
  console.error(`|---|---|---|---|`);
  for (const row of rows) {
    const rate = row.runs ? row.hits / row.runs : 0;
    console.error(
      `| ${row.id} | ${row.expected} | ${row.hits}/${row.runs} (${Math.round(rate * 100)}%) | ${row.tagsSeen.join(", ") || "(none)"} |`,
    );
  }
  if (notes.length) console.error("\n" + notes.map((n) => "  · " + n).join("\n"));

  const pass = rows.every((row) => (row.runs ? row.hits / row.runs : 0) >= HIT_RATE_GATE);
  console.error(`\n[pcm-dimension-check] ${pass ? "PASS ✅" : "FAIL ❌"}`);
  if (!pass) process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "[pcm-dimension-check] No ANTHROPIC_API_KEY set — skipping (this harness makes real Anthropic calls; nothing to run without a key).",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
