import { describe, expect, it } from "vitest";
import {
  buildDailyRecap,
  type DailyRecapMasteryRow,
} from "../dailyRecap";

const DAY_START = Date.UTC(2026, 6, 6, 0, 0, 0);
const TODAY = DAY_START + 3 * 60 * 60 * 1000;
const YESTERDAY = DAY_START - 2 * 60 * 60 * 1000;
const DAILY_RECAP_KEYS = [
  "finished",
  "hasAny",
  "newOnMap",
  "practiced",
  "practicedCount",
  "revealed",
  "yoursNow",
];

function row(
  over: Partial<DailyRecapMasteryRow> &
    Pick<DailyRecapMasteryRow, "skillKey">,
): DailyRecapMasteryRow {
  return {
    source: "practice",
    fluentNow: false,
    lastAttemptAt: null,
    becameFluentAt: null,
    frontierAdvancedAt: null,
    ...over,
  };
}

const labels = new Map<string, string>([
  ["add_within_20", "Adding within 20"],
  ["sub_within_20", "Subtracting within 20"],
  ["mult_facts", "Multiplication facts"],
  ["place_value", "Place value"],
]);

describe("buildDailyRecap — map-movement gate", () => {
  it("does not render for a practice attempt alone", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({ skillKey: "add_within_20", lastAttemptAt: TODAY }),
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap).toEqual({
      practiced: [],
      practicedCount: 0,
      yoursNow: [],
      newOnMap: [],
      revealed: [],
      finished: [],
      hasAny: false,
    });
  });

  it("does not render for an activity completion alone", () => {
    const recap = buildDailyRecap({
      masteryRows: [],
      labelByKey: labels,
      completions: [{ title: "Aquaponics QUEST", completedAt: TODAY }],
      dayStart: DAY_START,
    });

    expect(recap.finished).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });

  it("returns only map rows when weak signals and durable movement coexist", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({ skillKey: "place_value", lastAttemptAt: TODAY }),
        row({
          skillKey: "add_within_20",
          lastAttemptAt: TODAY,
          becameFluentAt: TODAY,
          source: "practice",
          fluentNow: true,
        }),
        row({
          skillKey: "mult_facts",
          lastAttemptAt: TODAY,
          frontierAdvancedAt: TODAY,
        }),
      ],
      labelByKey: labels,
      completions: [{ title: "Aquaponics QUEST", completedAt: TODAY }],
      dayStart: DAY_START,
    });

    expect(recap.practiced).toEqual([]);
    expect(recap.practicedCount).toBe(0);
    expect(recap.finished).toEqual([]);
    expect(recap.yoursNow).toEqual(["Adding within 20"]);
    expect(recap.newOnMap).toEqual(["Multiplication facts"]);
    expect(recap.hasAny).toBe(true);
  });

  it("ignores map transitions from before dayStart", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({
          skillKey: "add_within_20",
          becameFluentAt: YESTERDAY,
          fluentNow: true,
        }),
        row({
          skillKey: "mult_facts",
          frontierAdvancedAt: YESTERDAY,
        }),
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.yoursNow).toEqual([]);
    expect(recap.newOnMap).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });
});

describe("buildDailyRecap — demonstrated fluency", () => {
  it("includes a fluent crossing only while the row is currently fluent", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({
          skillKey: "add_within_20",
          becameFluentAt: TODAY,
          source: "practice",
          fluentNow: true,
        }),
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.yoursNow).toEqual(["Adding within 20"]);
    expect(recap.hasAny).toBe(true);
  });

  it.each(["placement", "accelerated", "reprobe"])(
    "does not claim %s credit as `yoursNow`",
    (source) => {
      const recap = buildDailyRecap({
        masteryRows: [
          row({
            skillKey: "add_within_20",
            becameFluentAt: TODAY,
            source,
            fluentNow: false,
          }),
        ],
        labelByKey: labels,
        completions: [],
        dayStart: DAY_START,
      });

      expect(recap.yoursNow).toEqual([]);
      expect(recap.hasAny).toBe(false);
    },
  );

  it("does not claim a crossing that has already decayed", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({
          skillKey: "add_within_20",
          becameFluentAt: TODAY,
          fluentNow: false,
        }),
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.yoursNow).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });
});

describe("buildDailyRecap — receipt formatting", () => {
  it("gives one node a Fluent row when one attempt stamped both transitions", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({
          skillKey: "add_within_20",
          becameFluentAt: TODAY,
          frontierAdvancedAt: TODAY,
          fluentNow: true,
        }),
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.yoursNow).toEqual(["Adding within 20"]);
    expect(recap.newOnMap).toEqual([]);
  });

  it("orders newest transitions first and caps each map bucket at four labels", () => {
    const yoursNow = ["a", "b", "c", "d", "e"].map((skillKey, i) =>
      row({
        skillKey,
        becameFluentAt: TODAY - i * 1000,
        fluentNow: true,
      }),
    );
    const newOnMap = ["f", "g", "h", "i", "j"].map((skillKey, i) =>
      row({
        skillKey,
        frontierAdvancedAt: TODAY - i * 1000,
      }),
    );
    const revealedRows = ["k", "l", "m", "n", "o"].map((nodeKey, i) => ({
      nodeKey,
      revealedAt: TODAY - i * 1000,
    }));
    const recap = buildDailyRecap({
      masteryRows: [...yoursNow, ...newOnMap],
      revealedRows,
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.yoursNow).toEqual(["a", "b", "c", "d"]);
    expect(recap.newOnMap).toEqual(["f", "g", "h", "i"]);
    expect(recap.revealed).toEqual(["k", "l", "m", "n"]);
  });

  it("gives fluent then frontier priority over revealed events", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({
          skillKey: "add_within_20",
          becameFluentAt: TODAY,
          fluentNow: true,
        }),
        row({
          skillKey: "mult_facts",
          frontierAdvancedAt: TODAY,
        }),
      ],
      revealedRows: [
        { nodeKey: "add_within_20", revealedAt: TODAY },
        { nodeKey: "mult_facts", revealedAt: TODAY },
        { nodeKey: "place_value", revealedAt: TODAY },
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.yoursNow).toEqual(["Adding within 20"]);
    expect(recap.newOnMap).toEqual(["Multiplication facts"]);
    expect(recap.revealed).toEqual(["Place value"]);
  });

  it("renders a reveal-only day and ignores stale reveal rows", () => {
    const recap = buildDailyRecap({
      masteryRows: [],
      revealedRows: [
        { nodeKey: "place_value", revealedAt: TODAY },
        { nodeKey: "mult_facts", revealedAt: YESTERDAY },
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.revealed).toEqual(["Place value"]);
    expect(recap.hasAny).toBe(true);
  });

  it("falls back to a de-slugged label", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({
          skillKey: "some_unknown_skill",
          frontierAdvancedAt: TODAY,
        }),
      ],
      labelByKey: labels,
      completions: [],
      dayStart: DAY_START,
    });

    expect(recap.newOnMap).toEqual(["some unknown skill"]);
  });
});

describe("buildDailyRecap — scholar-facing guardrails", () => {
  it("preserves the released response shape without quantified performance data", () => {
    const recap = buildDailyRecap({
      masteryRows: [
        row({
          skillKey: "sub_within_20",
          lastAttemptAt: TODAY,
          becameFluentAt: TODAY,
          fluentNow: true,
        }),
      ],
      labelByKey: labels,
      completions: [{ title: "Subtraction reflection", completedAt: TODAY }],
      dayStart: DAY_START,
    });

    expect(Object.keys(recap).sort()).toEqual(DAILY_RECAP_KEYS);
    expect(Object.entries(recap).filter(([, value]) => typeof value === "number")).toEqual([
      ["practicedCount", 0],
    ]);
    expect(recap.practiced).toEqual([]);
    expect(recap.finished).toEqual([]);
    expect(recap.yoursNow).toEqual(["Subtracting within 20"]);
  });
});
