import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../sessionHelpers";

// Most build*Section helpers are template substitution where a regression
// would be obvious by eye. These tests cover the three that have real
// branching logic with thresholds — silent regressions there would
// corrupt the tutor's input in ways that wouldn't show up in a quick read.

function build(opts: {
  masteryContext?: Parameters<typeof buildSystemPrompt>[11];
  signalContext?: Parameters<typeof buildSystemPrompt>[12];
  timingContext?: Parameters<typeof buildSystemPrompt>[13];
}) {
  return buildSystemPrompt(
    null, null, "Kai",
    null, null, null, null, null, null, null, null,
    opts.masteryContext ?? null,
    opts.signalContext ?? null,
    opts.timingContext ?? null,
    null, null, null, null, null, null, null,
    false, false, null,
  );
}

// ── buildMasterySection: Bloom-level thresholds ──────────────────────
//
// The Bloom label mapping is six explicit cutoffs (0.5/1.5/2.5/3.5/4.5).
// A typo'd threshold silently mislabels mastery in the tutor's context.

describe("mastery section — Bloom labels", () => {
  test("each threshold lands in the right bucket", () => {
    const prompt = build({
      masteryContext: [
        { domain: "Math", concept: "remember-low",  level: 0.4, confidence: 0.8, evidence: "x", studentInitiated: false },
        { domain: "Math", concept: "remember-high", level: 0.5, confidence: 0.8, evidence: "x", studentInitiated: false },
        { domain: "Math", concept: "understand",    level: 1.5, confidence: 0.8, evidence: "x", studentInitiated: false },
        { domain: "Math", concept: "apply",         level: 2.5, confidence: 0.8, evidence: "x", studentInitiated: false },
        { domain: "Math", concept: "analyze",       level: 3.5, confidence: 0.8, evidence: "x", studentInitiated: false },
        { domain: "Math", concept: "evaluate",      level: 4.4, confidence: 0.8, evidence: "x", studentInitiated: false },
        { domain: "Math", concept: "create",        level: 4.5, confidence: 0.8, evidence: "x", studentInitiated: false },
      ],
    });
    expect(prompt).toContain("remember-low: Remember (0.4)");
    expect(prompt).toContain("remember-high: Understand (0.5)");
    expect(prompt).toContain("understand: Apply (1.5)");
    expect(prompt).toContain("apply: Analyze (2.5)");
    expect(prompt).toContain("analyze: Evaluate (3.5)");
    expect(prompt).toContain("evaluate: Evaluate (4.4)");
    expect(prompt).toContain("create: Create (4.5)");
  });

  test("groups by domain and marks student-initiated with ★", () => {
    const prompt = build({
      masteryContext: [
        { domain: "Physics", concept: "force",    level: 3.0, confidence: 0.8, evidence: "x", studentInitiated: true  },
        { domain: "Physics", concept: "momentum", level: 2.0, confidence: 0.8, evidence: "x", studentInitiated: false },
        { domain: "Biology", concept: "cells",    level: 1.5, confidence: 0.8, evidence: "x", studentInitiated: false },
      ],
    });
    // Higher level appears first within a domain.
    const physicsIdx = prompt.indexOf("force");
    const momentumIdx = prompt.indexOf("momentum");
    expect(physicsIdx).toBeGreaterThan(0);
    expect(momentumIdx).toBeGreaterThan(physicsIdx);
    expect(prompt).toContain("force: Analyze (3.0) ★");
    expect(prompt).toContain("momentum: Apply (2.0)");
    expect(prompt).not.toContain("momentum: Apply (2.0) ★");
  });
});

// ── buildSignalSection: strength classifier ──────────────────────────
//
// strength = highCount > count/2 ? "strong" : count > 3 ? "moderate" : "emerging"
// A regression at either threshold mislabels learners.

describe("signal section — strength classification", () => {
  test("strong when majority of observations are high", () => {
    const prompt = build({
      signalContext: { task_commitment: { count: 4, highCount: 3 } },
    });
    expect(prompt).toContain("task commitment: strong (3/4 high)");
  });

  test("moderate when count > 3 but not majority-high", () => {
    const prompt = build({
      signalContext: { self_direction: { count: 4, highCount: 1 } },
    });
    expect(prompt).toContain("self direction: moderate (1/4 high)");
  });

  test("emerging when count <= 3 and not majority-high", () => {
    const prompt = build({
      signalContext: { metacognition: { count: 3, highCount: 1 } },
    });
    expect(prompt).toContain("metacognition: emerging (1/3 high)");
  });
});

// ── buildTimingSection: pacing thresholds ────────────────────────────
//
// The ≤5 / ≤10 / >10 messages drive how the tutor winds a session
// down. Getting the boundary wrong means the tutor either starts new
// threads too late or wraps too early.

describe("timing section — wrap-up thresholds", () => {
  const MIN = 60_000;
  const baseStart = 1_000_000;

  test("at >10 minutes remaining: pacing note only, no wrap-up", () => {
    const now = Date.now();
    const prompt = build({
      timingContext: {
        sessionStartedAt: baseStart,
        unitEndsAt: now + 15 * MIN,
        unitDurationMinutes: 30,
      },
    });
    expect(prompt).toContain("TIMING:");
    expect(prompt).toContain("15 minutes remaining");
    expect(prompt).not.toContain("Almost over");
    expect(prompt).not.toContain("Approaching the end");
  });

  test("at ≤10 minutes: 'Approaching the end' guidance fires", () => {
    const now = Date.now();
    const prompt = build({
      timingContext: {
        sessionStartedAt: baseStart,
        unitEndsAt: now + 8 * MIN,
        unitDurationMinutes: 30,
      },
    });
    expect(prompt).toContain("Approaching the end");
    expect(prompt).not.toContain("Almost over");
  });

  test("at ≤5 minutes: 'Almost over' takes over", () => {
    const now = Date.now();
    const prompt = build({
      timingContext: {
        sessionStartedAt: baseStart,
        unitEndsAt: now + 3 * MIN,
        unitDurationMinutes: 30,
      },
    });
    expect(prompt).toContain("Almost over");
    expect(prompt).not.toContain("Approaching the end");
    expect(prompt).toContain("one brief content-free goodbye");
    expect(prompt).toContain("point only to where they can resume");
    expect(prompt).not.toContain("summarize what they explored");
  });

  test("singular vs. plural minutes", () => {
    const now = Date.now();
    const oneMin = build({
      timingContext: {
        sessionStartedAt: baseStart,
        unitEndsAt: now + 1 * MIN,
        unitDurationMinutes: 30,
      },
    });
    expect(oneMin).toContain("1 minute remaining");
    expect(oneMin).not.toContain("1 minutes remaining");
  });

  test("no end time, just a duration: gives pacing note without a countdown", () => {
    const prompt = build({
      timingContext: {
        sessionStartedAt: baseStart,
        unitEndsAt: null,
        unitDurationMinutes: 45,
      },
    });
    expect(prompt).toContain("designed for ~45 minutes");
    expect(prompt).not.toContain("remaining");
  });
});
