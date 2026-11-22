/**
 * Which stance the tutor takes, per session kind (TRA-661): a chat the
 * scholar started themselves answers first; everything else stays Socratic.
 * Pins the SELECTION and that the assembled prompt uses the stance it selects,
 * never the stance's wording.
 */
import { describe, expect, test } from "vitest";
import {
  answerFirstWordBudget,
  buildBasePrompt,
  type AnswerFirstStance,
} from "../prompts";
import {
  buildSystemPromptParts,
  tutorStanceFor,
  type LessonActivityContext,
  type SeedOriginContext,
  type UnitContext,
} from "../sessionHelpers";

const UNIT: UnitContext = {
  title: "Why volcanoes erupt",
  description: null,
  systemPrompt: null,
  rubric: null,
  youtubeUrl: null,
  videoTranscript: null,
  bigIdea: null,
  essentialQuestions: null,
  enduringUnderstandings: null,
};

const OWN_QUEST_CHAT: UnitContext = {
  ...UNIT,
  isOwnIsUnit: true,
  isPlanningChat: true,
  ownIsUnitOutline: [],
};

const ACTIVITY: LessonActivityContext = {
  title: "Draw the inside of a volcano",
  description: null,
  kind: "online",
  systemPrompt: "Help the scholar label the parts of a volcano.",
  durationMinutes: null,
  processTitle: null,
  processEmoji: null,
};

const SEED: SeedOriginContext = {
  topic: "Why do volcanoes erupt?",
  domain: "science",
  rationale: null,
  approachHint: null,
  connectionTo: null,
  hasStructure: false,
};

function stance(over: {
  unitContext?: UnitContext | null;
  lessonActivityContext?: LessonActivityContext | null;
  seedOriginContext?: SeedOriginContext | null;
  builderStance?: boolean;
  isWorkbench?: boolean;
}) {
  return tutorStanceFor({
    unitContext: null,
    lessonActivityContext: null,
    seedOriginContext: null,
    builderStance: false,
    isWorkbench: false,
    ...over,
  });
}

describe("tutorStanceFor", () => {
  test("the activity-less chat of the scholar's own Quest answers first while the Quest has no activities", () => {
    expect(stance({ unitContext: OWN_QUEST_CHAT })).toBe("answerFirst");
    // A lesson with no activities yet is still nothing to do.
    expect(
      stance({
        unitContext: {
          ...OWN_QUEST_CHAT,
          ownIsUnitOutline: [{ title: "A lesson", activities: [] }],
        },
      }),
    ).toBe("answerFirst");
  });

  test("once the Quest has activities (a bake landed, or this chat built them), its chat stays Socratic", () => {
    const built = [
      { title: "A lesson", activities: [{ title: "An activity", done: false }] },
    ];
    expect(
      stance({ unitContext: { ...OWN_QUEST_CHAT, ownIsUnitOutline: built } }),
    ).toBe("socratic");
    expect(
      stance({
        unitContext: {
          ...OWN_QUEST_CHAT,
          ownIsUnitOutline: built,
          ownIsUnitBuiltInChat: true,
        },
      }),
    ).toBe("socratic");
  });

  test("a seed chat the scholar opened, with no activity, answers first", () => {
    expect(stance({ seedOriginContext: SEED })).toBe("answerFirst");
  });

  test("an activity stays Socratic: a teacher's, or one inside the scholar's own Quest", () => {
    expect(
      stance({ unitContext: UNIT, lessonActivityContext: ACTIVITY }),
    ).toBe("socratic");
    expect(
      stance({
        unitContext: { ...OWN_QUEST_CHAT, isPlanningChat: undefined },
        lessonActivityContext: ACTIVITY,
      }),
    ).toBe("socratic");
  });

  test("a teacher's unit chat with no activity stays Socratic", () => {
    expect(stance({ unitContext: UNIT, seedOriginContext: SEED })).toBe(
      "socratic",
    );
  });

  test("seed chats that hold their question open stay Socratic", () => {
    const held: SeedOriginContext[] = [
      { ...SEED, suggestionType: "cross_domain" },
      {
        ...SEED,
        storyThreadContext: {
          fromKey: "a",
          toKey: "b",
          fromLabel: "A",
          toLabel: "B",
          toDomain: "science",
          hook: "A hook.",
          narrative: "A story.",
          probe: null,
          source: null,
        },
      },
      {
        ...SEED,
        cardAnswer: { prompt: "Which one?", choice: "This one", correct: true },
      },
      { ...SEED, hasStructure: true },
      { ...SEED, assignedAsHomework: true, hasStructure: true },
    ];
    for (const seedOriginContext of held) {
      expect(stance({ seedOriginContext })).toBe("socratic");
    }
  });

  test("builder and Simulator sessions keep their own stance", () => {
    expect(stance({ unitContext: OWN_QUEST_CHAT, builderStance: true })).toBe(
      "socratic",
    );
    expect(stance({ seedOriginContext: SEED, isWorkbench: true })).toBe(
      "socratic",
    );
  });

  test("a plain chat with no unit and no seed stays Socratic", () => {
    expect(stance({})).toBe("socratic");
  });
});

describe("the assembled prompt uses the selected stance", () => {
  // Positional call, like ownIsUnitOutline.test.ts: readingLevel, name, unit
  // (index 2), lesson activity (15), seed origin (27); the rest default.
  function stable(over: {
    readingLevel?: string | null;
    unit?: UnitContext | null;
    activity?: LessonActivityContext | null;
    seed?: SeedOriginContext | null;
  }): string {
    const args: unknown[] = new Array(60).fill(undefined);
    args[0] = over.readingLevel ?? "4";
    args[1] = "Kai";
    args[2] = over.unit ?? null;
    args[15] = over.activity ?? null;
    args[27] = over.seed ?? null;
    return (
      buildSystemPromptParts as unknown as (
        ...a: unknown[]
      ) => ReturnType<typeof buildSystemPromptParts>
    )(...args).stable;
  }
  const base = (answerFirst: AnswerFirstStance | null) =>
    buildBasePrompt("Kai", undefined, answerFirst);

  test("own Quest chat and seed chat open with the ANSWER FIRST base", () => {
    const answerFirst = base({ wordBudget: 70 });
    expect(answerFirst).not.toBe(base(null));
    expect(stable({ unit: OWN_QUEST_CHAT }).startsWith(answerFirst)).toBe(true);
    expect(stable({ seed: SEED }).startsWith(answerFirst)).toBe(true);
  });

  test("a teacher activity opens with the Socratic base", () => {
    expect(
      stable({ unit: UNIT, activity: ACTIVITY }).startsWith(base(null)),
    ).toBe(true);
  });
});

describe("answerFirstWordBudget", () => {
  test("sizes the answer by talk level, and young-reader rules win", () => {
    expect(answerFirstWordBudget({ talk: "1.5", read: "reader" })).toBe(40);
    expect(answerFirstWordBudget({ talk: "4", read: "reader" })).toBe(70);
    expect(answerFirstWordBudget({ talk: "7.2", read: "reader" })).toBe(120);
    expect(answerFirstWordBudget({ talk: "college", read: "reader" })).toBe(120);
    expect(answerFirstWordBudget({ talk: "6", read: "listener" })).toBe(40);
    expect(answerFirstWordBudget({ talk: null, read: "reader" })).toBeNull();
  });
});
