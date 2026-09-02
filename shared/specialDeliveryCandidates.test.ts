import { describe, expect, it, test } from "vitest";

import {
  AI_TELL_PATTERNS,
  checkAiTells,
  checkFirstPerson,
  checkQuotedSpelling,
  checkScholarName,
  checkSectionWordBudget,
  CLUE_SOURCE_RANK,
  decidePrintNothing,
  finalizeSection,
  hasSelfGeneratedSignal,
  isPreferenceText,
  LOOK_BACK_SOURCE_RANK,
  MAX_SECTION_WORDS,
  mechanicalVeto,
  MIN_QUOTE_WORDS,
  normalizeTypography,
  SECTION_WORD_BUDGET,
  selectLetterCandidates,
  stripQuotedSpans,
  textLooksLikeQuestion,
  toQuotableMoment,
  validateGeneratedLine,
  type ActivityFact,
  type LetterFacts,
  type ScoredKeyMoment,
} from "./specialDeliveryCandidates";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

function moment(overrides: Partial<ScoredKeyMoment> = {}): ScoredKeyMoment {
  return {
    id: overrides.id ?? "m1",
    scholarVerbatim:
      overrides.scholarVerbatim ??
      "The remainder is what the pattern refuses to let go of",
    subject: overrides.subject ?? "division remainders",
    teacherAnalysis:
      overrides.teacherAnalysis ??
      "SECRET teacher-facing note: shaky on long division, watch for frustration",
    selfGenerated: overrides.selfGenerated ?? true,
    datedToday: overrides.datedToday ?? true,
    answersClosedQuestion: overrides.answersClosedQuestion ?? false,
    resolved: overrides.resolved ?? false,
    looksLikeQuestion: overrides.looksLikeQuestion ?? false,
    score: overrides.score ?? 10,
    dayKey: overrides.dayKey,
  };
}

function activity(overrides: Partial<ActivityFact> = {}): ActivityFact {
  return {
    id: overrides.id,
    subject: overrides.subject ?? "Fraction Sense workshop",
    datedToday: overrides.datedToday ?? true,
    dayKey: overrides.dayKey,
  };
}

function facts(overrides: Partial<LetterFacts> = {}): LetterFacts {
  return {
    dayKey: overrides.dayKey ?? "2026-08-19",
    keyMoments: overrides.keyMoments ?? [],
    completedActivities: overrides.completedActivities ?? [],
    practiceSkills: overrides.practiceSkills ?? [],
    seedInvitations: overrides.seedInvitations ?? [],
  };
}

/* ------------------------------------------------------------------------- *
 * looksLikeQuestion — a cheap syntactic hint, not a judgment
 * ------------------------------------------------------------------------- */

describe("textLooksLikeQuestion", () => {
  it("is a cheap syntactic hint: true iff a '?' is present", () => {
    expect(textLooksLikeQuestion("Why does the top pool never empty?")).toBe(true);
    expect(textLooksLikeQuestion("The top pool never empties.")).toBe(false);
    // It makes no semantic judgment — a declarative with a '?' still trips it.
    expect(textLooksLikeQuestion("Weird? the pattern keeps repeating")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Structural redaction (§3.2)
 * ------------------------------------------------------------------------- */

describe("structural redaction", () => {
  it("strips teacher-facing analysis from the quotable projection", () => {
    const quotable = toQuotableMoment(moment());
    expect("teacherAnalysis" in quotable).toBe(false);
  });

  it("never lets teacher analysis reach any candidate field", () => {
    const secret = "SECRET-DO-NOT-PRINT-clinical-diagnosis";
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [moment({ teacherAnalysis: secret })],
        seedInvitations: [activity({ subject: "keep pulling the remainder thread" })],
      }),
    );
    const serialized = JSON.stringify(selection);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("teacher-facing");
  });
});

/* ------------------------------------------------------------------------- *
 * Mechanical veto — ONE-WORD / NON-STANDING
 * ------------------------------------------------------------------------- */

describe("veto: one-word / non-standing", () => {
  test.each([
    ["under the word floor", "Too short here", "one-word-or-nonstanding"],
    ["a single word", "Yes", "one-word-or-nonstanding"],
  ])("vetoes %s", (_label, verbatim, expected) => {
    expect(
      mechanicalVeto({
        section: "lookBack",
        scholarVerbatim: verbatim,
        datedToday: true,
      }),
    ).toBe(expected);
  });

  it("vetoes a bare answer to a closed question even when long enough", () => {
    expect(
      mechanicalVeto({
        section: "lookBack",
        scholarVerbatim: "It equals forty two, that is the number",
        datedToday: true,
        answersClosedQuestion: true,
      }),
    ).toBe("one-word-or-nonstanding");
  });

  it("passes a standing idea at exactly the word floor", () => {
    const verbatim = Array.from({ length: MIN_QUOTE_WORDS }, (_v, i) => `w${i}`).join(" ");
    expect(
      mechanicalVeto({
        section: "lookBack",
        scholarVerbatim: verbatim,
        datedToday: true,
      }),
    ).toBeNull();
  });

  it("does not apply the quote-quality veto to activity-supplied (null verbatim) candidates", () => {
    expect(
      mechanicalVeto({
        section: "lookBack",
        scholarVerbatim: null,
        datedToday: true,
      }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Mechanical veto — STALENESS (founder rule 5)
 * ------------------------------------------------------------------------- */

describe("veto: staleness (founder rule 5)", () => {
  it("vetoes a clue candidate not touched today", () => {
    expect(
      mechanicalVeto({
        section: "clue",
        scholarVerbatim: null,
        datedToday: false,
      }),
    ).toBe("stale");
  });

  it("passes a clue candidate dated today", () => {
    expect(
      mechanicalVeto({
        section: "clue",
        scholarVerbatim: null,
        datedToday: true,
      }),
    ).toBeNull();
  });

  it("stale-vetoes lookBack too (finding D — a non-today look-back is a lie about when the idea happened)", () => {
    expect(
      mechanicalVeto({
        section: "lookBack",
        scholarVerbatim: null,
        datedToday: false,
      }),
    ).toBe("stale");
  });

  it("drops a stale (non-today) scholar moment from the lookBack selection (finding D)", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({ id: "today", subject: "today's idea", datedToday: true }),
          moment({
            id: "weeks-ago",
            subject: "naming the Boba dog",
            scholarVerbatim: "I think we should call the dog Boba because it is round",
            datedToday: false,
          }),
        ],
      }),
    );
    expect(selection.lookBack.some((c) => c.subject === "naming the Boba dog")).toBe(false);
    expect(selection.lookBack.some((c) => c.subject === "today's idea")).toBe(true);
  });

  it("drops a stale seed invitation from the clue selection (no returning-thread rank)", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [moment()],
        seedInvitations: [activity({ subject: "an old thread", datedToday: false })],
      }),
    );
    expect(selection.clue.some((c) => c.sourceKind === "seedInvitation")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Mechanical veto — PREFERENCE-NOT-IDEA (defense-in-depth for founder rule 6)
 *
 * Idea-shape is now the editorial model's judgment; this regex is the cheap
 * lexical guard that blanks an obvious preference before it reaches the prompt.
 * ------------------------------------------------------------------------- */

describe("veto: preference-not-idea (defense-in-depth)", () => {
  test.each<[string, string]>([
    ["a like", "I really like how fractions and division rhyme together"],
    ["a favourite", "My favourite part was the algae experiment we ran"],
    ["a dislike", "I don't like when the remainder never lands cleanly"],
    ["a superlative", "Long division is the worst thing we have done all year"],
  ])("vetoes a verbatim stating %s", (_label, verbatim) => {
    expect(isPreferenceText(verbatim)).toBe(true);
    expect(
      mechanicalVeto({
        section: "lookBack",
        scholarVerbatim: verbatim,
        datedToday: true,
      }),
    ).toBe("preference-not-idea");
  });

  it("passes a genuine standing idea that is not a preference", () => {
    expect(isPreferenceText("A remainder is a promise the division could not keep")).toBe(false);
    expect(
      mechanicalVeto({
        section: "lookBack",
        scholarVerbatim: "A remainder is a promise the division could not keep",
        datedToday: true,
      }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Ranking order (§3.1)
 * ------------------------------------------------------------------------- */

describe("candidate ranking", () => {
  it("orders lookBack kinds: scholarMoment > completedActivity > practiceSkill", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({ id: "idea", subject: "remainders", scholarVerbatim: "A remainder is what the pattern refuses to release" }),
        ],
        completedActivities: [activity({ subject: "Fraction Sense workshop" })],
        practiceSkills: [activity({ subject: "long division fluency" })],
      }),
    );
    expect(selection.lookBack.map((c) => c.sourceKind)).toEqual([
      "scholarMoment",
      "completedActivity",
      "practiceSkill",
    ]);
    expect(selection.lookBack.map((c) => c.sourceRank)).toEqual([1, 2, 3]);
  });

  it("offers EVERY self-generated moment as a scholarMoment (no taxonomy gate)", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({ id: "idea", subject: "remainders", scholarVerbatim: "A remainder is what the pattern refuses to release" }),
          moment({ id: "conn", subject: "music and fractions", scholarVerbatim: "Rhythm is just fractions you can clap along to" }),
        ],
      }),
    );
    expect(selection.lookBack.map((c) => c.sourceKind)).toEqual([
      "scholarMoment",
      "scholarMoment",
    ]);
    expect(selection.lookBack.every((c) => c.scholarVerbatim !== null)).toBe(true);
  });

  it("orders clue kinds: openQuestion > seedInvitation > emergingThread", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({ id: "q", looksLikeQuestion: true, resolved: false, subject: "why primes thin out", scholarVerbatim: "Why do the prime numbers get lonelier as they grow?" }),
          moment({ id: "thread", subject: "the sieve pattern", scholarVerbatim: "The sieve kept crossing out the same columns" }),
        ],
        seedInvitations: [activity({ subject: "the twin-prime puzzle" })],
      }),
    );
    expect(selection.clue.map((c) => c.sourceKind)).toEqual([
      "openQuestion",
      "seedInvitation",
      "emergingThread",
    ]);
  });

  it("breaks ties within a rank by score (higher first)", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({ id: "low", score: 2, subject: "low", scholarVerbatim: "The low scoring idea about counting by twos" }),
          moment({ id: "high", score: 9, subject: "high", scholarVerbatim: "The high scoring idea about counting by threes" }),
        ],
      }),
    );
    expect(selection.lookBack.map((c) => c.provenance.id)).toEqual(["high", "low"]);
  });

  it("exposes the ranked-kind order constants", () => {
    expect(LOOK_BACK_SOURCE_RANK).toEqual([
      "scholarMoment",
      "completedActivity",
      "practiceSkill",
    ]);
    expect(CLUE_SOURCE_RANK).toEqual(["openQuestion", "seedInvitation", "emergingThread"]);
  });
});

/* ------------------------------------------------------------------------- *
 * F1 — a signal-shaped moment (no taxonomy) is still quotable
 * ------------------------------------------------------------------------- */

describe("signal-borne verbatim (F1)", () => {
  it("becomes a quotable lookBack candidate with no kind classification", () => {
    // This moment carries only what upstream actually produces: a verbatim, a
    // subject, and the self-generated flag — no claim/rule/analogy taxonomy.
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({
            id: "sig",
            subject: "why the tide pools refill",
            scholarVerbatim: "I think each tide pool refills from a different wave each time",
          }),
        ],
      }),
    );
    expect(selection.lookBack).toHaveLength(1);
    const only = selection.lookBack[0];
    expect(only.sourceKind).toBe("scholarMoment");
    expect(only.selfGenerated).toBe(true);
    expect(only.scholarVerbatim).toBe(
      "I think each tide pool refills from a different wave each time",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * F1 — looksLikeQuestion routing for the tomorrow-clue
 * ------------------------------------------------------------------------- */

describe("looksLikeQuestion routing (F1)", () => {
  it("routes an unresolved, question-shaped moment to the rank-1 open question", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({
            id: "q",
            looksLikeQuestion: true,
            resolved: false,
            subject: "why the top pool stays full",
            scholarVerbatim: "Why does the top pool never empty even at the lowest tide?",
          }),
        ],
      }),
    );
    const q = selection.clue.find((c) => c.sourceKind === "openQuestion");
    expect(q).toBeDefined();
    expect(q?.scholarVerbatim).toContain("Why does the top pool never empty");
  });

  it("does not route a resolved question-shaped moment to open question (falls to emergingThread)", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({
            id: "q",
            looksLikeQuestion: true,
            resolved: true,
            subject: "why the top pool stays full",
            scholarVerbatim: "Why does the top pool never empty even at the lowest tide?",
          }),
        ],
      }),
    );
    expect(selection.clue.some((c) => c.sourceKind === "openQuestion")).toBe(false);
    expect(selection.clue.some((c) => c.sourceKind === "emergingThread")).toBe(true);
  });

  it("an emergingThread clue KEEPS the child's verbatim (never subject-only)", () => {
    // Regression: the scrunched-cloth analogy — the single best door material in
    // the golden set — used to reach the model as a bare subject label and was
    // correctly declined as anchorless. A candidate must never discard words the
    // child actually said once they survive redaction + the mechanical vetoes.
    const cloth = "It's like when you scrunch a cloth, the far parts come closer";
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({
            id: "cloth",
            looksLikeQuestion: false,
            subject: "folding space",
            scholarVerbatim: cloth,
          }),
        ],
      }),
    );
    const thread = selection.clue.find((c) => c.sourceKind === "emergingThread");
    expect(thread).toBeDefined();
    expect(thread?.scholarVerbatim).toBe(cloth);
  });

  it("does not route a non-question-shaped moment to open question", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({
            id: "obs",
            looksLikeQuestion: false,
            subject: "the sieve pattern",
            scholarVerbatim: "The sieve kept crossing out the same columns over and over",
          }),
        ],
      }),
    );
    expect(selection.clue.some((c) => c.sourceKind === "openQuestion")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Selection integration — provenance, dedupe, self-generated flag
 * ------------------------------------------------------------------------- */

describe("selection integration", () => {
  it("marks self-generated vs activity-supplied and stamps provenance", () => {
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [moment({ id: "m9" })],
        completedActivities: [activity({ id: "a1", subject: "aquaponics build" })],
      }),
    );
    const idea = selection.lookBack.find((c) => c.sourceKind === "scholarMoment");
    const act = selection.lookBack.find((c) => c.sourceKind === "completedActivity");
    expect(idea?.selfGenerated).toBe(true);
    expect(idea?.scholarVerbatim).not.toBeNull();
    expect(idea?.provenance).toMatchObject({ kind: "keyMoment", id: "m9" });
    expect(act?.selfGenerated).toBe(false);
    expect(act?.scholarVerbatim).toBeNull();
    expect(act?.provenance).toMatchObject({ kind: "completedActivity", id: "a1" });
  });

  it("also offers a question-shaped moment as a subject-only lookBack candidate", () => {
    // A self-generated moment appears in lookBack (quotable) AND — if it looks
    // like an open question — in clue at rank 1. Nothing filters it out of
    // lookBack anymore.
    const selection = selectLetterCandidates(
      facts({
        keyMoments: [
          moment({
            looksLikeQuestion: true,
            resolved: false,
            scholarVerbatim: "Why do the prime numbers get lonelier as they grow?",
          }),
        ],
      }),
    );
    expect(selection.lookBack.map((c) => c.sourceKind)).toContain("scholarMoment");
    expect(selection.clue.map((c) => c.sourceKind)).toContain("openQuestion");
  });

  it("does not surface a resolved question as an open-question clue", () => {
    const selection = selectLetterCandidates(
      facts({ keyMoments: [moment({ looksLikeQuestion: true, resolved: true })] }),
    );
    expect(selection.clue.some((c) => c.sourceKind === "openQuestion")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Word budget (§3.4) — boundary
 * ------------------------------------------------------------------------- */

describe("word budget (§3.4)", () => {
  const line = (n: number) => Array.from({ length: n }, (_v, i) => `w${i}`).join(" ");

  it("passes at exactly the budget", () => {
    const result = checkSectionWordBudget(line(MAX_SECTION_WORDS));
    expect(result).toEqual({ ok: true, wordCount: MAX_SECTION_WORDS, max: MAX_SECTION_WORDS });
  });

  it("fails one word over the budget", () => {
    const result = checkSectionWordBudget(line(MAX_SECTION_WORDS + 1));
    expect(result.ok).toBe(false);
    expect(result.wordCount).toBe(MAX_SECTION_WORDS + 1);
  });

  it("uses the compressed per-section budgets (finding F): look-back 40, clue 30", () => {
    expect(SECTION_WORD_BUDGET.lookBack).toBe(40);
    expect(SECTION_WORD_BUDGET.clue).toBe(30);
  });

  it("validateGeneratedLine reports the over-budget failure against the per-section budget", () => {
    const overBy = SECTION_WORD_BUDGET.lookBack + 5;
    const result = validateGeneratedLine(line(overBy), "lookBack");
    expect(result.ok).toBe(false);
    expect(result.reasons).toContainEqual({
      kind: "over-word-budget",
      wordCount: overBy,
      max: SECTION_WORD_BUDGET.lookBack,
    });
  });

  it("enforces the tighter clue budget: 31 words fails clue but 31 passes look-back", () => {
    expect(validateGeneratedLine(line(31), "clue").ok).toBe(false);
    expect(validateGeneratedLine(line(31), "lookBack").ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Banned constructions — founder rule 4 (AI tells)
 * ------------------------------------------------------------------------- */

describe("AI tells (founder rule 4)", () => {
  // Every banned construction fires on a line that contains it.
  test.each<[string, string]>([
    ["dive-in", "Let's dive into what you noticed today"],
    ["delve", "Today you began to delve into remainders"],
    ["learning-journey", "This is a big step on your learning journey"],
    ["unleash", "You unleashed a new way to see it"],
    ["unlock-your", "That question can unlock your next idea"],
    ["keep-up-the-good-work", "Keep up the great work with fractions"],
    ["important-to-note", "It's important to note that you tried twice"],
    ["at-the-end-of-the-day", "At the end of the day you found the pattern"],
    ["in-conclusion", "In conclusion, primes are strange"],
    ["in-todays-world", "In today's fast-paced world numbers matter"],
    ["the-power-of", "You felt the power of a good question"],
    ["explore-the-world-of", "Tomorrow you can explore the fascinating world of primes"],
    ["hope-this-finds-you", "I hope this note finds you curious"],
    ["as-an-ai", "As an AI I noticed your effort"],
    ["elevate-your", "This will elevate your understanding"],
    ["game-changer", "That insight was a game-changer for you"],
    ["remember-opener", "Remember, every mistake is a clue"],
    ["tapestry", "Your ideas wove a tapestry of meaning"],
    ["testament-to", "Your effort is a testament to your curiosity"],
    ["a-real-evaluative", "That's a real claim about representation"],
    ["worth-gerund", "That question is worth testing further"],
    ["sit-with", "That's a real problem to sit with"],
    ["onto-something", "You were really onto something today"],
  ])("flags the %s construction", (label, line) => {
    const result = checkAiTells(line);
    expect(result.ok).toBe(false);
    expect(result.hits.map((h) => h.label)).toContain(label);
  });

  it("has a positive test for every registered pattern", () => {
    // Guard against adding a pattern without a matching test above.
    const testedLabels = new Set<string>([
      "dive-in",
      "delve",
      "learning-journey",
      "unleash",
      "unlock-your",
      "keep-up-the-good-work",
      "important-to-note",
      "at-the-end-of-the-day",
      "in-conclusion",
      "in-todays-world",
      "the-power-of",
      "explore-the-world-of",
      "hope-this-finds-you",
      "as-an-ai",
      "elevate-your",
      "game-changer",
      "remember-opener",
      "tapestry",
      "testament-to",
      "a-real-evaluative",
      "worth-gerund",
      "sit-with",
      "onto-something",
    ]);
    for (const { label } of AI_TELL_PATTERNS) {
      expect(testedLabels.has(label)).toBe(true);
    }
  });

  it("does not ban ordinary uses (finding C): 'the real reason', 'a real say', 'a real spacecraft'", () => {
    expect(checkAiTells("You asked what the real reason for the tide was").ok).toBe(true);
    expect(checkAiTells("Does a group still get a real say if the leader can overrule it?").ok).toBe(true);
    expect(checkAiTells("How fast can a real spacecraft go compared to the speed of light?").ok).toBe(true);
  });

  it("worth-gerund fires on the editorial frames (finding #4): 'worth testing further', 'worth exploring'", () => {
    expect(checkAiTells("That question is worth testing further").hits.map((h) => h.label)).toContain("worth-gerund");
    expect(checkAiTells("The idea is worth exploring").hits.map((h) => h.label)).toContain("worth-gerund");
  });

  it("worth-gerund does NOT fire on ordinary child-facing 'worth <verb>ing' (finding #4 false positive)", () => {
    // The real regression: a genuine kid question the old broad /worth [a-z]+ing/
    // pattern killed. Ordinary "worth choosing/waiting/fighting" must pass.
    expect(checkAiTells("Is fast ever worth choosing over fair?").ok).toBe(true);
    expect(checkAiTells("Was the answer worth waiting for?").ok).toBe(true);
    expect(checkAiTells("Which rule is worth fighting for?").ok).toBe(true);
  });

  it("passes a clean, plain-spoken line", () => {
    const clean = "You said a remainder is what the pattern refuses to let go of. Where did that idea feel different by the end of today?";
    expect(checkAiTells(clean).ok).toBe(true);
    expect(validateGeneratedLine(clean, "lookBack").ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Quoted-span stripping + first-person (parasocial) rail — finding B
 * ------------------------------------------------------------------------- */

describe("stripQuotedSpans", () => {
  it("removes double-quoted spans but keeps apostrophes in ordinary words", () => {
    const out = stripQuotedSpans(`You asked "why does the top pool never empty" today`);
    expect(out).not.toContain("why does the top pool");
    expect(out).toContain("You asked");
    expect(out).toContain("today");
  });

  it("does not treat an apostrophe in a contraction as a quote mark", () => {
    // "That's ... isn't" must NOT be collapsed into a stripped span.
    const out = stripQuotedSpans("That's the distinction you drew, isn't it");
    expect(out).toContain("distinction you drew");
  });
});

describe("first-person / companion rail (anti-parasocial)", () => {
  it.each(["I", "me", "my", "we", "us", "let's"])(
    "flags the companion token %s in the model's own prose",
    (token) => {
      const line = `Where did that ${token} idea change by the end of today?`;
      const result = checkFirstPerson(line);
      expect(result.ok).toBe(false);
    },
  );

  it("validateGeneratedLine fails a first-person line with a first-person reason", () => {
    const result = validateGeneratedLine(
      "Your line stuck with me all afternoon. Where did it take you?",
      "lookBack",
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "first-person")).toBe(true);
  });

  it("EXEMPTS first person inside the child's quoted verbatim", () => {
    // The child said "I"; quoting it must NOT trip the parasocial rail.
    const line = `You wrote "I wonder if we ever really see the present". What made that feel true?`;
    const fp = checkFirstPerson(stripQuotedSpans(line));
    expect(fp.ok).toBe(true);
    expect(validateGeneratedLine(line, "lookBack").ok).toBe(true);
  });

  it("still catches first person OUTSIDE the quote even when a quote is present", () => {
    const line = `You wrote "the tide refills each pool" and I think that is a real claim.`;
    expect(validateGeneratedLine(line, "lookBack").ok).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Scholar-name rail (finding #1) — the letter addresses the child as "you"
 * ------------------------------------------------------------------------- */

describe("scholar-name rail (finding #1 address slip)", () => {
  it("fails a line that refers to the child in the third person by name", () => {
    // Real specimen: the address slip printed for Lily.
    const line = `"Everybody agreeing" takes a super long time, Lily said. Is there a faster way?`;
    const result = validateGeneratedLine(line, "lookBack", "Lily");
    expect(result.ok).toBe(false);
    expect(result.reasons).toContainEqual({ kind: "contains-scholar-name", name: "Lily" });
  });

  it("is case-insensitive and word-bounded", () => {
    expect(checkScholarName("Nice work today, henry.", "Henry").ok).toBe(false);
    // A name that only appears as a substring of another word must NOT fire.
    expect(checkScholarName("The prime numbers were surprising.", "Prime").ok).toBe(false);
  });

  it("passes a clean 'you'-addressed line, and skips the rail when no name is given", () => {
    const line = "You noticed everybody agreeing takes a long time. What would speed it up without losing anyone?";
    expect(validateGeneratedLine(line, "lookBack", "Lily").ok).toBe(true);
    // Empty name → rail skipped (a pure output-rail context).
    expect(checkScholarName(line, "").ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Quoted-spelling rail (finding #2) — never quote a child's nonstandard spelling
 * ------------------------------------------------------------------------- */

describe("quoted-spelling rail (finding #2)", () => {
  it("fails a quoted span with a standalone lowercase 'i' or an ALL-CAPS run", () => {
    // Real specimen: Ryder's verbatim carried both a lowercase "i" and "HARD".
    const line = `"You would need to think HARD and i mean HARD" — what makes a choice weigh so much?`;
    const result = validateGeneratedLine(line, "lookBack", "Ryder");
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "quoted-spelling")).toBe(true);
  });

  it("fires on each nonstandard form independently inside a quote", () => {
    expect(checkQuotedSpelling(`You said "i think so"`).ok).toBe(false);
    expect(checkQuotedSpelling(`You said "think REALLY hard"`).ok).toBe(false);
    expect(checkQuotedSpelling(`You said "it was tricky"`).ok).toBe(true);
  });

  it("does NOT fire on the SAME forms OUTSIDE a quote (prose is covered elsewhere)", () => {
    // The rail only inspects quoted spans; unquoted prose passes this rail.
    expect(checkQuotedSpelling("Think hard about what would go wrong.").ok).toBe(true);
    // A standard uppercase standalone "I" in prose is fine.
    expect(checkQuotedSpelling(`You wrote "a fair rule" today.`).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Typographic normalization (findings #2 high / #3 medium — the unicode bypass)
 *
 * validateGeneratedLine normalizes curly punctuation and strips zero-widths
 * BEFORE span-stripping and every pattern check, so the same banned
 * construction cannot slip past a rail by swapping in a curly apostrophe,
 * curly quotes, or an invisible joiner.
 * ------------------------------------------------------------------------- */

describe("typographic normalization (findings #2/#3 unicode bypass)", () => {
  it("normalizeTypography folds curly punctuation and strips zero-widths", () => {
    expect(normalizeTypography("let\u2019s")).toBe("let's");
    expect(normalizeTypography("\u201Cquote\u201D")).toBe('"quote"');
    expect(normalizeTypography("wo\u200Brth")).toBe("worth");
  });

  it("fails a first-person 'let\u2019s' written with a CURLY apostrophe", () => {
    // Straight "let's" is already caught; the curly-apostrophe variant used to
    // sail past the first-person rail.
    const curly = "let\u2019s explore what makes a fair rule for everyone here";
    const result = validateGeneratedLine(curly, "lookBack");
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "first-person")).toBe(true);
  });

  it("fails a 'worth testing further' AI-tell even with a curly apostrophe in context", () => {
    const curly = "That\u2019s worth testing further before anything else";
    const result = validateGeneratedLine(curly, "clue");
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "banned-phrase")).toBe(true);
  });

  it("strips a CURLY-quoted span so a first-person word inside it stays exempt", () => {
    // The child's own words carry "I"; wrapped in curly double quotes it must be
    // stripped (after normalization) so the parasocial rail does not fire on it.
    const line = "You asked \u201Cwhy do I think the tide refills\u201D at low tide";
    const result = validateGeneratedLine(line, "lookBack");
    expect(result.ok).toBe(true);
  });

  it("catches a zero-width-joiner attempt to hide a banned phrase", () => {
    const hidden = `Remember\u200B, the tide refills from a wave`;
    const result = validateGeneratedLine(hidden, "lookBack");
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "banned-phrase")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Print-nothing decision (§3.6) — blank carries a named reason, PER SECTION
 * ------------------------------------------------------------------------- */

describe("print-nothing decision (§3.6)", () => {
  it("lookBack condition 2: blanks when the day has no self-generated signal", () => {
    const noSignal = facts({
      keyMoments: [moment({ selfGenerated: false })],
      completedActivities: [activity()],
    });
    expect(hasSelfGeneratedSignal(noSignal)).toBe(false);
    const decision = decidePrintNothing({
      section: "lookBack",
      facts: noSignal,
      candidates: [
        {
          section: "lookBack",
          sourceRank: 2,
          sourceKind: "completedActivity",
          scholarVerbatim: null,
          subject: "Fraction Sense workshop",
          selfGenerated: false,
          datedToday: true,
          provenance: { kind: "completedActivity" },
        },
      ],
    });
    expect(decision).toEqual({ print: false, reason: "no-self-generated-signal" });
  });

  it("condition 1: blanks with a named reason when no candidate survives vetting", () => {
    const signalButNoCandidate = facts({ keyMoments: [moment({ selfGenerated: true })] });
    const decision = decidePrintNothing({
      section: "lookBack",
      facts: signalButNoCandidate,
      candidates: [],
    });
    expect(decision).toEqual({ print: false, reason: "no-candidate" });
  });

  it("prints when there is signal and at least one candidate", () => {
    const good = facts({ keyMoments: [moment()] });
    const selection = selectLetterCandidates(good);
    expect(
      decidePrintNothing({ section: "lookBack", facts: good, candidates: selection.lookBack }),
    ).toEqual({ print: true });
  });

  it("F2 — the Ryder shape: clue prints on a today-named interest while look-back blanks", () => {
    // No self-generated scholar moment all day, but a seed invitation dated
    // today. The clue can legitimately stand on it; the look-back cannot.
    const ryder = facts({
      keyMoments: [],
      seedInvitations: [activity({ subject: "what makes an autorotation stable", datedToday: true })],
    });
    const selection = selectLetterCandidates(ryder);

    // look-back: no self-generated signal → blank.
    expect(
      decidePrintNothing({ section: "lookBack", facts: ryder, candidates: selection.lookBack }),
    ).toEqual({ print: false, reason: "no-self-generated-signal" });

    // clue: the signal floor does NOT apply; a today seed survived → print.
    expect(selection.clue.some((c) => c.sourceKind === "seedInvitation")).toBe(true);
    expect(
      decidePrintNothing({ section: "clue", facts: ryder, candidates: selection.clue }),
    ).toEqual({ print: true });
  });

  it("clue still blanks with no-candidate when nothing survived, even without signal", () => {
    const empty = facts({ keyMoments: [], seedInvitations: [] });
    expect(
      decidePrintNothing({ section: "clue", facts: empty, candidates: [] }),
    ).toEqual({ print: false, reason: "no-candidate" });
  });
});

/* ------------------------------------------------------------------------- *
 * finalizeSection — worst a bad model output can do is a blank
 * ------------------------------------------------------------------------- */

describe("finalizeSection safety contract", () => {
  const good = facts({ keyMoments: [moment()] });
  const candidates = selectLetterCandidates(good).lookBack;

  it("prints a clean, budget-safe line", () => {
    const outcome = finalizeSection({
      section: "lookBack",
      facts: good,
      candidates,
      line: "Where did the idea about remainders feel different by the end of today?",
    });
    expect(outcome).toEqual({
      kind: "printed",
      line: "Where did the idea about remainders feel different by the end of today?",
    });
  });

  it("blanks (not throws) on an AI-tell line", () => {
    const outcome = finalizeSection({
      section: "lookBack",
      facts: good,
      candidates,
      line: "Let's dive into your learning journey and unleash the power of remainders",
    });
    expect(outcome).toEqual({ kind: "blank", reason: "failed-validation" });
  });

  it("blanks on an over-budget line", () => {
    const outcome = finalizeSection({
      section: "clue",
      facts: good,
      candidates: selectLetterCandidates(good).clue,
      line: Array.from({ length: MAX_SECTION_WORDS + 10 }, (_v, i) => `w${i}`).join(" "),
    });
    expect(outcome.kind).toBe("blank");
    if (outcome.kind === "blank") expect(outcome.reason).toBe("failed-validation");
  });

  it("F3 — blanks with model-declined (not no-candidate) when candidates existed but the model returned nothing", () => {
    const outcome = finalizeSection({
      section: "lookBack",
      facts: good,
      candidates,
      line: null,
    });
    expect(outcome).toEqual({ kind: "blank", reason: "model-declined" });
  });

  it("F3 — model-declined is distinct from no-candidate (which fires when nothing survived)", () => {
    // No candidates survived at all → no-candidate, regardless of the line.
    const outcome = finalizeSection({
      section: "lookBack",
      facts: good,
      candidates: [],
      line: null,
    });
    expect(outcome).toEqual({ kind: "blank", reason: "no-candidate" });
  });

  it("a blank result always carries a truthy named reason", () => {
    const outcome = finalizeSection({
      section: "lookBack",
      facts: facts({ keyMoments: [moment({ selfGenerated: false })] }),
      candidates: [],
      line: null,
    });
    expect(outcome.kind).toBe("blank");
    if (outcome.kind === "blank") {
      expect(outcome.reason).toBe("no-self-generated-signal");
      expect(typeof outcome.reason).toBe("string");
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });
});
