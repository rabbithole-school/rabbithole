import { describe, expect, it } from "vitest";

import {
  analyzeBackRow,
  BACK_ROW_WORDS,
  backRowColors,
  CLOSE_MIC_TALKING_ABOVE_DB,
  closeMicTalking,
  NOT_TALKING,
  talkingFrames,
  decodeLevels,
  encodeLevels,
  HEARD_ABOVE_ROOM_DB,
  isHeard,
  liveRoomFloor,
  quantizeDbfs,
  stepDecayFrames,
  type DecayLevel,
  SILENT_DECAY,
  stepDecay,
  DECAY_FALL_DB_PER_S,
  DECAY_HOLD_MS,
  roomFloor,
} from "./backRowVoice";
import { recordFrame } from "./rehearsalTake";

const ROOM = -50;
const frames = (count: number, db: number) =>
  Array.from({ length: count }, () => db);
/** Speech wobbles around a base level. */
const speech = (count: number, db: number) =>
  Array.from({ length: count }, (_, i) => db + 1.5 * Math.sin(i * 1.3));

describe("roomFloor", () => {
  it("needs about 2 s of frames", () => {
    expect(roomFloor(frames(24, -50))).toBeNull();
    expect(roomFloor(frames(25, -50))).toBe(-50);
  });

  it("takes the 20th percentile of the last 4 s, ignoring older frames", () => {
    const old = frames(100, -10);
    const recent = [...frames(40, -50), ...frames(10, -30)];
    expect(roomFloor([...old, ...recent])).toBe(-50);
    const noisy = Array.from({ length: 50 }, (_, i) => -60 + i);
    expect(roomFloor(noisy)).toBeCloseTo(-60 + Math.floor(49 * 0.2), 5);
  });

  it("treats missing readings as -100", () => {
    expect(roomFloor(frames(30, -160))).toBe(-100);
  });
});

describe("liveRoomFloor", () => {
  it("needs about 2 s of frames", () => {
    expect(liveRoomFloor(frames(24, -50))).toBeNull();
    expect(liveRoomFloor(frames(25, -50))).toBe(-50);
  });

  it("finds the room in the pauses while someone talks", () => {
    // Over 20 s of talk: 4 s sentences with 0.6 s pauses between them.
    const talk: number[] = [];
    while (talk.length < 250) talk.push(...speech(50, ROOM + 20), ...frames(8, ROOM));
    expect(liveRoomFloor(talk)).toBe(ROOM);
    expect(roomFloor(talk)).toBeGreaterThan(ROOM + 10);
  });

  it("forgets frames older than 20 s", () => {
    const quietThenLoud = [...frames(200, ROOM - 20), ...frames(250, ROOM)];
    expect(liveRoomFloor(quietThenLoud)).toBe(ROOM);
  });
});

describe("stepDecay", () => {
  const feed = (dbfs: number[]) => dbfs.reduce((d, x) => stepDecay(d, x), SILENT_DECAY);

  it("jumps to a louder reading at once", () => {
    expect(feed([-50, -20]).dbfs).toBe(-20);
  });

  it("holds 2 s, then falls 6 dB a second", () => {
    const holdFrames = DECAY_HOLD_MS / 80;
    const held = feed([-20, ...frames(holdFrames, -60)]);
    expect(held.dbfs).toBe(-20);
    const falling = feed([-20, ...frames(holdFrames + 25, -60)]);
    expect(falling.dbfs).toBeCloseTo(-20 - DECAY_FALL_DB_PER_S * 2, 5);
  });

  it("never falls below the current reading", () => {
    expect(feed([-20, ...frames(200, -45)]).dbfs).toBe(-45);
  });
});

describe("words and colors", () => {
  it("has sentence-case words, and no louder", () => {
    expect(BACK_ROW_WORDS).toEqual({
      heard: "We can hear you",
      listening: "Listening",
    });
  });

  it("gives every word a fill and ink in both themes", () => {
    for (const dark of [false, true]) {
      const colors = backRowColors(dark);
      for (const word of ["heard", "listening"] as const) {
        expect(colors[word].fill).toMatch(/^#/);
        expect(colors[word].ink).toMatch(/^#/);
        expect(colors[word].fill).not.toBe(colors[word].ink);
      }
      expect(colors.heard.fill).not.toBe(colors.listening.fill);
    }
  });
});

describe("analyzeBackRow: the review replays the meter", () => {
  const frameMs = 80;
  const oneSlide = () => ({ index: 0, slideId: "a" });

  it("counts a slide heard while the decay line reaches the threshold, and not when it doesn't", () => {
    // 3 s of room, slide 0 talking well over the line until 7 s, 5 s of
    // pause, then slide 1 talking just short of the line from 12 s.
    const dbfs = [
      ...frames(38, ROOM),
      ...speech(50, ROOM + 25),
      ...frames(62, ROOM),
      ...frames(50, ROOM + HEARD_ABOVE_ROOM_DB - 1),
    ];
    const result = analyzeBackRow({
      dbfs,
      frameMs,
      roomDbfs: ROOM,
      thresholdDb: HEARD_ABOVE_ROOM_DB,
      slideAt: (ms) => (ms < 12_000 ? { index: 0, slideId: "a" } : { index: 1, slideId: "b" }),
    });
    expect(result.rows.map((r) => r.index)).toEqual([0, 1]);
    const [a, b] = result.rows;
    expect(a.slideId).toBe("a");
    expect(result.share(a)).toBe(1);
    expect(result.share(b)).toBe(0);
    expect(result.totals).toEqual({
      talkingFrames: a.talkingFrames + b.talkingFrames,
      heardFrames: a.heardFrames + b.heardFrames,
    });
  });

  it("judges by the take's threshold", () => {
    const dbfs = [...frames(25, ROOM), ...frames(50, ROOM + 10)];
    const at = (thresholdDb: number) =>
      analyzeBackRow({ dbfs, frameMs, roomDbfs: ROOM, thresholdDb, slideAt: oneSlide }).rows[0];
    expect(at(8).heardFrames).toBe(50);
    // At the threshold exactly is green, as on the meter.
    expect(at(10).heardFrames).toBe(50);
    expect(at(12).heardFrames).toBe(0);
    expect(at(12).talkingFrames).toBe(50);
  });

  it("never counts a pause, so the decay holding green after the last word can't inflate a share", () => {
    // 2 s of talk, then 2 s of quiet: the meter stays green through the
    // quiet (the decay holds), but only the talking is judged.
    const dbfs = [...frames(25, ROOM), ...frames(25, ROOM + 25), ...frames(25, ROOM)];
    const [row] = analyzeBackRow({
      dbfs,
      frameMs,
      roomDbfs: ROOM,
      thresholdDb: HEARD_ABOVE_ROOM_DB,
      slideAt: oneSlide,
    }).rows;
    expect(row).toMatchObject({ talkingFrames: 25, heardFrames: 25 });
  });

  it("with the presenter's own BunnyPad, counts speech too quiet to rise over the room at the back as not heard", () => {
    // The back hears only the room, while the presenter's close mic says they talked from 2.4 s to 6.4 s.
    const dbfs = frames(100, ROOM + 2);
    const result = analyzeBackRow({
      dbfs,
      frameMs,
      roomDbfs: ROOM,
      thresholdDb: HEARD_ABOVE_ROOM_DB,
      slideAt: oneSlide,
      talkingAt: (ms) => ms >= 2400 && ms < 6400,
    });
    expect(result.rows[0]).toMatchObject({ talkingFrames: 50, heardFrames: 0 });
    expect(result.share(result.totals)).toBe(0);
  });

  it("never treats a green voice as a pause when the threshold is dragged below 6 dB", () => {
    // Threshold 4: a voice 5 dB over the room is green on the meter.
    const [row] = analyzeBackRow({
      dbfs: [...frames(25, ROOM), ...frames(30, ROOM + 5)],
      frameMs,
      roomDbfs: ROOM,
      thresholdDb: 4,
      slideAt: oneSlide,
    }).rows;
    expect(row).toMatchObject({ talkingFrames: 30, heardFrames: 30 });
  });

  it("judges each frame against the room the meter followed, when the take kept one per frame", () => {
    // The room drifts from -50 to -46 halfway through; speech at -41 is
    // green over -50 and grey over -46 at an 8 dB threshold.
    const dbfs = frames(60, -41);
    const roomDbfsAt = [...frames(30, -50), ...frames(30, -46)];
    const [row] = analyzeBackRow({
      dbfs,
      frameMs,
      roomDbfs: -50,
      roomDbfsAt,
      thresholdDb: 8,
      slideAt: oneSlide,
      talkingAt: () => true,
    }).rows;
    expect(row).toMatchObject({ talkingFrames: 60, heardFrames: 30 });
  });

  it("counts what the live screen showed even when the mic's frames arrive late", () => {
    // The meter's frames come every 160 ms instead of 80: a loud start, then
    // a voice just under the line, green only while the decay line holds it
    // up. The screen steps its decay line once per frame the recording fills,
    // so it and the replay agree frame for frame.
    const live: boolean[] = [];
    const levels: number[] = [];
    let decay: DecayLevel = SILENT_DECAY;
    // Stepping once per arriving frame instead runs the line at half speed.
    let oncePerFrame: DecayLevel = SILENT_DECAY;
    let oncePerFrameGreen = 0;
    for (let atMs = 0; atMs < 6080; atMs += 160) {
      const reading = quantizeDbfs(atMs < 400 ? -35 : -43);
      const filled = recordFrame(levels, atMs, reading);
      oncePerFrame = stepDecay(oncePerFrame, reading);
      for (let i = 0; i < filled; i++) {
        if (isHeard(oncePerFrame.dbfs, ROOM, 8)) oncePerFrameGreen++;
      }
      // The screen steps once per filled frame; drawn once per arriving frame,
      // it lands on the same line `stepDecayFrames` does.
      const before = decay;
      for (let i = 0; i < filled; i++) {
        decay = stepDecay(decay, reading);
        live.push(isHeard(decay.dbfs, ROOM, 8));
      }
      expect(stepDecayFrames(before, reading, filled)).toEqual(decay);
    }
    const [row] = analyzeBackRow({
      dbfs: levels,
      frameMs,
      roomDbfs: ROOM,
      thresholdDb: 8,
      slideAt: oneSlide,
      talkingAt: () => true,
    }).rows;
    expect(row.talkingFrames).toBe(live.length);
    expect(row.heardFrames).toBe(live.filter(Boolean).length);
    expect(oncePerFrameGreen).toBeGreaterThan(row.heardFrames);
  });

  it("gives no share with under 0.6 s of talking, and skips moments on no slide", () => {
    const result = analyzeBackRow({
      dbfs: speech(30, ROOM + 25),
      frameMs,
      roomDbfs: ROOM,
      thresholdDb: HEARD_ABOVE_ROOM_DB,
      slideAt: (ms) => (ms < 1500 ? undefined : { index: 2, slideId: "c" }),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].index).toBe(2);
    expect(result.share({ talkingFrames: 7, heardFrames: 7 })).toBeNull();
    expect(result.share({ talkingFrames: 8, heardFrames: 6 })).toBe(0.75);
  });
});

describe("encodeLevels / decodeLevels", () => {
  it("brings back exactly the readings the meter judged", () => {
    // The meter judges quantized readings, so one just short of an 8 dB line
    // over -50 reads the same live and after transport.
    const readings = [-42.2, -42.26, -41.74, -60.1, -0.3, -160];
    expect(decodeLevels(encodeLevels(readings))).toEqual(readings.map(quantizeDbfs));
  });

  it("round-trips within 0.25 dB for every length mod 3", () => {
    for (const n of [0, 1, 2, 3, 4, 100]) {
      const input = Array.from({ length: n }, (_, i) => -100 + ((i * 7.37) % 127));
      const out = decodeLevels(encodeLevels(input));
      expect(out).toHaveLength(n);
      out.forEach((v, i) => expect(Math.abs(v - input[i])).toBeLessThanOrEqual(0.25));
    }
  });

  it("clamps to -100..27.5 and matches standard base64", () => {
    const out = decodeLevels(encodeLevels([-160, 0, 90]));
    expect(out).toEqual([-100, 0, 27.5]);
    // bytes 0, 200, 255 -> "AMj/"
    expect(encodeLevels([-100, 0, 27.5])).toBe("AMj/");
  });

  it("handles a 45 minute recording", () => {
    const input = Array.from({ length: 33750 }, (_, i) => -60 + (i % 50));
    expect(decodeLevels(encodeLevels(input))).toHaveLength(33750);
  });
});

describe("closeMicTalking / talkingFrames", () => {
  const quiet = (n: number) => frames(n, -50);
  const burst = (n: number) => frames(n, -32); // 18 dB over the floor

  it("never talks over a steady floor", () => {
    expect(talkingFrames(quiet(200)).some(Boolean)).toBe(false);
  });

  it("starts with the floor's first second not counting", () => {
    expect(talkingFrames(burst(10)).some(Boolean)).toBe(false);
  });

  it("turns on within a few frames of speech 15+ dB over the floor", () => {
    const t = talkingFrames([...quiet(20), ...burst(10)]);
    expect(t.slice(0, 20).some(Boolean)).toBe(false);
    expect(t.slice(20).findIndex(Boolean)).toBeGreaterThanOrEqual(0);
    expect(t.slice(20).findIndex(Boolean)).toBeLessThanOrEqual(3);
  });

  it("rides through a breath of 0.5 s", () => {
    const t = talkingFrames([...quiet(20), ...burst(10), ...quiet(6), ...burst(5)]);
    expect(t.slice(30, 36).every(Boolean)).toBe(true);
    expect(t.at(-1)).toBe(true);
  });

  it("turns off after about 1 s of silence", () => {
    const t = talkingFrames([...quiet(20), ...burst(10), ...quiet(13)]);
    expect(t.at(-1)).toBe(false);
  });

  it("follows a floor that shifts instead of calling a noisier room talking forever", () => {
    const noisy = frames(200, -35);
    const t = talkingFrames([...quiet(20), ...noisy]);
    expect(t.slice(20).some(Boolean)).toBe(true); // the jump itself looks like speech at first
    expect(t.slice(-20).some(Boolean)).toBe(false);
  });

  it("exposes its threshold and a clean starting state", () => {
    expect(CLOSE_MIC_TALKING_ABOVE_DB).toBeGreaterThan(0);
    expect(NOT_TALKING.talking).toBe(false);
    expect(closeMicTalking(NOT_TALKING, -30).talking).toBe(false);
  });
});

