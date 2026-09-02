import { describe, expect, it } from "vitest";

import {
  calculatorLicenseCardPresentation,
  calculatorLicenseInvitationCopy,
} from "./calculatorLicense";

describe("calculatorLicenseInvitationCopy", () => {
  it("keeps diagnostic percentages and numeric thresholds out of scholar-facing copy", () => {
    const building = calculatorLicenseInvitationCopy("building");
    const ready = calculatorLicenseInvitationCopy("ready");

    expect(building.body).toContain("A teacher can give you");
    expect(building.body).toContain("Practicing fast math helps");
    expect(ready.title).toBe("You're ready for the test");
    expect(building.meta).toBe(
      "A teacher can grant calculator permission when they're ready.",
    );
    const serialized = JSON.stringify({ building, ready });
    expect(serialized).not.toContain("%");
    expect(serialized).not.toContain("unlock");
    expect(serialized).not.toMatch(/\d/);
  });
});

describe("calculatorLicenseCardPresentation", () => {
  const known = {
    calibration: "known" as const,
    baselineKnown: true,
    automaticCount: 263,
    denominator: 418,
    percent: 63,
    ready: false,
  };
  const licensedAt = { issuedAt: 1_755_000_000_000, issuedByName: "Teacher Lee" };

  it("keeps one fixed grammar across every state", () => {
    const states = [
      calculatorLicenseCardPresentation({ license: null, fastMath: undefined }),
      calculatorLicenseCardPresentation({ license: null, fastMath: known }),
      calculatorLicenseCardPresentation({
        license: null,
        fastMath: { ...known, automaticCount: 418, percent: 100, ready: true },
      }),
      calculatorLicenseCardPresentation({ license: licensedAt, fastMath: known }),
    ];
    for (const card of states) {
      expect(card.eyebrow).toBe("Fast math");
      expect(card.title).toBe("Calculator license");
      expect(card.cue).toBe("Your own practice progress");
      // The bottom action is IDENTICAL in every state — same words, and no
      // weight field, so neither frontend can render it as a primary CTA
      // competing with the check-in / playlist card above it.
      expect(card.action).toEqual({
        label: "Practice fast math",
        busyLabel: "Starting fast math…",
      });
    }
  });

  it("shows an em dash rather than 0% while the reading is loading or uncalibrated", () => {
    const loading = calculatorLicenseCardPresentation({
      license: null,
      fastMath: undefined,
    });
    const uncalibrated = calculatorLicenseCardPresentation({
      license: null,
      fastMath: {
        calibration: "uncalibrated",
        baselineKnown: false,
        automaticCount: 0,
        denominator: 418,
        percent: 0,
        ready: false,
      },
    });
    for (const card of [loading, uncalibrated]) {
      expect(card.state).toBe("uncalibrated");
      expect(card.status.value).toBe("—");
      expect(card.status.detail).toBe("Fast math is still getting a baseline");
      expect(card.chip).toEqual({ label: "Not licensed", tone: "neutral" });
      expect(card.showCredentialFields).toBe(false);
    }
  });

  it("reports a calibrated zero as a real measurement", () => {
    const card = calculatorLicenseCardPresentation({
      license: null,
      fastMath: { ...known, automaticCount: 0, percent: 0 },
    });
    expect(card.state).toBe("progress");
    expect(card.status.value).toBe("0%");
    expect(card.status.detail).toBe("0 of 418 facts automatic");
  });

  it("carries the scholar's own percentage and fraction while building", () => {
    const card = calculatorLicenseCardPresentation({
      license: null,
      fastMath: known,
    });
    expect(card.state).toBe("progress");
    expect(card.status.value).toBe("63%");
    expect(card.status.detail).toBe("263 of 418 facts automatic");
    expect(card.body).toContain("Keep practicing fast math");
    expect(card.body).toContain("A teacher can grant calculator permission");
  });

  it("asks for a proctor once every fact is automatic, without granting anything", () => {
    const card = calculatorLicenseCardPresentation({
      license: null,
      fastMath: { ...known, automaticCount: 418, percent: 100, ready: true },
    });
    expect(card.state).toBe("ready");
    expect(card.chip).toEqual({ label: "Ready for the test", tone: "neutral" });
    expect(card.status.value).toBe("100%");
    expect(card.body).toContain("Ask a teacher to proctor");
    expect(card.showCredentialFields).toBe(false);
  });

  it("lets the durable license win over a decayed reading", () => {
    const card = calculatorLicenseCardPresentation({
      license: licensedAt,
      fastMath: { ...known, automaticCount: 368, percent: 88, ready: false },
    });
    expect(card.state).toBe("licensed");
    expect(card.chip).toEqual({ label: "Licensed", tone: "on" });
    expect(card.status.value).toBe("88%");
    expect(card.status.detail).toBe("368 of 418 facts automatic");
    expect(card.body).toContain("optional now");
    expect(card.showCredentialFields).toBe(true);
  });

  it("keeps a licensed scholar licensed even with no baseline", () => {
    const card = calculatorLicenseCardPresentation({
      license: licensedAt,
      fastMath: {
        calibration: "uncalibrated",
        baselineKnown: false,
        automaticCount: 0,
        denominator: 418,
        percent: 0,
        ready: false,
      },
    });
    expect(card.state).toBe("licensed");
    expect(card.chip.label).toBe("Licensed");
    expect(card.status.value).toBe("—");
  });

  it("never introduces a score, threshold, comparison, or test workflow", () => {
    const serialized = JSON.stringify([
      calculatorLicenseCardPresentation({ license: null, fastMath: undefined }),
      calculatorLicenseCardPresentation({ license: null, fastMath: known }),
      calculatorLicenseCardPresentation({
        license: null,
        fastMath: { ...known, automaticCount: 418, percent: 100, ready: true },
      }),
      calculatorLicenseCardPresentation({ license: licensedAt, fastMath: known }),
    ]).toLowerCase();
    for (const banned of [
      "score",
      "threshold",
      "pass",
      "fail",
      "streak",
      "class",
      "rank",
      "average",
      "take the test",
      "start the test",
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });
});
