import { describe, expect, test } from "vitest";
import {
  computeRosterPulse,
  attentionScoreOf,
  attentionLevelOf,
  SPARKLINE_MAX_POINTS,
  type RosterAnalysisRow,
} from "../lib/rosterPulse";

// ─── Pure helper: computeRosterPulse ─────────────────────────────────────

let seq = 0;
/** One analysis row for `scholarId`; `t` orders rows within a scholar. */
function row(
  scholarId: string,
  fields: Partial<RosterAnalysisRow> = {},
): RosterAnalysisRow {
  return {
    scholarId,
    sessionId: fields.sessionId ?? `sess-${scholarId}`,
    createdAt: fields.createdAt ?? ++seq,
    engagement: fields.engagement ?? null,
    onTask: fields.onTask ?? null,
    concernFlags: fields.concernFlags ?? [],
    summary: fields.summary,
    suggestedIntervention: fields.suggestedIntervention,
  };
}

describe("computeRosterPulse", () => {
  test("empty input → empty map", () => {
    expect(computeRosterPulse([]).byScholar).toEqual({});
  });

  test("groups by scholar and orders the sparkline oldest→newest", () => {
    // Feed rows out of order; the helper must sort by createdAt.
    const rows = [
      row("a", { createdAt: 30, engagement: 0.9 }),
      row("a", { createdAt: 10, engagement: 0.3 }),
      row("a", { createdAt: 20, engagement: 0.6 }),
      row("b", { createdAt: 5, engagement: 0.5 }),
    ];
    const { byScholar } = computeRosterPulse(rows);
    expect(byScholar.a.sparkline).toEqual([0.3, 0.6, 0.9]);
    expect(byScholar.a.latestEngagement).toBe(0.9);
    expect(byScholar.a.sampleCount).toBe(3);
    expect(byScholar.b.sparkline).toEqual([0.5]);
  });

  test("caps the sparkline at the most recent N points", () => {
    const rows = Array.from({ length: SPARKLINE_MAX_POINTS + 6 }, (_, i) =>
      row("a", { createdAt: i + 1, engagement: i / 100 }),
    );
    const { byScholar } = computeRosterPulse(rows);
    expect(byScholar.a.sparkline).toHaveLength(SPARKLINE_MAX_POINTS);
    // Keeps the tail (most recent), drops the oldest 6.
    expect(byScholar.a.sparkline[0]).toBe(6 / 100);
    expect(byScholar.a.latestEngagement).toBe(
      (SPARKLINE_MAX_POINTS + 5) / 100,
    );
  });

  test("rising engagement → trend up; falling → down; steady → flat", () => {
    const up = computeRosterPulse([
      row("u", { createdAt: 1, engagement: 0.3 }),
      row("u", { createdAt: 2, engagement: 0.4 }),
      row("u", { createdAt: 3, engagement: 0.8 }),
      row("u", { createdAt: 4, engagement: 0.9 }),
    ]).byScholar.u;
    expect(up.trend).toBe("up");
    expect(up.trendDelta).toBeGreaterThan(0);

    const down = computeRosterPulse([
      row("d", { createdAt: 1, engagement: 0.9 }),
      row("d", { createdAt: 2, engagement: 0.8 }),
      row("d", { createdAt: 3, engagement: 0.4 }),
      row("d", { createdAt: 4, engagement: 0.3 }),
    ]).byScholar.d;
    expect(down.trend).toBe("down");
    expect(down.trendDelta).toBeLessThan(0);

    const flat = computeRosterPulse([
      row("f", { createdAt: 1, engagement: 0.7 }),
      row("f", { createdAt: 2, engagement: 0.72 }),
      row("f", { createdAt: 3, engagement: 0.69 }),
      row("f", { createdAt: 4, engagement: 0.71 }),
    ]).byScholar.f;
    expect(flat.trend).toBe("flat");
  });

  test("single reading → no trend", () => {
    const { byScholar } = computeRosterPulse([
      row("a", { engagement: 0.6 }),
    ]);
    expect(byScholar.a.trend).toBeNull();
    expect(byScholar.a.trendDelta).toBeNull();
  });

  test("too few readings (< TREND_MIN_POINTS) → no trend claim", () => {
    // A real-looking 3-point slide (0.9 → 0.4) still yields NO trend: one
    // reading per half is noise, not a trend. Honesty over drama.
    const { byScholar } = computeRosterPulse([
      row("a", { createdAt: 1, engagement: 0.9 }),
      row("a", { createdAt: 2, engagement: 0.6 }),
      row("a", { createdAt: 3, engagement: 0.4 }),
    ]);
    expect(byScholar.a.sparkline).toEqual([0.9, 0.6, 0.4]); // still plotted
    expect(byScholar.a.trend).toBeNull();
    expect(byScholar.a.trendDelta).toBeNull();
    // With no trend claim, a 3-point dip alone doesn't manufacture "concern".
    expect(byScholar.a.attentionLevel).not.toBe("concern");
  });

  test("carries the observer's most-recent non-empty summary + intervention", () => {
    const { byScholar } = computeRosterPulse([
      row("a", { createdAt: 1, engagement: 0.5, summary: "Warmed up on fractions." }),
      row("a", { createdAt: 2, engagement: 0.5, summary: "   ", suggestedIntervention: "Pair on the next problem." }),
      row("a", { createdAt: 3, engagement: 0.5, summary: "Drifted off task near the end." }),
      row("a", { createdAt: 4, engagement: 0.5 }),
    ]);
    const p = byScholar.a;
    // Most-recent NON-EMPTY summary (row 4 has none → falls back to row 3).
    expect(p.latestSummary).toBe("Drifted off task near the end.");
    // The summary's age is ITS OWN row's timestamp, not the newest analysis's —
    // consumers age the narrative by latestSummaryAt, so a fresh summary-less
    // analysis must not launder an old summary as current.
    expect(p.latestSummaryAt).toBe(3);
    expect(p.lastAnalysisAt).toBe(4);
    // Only row 2 set an intervention → that's the most-recent non-empty one.
    expect(p.latestIntervention).toBe("Pair on the next problem.");
  });

  test("no summary anywhere → null summary/intervention", () => {
    const { byScholar } = computeRosterPulse([
      row("a", { engagement: 0.6 }),
    ]);
    expect(byScholar.a.latestSummary).toBeNull();
    expect(byScholar.a.latestSummaryAt).toBeNull();
    expect(byScholar.a.latestIntervention).toBeNull();
  });

  test("means and distinct concern flags (most-recent-first, capped)", () => {
    const { byScholar } = computeRosterPulse([
      row("a", { createdAt: 1, engagement: 0.4, onTask: 0.5, concernFlags: ["off task"] }),
      row("a", { createdAt: 2, engagement: 0.6, onTask: 0.7, concernFlags: ["Off Task", "misconception: halves"] }),
      row("a", { createdAt: 3, engagement: 0.8, onTask: 0.9, concernFlags: ["avoidance", "drift", "stuck"] }),
    ]);
    const p = byScholar.a;
    expect(p.latelyEngagement).toBeCloseTo(0.6, 5);
    expect(p.latelyOnTask).toBeCloseTo(0.7, 5);
    expect(p.concernCount).toBe(6); // total occurrences
    // Newest-first, deduped case-insensitively, capped at 3.
    expect(p.concernFlags).toEqual(["avoidance", "drift", "stuck"]);
  });

  test("counts distinct analyzed sessions", () => {
    const { byScholar } = computeRosterPulse([
      row("a", { sessionId: "s1", engagement: 0.5 }),
      row("a", { sessionId: "s1", engagement: 0.6 }),
      row("a", { sessionId: "s2", engagement: 0.7 }),
    ]);
    expect(byScholar.a.analyzedSessions).toBe(2);
    expect(byScholar.a.sampleCount).toBe(3);
  });
});

// ─── Attention scoring / level ───────────────────────────────────────────

describe("attentionScoreOf / attentionLevelOf", () => {
  test("a concern flag forces the concern level and a high score", () => {
    const input = { concernCount: 1, trendDelta: 0.1, latelyEngagement: 0.9, latelyOnTask: 0.9 };
    expect(attentionLevelOf(input)).toBe("concern");
    expect(attentionScoreOf(input)).toBeGreaterThanOrEqual(2);
  });

  test("a steady, engaged scholar is ok with a ~0 score", () => {
    const input = { concernCount: 0, trendDelta: 0.02, latelyEngagement: 0.85, latelyOnTask: 0.9 };
    expect(attentionLevelOf(input)).toBe("ok");
    expect(attentionScoreOf(input)).toBe(0);
  });

  test("a mild slide with no concern is a nudge", () => {
    const input = { concernCount: 0, trendDelta: -0.09, latelyEngagement: 0.7, latelyOnTask: 0.8 };
    expect(attentionLevelOf(input)).toBe("nudge");
    expect(attentionScoreOf(input)).toBeGreaterThan(0);
  });

  test("a steep slide (no flag) still reads as concern", () => {
    const input = { concernCount: 0, trendDelta: -0.2, latelyEngagement: 0.7, latelyOnTask: 0.8 };
    expect(attentionLevelOf(input)).toBe("concern");
  });

  test("low on-task alone reads as concern", () => {
    const input = { concernCount: 0, trendDelta: 0.0, latelyEngagement: 0.6, latelyOnTask: 0.4 };
    expect(attentionLevelOf(input)).toBe("concern");
  });

  test("attention score orders concern > nudge > ok", () => {
    const concern = attentionScoreOf({ concernCount: 2, trendDelta: -0.2, latelyEngagement: 0.3, latelyOnTask: 0.4 });
    const nudge = attentionScoreOf({ concernCount: 0, trendDelta: -0.09, latelyEngagement: 0.7, latelyOnTask: 0.8 });
    const ok = attentionScoreOf({ concernCount: 0, trendDelta: 0.05, latelyEngagement: 0.9, latelyOnTask: 0.95 });
    expect(concern).toBeGreaterThan(nudge);
    expect(nudge).toBeGreaterThan(ok);
    expect(ok).toBe(0);
  });
});
