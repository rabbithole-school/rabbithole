import { describe, it, expect } from "vitest";
import {
  decideEstimateWrite,
  ESTIMATE_REFRESH_MS,
  normalizeReadingLevel,
} from "../readingLevels";

// The honesty properties of how a WRITING-DERIVED grade-level estimate is
// recorded. The value is produced entirely from the scholar's own production
// (typed chat + OCR'd handwritten work); none of it observes reading. These
// tests only assert how the recording behaves — they claim nothing about what
// the estimate measures.

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("decideEstimateWrite", () => {
  it("stores a disagreement with the confirmed level", () => {
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: null,
      pendingAt: null,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("stored");
    expect(d.nextSuggestion).toBe("5.2");
  });

  it("stores an estimate when no level has been confirmed yet", () => {
    // No teacher ruling exists, so there is nothing for evidence to agree with.
    const d = decideEstimateWrite({
      confirmed: null,
      pending: null,
      pendingAt: null,
      estimate: "3",
      now: NOW,
    });
    expect(d.action).toBe("stored");
    expect(d.nextSuggestion).toBe("3");
  });

  it("CLEARS a stale disagreement once evidence agrees with the teacher", () => {
    // The defect this fixes: agreement used to write nothing at all, so a
    // disagreement recorded weeks ago kept sitting on screen looking current.
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: "5.2",
      pendingAt: NOW - 30 * 24 * HOUR,
      estimate: "4",
      now: NOW,
    });
    expect(d.action).toBe("cleared");
    expect(d.nextSuggestion).toBeUndefined();
  });

  it("replaces a superseded disagreement with the current one", () => {
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: "5.2",
      pendingAt: NOW - 30 * 24 * HOUR,
      estimate: "6.1",
      now: NOW,
    });
    expect(d.action).toBe("stored");
    expect(d.nextSuggestion).toBe("6.1");
  });

  it("skips an unchanged conclusion inside the freshness window", () => {
    // The observer runs after every tutor session; patching the user doc
    // invalidates every subscription on it. An unchanged conclusion must not
    // thrash the doc.
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: "5.2",
      pendingAt: NOW - HOUR,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("skipped");
  });

  it("skips repeated AGREEMENT inside the window too", () => {
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: null,
      pendingAt: NOW - HOUR,
      estimate: "4",
      now: NOW,
    });
    expect(d.action).toBe("skipped");
    expect(d.nextSuggestion).toBeUndefined();
  });

  it("refreshes an unchanged conclusion once the stamp goes stale", () => {
    // Age has to stay honest: a displayed "computed 3 weeks ago" on evidence
    // that has been re-confirmed daily would be a wrong number.
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: "5.2",
      pendingAt: NOW - ESTIMATE_REFRESH_MS - 1,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("refreshed");
    expect(d.nextSuggestion).toBe("5.2");
  });

  it("always writes when a stored estimate has never been stamped", () => {
    // Rows written before the timestamp existed. Unknown age is not fresh.
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: "5.2",
      pendingAt: null,
      estimate: "5.2",
      now: NOW,
    });
    expect(d.action).toBe("refreshed");
  });

  it("force bypasses the guard for an explicit teacher-run analysis", () => {
    const d = decideEstimateWrite({
      confirmed: "4",
      pending: "5.2",
      pendingAt: NOW - HOUR,
      estimate: "5.2",
      now: NOW,
      force: true,
    });
    expect(d.action).toBe("refreshed");
  });

  it("never returns a suggestion equal to the confirmed level", () => {
    // Invariant: a stored estimate IS a disagreement. If this ever stored an
    // agreeing value, the board would render "evidence disagrees" when it does
    // not.
    for (const estimate of ["K", "1", "7.3", "12.9", "college"]) {
      const d = decideEstimateWrite({
        confirmed: estimate,
        pending: "2",
        pendingAt: null,
        estimate,
        now: NOW,
      });
      expect(d.nextSuggestion).toBeUndefined();
    }
  });

  it("treats pre-reader as an ordinary confirmed value for agreement", () => {
    const agree = decideEstimateWrite({
      confirmed: "pre-reader",
      pending: "1",
      pendingAt: null,
      estimate: "pre-reader",
      now: NOW,
    });
    expect(agree.action).toBe("cleared");

    const disagree = decideEstimateWrite({
      confirmed: "pre-reader",
      pending: null,
      pendingAt: null,
      estimate: "2",
      now: NOW,
    });
    expect(disagree.action).toBe("stored");
    expect(disagree.nextSuggestion).toBe("2");
  });
});

describe("normalizeReadingLevel (unchanged behaviour guard)", () => {
  it("keeps canonical forms stable", () => {
    expect(normalizeReadingLevel("Grade 7.3")).toBe("7.3");
    expect(normalizeReadingLevel("7.0")).toBe("7");
    expect(normalizeReadingLevel("kindergarten")).toBe("K");
    expect(normalizeReadingLevel("university")).toBe("college");
    expect(normalizeReadingLevel("nonsense")).toBeNull();
  });
});
