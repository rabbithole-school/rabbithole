/**
 * Fluency gate — a focused eval for the observer's OPTIONAL automaticity
 * (fluencyLevel) emission (proposal §7.5). Runs the PRODUCTION observer on the
 * fluency fixtures and checks the one behaviour the prompt change asks for:
 *
 *   - a clear automatic-recall moment (12×4 answered instantly) → fluencyLevel set
 *   - deep reasoning / productive struggle → fluencyLevel OMITTED (depth ≠ fluency)
 *
 * This is the gate the §7.5 prompt change ships behind — run it after editing
 * the observer prompt/schema:
 *
 *   evals/observer/fluency-check.sh            # sonnet (the live observer model)
 *   MODEL=opus evals/observer/fluency-check.sh
 *
 * Exits non-zero if the live observer's fluency behaviour regresses.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS } from "../../convex/lib/models";
import { runObserver, type TranscriptCase } from "./lib/runObserver";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_MAP: Record<string, string> = { sonnet: MODELS.SONNET, opus: MODELS.OPUS, haiku: MODELS.HAIKU };
const model = MODEL_MAP[process.env.MODEL ?? "sonnet"] ?? MODELS.SONNET;
const runs = parseInt(process.env.RUNS ?? "2", 10); // a couple of samples — LLMs vary

function load(id: string): TranscriptCase {
  return { ...JSON.parse(readFileSync(join(HERE, "fixtures", `${id}.json`), "utf8")), source: "fixture" as const };
}

// Heuristic: does a concept label look like times-tables / multiplication-fact recall?
const isRecallConcept = (label: string) =>
  /multipl|times.?table|arithmetic|number fact|fact fluency|mental math/i.test(label);

function pct(n: number, d: number) {
  return d ? `${Math.round((100 * n) / d)}%` : "n/a";
}

async function main() {
  console.error(`[fluency-gate] model=${model} runs=${runs}`);
  const cases = [load("08-automaticity-fluency"), load("05-gifted-asynchrony")];

  let recallHit = 0; // automatic-recall concept got a fluency reading
  let recallTotal = 0;
  let falsePositives = 0; // a NON-recall, deep-reasoning concept got fluency
  let nonRecallTotal = 0;
  const notes: string[] = [];

  for (let r = 0; r < runs; r++) {
    for (const c of cases) {
      const out = await runObserver(c, model);
      if (!out.result) {
        notes.push(`run ${r} / ${c.id}: ERROR ${out.error}`);
        continue;
      }
      const obs = out.result.observations ?? [];
      const recall = obs.filter((o) => isRecallConcept(o.conceptLabel));
      const nonRecall = obs.filter((o) => !isRecallConcept(o.conceptLabel));
      // Did at least one recall concept get a fluency reading this run?
      if (recall.length) {
        recallTotal++;
        const withFlu = recall.find((o) => o.fluencyLevel);
        if (withFlu) recallHit++;
        else notes.push(`run ${r} / ${c.id}: recall concept(s) [${recall.map((o) => o.conceptLabel).join(", ")}] got NO fluency`);
      }
      // Any non-recall concept stamped with fluency is a false positive
      // (depth/struggle wrongly read as fluency).
      for (const o of nonRecall) {
        nonRecallTotal++;
        if (o.fluencyLevel) {
          falsePositives++;
          notes.push(`run ${r} / ${c.id}: FALSE POSITIVE — "${o.conceptLabel}" got fluencyLevel ${o.fluencyLevel}`);
        }
      }
      const fluSummary = obs
        .filter((o) => o.fluencyLevel)
        .map((o) => `${o.conceptLabel}=${o.fluencyLevel}`)
        .join("; ");
      console.error(`  [run ${r}] ${c.id}: ${obs.length} obs · fluency: ${fluSummary || "(none)"}`);
    }
  }

  console.error(`\n[fluency-gate] recall concepts that earned a reading: ${recallHit}/${recallTotal} (${pct(recallHit, recallTotal)})`);
  console.error(`[fluency-gate] false positives (depth/struggle read as fluency): ${falsePositives}/${nonRecallTotal} (${pct(falsePositives, nonRecallTotal)})`);
  if (notes.length) console.error("\n" + notes.map((n) => "  · " + n).join("\n"));

  // Gate: the automatic-recall moment should USUALLY earn a reading, and
  // deep-reasoning concepts should RARELY be stamped (the prompt's whole point
  // is "usually omit"). Thresholds are loose because LLMs sample.
  const recallRate = recallTotal ? recallHit / recallTotal : 0;
  const fpRate = nonRecallTotal ? falsePositives / nonRecallTotal : 0;
  const pass = recallRate >= 0.5 && fpRate <= 0.1;
  console.error(`\n[fluency-gate] ${pass ? "PASS ✅" : "FAIL ❌"} (recall≥50% & false-positives≤10%)`);
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
