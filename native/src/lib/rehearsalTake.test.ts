import { describe, expect, it } from "vitest";

import { HEARD_ABOVE_ROOM_DB, VOICED_ABOVE_ROOM_DB } from "./backRowVoice";
import { METER_FRAME_MS } from "./micLevel";
import {
  analyzeTakeFromBack,
  backRowTrace,
  observeTake,
  parseTake,
  recordFrame,
  recordSlide,
  runAt,
  slideRuns,
  slideTimes,
  type BackRowRecording,
  type RehearsalTake,
  type SlideShowing,
} from "./rehearsalTake";

const ROOM_DBFS = -55;
/** Well above the "heard" line. */
const LOUD_DBFS = ROOM_DBFS + HEARD_ABOVE_ROOM_DB + 10;
/** Talking, but between the line that counts as talking and the green threshold. */
const SOFT_DBFS = ROOM_DBFS + (VOICED_ABOVE_ROOM_DB + HEARD_ABOVE_ROOM_DB) / 2;

const frames = (seconds: number, dbfs: number): number[] =>
  Array<number>(Math.round((seconds * 1000) / METER_FRAME_MS)).fill(dbfs);

/** A take of consecutive slide segments, each lasting `seconds`. */
function takeOf(
  segments: { slide: number; seconds: number }[],
  overrides: Partial<RehearsalTake> = {},
): RehearsalTake {
  const slides: SlideShowing[] = [];
  let atMs = 0;
  for (const segment of segments) {
    slides.push({ atMs, index: segment.slide, slideId: `sl${segment.slide + 1}` });
    atMs += segment.seconds * 1000;
  }
  return {
    version: 1,
    id: "take-1",
    recordedAt: 0,
    durationMs: atMs,
    frameMs: METER_FRAME_MS,
    levels: Array(Math.round(atMs / METER_FRAME_MS)).fill(0.5),
    slides,
    audioFile: "take-1.m4a",
    ...overrides,
  };
}

function backOf(dbfs: number[], offsetMs = 0): BackRowRecording {
  return { dbfs, frameMs: METER_FRAME_MS, roomDbfs: ROOM_DBFS, thresholdDb: HEARD_ABOVE_ROOM_DB, offsetMs };
}

describe("recording a take", () => {
  it("keeps one level per frame on the recording's clock when a frame arrives late, and says how many it filled", () => {
    const levels: number[] = [];
    expect(recordFrame(levels, 0, 0.5)).toBe(1);
    expect(recordFrame(levels, 80, 0.6)).toBe(1);
    expect(recordFrame(levels, 100, 0.65)).toBe(0); // early: its frame is already filled
    expect(recordFrame(levels, 330, 0.7)).toBe(3); // the timer ran late by two frames
    expect(levels).toEqual([0.5, 0.6, 0.7, 0.7, 0.7]);
  });

  it("notes a slide only when it changes", () => {
    const slides: SlideShowing[] = [];
    recordSlide(slides, 0, 0, "sl1");
    recordSlide(slides, 500, 0, "sl1");
    recordSlide(slides, 900, 1, "sl2");
    expect(slides.map((s) => s.index)).toEqual([0, 1]);
  });
});

describe("reading a take back", () => {
  it("makes runs, drops slides skipped past, and joins a slide that continues", () => {
    const take = takeOf([
      { slide: 0, seconds: 4 },
      { slide: 1, seconds: 0 }, // tapped straight past
      { slide: 2, seconds: 3 },
      { slide: 2, seconds: 1 }, // the same slide shown again right away
      { slide: 0, seconds: 2 },
    ]);
    const runs = slideRuns(take);
    expect(runs.map((r) => [r.index, r.fromMs, r.toMs])).toEqual([
      [0, 0, 4000],
      [2, 4000, 8000],
      [0, 8000, 10000],
    ]);
  });

  it("clips slides that came on after the recording ended", () => {
    const runs = slideRuns({
      durationMs: 5000,
      slides: [
        { atMs: 0, index: 0, slideId: "sl1" },
        { atMs: 6000, index: 1, slideId: "sl2" },
      ],
    });
    expect(runs.map((r) => r.index)).toEqual([0]);
    expect(runs[0].toMs).toBe(5000);
  });

  it("finds the run showing at a moment, including before the first and after the last", () => {
    const runs = slideRuns({
      durationMs: 9000,
      slides: [
        { atMs: 1000, index: 0, slideId: "sl1" },
        { atMs: 5000, index: 1, slideId: "sl2" },
      ],
    });
    expect(runAt(runs, 0)?.index).toBe(0); // before the first run
    expect(runAt(runs, 1000)?.index).toBe(0);
    expect(runAt(runs, 4999)?.index).toBe(0);
    expect(runAt(runs, 5000)?.index).toBe(1);
    expect(runAt(runs, 20000)?.index).toBe(1); // after the last
    expect(runAt([], 100)).toBeUndefined();
  });

  it("totals time on a slide across every time it came up, in slide order", () => {
    const runs = slideRuns(
      takeOf([
        { slide: 1, seconds: 3 },
        { slide: 0, seconds: 4 },
        { slide: 1, seconds: 2 },
      ]),
    );
    expect(slideTimes(runs)).toEqual([
      { index: 0, slideId: "sl1", timeMs: 4000, firstShownMs: 3000 },
      { index: 1, slideId: "sl2", timeMs: 5000, firstShownMs: 0 },
    ]);
  });
});

describe("the back row's view of a take", () => {
  // Take: slide 0 for 12 s, slide 1 for 12 s. The back video started 2 s into
  // the take (takeMs = backMs + 2000), so its 3 s of room is take 2..5 s, the
  // loud talking take 5..12 s, a 4 s pause (long enough for the meter's decay
  // line to fall back) take 12..16 s, and soft talking take 16..22 s.
  const take = takeOf([
    { slide: 0, seconds: 12 },
    { slide: 1, seconds: 12 },
  ]);
  const back = backOf(
    [...frames(3, ROOM_DBFS), ...frames(7, LOUD_DBFS), ...frames(4, ROOM_DBFS), ...frames(6, SOFT_DBFS)],
    2000,
  );

  it("puts heard and unheard talking on the slide showing at the moment, shifted by the offset", () => {
    const { rows, share } = analyzeTakeFromBack(slideRuns(take), back);
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    const [first, second] = rows;
    expect(first.talkingFrames).toBeGreaterThan(80);
    expect(share(first)).toBe(1);
    expect(second.talkingFrames).toBeGreaterThan(70);
    // Only the last loud frame, at the very moment slide 2 comes up, reads heard.
    expect(share(second) ?? 1).toBeLessThan(0.05);
  });

  it("the offset decides which slide gets the talking", () => {
    // Offset 6 s: the loud talking is take 9..16 s, so its last 4 s now fall on slide 1.
    const shifted = analyzeTakeFromBack(slideRuns(take), { ...back, offsetMs: 6000 });
    const [first, second] = shifted.rows;
    expect(shifted.share(first)).toBe(1);
    expect(second.heardFrames).toBeGreaterThan(40);
  });

  it("judges by the threshold the take carries", () => {
    const strict = analyzeTakeFromBack(slideRuns(take), { ...back, thresholdDb: LOUD_DBFS - ROOM_DBFS + 1 });
    expect(strict.totals.heardFrames).toBe(0);
    expect(strict.totals.talkingFrames).toBe(analyzeTakeFromBack(slideRuns(take), back).totals.talkingFrames);
  });

  it("puts everything in one row for an app take with no slides", () => {
    const { rows, totals } = analyzeTakeFromBack([], back);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ index: 0, slideId: "talk" });
    expect(rows[0].heardFrames).toBe(totals.heardFrames);
    expect(rows[0].talkingFrames).toBe(totals.talkingFrames);
    expect(totals.heardFrames).toBeGreaterThan(80);
    expect(totals.talkingFrames - totals.heardFrames).toBeGreaterThan(70);
  });
});

describe("observations", () => {
  const take = takeOf([
    { slide: 0, seconds: 12 },
    { slide: 1, seconds: 12 },
  ]);
  const times = slideTimes(slideRuns(take));
  const back = analyzeTakeFromBack(
    slideRuns(take),
    backOf(
      [...frames(3, ROOM_DBFS), ...frames(7, LOUD_DBFS), ...frames(4, ROOM_DBFS), ...frames(6, SOFT_DBFS)],
      2000,
    ),
  );

  it("says nothing without a back row and a previous take", () => {
    expect(observeTake({ take, times, back: null })).toEqual([]);
  });

  it("compares only the length with the previous take when there is no back row", () => {
    const previous = takeOf([{ slide: 0, seconds: 70 }]);
    const after = takeOf([{ slide: 0, seconds: 55 }]);
    expect(
      observeTake({ take: after, times: slideTimes(slideRuns(after)), back: null, previous }),
    ).toEqual([{ text: "Since your last take, the talk took 1:10 → 0:55." }]);
  });

  it("says how much of the talking the back of the room could hear", () => {
    const [overall] = observeTake({ take, times, back });
    expect(overall.text).toMatch(
      /^From the back of the room, they could hear you \d+% of the time you were talking\.$/,
    );
    expect(overall.listen).toBeUndefined();
  });

  it("calls out the slide the back row couldn't hear, linked a little before it first showed", () => {
    const observations = observeTake({ take, times, back });
    expect(observations).toHaveLength(2);
    expect(observations[1].text).toMatch(
      /^On slide 2, the back row couldn't hear you \d+% of the time you were talking\.$/,
    );
    expect(observations[1].listen).toEqual({ slideIndex: 1, atMs: 12000 - 1500 });
  });

  it("puts the comparison first when there is a previous take", () => {
    const observations = observeTake({ take, times, back, previous: { durationMs: 30000 } });
    expect(observations[0].text).toBe("Since your last take, the talk took 0:30 → 0:24.");
    expect(observations).toHaveLength(3);
  });

  it("doesn't call out a slide that was heard throughout", () => {
    const loudTake = takeOf([{ slide: 0, seconds: 10 }]);
    const loudBack = analyzeTakeFromBack(
      slideRuns(loudTake),
      backOf([...frames(2, ROOM_DBFS), ...frames(8, LOUD_DBFS)]),
    );
    const observations = observeTake({
      take: loudTake,
      times: slideTimes(slideRuns(loudTake)),
      back: loudBack,
    });
    expect(observations).toHaveLength(1);
    expect(observations[0].text).toMatch(/^From the back of the room, they could hear you 100%/);
  });

  it("says when the back row didn't hear enough talking", () => {
    const quietBack = analyzeTakeFromBack(slideRuns(take), backOf(frames(10, ROOM_DBFS)));
    expect(observeTake({ take, times, back: quietBack })).toEqual([
      { text: "The BunnyPad at the back didn't hear enough talking to say how loud you were." },
    ]);
  });
});

describe("the timeline's back-row line", () => {
  const traceOf = (dbfs: number[], columns: number, thresholdDb = HEARD_ABOVE_ROOM_DB) =>
    backRowTrace({ dbfs, frameMs: METER_FRAME_MS, roomDbfs: ROOM_DBFS, thresholdDb }, columns);

  it("draws the meter's decay line: held after talking, then a gap once it falls back to the room", () => {
    // 1 s of room, 1 s loud, 6 s of room; one column a second.
    const { trace } = traceOf([...frames(1, ROOM_DBFS), ...frames(1, LOUD_DBFS), ...frames(6, ROOM_DBFS)], 8);
    const loud = (LOUD_DBFS - ROOM_DBFS) / 30;
    expect(trace[0]).toBeNull();
    expect(trace[1]).toBeCloseTo(loud);
    expect(trace[2]).toBeCloseTo(loud);
    expect(trace[7]).toBeNull();
  });

  it("keeps a green voice on the line when the threshold is below 6 dB", () => {
    const { trace } = traceOf(frames(2, ROOM_DBFS + 5), 2, 4);
    expect(trace[0]).not.toBeNull();
    expect(trace[1]).not.toBeNull();
  });

  it("marks the take's own green threshold", () => {
    expect(traceOf([ROOM_DBFS], 1).heardAt).toBeCloseTo(HEARD_ABOVE_ROOM_DB / 30);
    expect(traceOf([ROOM_DBFS], 1, 15).heardAt).toBeCloseTo(0.5);
  });

  it("keeps values in 0..1, even for a very loud room or a missing reading", () => {
    const { trace } = traceOf([0, 0, -160, 0], 2);
    for (const value of trace) {
      expect(value).not.toBeNull();
      expect(value ?? -1).toBeGreaterThanOrEqual(0);
      expect(value ?? 2).toBeLessThanOrEqual(1);
    }
  });

  it("gives no columns when asked for none", () => {
    expect(traceOf([-30], 0).trace).toEqual([]);
  });
});

describe("saved takes", () => {
  it("reads back a take it wrote, and refuses a file that isn't one", () => {
    const take = takeOf([{ slide: 0, seconds: 2 }]);
    expect(parseTake(JSON.parse(JSON.stringify(take)))).toEqual(take);
    expect(parseTake({ ...take, levels: ["loud"] })).toBeNull();
    expect(parseTake({ ...take, version: 2 })).toBeNull();
    expect(parseTake({ ...take, frameMs: 0 })).toBeNull();
    expect(parseTake(null)).toBeNull();
  });
});

describe("analyzeTakeFromBack with the presenter's close mic", () => {
  const take = takeOf([{ slide: 0, seconds: 5 }]);
  // Close mic quiet for 20 frames (its floor), then the presenter talks loudly.
  const presenterLevels = take.levels.map((_, i) => (i < 20 ? 0.2 : 0.9));
  // The back hears only 4 dB over the room: too faint to count as voiced.
  const faintBack: BackRowRecording = {
    dbfs: frames(5, ROOM_DBFS + 4),
    frameMs: METER_FRAME_MS,
    roomDbfs: ROOM_DBFS,
    thresholdDb: HEARD_ABOVE_ROOM_DB,
    offsetMs: 0,
  };

  it("counts a talking presenter the back barely hears as talking the back didn't hear", () => {
    const { rows, totals, share } = analyzeTakeFromBack(slideRuns(take), faintBack, presenterLevels);
    expect(totals.talkingFrames).toBeGreaterThan(0);
    expect(totals.heardFrames).toBe(0);
    expect(share(rows[0])).toBe(0);
  });

  it("has no talking to judge without presenter levels when the back hears nobody", () => {
    const { rows, totals, share } = analyzeTakeFromBack(slideRuns(take), faintBack);
    expect(rows).toEqual([]);
    expect(totals).toEqual({ talkingFrames: 0, heardFrames: 0 });
    expect(share(totals)).toBeNull();
  });

  it("lines the presenter's clock up through offsetMs", () => {
    // The back recording starts 4 s into the take: before the presenter talks (1.6 s) it would be silent.
    const late = { ...faintBack, dbfs: frames(5, ROOM_DBFS + 4), offsetMs: -2000 };
    const { totals } = analyzeTakeFromBack(slideRuns(take), late, presenterLevels);
    expect(totals.talkingFrames).toBeGreaterThan(0);
  });
});
