import { describe, expect, it } from "vitest";

import {
  calibrationFigureLine,
  confirmedLevelLine,
  frictionLine,
  hasNoFigures,
  levelPhrase,
  levelText,
  figuresAreCurrentLine,
  noFiguresLine,
  roundsFigureSlots,
  writingComplexityLine,
  writingEstimateLine,
  type RoundsLevelSignals,
  type RoundsMathGrade,
  type RoundsPracticeSignals,
} from "../roundsFigures";

// Fixtures are invented. This repository is public; no real scholar, and no
// real record, appears in a test.
function signals(
  over: Partial<RoundsPracticeSignals> = {},
): RoundsPracticeSignals {
  return {
    scholarId: "scholar-fixture",
    domain: "math",
    needsPlacement: false,
    practicedDays: 0,
    lastAttemptAt: null,
    skillsTurnedFluent: 0,
    turnedFluentLabels: [],
    skillsAdvanced: 0,
    frontierLabels: [],
    frictionSkillLabel: null,
    frictionMisses: 0,
    mathGrade: null,
    ...over,
  };
}

function grade(over: Partial<RoundsMathGrade> = {}): RoundsMathGrade {
  return {
    domain: "math",
    domainLabel: "Math",
    value: 3.3,
    label: "Grade 3.3",
    priorValue: 3.1,
    priorLabel: "Grade 3.1",
    delta: 0.2,
    deltaSuppressedReason: null,
    leftCensored: false,
    fluentSkills: 12,
    ...over,
  };
}

describe("roundsFigureSlots", () => {
  it("always returns the same three slots in the same order", () => {
    const empty = roundsFigureSlots(signals()).map((s) => s.key);
    const full = roundsFigureSlots(
      signals({ practicedDays: 3, skillsTurnedFluent: 2, mathGrade: grade() }),
    ).map((s) => s.key);
    expect(empty).toEqual(["practiceDays", "turnedFluent", "mathGrade"]);
    expect(full).toEqual(empty);
  });

  it("states an empty slot rather than collapsing it", () => {
    const [days, fluent, math] = roundsFigureSlots(signals());
    expect(days.value).toBe("None");
    expect(days.present).toBe(false);
    expect(fluent.value).toBe("None");
    expect(math.value).toBe("Not yet");
    // The slot label survives so the row keeps its shape on a projector.
    expect(days.label).toBe("Practice days");
    expect(math.label).toBe("Demonstrated math grade");
  });

  it("says so when the scholar has never been placed", () => {
    const [days] = roundsFigureSlots(signals({ needsPlacement: true }));
    expect(days.caption).toBe("Not placed yet");
  });

  it("singularizes a one-day, one-skill week", () => {
    const [days, fluent] = roundsFigureSlots(
      signals({
        practicedDays: 1,
        skillsTurnedFluent: 1,
        turnedFluentLabels: ["Halving even numbers"],
      }),
    );
    expect(days.value).toBe("1 day");
    expect(fluent.value).toBe("1 skill");
    expect(fluent.caption).toBe("Halving even numbers");
  });

  it("overflows the fluent labels rather than listing them all", () => {
    const [, fluent] = roundsFigureSlots(
      signals({
        skillsTurnedFluent: 4,
        turnedFluentLabels: ["A", "B", "C", "D"],
      }),
    );
    expect(fluent.caption).toBe("A, B +2 more");
  });

  it("draws the movement when there is a real prior value", () => {
    const [, , math] = roundsFigureSlots(signals({ mathGrade: grade() }));
    expect(math.value).toBe("3.1 → 3.3");
    expect(math.caption).toBeNull();
  });

  it("NEVER reconstructs a suppressed delta from zero", () => {
    const [, , math] = roundsFigureSlots(
      signals({
        mathGrade: grade({
          priorValue: null,
          priorLabel: null,
          delta: null,
          deltaSuppressedReason: "no_prior_value",
        }),
      }),
    );
    // The standing value, with no arrow: "0 → 3.3" would draw a three-grade
    // leap that is really instrumentation starting.
    expect(math.value).toBe("Grade 3.3");
    expect(math.value).not.toContain("→");
    expect(math.caption).toContain("nothing earlier to compare");
  });

  it("marks a left-censored baseline quietly, and keeps marking it alongside a delta", () => {
    const [, , suppressed] = roundsFigureSlots(
      signals({
        mathGrade: grade({
          delta: null,
          deltaSuppressedReason: "no_prior_value",
          leftCensored: true,
        }),
      }),
    );
    expect(suppressed.caption).toContain("predates the crossing stamps");

    const [, , moved] = roundsFigureSlots(
      signals({ mathGrade: grade({ leftCensored: true }) }),
    );
    expect(moved.value).toBe("3.1 → 3.3");
    expect(moved.caption).toContain("predates the crossing stamps");
  });

  it("says 'unchanged' rather than drawing a flat arrow", () => {
    const [, , math] = roundsFigureSlots(
      signals({
        mathGrade: grade({ delta: 0, priorValue: 3.3, priorLabel: "Grade 3.3" }),
      }),
    );
    expect(math.value).toBe("Grade 3.3");
    expect(math.caption).toContain("Unchanged");
  });

  it("reports no grade when nothing gradeable is fluent yet", () => {
    const [, , math] = roundsFigureSlots(
      signals({ mathGrade: grade({ value: null, label: null }) }),
    );
    expect(math.value).toBe("Not yet");
    expect(math.present).toBe(false);
  });
});

describe("the silent-figures finding", () => {
  it("treats a week with no arithmetic as a finding, not a gap", () => {
    expect(hasNoFigures(signals())).toBe(true);
    expect(noFiguresLine(signals(), "Scholar A")).toContain("did no practice");
    expect(noFiguresLine(signals({ needsPlacement: true }), "Scholar A")).toContain(
      "not been placed",
    );
  });

  it("is false as soon as anything happened", () => {
    expect(hasNoFigures(signals({ practicedDays: 1 }))).toBe(false);
    expect(hasNoFigures(signals({ skillsAdvanced: 1 }))).toBe(false);
    expect(hasNoFigures(signals({ mathGrade: grade() }))).toBe(false);
  });
});

describe("frictionLine", () => {
  it("passes the server's calibrated line through without adding a threshold", () => {
    // 3 misses is the server's floor; the UI must not raise it.
    const line = frictionLine(
      signals({ frictionSkillLabel: "Remainders", frictionMisses: 3 }),
    );
    expect(line?.headline).toBe("Friction · Remainders · 3 classified misses");
    expect(line?.caption).toContain("from 3 misses up");
    expect(line?.caption).toContain("turned fluent this week are excluded");
  });

  it("renders nothing when the server did not name a skill", () => {
    expect(frictionLine(signals({ frictionMisses: 9 }))).toBeNull();
  });
});

describe("the three level instruments", () => {
  function levels(over: Partial<RoundsLevelSignals> = {}): RoundsLevelSignals {
    return {
      scholarId: "scholar-fixture",
      confirmed: {
        level: "5",
        isPreReader: false,
        setAt: 1_700_000_000_000,
        setBy: "teacher",
        ...(over.confirmed ?? {}),
      },
      estimate: {
        level: null,
        computedAt: null,
        ageDays: null,
        disagreesWithConfirmed: false,
        ...(over.estimate ?? {}),
      },
    };
  }

  it("renders a stored band the way the rest of the app does", () => {
    expect(levelText("5")).toBe("Grade 5");
    expect(levelText("K")).toBe("K");
    expect(levelText("college")).toBe("College");
    expect(levelText("pre-reader")).toBe("Pre-reader");
    expect(levelText(null)).toBe("Not set");
  });

  it("names the confirmed value as a ratified setting", () => {
    const line = confirmedLevelLine(levels());
    expect(line.headline).toBe("Reading level · Grade 5");
    expect(line.caption).toBe("Ratified by a teacher");
  });

  it("distinguishes an observer-set band from a ratified one", () => {
    const line = confirmedLevelLine(
      levels({
        confirmed: { level: "5", isPreReader: false, setAt: 1, setBy: "observer" },
      }),
    );
    expect(line.caption).toBe("Set by the observer — no teacher has ratified it");
  });

  it("says a pre-reader triggers the voice-first register", () => {
    const line = confirmedLevelLine(
      levels({ confirmed: { level: "K", isPreReader: true, setAt: null, setBy: null } }),
    );
    expect(line.headline).toBe("Pre-reader");
    expect(line.caption).toContain("voice first");
  });

  it("shows no estimate while the writing agrees", () => {
    expect(writingEstimateLine(levels(), "Scholar A")).toBeNull();
  });

  it("never calls the estimate a reading level, and names its evidence", () => {
    const line = writingEstimateLine(
      levels({
        estimate: {
          level: "6.2",
          computedAt: 1_700_000_000_000,
          ageDays: 4,
          disagreesWithConfirmed: true,
        },
      }),
      "Scholar A",
    );
    expect(line?.headline).toBe("Writing suggests Grade 6.2");
    expect(line?.headline.toLowerCase()).not.toContain("reading");
    expect(line?.caption).toContain("own writing");
    expect(line?.caption).toContain("typed chat and scanned work");
    // Staleness is visible, because a four-day-old estimate and a four-month-old
    // one carry very different weight in the room.
    expect(line?.caption).toContain("computed 4 days ago");
    expect(line?.caption).toContain("Nobody has settled it against grade 5.");
    // The board runs the same claim short enough to read across a room.
    expect(line?.shortCaption).toBe(
      "From their own writing. Not settled against grade 5.",
    );
    expect(line?.shortCaption.toLowerCase()).not.toContain("reading");
  });

  it("keeps a named band a name inside a sentence", () => {
    expect(levelPhrase("5")).toBe("grade 5");
    expect(levelPhrase("K")).toBe("K");
    expect(levelPhrase("pre-reader")).toBe("Pre-reader");
  });

  it("offers to KEEP the confirmed value rather than to 'dismiss'", () => {
    const line = writingEstimateLine(
      levels({
        estimate: {
          level: "6.2",
          computedAt: 1_700_000_000_000,
          ageDays: 0,
          disagreesWithConfirmed: true,
        },
      }),
      "Scholar A",
    );
    expect(line?.dismissLabel).toBe("Keep grade 5");
    expect(line?.dismissLabel.toLowerCase()).not.toContain("dismiss");
  });

  it("keeps Flesch–Kincaid named as its own mechanical instrument", () => {
    const line = writingComplexityLine(4.8);
    expect(line.headline).toBe("Writing complexity · grade 4.8");
    expect(line.caption).toContain("Flesch–Kincaid");
    expect(line.caption).toContain("not a judgement of the ideas");
    expect(writingComplexityLine(null).headline).toContain(
      "not enough typed writing yet",
    );
  });
});

describe("figuresAreCurrentLine", () => {
  it("says the figures describe now, not the week on screen", () => {
    const line = figuresAreCurrentLine("6 Aug");
    // The figures query takes no week: it is always the last seven days. On a
    // closed week the numbers would be read off a projected wall as that
    // week's, so the line has to name the mismatch rather than caption it.
    expect(line).toContain("last seven days");
    expect(line).toContain("6 Aug");
    expect(line).toContain("describe now");
    // And it must point at the read that IS week-scoped, so the room is not
    // left thinking the week has no practice in it.
    expect(line).toContain("evidence below");
  });
});

describe("calibrationFigureLine (spec §3.3)", () => {
  it("renders nothing below the server's data floor, never an empty shell", () => {
    // The insufficient-data band IS the floor — the pane must show no line at
    // all, not a placeholder.
    expect(
      calibrationFigureLine({ overall: { band: "insufficient_data", n: 3 } }),
    ).toBeNull();
    expect(calibrationFigureLine(null)).toBeNull();
    expect(calibrationFigureLine(undefined)).toBeNull();
  });

  it("reads the child's predictions, never scoring the child", () => {
    const line = calibrationFigureLine({
      overall: { band: "well_calibrated", n: 50 },
    });
    expect(line).not.toBeNull();
    expect(line!.value).toBe("Well calibrated · n=50");
    expect(line!.wellCalibrated).toBe(true);
    // The caption is a diagnostic about the predictions, not a label on the kid.
    expect(line!.caption).toBe("Predictions track results.");
    expect(line!.label.toLowerCase()).toContain("calibration");
  });

  it("names the direction for a mis-calibrated band without judging the child", () => {
    const over = calibrationFigureLine({
      overall: { band: "overconfident", n: 20 },
    });
    expect(over!.caption).toBe("Predictions run ahead of results.");
    expect(over!.wellCalibrated).toBe(false);
    expect(over!.value).toContain("n=20");

    const under = calibrationFigureLine({
      overall: { band: "underconfident", n: 12 },
    });
    expect(under!.caption).toBe("Results run ahead of predictions.");
    expect(under!.wellCalibrated).toBe(false);
  });
});
