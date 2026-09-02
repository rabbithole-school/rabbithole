/**
 * Pure-unit tests for convex/lib/nodeDepthHelpers.ts.
 *
 * These tests cover:
 *   1. bloomToDepth() — Bloom 0–5 → 0..1 normalization + boundary clamping.
 *   2. buildNodeReadings() — teacher path: depth + hasOpenMisconception.
 *   3. buildNodeReadings() — non-teacher (scholar/parent) path: depth only,
 *      hasOpenMisconception STRUCTURALLY ABSENT.
 *
 * No Convex runtime needed — nodeDepthHelpers.ts has zero Convex imports.
 */

import { describe, expect, test } from "vitest";
import {
  bloomToDepth,
  buildNodeReadings,
  BLOOM_MAX,
  normalizeLabel,
} from "../lib/nodeDepthHelpers";

// ── bloomToDepth ──────────────────────────────────────────────────────────

describe("bloomToDepth", () => {
  test("0 (remember) → 0", () => {
    expect(bloomToDepth(0)).toBe(0);
  });

  test("BLOOM_MAX (create) → 1", () => {
    expect(bloomToDepth(BLOOM_MAX)).toBe(1);
  });

  test("2.5 (midpoint) → 0.5", () => {
    expect(bloomToDepth(2.5)).toBe(0.5);
  });

  test("3 (apply) → 0.6", () => {
    expect(bloomToDepth(3)).toBeCloseTo(0.6);
  });

  test("clamps negative input to 0", () => {
    expect(bloomToDepth(-1)).toBe(0);
  });

  test("clamps over-max input to 1", () => {
    expect(bloomToDepth(10)).toBe(1);
  });
});

// ── normalizeLabel ────────────────────────────────────────────────────────

describe("normalizeLabel", () => {
  test("lowercases", () => expect(normalizeLabel("Fractions")).toBe("fractions"));
  test("collapses inner whitespace", () =>
    expect(normalizeLabel("place  value")).toBe("place value"));
  test("trims leading/trailing whitespace", () =>
    expect(normalizeLabel("  halves  ")).toBe("halves"));
});

// ── buildNodeReadings — teacher path ─────────────────────────────────────

describe("buildNodeReadings (isTeacher=true)", () => {
  const nodeKey = "fractions:halves";

  test("depth is max masteryLevel normalised", () => {
    const groups = [
      {
        nodeKey,
        observations: [
          { masteryLevel: 2, evidenceType: "mastery_evidence" },
          { masteryLevel: 4, evidenceType: "mastery_evidence" },
        ],
      },
    ];
    const [r] = buildNodeReadings(groups, true);
    expect(r.depth).toBeCloseTo(4 / BLOOM_MAX);
  });

  test("hasOpenMisconception=true when misconception_signal with absent status", () => {
    const groups = [
      {
        nodeKey,
        observations: [
          { masteryLevel: 3, evidenceType: "misconception_signal" },
        ],
      },
    ];
    const [r] = buildNodeReadings(groups, true);
    expect(r.hasOpenMisconception).toBe(true);
  });

  test("hasOpenMisconception=true when misconception_signal with status='open'", () => {
    const groups = [
      {
        nodeKey,
        observations: [
          {
            masteryLevel: 3,
            evidenceType: "misconception_signal",
            misconceptionStatus: "open" as const,
          },
        ],
      },
    ];
    const [r] = buildNodeReadings(groups, true);
    expect(r.hasOpenMisconception).toBe(true);
  });

  test("hasOpenMisconception absent when misconception is addressed", () => {
    const groups = [
      {
        nodeKey,
        observations: [
          {
            masteryLevel: 3,
            evidenceType: "misconception_signal",
            misconceptionStatus: "addressed" as const,
          },
        ],
      },
    ];
    const [r] = buildNodeReadings(groups, true);
    // Addressed misconceptions do not light the flag.
    expect(r.hasOpenMisconception).toBeUndefined();
    expect("hasOpenMisconception" in r).toBe(false);
  });

  test("hasOpenMisconception absent when no misconception_signal at all", () => {
    const groups = [
      {
        nodeKey,
        observations: [
          { masteryLevel: 3, evidenceType: "mastery_evidence" },
        ],
      },
    ];
    const [r] = buildNodeReadings(groups, true);
    expect("hasOpenMisconception" in r).toBe(false);
  });

  test("multiple nodes returned in input order", () => {
    const groups = [
      { nodeKey: "a", observations: [{ masteryLevel: 1, evidenceType: "mastery_evidence" }] },
      { nodeKey: "b", observations: [{ masteryLevel: 3, evidenceType: "mastery_evidence" }] },
    ];
    const readings = buildNodeReadings(groups, true);
    expect(readings.map((r) => r.nodeKey)).toEqual(["a", "b"]);
  });
});

// ── buildNodeReadings — non-teacher (scholar/parent) path ─────────────────

describe("buildNodeReadings (isTeacher=false) — REDACTION", () => {
  const nodeKey = "fractions:halves";

  test("depth is returned (scholar can see their own depth)", () => {
    const groups = [
      {
        nodeKey,
        observations: [
          {
            masteryLevel: 3,
            evidenceType: "misconception_signal",
            misconceptionStatus: undefined as undefined,
          },
        ],
      },
    ];
    const [r] = buildNodeReadings(groups, false);
    expect(r.depth).toBeCloseTo(3 / BLOOM_MAX);
  });

  test("hasOpenMisconception is STRUCTURALLY ABSENT for non-teacher — not just falsy", () => {
    const groups = [
      {
        nodeKey,
        observations: [
          {
            masteryLevel: 4,
            evidenceType: "misconception_signal",
            // absent status = open, per schema
          },
        ],
      },
    ];
    const [r] = buildNodeReadings(groups, false);

    // The field must not exist at all on a non-teacher reading.
    // `undefined` would be insufficient — a consumer checking
    // `reading.hasOpenMisconception` must not be able to infer the flag.
    expect("hasOpenMisconception" in r).toBe(false);
  });

  test("nodeKey is present on non-teacher reading", () => {
    const groups = [
      {
        nodeKey,
        observations: [{ masteryLevel: 2, evidenceType: "mastery_evidence" }],
      },
    ];
    const [r] = buildNodeReadings(groups, false);
    expect(r.nodeKey).toBe(nodeKey);
  });
});
