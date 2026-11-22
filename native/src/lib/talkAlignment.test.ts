import { describe, expect, it } from "vitest";

import { alignRecordings } from "./talkAlignment";

const FRAME_MS = 80;

/** Seeded RNG (mulberry32) so the synthetic talks are the same every run. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speech-like bursts (syllables 0.08-0.35 s) with pauses of 0.2-1.2 s. */
function makeTalk(seed: number, seconds: number) {
  const r = rng(seed);
  const bursts: { from: number; to: number; gain: number }[] = [];
  let t = 0.5;
  while (t < seconds) {
    const len = 0.08 + r() * 0.27;
    bursts.push({ from: t, to: t + len, gain: 0.5 + r() * 0.5 });
    t += len + 0.2 + r() * 1.0;
  }
  const RAMP = 0.05;
  /** Smooth 0..1 envelope at continuous time `sec`. */
  return (sec: number) => {
    let v = 0;
    for (const b of bursts) {
      if (sec < b.from - RAMP || sec > b.to + RAMP) continue;
      const up = Math.min(1, Math.max(0, (sec - b.from + RAMP) / (2 * RAMP)));
      const down = Math.min(1, Math.max(0, (b.to + RAMP - sec) / (2 * RAMP)));
      v = Math.max(v, b.gain * Math.min(up, down));
    }
    return v;
  };
}

/** The presenter's close mic, as 0..1 levels (dB = level * 60 - 60). */
function presenterRecording(env: (s: number) => number, seconds: number, seed: number) {
  const r = rng(seed);
  const n = Math.floor((seconds * 1000) / FRAME_MS);
  return Array.from({ length: n }, (_, i) => {
    const db = -52 + 40 * env((i * FRAME_MS) / 1000) + (r() - 0.5) * 2;
    return Math.max(0, Math.min(1, (db + 60) / 60));
  });
}

/** The back device: starts `offsetMs` after the presenter, quieter, noisier, higher floor. */
function backRecording(
  env: (s: number) => number,
  seconds: number,
  offsetMs: number,
  seed: number,
) {
  const r = rng(seed);
  const n = Math.floor(((seconds * 1000) - offsetMs) / FRAME_MS);
  return Array.from({ length: n }, (_, i) => {
    const speechDb = -50 + 22 * env((i * FRAME_MS + offsetMs) / 1000);
    // Room floor -42 dBFS, with its own wobble: add power, not dB.
    const power = 10 ** (speechDb / 10) + 10 ** ((-42 + (r() - 0.5) * 6) / 10);
    return 10 * Math.log10(power);
  });
}

describe("alignRecordings", () => {
  const SECONDS = 120;

  for (const delay of [0, 800, 1280, 1537, 2250, -500]) {
    it(`finds a back-device delay of ${delay} ms within 40 ms`, () => {
      const env = makeTalk(11, SECONDS + 10);
      const presenter = presenterRecording(env, SECONDS, 1);
      // A negative delay means the back device started first: its time 0 is
      // before the presenter's, so presenter time = back time - 500.
      const back = backRecording(env, SECONDS, delay, 2);
      const result = alignRecordings({
        presenterLevels: presenter,
        backDbfs: back,
        frameMs: FRAME_MS,
        // The device clocks are good to a few hundred ms.
        priorOffsetMs: delay + 240,
      });
      expect(result.matched).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(Math.abs(result.offsetMs - delay)).toBeLessThanOrEqual(40);
    });
  }

  it("falls back to the prior on uncorrelated noise", () => {
    const r = rng(99);
    const presenter = Array.from({ length: 1500 }, () => r() * 0.3 + 0.1);
    const back = Array.from({ length: 1500 }, () => -50 + r() * 6);
    const result = alignRecordings({
      presenterLevels: presenter,
      backDbfs: back,
      frameMs: FRAME_MS,
      priorOffsetMs: 1200,
    });
    expect(result.matched).toBe(false);
    expect(result.offsetMs).toBe(1200);
  });

  it("falls back when the recordings are too short to overlap", () => {
    const env = makeTalk(5, 30);
    const result = alignRecordings({
      presenterLevels: presenterRecording(env, 3, 1),
      backDbfs: backRecording(env, 3, 500, 2),
      frameMs: FRAME_MS,
      priorOffsetMs: 500,
    });
    expect(result).toEqual({ offsetMs: 500, confidence: 0, matched: false });
  });

  it("handles a 30 minute talk quickly", () => {
    const env = makeTalk(21, 1810);
    const presenter = presenterRecording(env, 1800, 3);
    const back = backRecording(env, 1800, 1600, 4);
    const started = Date.now();
    const result = alignRecordings({
      presenterLevels: presenter,
      backDbfs: back,
      frameMs: FRAME_MS,
      priorOffsetMs: 1400,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(Math.abs(result.offsetMs - 1600)).toBeLessThanOrEqual(40);
  });
});
