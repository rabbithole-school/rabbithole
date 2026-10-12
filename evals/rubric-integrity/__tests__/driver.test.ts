/**
 * Driver wiring: does a session's ledger actually collect every accepted
 * `update_rubric_score` call, and does the summary survive a prose-only final
 * turn? `runRubricTutor` is mocked so this never loads the Anthropic SDK and
 * never needs a key — the reduction rule itself is covered separately in
 * rubricCallRecord.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RubricCase } from "../lib/types";

type AcceptedRubricCall = {
  roundIndex: number;
  verdicts: { criterionId: string; level: "not" | "half" | "full" }[];
  overall: "not" | "half" | "full";
};

type TutorTurn = {
  text: string;
  calls: AcceptedRubricCall[];
};

/** Scripted tutor replies, consumed one per scholar turn. */
const scriptedTutorTurns: TutorTurn[] = [];

const generateTutorTurnMock = vi.fn(async (..._args: unknown[]) => {
  const next = scriptedTutorTurns.shift();
  if (!next) throw new Error("driver asked for more tutor turns than scripted");
  return next;
});

vi.mock("../lib/runRubricTutor", () => ({
  generateTutorTurn: (...args: unknown[]) => generateTutorTurnMock(...args),
}));

const { runRubricSession, normalizeStep } = await import("../lib/driver");
const { rubricCheckInstruction } = await import(
  "../../../convex/sessionStreamHelpers"
);

const CASE: RubricCase = {
  id: "test-case",
  activityTitle: "Field notebook",
  deliverablePrompt: "Write up what you noticed.",
  criteria: [
    { id: "prediction", label: "Makes a prediction" },
    { id: "evidence", label: "Cites evidence" },
  ],
  probedCriterionId: "prediction",
  script: ["turn one", "turn two", "turn three"],
  artifactVisibleFromTurn: 1,
  finalArtifactContent: "I thnk the plant will gro tallr in the sun.",
  expectation: "should-be-full",
};

type Levels = {
  prediction: "not" | "half" | "full";
  evidence: "not" | "half" | "full";
};

function accepted(levels: Levels, roundIndex: number): AcceptedRubricCall {
  const verdicts = [
    { criterionId: "prediction", level: levels.prediction },
    { criterionId: "evidence", level: levels.evidence },
  ];
  const overall = verdicts.some((v) => v.level === "not")
    ? ("not" as const)
    : verdicts.some((v) => v.level === "half")
      ? ("half" as const)
      : ("full" as const);
  return { roundIndex, verdicts, overall };
}

/** A tutor turn with zero, one, or several accepted calls (one per round). */
function tutor(text: string, ...levels: Levels[]): TutorTurn {
  return { text, calls: levels.map(accepted) };
}

function loadScript(turns: TutorTurn[]) {
  scriptedTutorTurns.length = 0;
  scriptedTutorTurns.push(...turns);
}

describe("runRubricSession", () => {
  test("THE BUG: a mid-session verdict survives a prose-only final turn", async () => {
    loadScript([
      tutor("What do you think will happen?"),
      tutor("Got it — I can see your prediction.", {
        prediction: "full",
        evidence: "full",
      }),
      tutor("That's the part I already gave you credit for — nice work."),
    ]);

    const result = await runRubricSession(CASE, { warn: () => {} });

    expect(result.rubricCalls).toHaveLength(1);
    expect(result.rubricCalls[0].turnIndex).toBe(1);
    expect(result.rubricCalls[0].roundIndex).toBe(0);
    expect(result.rubricCalls[0].onFinalTurn).toBe(false);
    expect(result.verdictRecorded).toBe(true);
    expect(result.recordedOnFinalTurn).toBe(false);
    expect(result.probedCriterionLevel).toBe("full");
    expect(result.allCriteriaFull).toBe(true);
    expect(result.probedCriterionDowngraded).toBe(false);
    // The scholar-visible text is still the FINAL turn's — that has not changed.
    expect(result.finalTurnText).toContain("already gave you credit");
    expect(result.finalTextIsSubstantive).toBe(true);
  });

  test("a session with no accepted call records nothing", async () => {
    loadScript([
      tutor("What do you think will happen?"),
      tutor("Tell me more about that."),
      tutor("Say a bit more about what you'd measure."),
    ]);

    const result = await runRubricSession(CASE, { warn: () => {} });

    expect(result.rubricCalls).toHaveLength(0);
    expect(result.verdictRecorded).toBe(false);
    expect(result.probedCriterionLevel).toBeNull();
    expect(result.allCriteriaFull).toBe(false);
  });

  test("a walk-back is announced, not swallowed", async () => {
    loadScript([
      tutor("What do you think will happen?"),
      tutor("Crediting your prediction.", { prediction: "full", evidence: "full" }),
      tutor("Actually, on a re-read I want more there.", {
        prediction: "half",
        evidence: "full",
      }),
    ]);

    const warnings: string[] = [];
    const result = await runRubricSession(CASE, {
      warn: (m) => warnings.push(m),
    });

    expect(result.rubricCalls).toHaveLength(2);
    expect(result.probedCriterionLevel).toBe("full");
    expect(result.probedCriterionFinalLevel).toBe("half");
    expect(result.probedCriterionDowngraded).toBe(true);
    expect(result.probedCriterionDowngradedWithinTurn).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("prediction");
    expect(warnings[0]).toContain("walked back");
    expect(warnings[0]).toContain("across turns");
  });

  test("THE ROUND-LEVEL BUG: both calls from ONE turn reach the ledger", async () => {
    // Nothing to assert about turn ordering here — the point is that a turn
    // which scores `full` and then corrects itself to `half` before it ever
    // replies contributes TWO entries. The collapsed `{ called, verdicts,
    // overall }` shape this driver used to consume kept only the `half`, which
    // hid a peak production had already minted flair for.
    loadScript([
      tutor("What do you think will happen?"),
      tutor(
        "Second look — I want a bit more there.",
        { prediction: "full", evidence: "full" },
        { prediction: "half", evidence: "full" },
      ),
      tutor("Say more about what you'd measure — what would you count?"),
    ]);

    const warnings: string[] = [];
    const result = await runRubricSession(CASE, {
      warn: (m) => warnings.push(m),
    });

    expect(result.rubricCalls).toHaveLength(2);
    expect(result.rubricCalls.map((c) => [c.turnIndex, c.roundIndex])).toEqual([
      [1, 0],
      [1, 1],
    ]);
    expect(result.probedCriterionLevel).toBe("full");
    expect(result.probedCriterionFinalLevel).toBe("half");
    expect(result.probedCriterionDowngraded).toBe(true);
    expect(result.probedCriterionDowngradedWithinTurn).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("WITHIN ONE TURN");
  });

  test("the flair set is session-scoped, mirroring production's row", async () => {
    // The driver owns the set and hands the SAME one to every turn, so a
    // criterion re-scored `full` later is not re-announced as newly earned —
    // production seeds it from the deliverable row's existing `flairEarned`.
    const seen: (Set<string> | undefined)[] = [];
    generateTutorTurnMock.mockImplementation(async (...args: unknown[]) => {
      seen.push(args[4] as Set<string> | undefined);
      const next = scriptedTutorTurns.shift();
      if (!next) throw new Error("driver asked for more tutor turns than scripted");
      return next;
    });
    loadScript([tutor("One."), tutor("Two."), tutor("Three.")]);

    await runRubricSession(CASE, { warn: () => {} });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBeInstanceOf(Set);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  test("every scripted scholar turn and tutor reply lands in the transcript", async () => {
    loadScript([
      tutor("One."),
      tutor("Two.", { prediction: "full", evidence: "full" }),
      tutor("Three."),
    ]);

    const result = await runRubricSession(CASE, { warn: () => {} });

    expect(result.turns.map((t) => t.role)).toEqual([
      "scholar",
      "tutor",
      "scholar",
      "tutor",
      "scholar",
      "tutor",
    ]);
  });
});

/**
 * The script-item shapes the goalpost probe added. Same mocked tutor, so this
 * is still pure wiring: does the driver play seeded turns without spending a
 * model call, does a "Check my work" click land as production's own ephemeral
 * user-role instruction, and does a per-step document override take over from
 * the legacy fixed reveal?
 */
const GOALPOST_CASE: RubricCase = {
  ...CASE,
  id: "goalpost-shapes",
  activityTitle: "Discussion card",
  // Deliberately absent: this fixture shape reveals its document per step.
  artifactVisibleFromTurn: undefined,
  finalArtifactContent: undefined,
  script: [],
};

/** Per-turn call args the mock saw: [caseArg, documentContent, turns, ...]. */
function documentArgs(): (string | null)[] {
  return generateTutorTurnMock.mock.calls.map(
    (c) => c[1] as string | null,
  );
}

describe("runRubricSession — script item shapes", () => {
  beforeEach(() => {
    generateTutorTurnMock.mockReset();
    generateTutorTurnMock.mockImplementation(async (..._args: unknown[]) => {
      const next = scriptedTutorTurns.shift();
      if (!next) throw new Error("driver asked for more tutor turns than scripted");
      return next;
    });
  });

  test("normalizeStep keeps a bare string meaning exactly what it meant", () => {
    expect(normalizeStep("hello")).toEqual({ kind: "scholar", text: "hello" });
    expect(normalizeStep({ role: "scholar", text: "hi", document: "DOC" })).toEqual({
      kind: "scholar",
      text: "hi",
      document: "DOC",
    });
    expect(normalizeStep({ role: "tutor", text: "seeded" })).toEqual({
      kind: "tutor",
      text: "seeded",
    });
    expect(normalizeStep({ role: "check" })).toEqual({
      kind: "check",
      document: undefined,
    });
  });

  test("a legacy all-strings script is untouched: one model call per step, fixed reveal", async () => {
    loadScript([tutor("One."), tutor("Two."), tutor("Three.")]);

    const result = await runRubricSession(CASE, { warn: () => {} });

    expect(generateTutorTurnMock).toHaveBeenCalledTimes(3);
    // CASE.artifactVisibleFromTurn is 1 — no document on step 0, then the
    // fixture's finalArtifactContent from step 1 on.
    expect(documentArgs()).toEqual([
      null,
      CASE.finalArtifactContent,
      CASE.finalArtifactContent,
    ]);
    expect(result.finalDocumentContent).toBe(CASE.finalArtifactContent);
  });

  test("a seeded tutor turn is played verbatim and costs no model call", async () => {
    loadScript([tutor("generated reply")]);

    const result = await runRubricSession(
      {
        ...GOALPOST_CASE,
        script: [
          { role: "scholar", text: "first", document: "DOC v1" },
          { role: "tutor", text: "'near the end' is enough." },
          { role: "scholar", text: "second" },
        ],
      },
      { warn: () => {} },
    );

    // The scholar step immediately before a seeded turn gets NO generated
    // reply — the seeded turn IS the reply.
    expect(generateTutorTurnMock).toHaveBeenCalledTimes(1);
    expect(result.turns).toEqual([
      { role: "scholar", content: "first" },
      { role: "tutor", content: "'near the end' is enough." },
      { role: "scholar", content: "second" },
      { role: "tutor", content: "generated reply" },
    ]);
    // A seeded turn contributes no rubric calls, by construction.
    expect(result.rubricCalls).toHaveLength(0);
  });

  test("a check step appends production's ephemeral instruction as a user turn", async () => {
    loadScript([tutor("verdict turn", { prediction: "full", evidence: "full" })]);

    const result = await runRubricSession(
      {
        ...GOALPOST_CASE,
        script: [
          { role: "scholar", text: "here it is", document: "DOC v1" },
          { role: "tutor", text: "seeded" },
          { role: "check" },
        ],
      },
      { warn: () => {} },
    );

    expect(generateTutorTurnMock).toHaveBeenCalledTimes(1);
    const clickTurn = result.turns[2];
    // Same role the harness uses for every non-tutor turn — toMessages maps it
    // to `user`, which is exactly what convex/http.ts pushes.
    expect(clickTurn.role).toBe("scholar");
    expect(clickTurn.content).toBe(rubricCheckInstruction("Discussion card"));
    expect(clickTurn.content).toContain("Check my work");
    expect(clickTurn.content).toContain("Discussion card");
    // The model turn AFTER the click is the verdict turn.
    expect(result.finalTurnText).toBe("verdict turn");
    expect(result.rubricCalls).toHaveLength(1);
    expect(result.rubricCalls[0].onFinalTurn).toBe(true);
  });

  test("a per-step document takes over and persists for the rest of the session", async () => {
    loadScript([tutor("a"), tutor("b"), tutor("c")]);

    const result = await runRubricSession(
      {
        ...GOALPOST_CASE,
        script: [
          { role: "scholar", text: "one" },
          { role: "scholar", text: "two", document: "DOC v1" },
          { role: "scholar", text: "three" },
        ],
      },
      { warn: () => {} },
    );

    expect(documentArgs()).toEqual([null, "DOC v1", "DOC v1"]);
    expect(result.finalDocumentContent).toBe("DOC v1");
  });

  test("a per-step document overrides the legacy fixed reveal", async () => {
    loadScript([tutor("a"), tutor("b")]);

    await runRubricSession(
      {
        ...CASE,
        script: [
          { role: "scholar", text: "one", document: "OVERRIDE" },
          { role: "scholar", text: "two" },
        ],
      },
      { warn: () => {} },
    );

    // CASE would have revealed finalArtifactContent from step 1; the override
    // wins from step 0 onward.
    expect(documentArgs()).toEqual(["OVERRIDE", "OVERRIDE"]);
  });

  test("finalTurnText comes from the last GENERATED turn, not the last script step", async () => {
    loadScript([tutor("generated")]);

    const result = await runRubricSession(
      {
        ...GOALPOST_CASE,
        script: [
          { role: "scholar", text: "one", document: "DOC" },
          { role: "scholar", text: "two" },
          { role: "tutor", text: "seeded last word" },
        ],
      },
      { warn: () => {} },
    );

    expect(result.turns.at(-1)).toEqual({
      role: "tutor",
      content: "seeded last word",
    });
    expect(result.finalTurnText).toBe("generated");
  });
});
