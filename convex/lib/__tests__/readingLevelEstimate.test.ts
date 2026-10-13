import { describe, it, expect } from "vitest";
import {
  countWords,
  decideEstimateWrite,
  ESTIMATE_REFRESH_MS,
  MIN_TYPED_WORDS_FOR_ESTIMATE,
  normalizeReadingLevel,
  writingEstimateText,
} from "../readingLevels";

// How a WRITING-DERIVED grade-level estimate is recorded and worded. The value
// is produced entirely from the scholar's own typed writing; none of it
// observes reading, and (TRA-513) none of it is compared with, or promoted
// into, the talk level. These tests only assert how recording and wording
// behave — they claim nothing about what the estimate measures.

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("decideEstimateWrite", () => {
  it("stores a first estimate", () => {
    const d = decideEstimateWrite({
      pending: null,
      pendingAt: null,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("stored");
  });

  it("stores a changed estimate", () => {
    const d = decideEstimateWrite({
      pending: "5.2",
      pendingAt: NOW - 30 * 24 * HOUR,
      estimate: "6.1",
      now: NOW,
    });
    expect(d.action).toBe("stored");
  });

  it("skips an unchanged grade inside the freshness window", () => {
    // The observer runs after every tutor session; patching the user doc
    // invalidates every subscription on it. An unchanged conclusion must not
    // thrash the doc.
    const d = decideEstimateWrite({
      pending: "5.2",
      pendingAt: NOW - HOUR,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("skipped");
  });

  it("refreshes an unchanged grade once the stamp goes stale", () => {
    // Age has to stay honest: a displayed "computed 3 weeks ago" on evidence
    // that has been re-confirmed daily would be a wrong number.
    const d = decideEstimateWrite({
      pending: "5.2",
      pendingAt: NOW - ESTIMATE_REFRESH_MS - 1,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("refreshed");
  });

  it("always writes when a stored estimate has never been stamped", () => {
    // Rows written before the timestamp existed. Unknown age is not fresh.
    const d = decideEstimateWrite({
      pending: "5.2",
      pendingAt: null,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("refreshed");
  });

  it("force bypasses the guard for an explicit teacher-run analysis", () => {
    const d = decideEstimateWrite({
      pending: "5.2",
      pendingAt: NOW - HOUR,
      estimate: "5.2",
      now: NOW,
      force: true,
    });
    expect(d.action).toBe("refreshed");
  });
});

describe("normalizeReadingLevel (the one grade comparison form)", () => {
  it("keeps canonical forms stable and collapses a .0 tenth", () => {
    expect(normalizeReadingLevel("Grade 7.3")).toBe("7.3");
    expect(normalizeReadingLevel("7.0")).toBe("7");
    expect(normalizeReadingLevel("7")).toBe(normalizeReadingLevel("7.0"));
    expect(normalizeReadingLevel("kindergarten")).toBe("K");
    expect(normalizeReadingLevel("university")).toBe("college");
    expect(normalizeReadingLevel("nonsense")).toBeNull();
  });
});

describe("countWords", () => {
  it("counts tokens containing a letter, not stray digits or dashes", () => {
    expect(countWords("I think - 3 - the moon is big")).toBe(6);
    expect(countWords("")).toBe(0);
  });
});

describe("writingEstimateText", () => {
  const refusal = "Typed writing: too few typed words to trust";
  const DAY = 24 * HOUR;

  it("states the grade, the typed-word sample and the age", () => {
    expect(writingEstimateText("6.2", 240, NOW - 3 * DAY, NOW)).toBe(
      "Typed writing reads like grade 6.2 · from 240 typed words · 3 days ago",
    );
    expect(writingEstimateText("7.0", MIN_TYPED_WORDS_FOR_ESTIMATE, NOW, NOW)).toContain(
      "grade 7 · from 100 typed words · today",
    );
    expect(writingEstimateText("K", 150, NOW - DAY, NOW)).toContain("kindergarten");
    expect(writingEstimateText("K", 150, NOW - DAY, NOW)).toContain("1 day ago");
  });

  it("refuses to state a grade below the typed-word floor", () => {
    expect(writingEstimateText("6.2", MIN_TYPED_WORDS_FOR_ESTIMATE - 1, NOW, NOW)).toBe(refusal);
    expect(writingEstimateText("6.2", 0, NOW, NOW)).toBe(refusal);
  });

  it("refuses when nothing was stored or the stored grade is unreadable", () => {
    expect(writingEstimateText(null, null, null, NOW)).toBe(refusal);
    expect(writingEstimateText("nonsense", 500, NOW, NOW)).toBe(refusal);
  });

  it("labels an estimate with no word count as an older method, not as too few words", () => {
    expect(writingEstimateText("6.2", null, NOW - 40 * DAY, NOW)).toBe(
      "Estimate from an older method: grade 6.2 · 40 days ago",
    );
    expect(writingEstimateText("6.2", undefined, null, NOW)).toBe(
      "Estimate from an older method: grade 6.2",
    );
  });
});
