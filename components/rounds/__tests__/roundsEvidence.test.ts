import { describe, expect, it } from "vitest";
import {
  TEACHER_LINE_LIMIT,
  WEEK_OBSERVATION_CAP,
  WEEK_PRACTICE_CAP,
  NO_EVIDENCE_HEADLINE,
  moreThisWeek,
  ageYearsMonths,
  buildRoundsEvidence,
  foldRoundsAbsence,
  isSilentWeek,
  resolveNoteDraft,
  roundsHeadline,
  roundsWriteFailure,
  splitUndatedTail,
  type RoundsEvidenceInput,
  type RoundsWeekPulse,
  type StoredNoteDraft,
} from "@/components/rounds/roundsEvidence";
import {
  SCHOLAR_BATCH_SIZE,
  chunkScholarIds,
} from "@/components/rounds/useScholarBatches";

// Every fixture here is invented. Nothing in this file names a real scholar.

const T0 = Date.UTC(2026, 8, 3, 20, 0, 0); // 3 Sep 2026
const DAY = 24 * 60 * 60 * 1000;

function observation(i: number, note: string, teacherName: string | null = "Ms Alani") {
  return {
    _id: `obs${i}`,
    type: "praise",
    note,
    weight: "normal",
    at: T0 + i * DAY,
    teacherName,
  };
}

const EMPTY: RoundsEvidenceInput = {
  observations: [],
  mastery: [],
  practice: { attempts: 0, correct: 0, nodes: 0, lastAttemptAt: null },
  pulse: null,
};

describe("buildRoundsEvidence", () => {
  it("quotes teacher observations in the source's own words", () => {
    const lines = buildRoundsEvidence({
      ...EMPTY,
      observations: [observation(1, "Asked why the pump cycles at night.")],
    });
    const teacher = lines.find((l) => l.source === "Teacher");
    expect(teacher?.quote).toBe("Asked why the pump cycles at night.");
    expect(teacher?.provenance).toContain("Ms Alani");
    expect(teacher?.provenance).toContain("Sep");
  });

  it("counts only as an overflow suffix, never in place of the words", () => {
    const lines = buildRoundsEvidence({
      ...EMPTY,
      observations: [
        observation(1, "one"),
        observation(2, "two"),
        observation(3, "three"),
        observation(4, "four"),
      ],
    });
    const teacher = lines.filter((l) => l.source === "Teacher");
    expect(teacher).toHaveLength(TEACHER_LINE_LIMIT);
    for (const line of teacher) expect(line.quote).toBeTruthy();
    expect(teacher.at(-1)?.overflow).toBe("+2 more this week");
  });

  it("writes silence out as a finding rather than leaving a blank", () => {
    expect(isSilentWeek(EMPTY)).toBe(true);
    expect(buildRoundsEvidence(EMPTY).every((l) => l.absence)).toBe(true);
  });

  it("does not call a week silent when practice happened", () => {
    const input: RoundsEvidenceInput = {
      ...EMPTY,
      practice: { attempts: 12, correct: 9, nodes: 3, lastAttemptAt: T0 },
    };
    expect(isSilentWeek(input)).toBe(false);
    const practice = buildRoundsEvidence(input).find((l) => l.source === "Practice");
    expect(practice?.absence).toBeFalsy();
    expect(practice?.body).toContain("12");
  });

  it("names the Bloom rung from lib/bloom, never an invented word", () => {
    const line = buildRoundsEvidence({
      ...EMPTY,
      mastery: [
        {
          _id: "m1",
          conceptLabel: "Ratio reasoning",
          domain: "math",
          masteryLevel: 3.2,
          evidenceType: "session",
          observedAt: T0,
        },
      ],
    }).find((l) => l.source === "Mastery");
    expect(line?.rung?.label).toBe("Analyze");
    expect(line?.rung?.label).not.toMatch(/emerging|developing/i);
  });

  it.each([
    ["game_session", "read off the game round"],
    ["portfolio_scan", "read off scanned work"],
    ["reflection", "read off the scholar's reflection"],
    ["session", "read off the session transcript"],
  ])("attributes %s mastery to its actual evidence", (attemptContext, phrase) => {
    const line = buildRoundsEvidence({
      ...EMPTY,
      mastery: [
        {
          _id: "m1",
          conceptLabel: "Ratio reasoning",
          domain: "math",
          masteryLevel: 3.2,
          evidenceType: "session",
          attemptContext,
          observedAt: T0,
        },
      ],
    }).find((item) => item.source === "Mastery");

    expect(line?.provenance).toContain(phrase);
  });

  it("always names all four sources, so nothing reads as an unexplained gap", () => {
    const sources = buildRoundsEvidence(EMPTY).map((l) => l.source);
    expect(new Set(sources)).toEqual(
      new Set(["Teacher", "Observer", "Mastery", "Practice"]),
    );
  });
});

function pulse(overrides: Partial<RoundsWeekPulse> = {}): RoundsWeekPulse {
  return {
    latestSummary: null,
    latestSummaryAt: null,
    latestIntervention: null,
    analyzedSessions: 0,
    sampleCount: 0,
    ...overrides,
  };
}

function major(note: string) {
  return { ...observation(1, note), weight: "major" };
}

describe("roundsHeadline", () => {
  it("writes a genuinely empty week out as a muted, quiet headline", () => {
    const headline = roundsHeadline(EMPTY);
    expect(headline.quiet).toBe(true);
    expect(headline.text).toBe(NO_EVIDENCE_HEADLINE);
  });

  it("leads with a major teacher observation over everything else", () => {
    const headline = roundsHeadline({
      ...EMPTY,
      observations: [major("Led the fraction-strip demo for the group.")],
      mastery: [
        {
          _id: "m1",
          conceptLabel: "Ratio reasoning",
          domain: "math",
          masteryLevel: 3.2,
          evidenceType: "session",
          observedAt: T0,
        },
      ],
      practice: { attempts: 20, correct: 15, nodes: 4, lastAttemptAt: T0 },
      pulse: pulse({ latestSummary: "A busy week.", analyzedSessions: 3 }),
    });
    expect(headline.quiet).toBe(false);
    expect(headline.text).toBe("Led the fraction-strip demo for the group.");
  });

  it("surfaces an observer concern when no major note was written", () => {
    const headline = roundsHeadline({
      ...EMPTY,
      pulse: pulse({
        latestIntervention: "Consider pairing on the harder set.",
        analyzedSessions: 2,
      }),
    });
    expect(headline.text).toBe("Consider pairing on the harder set.");
    expect(headline.quiet).toBe(false);
  });

  it("names real mastery movement before practice or an observer summary", () => {
    const headline = roundsHeadline({
      ...EMPTY,
      mastery: [
        {
          _id: "m1",
          conceptLabel: "Equivalent fractions",
          domain: "math",
          masteryLevel: 3.2,
          evidenceType: "session",
          observedAt: T0,
        },
      ],
      practice: { attempts: 20, correct: 15, nodes: 4, lastAttemptAt: T0 },
      pulse: pulse({ latestSummary: "A busy week.", analyzedSessions: 3 }),
    });
    expect(headline.text).toContain("Equivalent fractions");
    expect(headline.text).toContain("Analyze");
  });

  it("summarises practice when that is the week's signal", () => {
    const headline = roundsHeadline({
      ...EMPTY,
      practice: { attempts: 12, correct: 9, nodes: 3, lastAttemptAt: T0 },
    });
    expect(headline.text).toContain("12 attempts");
    expect(headline.quiet).toBe(false);
  });

  it("falls back to the observer summary, then a minor observation", () => {
    const summaryOnly = roundsHeadline({
      ...EMPTY,
      pulse: pulse({ latestSummary: "Steady, engaged throughout.", analyzedSessions: 1 }),
    });
    expect(summaryOnly.text).toBe("Steady, engaged throughout.");

    const minorOnly = roundsHeadline({
      ...EMPTY,
      observations: [observation(1, "Quiet but present.")],
    });
    expect(minorOnly.text).toBe("Quiet but present.");
    expect(minorOnly.quiet).toBe(false);
  });
});

describe("foldRoundsAbsence", () => {
  it("folds the sources that produced nothing into one collective sentence", () => {
    const lines = buildRoundsEvidence({
      ...EMPTY,
      observations: [observation(1, "Asked a sharp question about tides.")],
    });
    const { present, absence } = foldRoundsAbsence(lines);
    // The teacher line stays; observer/mastery/practice fold to one sentence.
    expect(present.some((l) => l.source === "Teacher")).toBe(true);
    expect(present.every((l) => !(l.absence && l.foldable))).toBe(true);
    expect(absence).toBe(
      "No observer analysis, mastery movement or practice this week.",
    );
  });

  it("leaves the observer standing when sessions ran but nothing was written", () => {
    const lines = buildRoundsEvidence({
      ...EMPTY,
      observations: [observation(1, "Asked a sharp question about tides.")],
      pulse: pulse({ analyzedSessions: 2 }),
    });
    const { present, absence } = foldRoundsAbsence(lines);
    // "Sessions ran, but the observer wrote nothing" is a finding, not an
    // empty source — it is not folded away.
    expect(present.some((l) => l.key === "observer-quiet")).toBe(true);
    expect(absence).toBe("No mastery movement or practice this week.");
  });

  it("returns no collective sentence when nothing folds", () => {
    const lines = buildRoundsEvidence({
      ...EMPTY,
      observations: [observation(1, "Asked a sharp question about tides.")],
      mastery: [
        {
          _id: "m1",
          conceptLabel: "Ratio reasoning",
          domain: "math",
          masteryLevel: 3.2,
          evidenceType: "session",
          observedAt: T0,
        },
      ],
      practice: { attempts: 12, correct: 9, nodes: 3, lastAttemptAt: T0 },
      pulse: pulse({ latestSummary: "Engaged.", analyzedSessions: 1 }),
    });
    const { absence } = foldRoundsAbsence(lines);
    expect(absence).toBeNull();
  });
});

describe("resolveNoteDraft (lifted, entryId-keyed drafts)", () => {
  it("follows the server when there is no stored draft", () => {
    const r = resolveNoteDraft(null, "saved text", 4);
    expect(r).toEqual({ text: "saved text", dirty: false, baseVersion: 4 });
  });

  it("treats an empty server note as clean, not dirty", () => {
    const r = resolveNoteDraft(undefined, null, null);
    expect(r).toEqual({ text: "", dirty: false, baseVersion: null });
  });

  it("holds the writer's words and the version they started from when dirty", () => {
    const stored: StoredNoteDraft = { text: "half a thought", baseVersion: 2 };
    const r = resolveNoteDraft(stored, "server moved on", 5);
    // The draft text and its base version win; the newer server version is what
    // the composer compares against to detect a concurrent save.
    expect(r).toEqual({ text: "half a thought", dirty: true, baseVersion: 2 });
  });

  it("keeps drafts isolated per entryId, so week N's draft cannot leak into week N+1", () => {
    // The board keys drafts by entryId; an entry is unique to one scholar in
    // one week. A draft under this-week's entry must not surface for next
    // week's entry (which is what a stale cross-week save would require).
    const drafts: Record<string, StoredNoteDraft> = {
      "entry-weekN": { text: "note for week N", baseVersion: null },
    };
    const thisWeek = resolveNoteDraft(drafts["entry-weekN"], null, null);
    const nextWeek = resolveNoteDraft(drafts["entry-weekN+1"], null, null);
    expect(thisWeek).toEqual({
      text: "note for week N",
      dirty: true,
      baseVersion: null,
    });
    // No draft under next week's entry → clean, empty, nothing to save.
    expect(nextWeek).toEqual({ text: "", dirty: false, baseVersion: null });
  });
});

describe("splitUndatedTail", () => {  it("separates the no-birth-date group so the board can label it", () => {
    const { dated, undated } = splitUndatedTail([
      { scholarId: "a", dateOfBirth: "2017-04-02" },
      { scholarId: "b", dateOfBirth: null },
      { scholarId: "c", dateOfBirth: "2016-01-09" },
    ]);
    expect(dated.map((s) => s.scholarId)).toEqual(["a", "c"]);
    expect(undated.map((s) => s.scholarId)).toEqual(["b"]);
  });
});

describe("ageYearsMonths", () => {
  it("reads out years and months so a youngest-first order is visible", () => {
    expect(ageYearsMonths("2017-07-03", T0)).toBe("9 y 2 m");
  });

  it("returns null when there is no birth date to read", () => {
    expect(ageYearsMonths(null, T0)).toBeNull();
  });
});

describe("roundsWriteFailure", () => {
  it("explains a stale write as a person, not a version number", () => {
    const message = roundsWriteFailure(
      new Error("This note changed while you were writing it."),
      "Kai",
    );
    expect(message).toMatch(/someone else/i);
    expect(message).toContain("Kai");
    expect(message).not.toMatch(/expectedVersion/);
  });

  it("explains a length overflow as a thing to trim, not a raw server error", () => {
    const message = roundsWriteFailure(
      new Error("Keep the note under 4000 characters"),
      "Kai",
    );
    expect(message).toMatch(/too long|trim/i);
    expect(message).not.toMatch(/Keep the note under/);
  });
});

// ---------------------------------------------------------------------------
// The server's read caps. A full array is a FLOOR, not a count, so the board
// must never print a confidently wrong exact remainder.
// ---------------------------------------------------------------------------

describe("bounded reads are described honestly", () => {
  it("counts the remainder exactly below the observation cap", () => {
    expect(moreThisWeek(3, false)).toBe("+3 more this week");
  });

  it("says 'or more' once the read hit the cap", () => {
    expect(moreThisWeek(38, true)).toBe("+38 or more this week");
  });

  it("says nothing when there is no remainder", () => {
    expect(moreThisWeek(0, true)).toBeUndefined();
  });

  it("marks the teacher overflow as a floor at the observation cap", () => {
    const observations = Array.from({ length: WEEK_OBSERVATION_CAP }, (_, i) =>
      observation(i, `Line ${i}`),
    );
    const lines = buildRoundsEvidence({ ...EMPTY, observations });
    const teacher = lines.filter((l) => l.source === "Teacher");
    expect(teacher.at(-1)?.overflow).toContain("or more");
  });

  it("keeps the teacher overflow exact below the cap", () => {
    const observations = Array.from({ length: TEACHER_LINE_LIMIT + 2 }, (_, i) =>
      observation(i, `Line ${i}`),
    );
    const lines = buildRoundsEvidence({ ...EMPTY, observations });
    const teacher = lines.filter((l) => l.source === "Teacher");
    expect(teacher.at(-1)?.overflow).toBe("+2 more this week");
  });

  it("drops the exact attempt count and the last-attempt date at the practice cap", () => {
    const lines = buildRoundsEvidence({
      ...EMPTY,
      practice: {
        attempts: WEEK_PRACTICE_CAP,
        correct: 300,
        nodes: 9,
        lastAttemptAt: T0,
      },
    });
    const practice = lines.find((l) => l.source === "Practice");
    expect(practice?.body).toContain(`At least ${WEEK_PRACTICE_CAP} attempts`);
    expect(practice?.provenance).toContain("cap");
  });
});

describe("a rejected note keeps the writer's words", () => {
  it("says what happened when the note is over the stored length", () => {
    const said = roundsWriteFailure(
      new Error("Keep the note under 4000 characters"),
      "Scholar F",
    );
    expect(said).toContain("still on screen");
    expect(said).toContain("4,000");
  });
});

describe("chunking the roster", () => {
  it("makes no request for an empty roster", () => {
    expect(chunkScholarIds([])).toEqual([]);
  });

  it("keeps a roster at the cap in one batch", () => {
    const ids = Array.from({ length: SCHOLAR_BATCH_SIZE }, (_, i) => `s${i}`);
    expect(chunkScholarIds(ids)).toHaveLength(1);
  });

  it("splits one id past the cap rather than throwing", () => {
    const ids = Array.from({ length: SCHOLAR_BATCH_SIZE + 1 }, (_, i) => `s${i}`);
    const batches = chunkScholarIds(ids);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([`s${SCHOLAR_BATCH_SIZE}`]);
  });

  it("covers every id exactly once across batches", () => {
    const ids = Array.from({ length: 121 }, (_, i) => `s${i}`);
    const batches = chunkScholarIds(ids);
    expect(batches).toHaveLength(3);
    expect(batches.flat()).toEqual(ids);
  });
});
