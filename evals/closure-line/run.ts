/**
 * Closure-line eval (review/practice/completion-messaging-plan.html, Phase 3) —
 * the anti-parasocial GATE for the governed generator convex/closureLines.ts.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/closure-line/run.ts [--samples N]
 *
 * Feeds the REAL production prompt (convex/lib/closureLinePrompt.ts →
 * CLOSURE_SYSTEM + buildClosureUserMessage) a spread of redacted signal fixtures
 * — the same shapes the practice done-screen and daily recap emit — samples each
 * N times (generation is stochastic), and runs every line through the SAME guard
 * the runtime enforces (shared/closureGuard.ts). Reports the pass rate and prints
 * any line that would have been dropped, so a prompt change that starts leaking
 * praise / numbers / a simulated self is caught before it ships.
 *
 * The guard is deterministic and also unit-tested in shared/closureGuard.test.ts
 * (that's the CI gate); this harness is the live-generation spot-check on top.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../convex/lib/models";
import {
  CLOSURE_SYSTEM,
  CLOSURE_PROMPT_VERSION,
  buildClosureUserMessage,
} from "../../convex/lib/closureLinePrompt";
import { validateClosureLine } from "../../shared/closureGuard";
import type {
  ClosureKind,
  ClosureSignal,
  PracticeSignal,
  DailySignal,
} from "../../shared/closureLines";
import { parseEvalArgs } from "../lib/harness";

const { samples } = parseEvalArgs({
  samples: {
    default: 3,
    parse: (value) => parseInt(value, 10),
    allowOptionLikeValue: true,
  },
});
const SAMPLES = samples;

const anthropic = new Anthropic();

type Case = { id: string; kind: ClosureKind; signal: ClosureSignal };

const practice = (over: Partial<PracticeSignal>): PracticeSignal => ({
  wrap: "session",
  skills: [],
  effortShape: "steady",
  challengeMoved: false,
  frontierSkills: [],
  ...over,
});
const daily = (over: Partial<DailySignal>): DailySignal => ({
  yoursNow: [],
  newOnMap: [],
  practiced: [],
  finished: [],
  practicedCount: 0,
  ...over,
});

const CASES: Case[] = [
  {
    id: "practice-steady",
    kind: "practice",
    signal: practice({ skills: ["adding fractions", "equivalent fractions"], effortShape: "steady" }),
  },
  {
    id: "practice-hard-set",
    kind: "practice",
    signal: practice({ skills: ["long division"], effortShape: "hardSet" }),
  },
  {
    id: "practice-challenge-moved",
    kind: "practice",
    signal: practice({
      wrap: "challenge",
      skills: ["multiplying fractions"],
      effortShape: "stretched",
      challengeMoved: true,
      frontierSkills: ["multiplying fractions"],
    }),
  },
  {
    id: "practice-tuneup",
    kind: "practice",
    signal: practice({ wrap: "tuneup", skills: ["place value", "multiplication facts"] }),
  },
  {
    id: "daily-fluent-and-opened",
    kind: "daily",
    signal: daily({
      yoursNow: ["equivalent fractions"],
      newOnMap: ["comparing fractions"],
      practicedCount: 3,
    }),
  },
  {
    id: "daily-finished-and-practiced",
    kind: "daily",
    signal: daily({
      finished: ["Fraction Sense — Lesson 2"],
      practiced: ["adding within 20"],
      practicedCount: 2,
    }),
  },
];

async function generate(kind: ClosureKind, signal: ClosureSignal): Promise<string> {
  const res = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 120,
    system: CLOSURE_SYSTEM,
    messages: [{ role: "user", content: buildClosureUserMessage(kind, signal) }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text"
    ? block.text.replace(/[\r\n]+/g, " ").replace(/^["'`]+|["'`]+$/g, "").trim()
    : "";
}

async function main() {
  console.log(`closure-line eval · prompt ${CLOSURE_PROMPT_VERSION} · ${MODELS.SONNET}`);
  console.log(`${CASES.length} cases × ${SAMPLES} samples\n`);

  let total = 0;
  let passed = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    const allowedLabels =
      "skills" in c.signal
        ? [...c.signal.skills, ...c.signal.frontierSkills]
        : [
            ...c.signal.yoursNow,
            ...c.signal.newOnMap,
            ...c.signal.practiced,
            ...c.signal.finished,
          ];
    for (let i = 0; i < SAMPLES; i++) {
      const line = await generate(c.kind, c.signal);
      const guard = validateClosureLine(line, { allowedLabels });
      total++;
      if (guard.ok) {
        passed++;
        console.log(`  ✓ [${c.id}] ${line}`);
      } else {
        failures.push(`[${c.id}] (${guard.reason}) ${line}`);
        console.log(`  ✗ [${c.id}] (${guard.reason}) ${line}`);
      }
    }
  }

  const rate = total ? ((passed / total) * 100).toFixed(1) : "0.0";
  console.log(`\nPASS RATE: ${passed}/${total} (${rate}%)`);
  if (failures.length) {
    console.log("\nDROPPED LINES (fallback would render instead):");
    for (const f of failures) console.log("  " + f);
  }
  // The guard is a hard runtime gate, so a healthy prompt should pass ~all of the
  // time. A dropped line is a signal to inspect, not a system failure (the
  // runtime already falls back safely) — but fail CI if the prompt has regressed
  // badly enough that most lines are rejected.
  if (total > 0 && passed / total < 0.8) {
    console.error("\nFAIL: pass rate below 80% — the prompt is leaking off-contract lines.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
