import { describe, expect, it } from "vitest";

import {
  type EditorialCandidates,
  type EditorialResult,
  buildEditorialUserPrompt,
  parseEditorialToolResponse,
  SPECIAL_DELIVERY_EDITORIAL_TOOL,
} from "../lib/specialDeliveryEditorial";
import { PROSE_STYLE_GUIDE } from "../prompts";
import {
  type CandidateSourceKind,
  type LetterCandidate,
  type LetterSection,
} from "../../shared/specialDeliveryCandidates";

// A leak sentinel: if any test's candidate object is ever JSON-dumped into the
// prompt wholesale, this string (hidden in an internal-only field) would show
// up. The prompt must render ONLY the safe whitelist, so it must never appear.
const TEACHER_LEAK_SENTINEL = "SECRET_TEACHER_FACING_ANALYSIS_DO_NOT_PRINT";

function makeCandidate(
  section: LetterSection,
  sourceKind: CandidateSourceKind,
  overrides: Partial<LetterCandidate> = {},
): LetterCandidate {
  return {
    section,
    sourceRank: 1,
    sourceKind,
    scholarVerbatim: "I think the tide pools refill from a different wave each time.",
    subject: "how tide pools refill between waves",
    selfGenerated: true,
    datedToday: true,
    // provenance carries an internal-only marker; it must never reach the prompt.
    provenance: { kind: TEACHER_LEAK_SENTINEL, id: TEACHER_LEAK_SENTINEL },
    ...overrides,
  };
}

const SAMPLE_CANDIDATES: EditorialCandidates = {
  lookBack: [
    makeCandidate("lookBack", "scholarMoment", {
      subject: "waves and tide pools",
      scholarVerbatim: "I think the tide pools refill from a different wave each time.",
    }),
    makeCandidate("lookBack", "completedActivity", {
      subject: "the intertidal zoning worksheet",
      scholarVerbatim: null,
    }),
  ],
  clue: [
    makeCandidate("clue", "openQuestion", {
      subject: "why some pools stay full at low tide",
      scholarVerbatim: "Why does the top pool never empty even when the tide goes all the way out?",
    }),
  ],
};

function toolResponse(input: unknown) {
  return [{ type: "tool_use", input }];
}

describe("exports", () => {
  it("offers decline beside write in the tool schema", () => {
    const decision =
      SPECIAL_DELIVERY_EDITORIAL_TOOL.input_schema.properties.lookBack.properties.decision;
    expect(decision.enum).toEqual(["write", "decline"]);
    expect(SPECIAL_DELIVERY_EDITORIAL_TOOL.input_schema.required).toEqual([
      "lookBack",
      "clue",
    ]);
  });
});

describe("buildEditorialUserPrompt", () => {
  const prompt = buildEditorialUserPrompt({
    scholarFirstName: "Maya",
    readingLevel: "early elementary",
    candidates: SAMPLE_CANDIDATES,
  });

  it("includes PROSE_STYLE_GUIDE exactly once", () => {
    expect(prompt).toContain(PROSE_STYLE_GUIDE);
    expect(prompt.split(PROSE_STYLE_GUIDE)).toHaveLength(2);
  });

  it("presents candidates by stable index with safe fields only", () => {
    expect(prompt).toContain("[0] kind: scholarMoment");
    expect(prompt).toContain("[1] kind: completedActivity");
    expect(prompt).toContain("[0] kind: openQuestion");
    expect(prompt).toContain("waves and tide pools");
    expect(prompt).toContain("their exact words:");
    expect(prompt).toContain("no direct quote — activity-supplied subject only");
  });

  it("keeps indices stable to input order (reordering changes the mapping)", () => {
    const reordered = buildEditorialUserPrompt({
      scholarFirstName: "Maya",
      readingLevel: null,
      candidates: {
        lookBack: [SAMPLE_CANDIDATES.lookBack[1], SAMPLE_CANDIDATES.lookBack[0]],
        clue: SAMPLE_CANDIDATES.clue,
      },
    });
    expect(reordered).toContain("[0] kind: completedActivity");
    expect(reordered).toContain("[1] kind: scholarMoment");
  });

  it("never leaks a teacher-facing / internal field into the prompt", () => {
    // The only leak vector that matters: an internal field VALUE reaching the
    // prompt (e.g. via a wholesale JSON dump of the candidate). The sentinel
    // lives in provenance; it must never appear.
    expect(prompt).not.toContain(TEACHER_LEAK_SENTINEL);
    // Nor should the internal field NAMES be rendered as data labels.
    expect(prompt).not.toContain("sourceRank");
    expect(prompt).not.toContain("selfGenerated");
  });

  it("states the judgment rules and word budget", () => {
    expect(prompt).toContain("Parent-proof read");
    expect(prompt).toContain("gotcha");
    expect(prompt).toContain("counselling");
    expect(prompt).toContain("The surprise test");
    expect(prompt).toContain("Coherence");
    expect(prompt).toContain("at most 40 words");
    expect(prompt).toContain("at most 30 words");
  });

  it("requires the tomorrow-clue to name a concrete anchor and decline a generic one", () => {
    expect(prompt).toContain("concrete anchor");
    // The two generic filler specimens observed in a prior run are named so the
    // model recognises and declines them.
    expect(prompt).toContain("Where else does that same problem show up?");
    expect(prompt).toContain("Where else could that trade-off show up tomorrow?");
    expect(prompt).toContain("Three towns of 10, 5, and 2 people");
    expect(prompt).toContain("DECLINE the clue rather than print the generic version");
  });

  it("makes the idea-shape taxonomy a SILENT selection criterion, not page vocabulary (A)", () => {
    // The taxonomy words remain in the rule (the model selects on them)…
    expect(prompt).toContain("Idea-shape");
    // …but the rule forbids naming the category or stamping the idea, and cites
    // the exact formula specimens from the prior run as negative examples.
    expect(prompt).toContain("NEVER name the category");
    expect(prompt).toContain("That's a real claim about representation.");
    expect(prompt).toContain("worth testing further");
    expect(prompt).toContain("you were really onto something");
  });

  it("states the anti-parasocial rule: no first person, no companion (B)", () => {
    expect(prompt).toContain("No narrator, no companion");
    expect(prompt).toContain("never I, me, my, we, us, or let's");
    expect(prompt).toContain("your line stuck with me");
  });

  it("states the address-as-you rule with the Lily specimen (finding #1)", () => {
    expect(prompt).toContain('Address the child ONLY as "you"');
    expect(prompt).toContain("Lily said");
  });

  it("bans quoting a child's nonstandard spelling with the Ryder specimen (finding #2)", () => {
    expect(prompt).toContain("Paraphrase a young child's nonstandard spelling");
    expect(prompt).toContain("and i mean HARD");
  });

  it("requires a production question, not a yes/no verdict, with specimens (finding #3)", () => {
    expect(prompt).toContain("ask the child to PRODUCE something");
    expect(prompt).toContain("Is that fair?");
    expect(prompt).toContain("What would a fairer split look like?");
  });

  it("states the read-aloud grammar test with the Oliver specimen (finding #5)", () => {
    expect(prompt).toContain("Read-aloud test");
    expect(prompt).toContain("A council with no more ideas is not failed");
  });

  it("strengthens the decline weighting with the Ryder worked example (E / finding #6)", () => {
    expect(prompt).toContain("Ryder");
    expect(prompt).toContain("respecting the child");
    expect(prompt).toContain("hedged one-liners");
  });

  it("carries the compression directive and target register (F)", () => {
    expect(prompt).toContain("Compression");
    expect(prompt).toContain("telegram-grade");
    expect(prompt).toContain("What would a planet see if it were close enough");
  });

  it("states the idea-shape bar the code no longer decides (F1/F6)", () => {
    // The model, not code, now judges whether a verbatim is a standing idea.
    expect(prompt).toContain("Idea-shape");
    expect(prompt).toContain("claim");
    expect(prompt).toContain("analogy");
    expect(prompt).toContain("coined term");
    expect(prompt).toContain("distinction");
    // A preference / bare answer / observation is explicitly NOT quotable.
    expect(prompt).toContain("is NOT quotable");
  });

  it("falls back to a generic age-fit line when reading level is missing", () => {
    const noLevel = buildEditorialUserPrompt({
      scholarFirstName: "Maya",
      readingLevel: null,
      candidates: SAMPLE_CANDIDATES,
    });
    expect(noLevel).toContain("Write for a young reader");
  });
});

// ─── Parser: every malformed shape degrades to DECLINE ───────────────────────

type ParserCase = {
  name: string;
  input: unknown; // the tool_use `input`, or a special marker handled below
  content?: { type?: unknown; input?: unknown }[];
  expectLookBack: EditorialResult["lookBack"]["kind"];
  expectClue: EditorialResult["clue"]["kind"];
};

const VALID_LINE = "You wondered whether each tide pool refills from a different wave.";

const declineCases: ParserCase[] = [
  {
    name: "no tool_use block (text only)",
    content: [{ type: "text", input: undefined }],
    input: undefined,
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "empty content array",
    content: [],
    input: undefined,
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "missing both sections",
    input: {},
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "section is a string, not an object",
    input: { lookBack: "write it", clue: 42 },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "write with out-of-range index",
    input: {
      lookBack: { decision: "write", candidateIndex: 99, line: VALID_LINE },
      clue: { decision: "write", candidateIndex: 5, line: VALID_LINE },
    },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "write with negative index",
    input: { lookBack: { decision: "write", candidateIndex: -1, line: VALID_LINE } },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "write with non-integer index",
    input: { lookBack: { decision: "write", candidateIndex: 1.5, line: VALID_LINE } },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "write with missing line",
    input: { lookBack: { decision: "write", candidateIndex: 0 } },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "write with empty line",
    input: { lookBack: { decision: "write", candidateIndex: 0, line: "   " } },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "write with a line that fails validateGeneratedLine (AI tell)",
    input: {
      lookBack: {
        decision: "write",
        candidateIndex: 0,
        line: "Today we delve into the tapestry of your learning journey.",
      },
    },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "write with an over-budget line",
    input: {
      lookBack: {
        decision: "write",
        candidateIndex: 0,
        line: Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "),
      },
    },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "missing decision field",
    input: { lookBack: { candidateIndex: 0, line: VALID_LINE } },
    expectLookBack: "decline",
    expectClue: "decline",
  },
  {
    name: "unknown decision value",
    input: { lookBack: { decision: "maybe", candidateIndex: 0, line: VALID_LINE } },
    expectLookBack: "decline",
    expectClue: "decline",
  },
];

describe("parseEditorialToolResponse degrades to decline", () => {
  it.each(declineCases)("$name", (c) => {
    const content = c.content ?? toolResponse(c.input);
    const result = parseEditorialToolResponse(content, SAMPLE_CANDIDATES);
    expect(result.lookBack.kind).toBe(c.expectLookBack);
    expect(result.clue.kind).toBe(c.expectClue);
  });

  it("a non-array content degrades to decline both sections", () => {
    const result = parseEditorialToolResponse(
      undefined as unknown as { type?: unknown }[],
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack.kind).toBe("decline");
    expect(result.clue.kind).toBe("decline");
  });
});

describe("parseEditorialToolResponse accepts valid shapes", () => {
  it("returns a write for a valid, safety-passing, grounded line", () => {
    // candidateIndex 0 is the tide-pool candidate — VALID_LINE is actually
    // about that candidate's own subject/verbatim.
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: { decision: "write", candidateIndex: 0, line: VALID_LINE },
        clue: { decision: "decline", reason: "coherence: same idea as look-back" },
      }),
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack).toEqual({
      kind: "write",
      candidateIndex: 0,
      line: VALID_LINE,
    });
    expect(result.clue).toEqual({
      kind: "decline",
      reason: "coherence: same idea as look-back",
    });
  });

  it("preserves a model decline reason, and defaults one when absent", () => {
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: { decision: "decline" },
        clue: { decision: "decline", reason: "  the only quote is a gotcha  " },
      }),
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack).toEqual({ kind: "decline", reason: "model-declined" });
    expect(result.clue).toEqual({ kind: "decline", reason: "the only quote is a gotcha" });
  });

  it("bounds-checks against the ACTUAL candidate list (index 0 invalid when the list is empty)", () => {
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: { decision: "write", candidateIndex: 0, line: VALID_LINE },
      }),
      { lookBack: [], clue: [] },
    );
    expect(result.lookBack.kind).toBe("decline");
  });

  it("threads scholarFirstName so the name rail (finding #1) rejects here too", () => {
    // A candidate whose own material overlaps with the slip line, so ONLY the
    // name rail is exercised here — grounding must not be what fails it.
    const nameRailCandidates: EditorialCandidates = {
      lookBack: [
        makeCandidate("lookBack", "scholarMoment", {
          subject: "how quickly the class reached agreement",
          scholarVerbatim:
            "Everybody agreed way faster than I expected, even though it still felt like it took forever.",
        }),
      ],
      clue: [],
    };
    const slipLine = "You noticed everybody agreed it took forever, Lily said.";
    // Without the name, the line passes the parser and is written.
    const noName = parseEditorialToolResponse(
      toolResponse({
        lookBack: { decision: "write", candidateIndex: 0, line: slipLine },
        clue: { decision: "decline", reason: "coherence" },
      }),
      nameRailCandidates,
    );
    expect(noName.lookBack.kind).toBe("write");
    // With the name supplied, the same line degrades to decline (the rail fires).
    const withName = parseEditorialToolResponse(
      toolResponse({
        lookBack: { decision: "write", candidateIndex: 0, line: slipLine },
        clue: { decision: "decline", reason: "coherence" },
      }),
      nameRailCandidates,
      "Lily",
    );
    expect(withName.lookBack.kind).toBe("decline");
  });
});

// ─── Grounding: candidateIndex constrains the printed line ───────────────────
//
// These cases exercise `checkLineGrounding` through the public parser: a
// write must be provably anchored to the SELECTED candidate — never any
// candidate, never invented material — or it degrades to decline exactly like
// any other malformed shape.

describe("parseEditorialToolResponse rejects ungrounded writes", () => {
  it("rejects a quote that is not an exact substring of the selected candidate's verbatim", () => {
    // candidateIndex 0's verbatim is about tide pools; the quoted words below
    // were never said by this candidate (mismatched/misattributed quote).
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: {
          decision: "write",
          candidateIndex: 0,
          line: 'You noticed "the ocean is alive" every time the tide came in.',
        },
      }),
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack.kind).toBe("decline");
  });

  it("rejects a quote when the selected candidate has no verbatim at all", () => {
    // candidateIndex 1 (completedActivity) has scholarVerbatim: null — any
    // quoted span here is fabricated by construction.
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: {
          decision: "write",
          candidateIndex: 1,
          line: 'You noticed "the zones never mix" on the worksheet today.',
        },
      }),
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack.kind).toBe("decline");
  });

  it("rejects a fabricated line with no lexical grounding in the selected candidate", () => {
    // candidateIndex 0 is about tide pools; this line is a wholly unrelated,
    // fluent sentence that shares no meaningful words with it.
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: {
          decision: "write",
          candidateIndex: 0,
          line: "You imagined a rocket launching toward a distant red planet.",
        },
      }),
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack.kind).toBe("decline");
  });

  it("rejects a numeric token not present in the selected candidate's source", () => {
    // Otherwise grounded (shares "tide"/"pool"/"wave"/"refill" with candidate
    // 0), but invents a count ("12") that appears nowhere in its material.
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: {
          decision: "write",
          candidateIndex: 0,
          line: "You counted 12 tide pools that refill from a different wave.",
        },
      }),
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack.kind).toBe("decline");
  });

  it("accepts an exact, normalized substring quote of the selected candidate's verbatim", () => {
    // A genuine, in-bounds quote from candidate 0's own scholarVerbatim.
    const result = parseEditorialToolResponse(
      toolResponse({
        lookBack: {
          decision: "write",
          candidateIndex: 0,
          line: 'You wrote "the tide pools refill from a different wave each time."',
        },
      }),
      SAMPLE_CANDIDATES,
    );
    expect(result.lookBack.kind).toBe("write");
  });
});
