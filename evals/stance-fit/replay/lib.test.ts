// @vitest-environment node
import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DecisionPoint,
  type GenerationsFile,
  type SessionData,
  type VerdictsFile,
  HEADLINES,
  buildPrefix,
  dpKey,
  inferOffersWrapUp,
  joinSamples,
  loadDecisionPoints,
  loadSessions,
  mechanical,
  pairedHeadline,
  questionMarks,
  renderCompare,
} from "./lib";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "synthetic");

const session: SessionData = {
  sessionId: "s1",
  unitTitle: null,
  activityTitle: null,
  readingLevel: "Grade 4",
  messages: [
    { role: "user", content: "<start>" },
    { role: "assistant", content: "Hi! What shall we explore?" },
    { role: "user", content: "volcanoes" },
    { role: "assistant", content: "What do you know already?" },
    { role: "user", content: "no idea" },
    { role: "assistant", content: "Magma is melted rock." },
  ],
};
const dp = (over: Partial<DecisionPoint> = {}): DecisionPoint => ({
  sessionId: "s1",
  scholarIndex: 4,
  tutorIndex: 5,
  state: "stuck_repeating",
  originalMove: "probe_question",
  originalFit: "over_socratic",
  ...over,
});

describe("buildPrefix", () => {
  test("keeps messages[0..scholarIndex] inclusive and drops the shipped tutor turn", () => {
    const prefix = buildPrefix(session, dp());
    expect(prefix).toHaveLength(5);
    expect(prefix.at(-1)).toEqual({ role: "user", content: "no idea" });
    expect(prefix.some((m) => m.content === "Magma is melted rock.")).toBe(false);
  });
  test("rejects misaligned decision points instead of replaying the wrong moment", () => {
    expect(() => buildPrefix(session, dp({ scholarIndex: 3, tutorIndex: 4 }))).toThrow(/not a scholar turn/);
    expect(() => buildPrefix(session, dp({ scholarIndex: 0, tutorIndex: 1 }))).toThrow(/<start>/);
    expect(() => buildPrefix(session, dp({ scholarIndex: 2, tutorIndex: 5 }))).toThrow(/immediately follow/);
    expect(() => buildPrefix(session, dp({ scholarIndex: 40, tutorIndex: 41 }))).toThrow(/out of range/);
  });
  test("allows a final scholar turn with no shipped reply", () => {
    const open = { ...session, messages: session.messages.slice(0, 5) };
    expect(buildPrefix(open, dp())).toHaveLength(5);
  });
  test("wrap-up note follows activity presence", () => {
    expect(inferOffersWrapUp(session)).toBe(true);
    expect(inferOffersWrapUp({ ...session, activityTitle: "Moon Phases" })).toBe(false);
  });
  test("fixture decision points all line up with their transcripts", () => {
    const sessions = loadSessions(FIXTURE);
    for (const point of loadDecisionPoints(FIXTURE)) {
      const s = sessions.get(point.sessionId);
      expect(s, point.sessionId).toBeDefined();
      expect(buildPrefix(s!, point).length).toBe(point.scholarIndex + 1);
    }
  });
});

// ── aggregation ─────────────────────────────────────────────────────────────

function run(label: string, rows: Array<[DecisionPoint, number, string, string, string]>) {
  const gens: GenerationsFile = {
    label, gitSha: "a".repeat(40), convexDiffSha256: null, tutorModel: "m", tutorEffort: null,
    usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, generations: {},
  };
  const verdicts: VerdictsFile = { label, judgeModel: "j", judgePromptSha256: "p".repeat(64), verdicts: {} };
  for (const [point, sample, text, move, fit] of rows) {
    const key = `${dpKey(point)}#${sample}`;
    const textSha256 = `sha-${label}-${key}`;
    gens.generations[key] = {
      key, dpKey: dpKey(point), sample, sessionId: point.sessionId, scholarIndex: point.scholarIndex,
      state: point.state, text, textSha256, systemPromptSha256: "x", generatedAt: "",
    };
    verdicts.verdicts[key] = {
      key, dpKey: dpKey(point), textSha256, scholarState: point.state, tutorMove: move, stanceFit: fit,
      teachingSentences: 0, rationale: "",
    };
  }
  return { gens, verdicts };
}

const stuck1 = dp({ sessionId: "a", scholarIndex: 2, tutorIndex: 3 });
const stuck2 = dp({ sessionId: "b", scholarIndex: 2, tutorIndex: 3 });
const footing = dp({ sessionId: "c", scholarIndex: 2, tutorIndex: 3, state: "has_footing", originalMove: "probe_question", originalFit: "matched" });
const dps = [stuck1, stuck2, footing];

const A = run("A", [
  [stuck1, 1, "Why? Why?", "probe_question", "over_socratic"],
  [stuck1, 2, "Hmm?", "narrowing_hint", "funnel"],
  [stuck2, 1, "What?", "probe_question", "over_socratic"],
  [stuck2, 2, "Here: x.", "direct_explanation", "matched"],
  [footing, 1, "What next?", "probe_question", "matched"],
]);
const B = run("B", [
  [stuck1, 1, "It works like this.", "direct_explanation", "matched"],
  [stuck1, 2, "Example: y.", "worked_example_parallel", "matched"],
  [stuck2, 1, "Answer is z.", "answer_given", "matched"],
  [stuck2, 2, "So?", "probe_question", "over_socratic"],
  [footing, 1, "The answer is all of it.", "direct_explanation", "over_didactic"],
]);

describe("aggregation", () => {
  const a = joinSamples(dps, A.gens, A.verdicts);
  const b = joinSamples(dps, B.gens, B.verdicts);
  const metric = (prefix: string) => HEADLINES.find((h) => h.name.startsWith(prefix))!;

  test("stuck→teaching rate is the mean of per-dp rates, with paired direction counts", () => {
    const h = pairedHeadline(metric("stuck_repeating"), a, b, dps);
    expect(h.nDp).toBe(2);
    expect(h.rateA).toBeCloseTo(0.25); // dp a: 0/2, dp b: 1/2
    expect(h.rateB).toBeCloseTo(0.75); // dp a: 2/2, dp b: 1/2
    expect(h.rateOriginal).toBe(0); // both originals were probe_question
    expect([h.bBetter, h.bWorse, h.ties]).toEqual([1, 0, 1]);
  });

  test("over_socratic+funnel and over_didactic span all states", () => {
    const soc = pairedHeadline(metric("over_socratic"), a, b, dps);
    expect(soc.nDp).toBe(3);
    expect(soc.rateA).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(soc.rateB).toBeCloseTo((0 + 0.5 + 0) / 3);
    const did = pairedHeadline(metric("over_didactic"), a, b, dps);
    expect(did.rateA).toBe(0);
    expect(did.rateB).toBeCloseTo(1 / 3);
    expect(did.bWorse).toBe(1);
  });

  test("control metric reports raw up/down", () => {
    const h = pairedHeadline(metric("has_footing → probe_question (control)"), a, b, dps);
    expect([h.rateA, h.rateB, h.bBetter, h.bWorse]).toEqual([1, 0, 0, 1]);
  });

  test("only decision points present in both runs are paired", () => {
    const onlyA = run("A", [[dp({ sessionId: "z", scholarIndex: 2, tutorIndex: 3 }), 1, "?", "probe_question", "over_socratic"]]);
    const h = pairedHeadline(metric("stuck_repeating"), joinSamples(dps, onlyA.gens, onlyA.verdicts), b, dps);
    expect(h.nDp).toBe(0);
    expect(h.rateA).toBeNull();
  });

  test("a verdict for an older generation is dropped as stale", () => {
    const stale = run("A", [[stuck1, 1, "x", "probe_question", "funnel"]]);
    stale.verdicts.verdicts[`${dpKey(stuck1)}#1`].textSha256 = "old";
    expect(joinSamples(dps, stale.gens, stale.verdicts)).toHaveLength(0);
  });

  test("mechanical metrics count '?' and words", () => {
    expect(questionMarks("Why? Really?")).toBe(2);
    const m = mechanical(a);
    expect(m.n).toBe(5);
    expect(m.questionMarks).toBeCloseTo((2 + 1 + 1 + 0 + 1) / 5);
  });

  test("report renders headline, per-state tables, and warns on judge drift", () => {
    const md = renderCompare({ labelA: "A", labelB: "B", dps, gensA: A.gens, gensB: B.gens, verdictsA: A.verdicts, verdictsB: B.verdicts });
    expect(md).toContain("Paired decision points: **3**");
    expect(md).toContain("### stuck_repeating (2 dp; A n=4, B n=4)");
    expect(md).not.toContain("Warning");
    const drifted = { ...B.verdicts, judgePromptSha256: "q".repeat(64) };
    expect(renderCompare({ labelA: "A", labelB: "B", dps, gensA: A.gens, gensB: B.gens, verdictsA: A.verdicts, verdictsB: drifted })).toContain("judge drift");
  });
});
