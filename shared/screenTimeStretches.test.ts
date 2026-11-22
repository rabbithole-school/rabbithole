import { describe, expect, test } from "vitest";

import {
  NO_ACTIVITY_DETAIL,
  PRACTICE_ATTEMPT_LEAD_CAP_MS,
  PRACTICE_ATTEMPT_TRAIL_MS,
  classifyDayStretches,
  kindMinutesAtBell,
  practiceWindowsFromAttempts,
  type StretchSources,
} from "./screenTimeStretches";

const MIN = 60_000;
const at = (minute: number) => minute * MIN;
const span = (from: number, to: number) => ({ start: at(from), end: at(to) });
const NONE = NO_ACTIVITY_DETAIL;

function sources(partial: Partial<StretchSources>): StretchSources {
  return {
    foreground: [],
    launchedApps: [],
    web: [],
    builderOnScreen: [],
    builderActive: [],
    practice: [],
    chat: [],
    ...partial,
  };
}

/** [kind, from, to, detail] in minutes, for compact expectations. */
function shape(day: ReturnType<typeof classifyDayStretches>) {
  return day.stretches.map((s) => [s.kind, s.start / MIN, s.end / MIN, s.detail ?? null]);
}

describe("classifyDayStretches", () => {
  test("plain foreground is Rabbithole time, and contiguous spans join", () => {
    const day = classifyDayStretches(
      sources({ foreground: [span(0, 1), span(1, 2), span(5, 6)] }),
    );
    expect(shape(day)).toEqual([
      ["rabbithole", 0, 2, NONE],
      ["rabbithole", 5, 6, NONE],
    ]);
    expect(day.totalMinutes).toBe(3);
    expect(day.minutesByKind.rabbithole).toBe(3);
  });

  test("labels never add time outside the device's foreground", () => {
    const day = classifyDayStretches(
      sources({
        foreground: [span(10, 20)],
        // A laptop web session and chat before the iPad came on.
        web: [{ ...span(0, 12), detail: "Epic" }],
        chat: [{ ...span(0, 30), detail: "Fractions" }],
      }),
    );
    expect(shape(day)).toEqual([
      ["web", 10, 12, "Epic"],
      ["chat", 12, 20, "Fractions"],
    ]);
    expect(day.totalMinutes).toBe(10);
  });

  test("building outranks playing; the rest of own-app time is playing", () => {
    const app = "Volcano app";
    const day = classifyDayStretches(
      sources({
        foreground: [span(0, 30)],
        builderOnScreen: [{ ...span(5, 25), detail: app }],
        builderActive: [{ ...span(8, 12), detail: app }],
        // A tutor turn during the build does not relabel it.
        chat: [{ ...span(9, 11), detail: "Chat" }],
      }),
    );
    expect(shape(day)).toEqual([
      ["rabbithole", 0, 5, NONE],
      ["playing", 5, 8, app],
      ["building", 8, 12, app],
      ["playing", 12, 25, app],
      ["rabbithole", 25, 30, NONE],
    ]);
    expect(day.minutesByKind).toMatchObject({
      building: 4,
      playing: 16,
      rabbithole: 10,
      chat: 0,
    });
  });

  test("web outranks own app; practice outranks chat", () => {
    const day = classifyDayStretches(
      sources({
        foreground: [span(0, 20)],
        web: [span(2, 4)],
        builderOnScreen: [span(0, 6)],
        practice: [span(10, 15)],
        chat: [span(12, 18)],
      }),
    );
    expect(shape(day).map(([kind, from, to]) => [kind, from, to])).toEqual([
      ["playing", 0, 2],
      ["web", 2, 4],
      ["playing", 4, 6],
      ["rabbithole", 6, 10],
      ["practice", 10, 15],
      ["chat", 15, 18],
      ["rabbithole", 18, 20],
    ]);
  });

  test("a chat that moves to another session splits at the switch", () => {
    const day = classifyDayStretches(
      sources({
        foreground: [span(0, 20)],
        chat: [
          { ...span(0, 10), detail: "Volcanoes" },
          // A newer turn in another session takes over where windows overlap.
          { ...span(8, 16), detail: "Fractions" },
        ],
      }),
    );
    expect(shape(day)).toEqual([
      ["chat", 0, 8, "Volcanoes"],
      ["chat", 8, 16, "Fractions"],
      ["rabbithole", 16, 20, NONE],
    ]);
  });

  test("a launched app is its own stretch, named, and wins over everything", () => {
    const day = classifyDayStretches(
      sources({
        foreground: [span(0, 5), span(15, 20)],
        launchedApps: [
          { ...span(5, 10), detail: "Sketch app" },
          { ...span(10, 15), detail: "Robot app" },
        ],
        web: [span(4, 12)],
      }),
    );
    expect(shape(day)).toEqual([
      ["rabbithole", 0, 4, NONE],
      ["web", 4, 5, null],
      ["launched_app", 5, 10, "Sketch app"],
      ["launched_app", 10, 15, "Robot app"],
      ["rabbithole", 15, 20, NONE],
    ]);
    expect(day.minutesByKind.launched_app).toBe(10);
    expect(day.totalMinutes).toBe(20);
  });

  test("own app on screen with no measured time is left open, never counted", () => {
    const day = classifyDayStretches(
      sources({
        foreground: [span(0, 10), span(20, 25)],
        builderOnScreen: [span(5, 30)],
      }),
    );
    expect(day.leftOpen).toEqual([span(10, 20), span(25, 30)]);
    expect(day.totalMinutes).toBe(15);
  });

  test("an empty day has no stretches and zero everywhere", () => {
    const day = classifyDayStretches(sources({ chat: [span(0, 10)] }));
    expect(day.stretches).toEqual([]);
    expect(day.leftOpen).toEqual([]);
    expect(day.totalMinutes).toBe(0);
    expect(Object.values(day.minutesByKind).every((m) => m === 0)).toBe(true);
  });
});

describe("practiceWindowsFromAttempts", () => {
  test("each attempt vouches for its time on the item plus a short trail", () => {
    expect(
      practiceWindowsFromAttempts([{ createdAt: at(10), elapsedMs: 40_000 }]),
    ).toEqual([
      { start: at(10) - 40_000, end: at(10) + PRACTICE_ATTEMPT_TRAIL_MS },
    ]);
  });

  test("a missing or huge elapsed time is capped; a run of items joins", () => {
    const windows = practiceWindowsFromAttempts([
      { createdAt: at(10) },
      { createdAt: at(11), elapsedMs: 60 * MIN },
    ]);
    expect(windows).toEqual([
      {
        start: at(10) - PRACTICE_ATTEMPT_LEAD_CAP_MS,
        end: at(11) + PRACTICE_ATTEMPT_TRAIL_MS,
      },
    ]);
  });

  test("windows join per skill and carry the skill's name", () => {
    const windows = practiceWindowsFromAttempts([
      { createdAt: at(10), elapsedMs: MIN, detail: "Fractions on a number line" },
      { createdAt: at(11), elapsedMs: MIN, detail: "Fractions on a number line" },
      { createdAt: at(20), elapsedMs: MIN, detail: "Area of rectangles" },
    ]);
    expect(windows).toEqual([
      { start: at(9), end: at(11) + PRACTICE_ATTEMPT_TRAIL_MS, detail: "Fractions on a number line" },
      { start: at(19), end: at(20) + PRACTICE_ATTEMPT_TRAIL_MS, detail: "Area of rectangles" },
    ]);
  });
});

describe("kindMinutesAtBell", () => {
  test("splits each stretch at the bell, kind by kind", () => {
    const { stretches } = classifyDayStretches(
      sources({
        foreground: [span(100, 200)],
        builderOnScreen: [span(150, 200)],
        launchedApps: [span(200, 230)],
      }),
    );
    // School runs 120 to 210.
    const { inSchool, outside } = kindMinutesAtBell(stretches, [span(120, 210)]);
    expect(inSchool).toMatchObject({ rabbithole: 30, playing: 50, launched_app: 10 });
    expect(outside).toMatchObject({ rabbithole: 20, playing: 0, launched_app: 20 });
  });

  test("a day with no bell is all outside school", () => {
    const { stretches } = classifyDayStretches(sources({ foreground: [span(0, 45)] }));
    const { inSchool, outside } = kindMinutesAtBell(stretches, []);
    expect(inSchool.rabbithole).toBe(0);
    expect(outside.rabbithole).toBe(45);
  });
});
