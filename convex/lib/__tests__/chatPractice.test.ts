import { describe, it, expect, afterEach } from "vitest";
import {
  chatPracticeEnabled,
  selectChatPracticeItemKind,
  serveChatItem,
  resolveChatPracticeSkill,
  buildChatPracticeSection,
  hasExplicitPracticeWithholdSignal,
  SERVE_PRACTICE_PROBLEM_TOOL,
  type ChatPracticeCandidate,
  type SkillCandidate,
} from "../practice/chatPractice";
import { gradeTemplateItem } from "../practice/session";
import type { Id } from "../../_generated/dataModel";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../../lib/manipulative/practiceContract";

function storedItem(
  id: string,
  overrides: Partial<ChatPracticeCandidate["storedItems"][number]> = {},
): ChatPracticeCandidate["storedItems"][number] {
  return {
    _id: id as Id<"practiceItems">,
    skillKey: "mult_facts_7_8_9",
    stem: "Seven groups of eight is how many?",
    answerType: "integer",
    answerCanonical: "56",
    ...overrides,
  };
}

const manipulativeSpec = JSON.stringify({
  kind: "array",
  id: "chat-array",
  concept: "Multiplication as equal groups",
  prompt: "Build 7 rows of 8.",
  rows: 2,
  columns: 2,
  goal: { type: "dimensions", rows: 7, columns: 8 },
});

function candidate(
  overrides: Partial<ChatPracticeCandidate> = {},
): ChatPracticeCandidate {
  return {
    skillKey: "mult_facts_7_8_9",
    label: "Multiplication facts for 7, 8, 9",
    domain: "whole-number-arithmetic",
    isFluent: false,
    storedItems: [],
    ...overrides,
  };
}

describe("chatPracticeEnabled — the gate", () => {
  const prev = process.env.CHAT_PRACTICE_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.CHAT_PRACTICE_ENABLED;
    else process.env.CHAT_PRACTICE_ENABLED = prev;
  });

  it("is OFF by default (unset / false / 0 / empty)", () => {
    delete process.env.CHAT_PRACTICE_ENABLED;
    expect(chatPracticeEnabled()).toBe(false);
    process.env.CHAT_PRACTICE_ENABLED = "false";
    expect(chatPracticeEnabled()).toBe(false);
    process.env.CHAT_PRACTICE_ENABLED = "0";
    expect(chatPracticeEnabled()).toBe(false);
    process.env.CHAT_PRACTICE_ENABLED = "";
    expect(chatPracticeEnabled()).toBe(false);
  });

  it("is ON only for an explicit truthy value", () => {
    for (const v of ["true", "1", "on", "yes", "TRUE", "On"]) {
      process.env.CHAT_PRACTICE_ENABLED = v;
      expect(chatPracticeEnabled()).toBe(true);
    }
  });
});

describe("hasExplicitPracticeWithholdSignal", () => {
  it("recognizes only explicit frustration or disengagement", () => {
    expect(hasExplicitPracticeWithholdSignal("ugh I am frustrated and this is dumb")).toBe(true);
    expect(hasExplicitPracticeWithholdSignal("I'm tired; can we stop?")).toBe(true);
    expect(hasExplicitPracticeWithholdSignal("I can do a couple more on my own")).toBe(false);
    expect(hasExplicitPracticeWithholdSignal("why does carrying work?")).toBe(false);
  });
});

describe("serveChatItem — server-side item, no answer", () => {
  it("re-derives a gradeable {stem, itemId} that never carries the answer", () => {
    const served = serveChatItem("mult_facts_7_8_9", 12345);
    expect(served).not.toBeNull();
    const s = served!;
    expect(s.skillKey).toBe("mult_facts_7_8_9");
    expect(s.stem.length).toBeGreaterThan(0);
    expect(s.itemId).toContain("mult_facts_7_8_9#");
    expect(s.kind).toBe("typed");
    // A text-only skill carries no prompt visual, and no field holds the answer.
    expect(s.promptVisual).toBeUndefined();
    expect(Object.keys(s).sort()).toEqual([
      "answerType",
      "itemId",
      "kind",
      "skillKey",
      "skillLabel",
      "stem",
    ]);
    expect(JSON.stringify(s)).not.toContain("answer\":");
  });

  it("carries the display-only prompt visual for a visual skill (so an inline chat item is answerable)", () => {
    const s = serveChatItem("cardinality_within_10", 4242)!;
    expect(s.promptVisual).toBeDefined();
    expect(s.promptVisual?.kind).toBe("countables");
    // The visual is the prompt (what to count), not an answer echo.
    expect(JSON.stringify(s)).not.toContain("answer\":");
  });

  it("is deterministic — same seed re-derives the same item, gradeable via the shared path", () => {
    const a = serveChatItem("add_2digit_regroup", 999)!;
    const b = serveChatItem("add_2digit_regroup", 999)!;
    expect(a.itemId).toBe(b.itemId);
    expect(a.stem).toBe(b.stem);
    // The itemId grades through the SAME server re-derivation the drill uses.
    const graded = gradeTemplateItem(a.itemId, "0");
    expect(graded).not.toBeNull();
    expect(graded!.skillKey).toBe("add_2digit_regroup");
  });

  it("returns null for a non-templated skill", () => {
    expect(serveChatItem("not_a_real_skill", 1)).toBeNull();
  });

  it("serves verified stored and manipulative items through the unified resolvers", () => {
    const stored = serveChatItem(
      candidate({ storedItems: [storedItem("stored-word")] }),
      5,
      "multiplication facts",
    );
    expect(stored).toEqual({
      kind: "typed",
      itemId: "gen#stored-word",
      skillKey: "mult_facts_7_8_9",
      skillLabel: "Multiplication facts for 7, 8, 9",
      stem: "Seven groups of eight is how many?",
      answerType: "integer",
    });

    const manipulative = serveChatItem(
      candidate({
        isFluent: true,
        storedItems: [
          storedItem("stored-manip", {
            answerType: MANIPULATIVE_ANSWER_TYPE,
            answerCanonical: "",
            verifierKind: MANIPULATIVE_VERIFIER_KIND,
            manipulativeSpec,
          }),
        ],
      }),
      5,
      "explore a visual model for multiplication",
    );
    expect(manipulative).toEqual({
      kind: "manipulative",
      itemId: "gen#stored-manip",
      skillKey: "mult_facts_7_8_9",
      skillLabel: "Multiplication facts for 7, 8, 9",
      manipulativeSpec,
    });
    expect(JSON.stringify(manipulative)).not.toContain("answerCanonical");
  });
});

describe("chat item selection policy", () => {
  const word = storedItem("word");
  const manipulative = storedItem("manip", {
    answerType: MANIPULATIVE_ANSWER_TYPE,
    answerCanonical: "",
    verifierKind: MANIPULATIVE_VERIFIER_KIND,
    manipulativeSpec,
  });

  it("prefers templates for fluency, but explicit exploration intent selects a curated manipulative", () => {
    const fluent = candidate({
      isFluent: true,
      storedItems: [word, manipulative],
    });
    expect(selectChatPracticeItemKind("multiplication facts", fluent)).toBe(
      "template",
    );
    expect(
      selectChatPracticeItemKind(
        "explore a visual model of multiplication",
        fluent,
      ),
    ).toBe("manipulative");
  });

  it("prefers a stored word item before template fallback for a non-fluent skill", () => {
    expect(
      selectChatPracticeItemKind(
        "multiplication facts",
        candidate({ storedItems: [word] }),
      ),
    ).toBe("stored");
    expect(
      selectChatPracticeItemKind("multiplication facts", candidate()),
    ).toBe("template");
  });
});

describe("resolveChatPracticeSkill — free-text label → servable skillKey", () => {
  const candidates: SkillCandidate[] = [
    { skillKey: "mult_facts_7_8_9", label: "Multiplication facts for 7, 8, 9" },
    { skillKey: "add_2digit_regroup", label: "Add two-digit numbers with regrouping" },
    { skillKey: "subtract_2digit_regroup", label: "Subtract two-digit numbers with regrouping" },
  ];

  it("matches an exact label (case-insensitive)", () => {
    expect(
      resolveChatPracticeSkill("multiplication facts for 7, 8, 9", candidates),
    ).toBe("mult_facts_7_8_9");
  });

  it("matches a paraphrase / partial phrase by token overlap", () => {
    expect(resolveChatPracticeSkill("two-digit addition with regrouping", candidates)).toBe(
      "add_2digit_regroup",
    );
    expect(resolveChatPracticeSkill("subtraction with regrouping", candidates)).toBe(
      "subtract_2digit_regroup",
    );
  });

  it("understands 'your 7s' → the 7/8/9 multiplication facts", () => {
    expect(resolveChatPracticeSkill("let's see your 7s", candidates)).toBe(
      "mult_facts_7_8_9",
    );
  });

  it("accepts a raw skillKey if the tutor echoes one back", () => {
    expect(resolveChatPracticeSkill("add_2digit_regroup", candidates)).toBe(
      "add_2digit_regroup",
    );
  });

  it("returns null on no match / empty candidates", () => {
    expect(resolveChatPracticeSkill("photosynthesis", candidates)).toBeNull();
    expect(resolveChatPracticeSkill("", candidates)).toBeNull();
    expect(resolveChatPracticeSkill("anything", [])).toBeNull();
  });

  it("resolves a stored-only candidate after availability is filtered by the caller", () => {
    const storedOnly: SkillCandidate[] = [
      { skillKey: "contextual_division", label: "Contextual division" },
    ];
    expect(resolveChatPracticeSkill("contextual division", storedOnly)).toBe(
      "contextual_division",
    );
  });
});

describe("buildChatPracticeSection — the gated tutor-visible prompt", () => {
  it("returns null when there are no skills to offer", () => {
    expect(buildChatPracticeSection(null)).toBeNull();
    expect(
      buildChatPracticeSection({ fluentLabels: [], frontierLabels: [], dueLabels: [] }),
    ).toBeNull();
  });

  it("frames it as retrieval practice, probe-first, and forbids stating the answer", () => {
    const section = buildChatPracticeSection({
      fluentLabels: ["Add within 20"],
      frontierLabels: ["Multiplication facts for 7, 8, 9"],
      dueLabels: [],
    })!;
    expect(section).toMatch(/serve_practice_problem/);
    expect(section.toLowerCase()).toContain("retrieval practice");
    expect(section.toLowerCase()).toContain("probe");
    // The anti-pattern is named explicitly.
    expect(section.toLowerCase()).toContain("lecture-then-test");
    // Answer-withholding is stated.
    expect(section.toLowerCase()).toMatch(/not told the answer|never state it|not.*know the answer/);
    // Labels appear; skillKeys never do (redaction contract).
    expect(section).toContain("Multiplication facts for 7, 8, 9");
    expect(section).not.toContain("mult_facts_7_8_9");
  });
});

describe("SERVE_PRACTICE_PROBLEM_TOOL — the tool spec", () => {
  it("takes a free-text skill (a label, not a skillKey)", () => {
    expect(SERVE_PRACTICE_PROBLEM_TOOL.name).toBe("serve_practice_problem");
    expect(SERVE_PRACTICE_PROBLEM_TOOL.inputSchema.required).toEqual(["skill"]);
    expect(SERVE_PRACTICE_PROBLEM_TOOL.inputSchema.properties.skill.type).toBe("string");
    // The description steers toward probe-first, sparse use.
    expect(SERVE_PRACTICE_PROBLEM_TOOL.description.toLowerCase()).toContain("probed");
    expect(SERVE_PRACTICE_PROBLEM_TOOL.description.toLowerCase()).toContain(
      "manipulative",
    );
  });
});
