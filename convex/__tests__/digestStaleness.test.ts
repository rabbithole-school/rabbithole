import { describe, expect, test } from "vitest";
import {
  digestMetaLine,
  digestStaleNote,
  digestStaleness,
  watermarkAdvanced,
  type DigestSourceSnapshot,
} from "../lib/digestStaleness";

// Pure boundary coverage for the digest watermark comparison. See
// convex/classDigests.ts (read-time staleness + auto-regen) and
// convex/teacherToday.ts (suppression) for the Convex callers.

const counts = {
  completedCount: 1,
  startedCount: 2,
  deliverableCount: 0,
};

describe("watermarkAdvanced", () => {
  test("absent snapshot → never advanced (legacy digest untouched)", () => {
    expect(
      watermarkAdvanced(undefined, {
        latestAnalysisAt: 999,
        latestMessageAt: 999,
      }),
    ).toBe(false);
  });

  test("snapshot without watermark fields → no watermark check", () => {
    // An old row that has counts but no watermark: current watermark is far
    // ahead, yet absent == skip → not advanced.
    const snap: DigestSourceSnapshot = { ...counts };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 5000, latestMessageAt: 5000 }),
    ).toBe(false);
  });

  test("analysis watermark advance is detected", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 101, latestMessageAt: 100 }),
    ).toBe(true);
  });

  test("message watermark advance is detected", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 100, latestMessageAt: 101 }),
    ).toBe(true);
  });

  test("equal watermark → not advanced (boundary)", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 100, latestMessageAt: 100 }),
    ).toBe(false);
  });

  test("a zero snapshot watermark still applies (0 is a real stamp, not absent)", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 0,
      latestMessageAt: 0,
    };
    // A digest generated with no analyses yet (0), then one lands (>0).
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 1, latestMessageAt: 0 }),
    ).toBe(true);
  });

  test("missing current field defaults to 0 (no false advance)", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(watermarkAdvanced(snap, {})).toBe(false);
  });
});

describe("digestStaleness", () => {
  test("absent snapshot → not stale, no delta", () => {
    expect(
      digestStaleness(undefined, { ...counts, latestAnalysisAt: 9 }),
    ).toEqual({
      stale: false,
      newSince: 0,
      completionsSince: 0,
      countGrew: false,
      watermarkAdvanced: false,
    });
  });

  test("count growth marks stale with a positive delta", () => {
    const snap: DigestSourceSnapshot = {
      completedCount: 1,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    const res = digestStaleness(snap, {
      completedCount: 3,
      startedCount: 3,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    });
    expect(res.stale).toBe(true);
    expect(res.countGrew).toBe(true);
    expect(res.newSince).toBe(2);
    expect(res.watermarkAdvanced).toBe(false);
  });

  test("watermark advance marks stale with unchanged counts (Leilani case)", () => {
    const snap: DigestSourceSnapshot = {
      completedCount: 0,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    const res = digestStaleness(snap, {
      completedCount: 0,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 200, // a later observer analysis resolved it
      latestMessageAt: 100,
    });
    expect(res.stale).toBe(true);
    expect(res.watermarkAdvanced).toBe(true);
    expect(res.countGrew).toBe(false);
    expect(res.newSince).toBe(0); // watermark advance has no cardinality
  });

  test("legacy snapshot (no watermark) with unchanged counts stays fresh", () => {
    const snap: DigestSourceSnapshot = {
      completedCount: 1,
      startedCount: 1,
      deliverableCount: 0,
    };
    const res = digestStaleness(snap, {
      completedCount: 1,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 999999, // current source is far ahead …
      latestMessageAt: 999999,
    });
    // … but the snapshot has no watermark to compare → behaves exactly as before.
    expect(res.stale).toBe(false);
    expect(res.watermarkAdvanced).toBe(false);
  });
});

describe("completion leg", () => {
  // The finding: one scholar finished one activity, and the frozen Debrief
  // digest still read "No activities in this dispatch are marked finished
  // yet" — forever, because completion was not part of the watermark.
  const snap: DigestSourceSnapshot = {
    completedCount: 0,
    startedCount: 1,
    deliverableCount: 0,
    latestAnalysisAt: 100,
    latestMessageAt: 100,
    latestCompletionAt: 0,
  };

  test("a completion advances the watermark on its own", () => {
    expect(
      watermarkAdvanced(snap, {
        latestAnalysisAt: 100,
        latestMessageAt: 100,
        latestCompletionAt: 150,
      }),
    ).toBe(true);
  });

  test("an offline completion (no message, no analysis) still stales the digest", () => {
    // Take-home work completed with no session traffic: neither of the two
    // original watermark legs moves. This is exactly the case that used to
    // leave the digest reading fresh while contradicting the run record.
    const res = digestStaleness(snap, {
      completedCount: 1,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
      latestCompletionAt: 150,
    });
    expect(res.stale).toBe(true);
    expect(res.watermarkAdvanced).toBe(true);
    expect(res.completionsSince).toBe(1);
  });

  test("legacy snapshot without a completion stamp keeps the old behavior", () => {
    const legacy: DigestSourceSnapshot = {
      completedCount: 0,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(
      watermarkAdvanced(legacy, {
        latestAnalysisAt: 100,
        latestMessageAt: 100,
        latestCompletionAt: 9999,
      }),
    ).toBe(false);
    // …and loses nothing, because count growth already stales it.
    expect(
      digestStaleness(legacy, {
        completedCount: 1,
        startedCount: 1,
        deliverableCount: 0,
        latestCompletionAt: 9999,
      }).stale,
    ).toBe(true);
  });

  test("completionsSince never goes negative if the count shrinks", () => {
    // A scholar can be removed from a dispatch after generation.
    const res = digestStaleness(
      { ...snap, completedCount: 2 },
      { completedCount: 1, startedCount: 1, deliverableCount: 0 },
    );
    expect(res.completionsSince).toBe(0);
  });
});

describe("digestStaleNote", () => {
  test("names the completion, singular", () => {
    expect(digestStaleNote({ newSince: 1, completionsSince: 1 })).toBe(
      "written before 1 scholar finished — regenerate to see what changed",
    );
  });

  test("names the completion, plural", () => {
    expect(digestStaleNote({ newSince: 3, completionsSince: 2 })).toBe(
      "written before 2 scholars finished — regenerate to see what changed",
    );
  });

  test("falls back to the count delta when nobody finished", () => {
    expect(digestStaleNote({ newSince: 2, completionsSince: 0 })).toBe(
      "2 new since — regenerate for the latest",
    );
  });

  test("a watermark-only advance never reports '0 new since'", () => {
    expect(digestStaleNote({ newSince: 0, completionsSince: 0 })).toBe(
      "new work since — regenerate for the latest",
    );
  });
});

describe("digestMetaLine", () => {
  test("cohort line is singular at one activity", () => {
    // The walkthrough bug: "1 activities done".
    expect(
      digestMetaLine("cohort", {
        completedCount: 1,
        startedCount: 1,
        deliverableCount: 0,
      }),
    ).toBe("1 activity done · 1 active");
  });

  test("cohort line is plural at zero and at many", () => {
    expect(
      digestMetaLine("cohort", {
        completedCount: 0,
        startedCount: 2,
        deliverableCount: 0,
      }),
    ).toBe("0 activities done · 2 active");
    expect(
      digestMetaLine("cohort", {
        completedCount: 4,
        startedCount: 5,
        deliverableCount: 0,
      }),
    ).toBe("4 activities done · 5 active");
  });

  test("activity line counts scholars, so it needs no noun", () => {
    expect(
      digestMetaLine("activity", {
        completedCount: 1,
        startedCount: 3,
        deliverableCount: 2,
      }),
    ).toBe("1 done · 3 started · 2 submitted");
  });
});
