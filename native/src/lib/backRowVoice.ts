/**
 * The back-row listener's judgment: can the people at the back of the room
 * hear the presenter? A second BunnyPad sits at the back, listens, and turns
 * its screen green ("We can hear you") or leaves it grey.
 *
 * Measuring at the back, against the room's own background noise, is the point.
 * A mic on the presenter's iPad mostly measures how close they lean in; the
 * back device hears what the listeners hear. So the judgment never looks at an
 * absolute level: it compares a decay line over the readings with the room
 * floor measured while nobody was presenting, plus a threshold the meter's
 * user can drag (`isHeard`). The live meter and the take review both use that
 * one rule, so the review counts exactly what the screen showed (T1). The
 * scholar sees a word and a colour, never a number (taste charter T9).
 *
 * Frames are dBFS readings from expo-audio metering: about -60 in a quiet
 * room up to 0 at full scale, with a missing reading arriving as -160 or
 * similar. Anything below -100 is treated as -100.
 */

import { palette } from "../../vendor/shared/brand";
import { METER_FRAME_MS } from "./micLevel";

/**
 * What the back-row screen says. There is no "louder": quiet speech and no
 * speech look the same from the back, so the meter only says when it hears.
 */
export type BackRowWord = "heard" | "listening";

/** The floor of the dBFS scale this module reads; deeper readings are clamped here. */
const MIN_DBFS = -100;
/** The top of the encodable range: a byte of 255 at 0.5 dB steps from -100. */
const MAX_ENCODED_DBFS = 27.5;

/**
 * The green threshold the meter starts at, in dB over the room: the decay
 * line at or above it reads "We can hear you". The meter's user can drag it,
 * and a take is judged by the threshold the meter had at Stop; this is also
 * what a take recorded before thresholds travelled with it is judged by.
 *
 * Set from a real take (2026-11-18): a BunnyPad at the back of a noisy room
 * (floor −34.5 dBFS), where Andy judged the presenter's ordinary speaking voice
 * plainly audible. Its voiced frames sat 9–11 dB over the room, so at 8 dB that
 * sentence reads heard throughout. The 15 dB classroom guideline (ANSI/ASA
 * S12.60) is about a listener's ears; a BunnyPad mic's margin over a room
 * floor full of the same voice's echo runs far smaller, and at 15 the plainly
 * audible sentence never read heard (taste charter T6).
 */
export const HEARD_ABOVE_ROOM_DB = 8;
/**
 * A frame this far above the room's floor counts as someone talking, when
 * there is no presenter's own BunnyPad to say so. 6 dB is a doubling of sound
 * pressure: clear of the moment-to-moment wobble in a quiet room (a
 * placeholder to measure on a real BunnyPad, taste charter T6).
 */
export const VOICED_ABOVE_ROOM_DB = 6;

/**
 * How far over the room a frame must be to count as someone talking, at a
 * given green threshold: never above the threshold itself, so a voice the
 * meter showed green (the threshold can be dragged down to 1 dB) is never
 * treated as a pause.
 */
export function voicedAboveRoomDb(thresholdDb: number): number {
  return Math.min(VOICED_ABOVE_ROOM_DB, thresholdDb);
}

/** The room floor looks at the last 4 s of frames. */
const FLOOR_WINDOW_FRAMES = Math.round(4000 / METER_FRAME_MS);
/** ...and needs at least 2 s of them before it says anything. */
const FLOOR_MIN_FRAMES = Math.round(2000 / METER_FRAME_MS);
/**
 * The 20th percentile: the quiet frames between a room's sounds (a chair, a
 * cough) sit above it, and a stray silent glitch can't drag it to nothing.
 */
const FLOOR_PERCENTILE = 0.2;

/** A slide needs about 0.6 s of talking before it gets a share. */
const MIN_SHARE_MS = 600;

function clampDbfs(dbfs: number): number {
  return Number.isFinite(dbfs) ? Math.max(MIN_DBFS, dbfs) : MIN_DBFS;
}

/**
 * A reading as a recording keeps it: clamped to -100..27.5 and rounded to the
 * 0.5 dB steps `encodeLevels` sends. The meter judges this same value, so a
 * reading near the green line can't read one way live and the other way in
 * the review.
 */
export function quantizeDbfs(dbfs: number): number {
  const c = Math.min(MAX_ENCODED_DBFS, clampDbfs(dbfs));
  return Math.round((c - MIN_DBFS) * 2) / 2 + MIN_DBFS;
}

/**
 * The room's background level in dBFS from frames recorded while nobody is
 * presenting, or null when there are fewer than about 2 s of them.
 */
export function roomFloor(dbfs: readonly number[]): number | null {
  if (dbfs.length < FLOOR_MIN_FRAMES) return null;
  const sorted = dbfs
    .slice(-FLOOR_WINDOW_FRAMES)
    .map(clampDbfs)
    .sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * FLOOR_PERCENTILE)];
}

/** A floor kept up to date while someone talks looks back 20 s... */
const LIVE_FLOOR_WINDOW_FRAMES = Math.round(20_000 / METER_FRAME_MS);
/** ...at the 10th percentile, so the pauses between sentences set it. */
const LIVE_FLOOR_PERCENTILE = 0.1;

/**
 * The room's background level while someone may already be talking, for
 * listening with no quiet moment before a take. The 4 s floor above drifts 7
 * to 23 dB too high once speech starts; the quietest tenth of the last 20 s
 * stayed within about 4 dB of the floor measured before the take on all five
 * real back-row takes recorded so far (2026-11-17/18, taste charter T6).
 * Null until about 2 s of frames.
 */
export function liveRoomFloor(dbfs: readonly number[]): number | null {
  if (dbfs.length < FLOOR_MIN_FRAMES) return null;
  const sorted = dbfs
    .slice(-LIVE_FLOOR_WINDOW_FRAMES)
    .map(clampDbfs)
    .sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * LIVE_FLOOR_PERCENTILE)];
}

/*
 * The meter's decay line (Andy, 2026-11-18): it jumps to any louder reading at
 * once, holds 2 s, then falls 6 dB a second, never below the current reading.
 * The meter turns green while it is at or above the green threshold, so a
 * speaker at a good volume stays green through the gaps between words and the
 * screen goes grey a few seconds after they stop. Replayed over the real
 * back-row takes, it kept the first sentence of Andy's plainly audible take
 * green 98% of the time from its first word.
 */
export const DECAY_HOLD_MS = 2000;
export const DECAY_FALL_DB_PER_S = 6;

export type DecayLevel = { readonly dbfs: number; readonly heldMs: number };
export const SILENT_DECAY: DecayLevel = { dbfs: MIN_DBFS, heldMs: 0 };

/**
 * The one rule for "We can hear you": the decay line at or above the room
 * plus the green threshold. The meter colours its screen by it, and the
 * review replays it frame by frame.
 */
export function isHeard(decayDbfs: number, roomDbfs: number, thresholdDb: number): boolean {
  return decayDbfs >= roomDbfs + thresholdDb;
}

/** Feeds one reading (dBFS) to the decay line. */
export function stepDecay(decay: DecayLevel, dbfs: number, frameMs = METER_FRAME_MS): DecayLevel {
  const now = clampDbfs(dbfs);
  if (now >= decay.dbfs) return { dbfs: now, heldMs: 0 };
  const heldMs = decay.heldMs + frameMs;
  if (heldMs <= DECAY_HOLD_MS) return { dbfs: decay.dbfs, heldMs };
  return { dbfs: Math.max(now, decay.dbfs - (DECAY_FALL_DB_PER_S * frameMs) / 1000), heldMs };
}

/**
 * Feeds one reading to the decay line for `frames` frames. A reading that
 * arrives late fills the frames it skipped in a recording (`recordFrame`), so
 * the meter steps its line once per filled frame too: the review, stepping
 * once per stored frame, then traces the same line the screen showed.
 */
export function stepDecayFrames(
  decay: DecayLevel,
  dbfs: number,
  frames: number,
  frameMs = METER_FRAME_MS,
): DecayLevel {
  let next = decay;
  for (let i = 0; i < frames; i++) next = stepDecay(next, dbfs, frameMs);
  return next;
}

export const BACK_ROW_WORDS: Readonly<Record<BackRowWord, string>> = {
  heard: "We can hear you",
  listening: "Listening",
};

export type BackRowColor = {
  /** The screen's colour. */
  fill: string;
  /** The word drawn on it. */
  ink: string;
};

/** Brand colors per word: green when heard, neutral grey otherwise. */
export function backRowColors(
  dark: boolean,
): Readonly<Record<BackRowWord, BackRowColor>> {
  return dark
    ? {
        heard: { fill: palette.green[400], ink: palette.green[900] },
        listening: { fill: palette.gray[800], ink: palette.gray[200] },
      }
    : {
        heard: { fill: palette.green[700], ink: palette.green[50] },
        listening: { fill: palette.gray[200], ink: palette.gray[800] },
      };
}

export type BackRowSlideRow = {
  index: number;
  slideId: string;
  /** Frames the presenter was talking. */
  talkingFrames: number;
  /** Of those, the frames the meter showed "We can hear you". */
  heardFrames: number;
};

export type BackRowAnalysis = {
  rows: BackRowSlideRow[];
  totals: { talkingFrames: number; heardFrames: number };
  /** The heard share of the talking frames, or null with under about 0.6 s of talking. */
  share: (row: { talkingFrames: number; heardFrames: number }) => number | null;
};

/**
 * Replays a whole back-row recording through the meter (the decay line
 * against `thresholdDb` over the room, `isHeard`) and counts, per slide, the
 * frames the presenter was talking and how many of them showed green. A pause
 * never counts either way, so the decay holding green after the last word
 * can't inflate a share. `slideAt` maps a moment on the back recording's
 * clock to the slide showing then.
 */
export function analyzeBackRow(args: {
  dbfs: readonly number[];
  frameMs: number;
  roomDbfs: number;
  /**
   * The room the meter judged each frame against, when it kept moving (a
   * meter with nobody linked follows the room through the take); otherwise
   * `roomDbfs` throughout.
   */
  roomDbfsAt?: readonly number[];
  /** The green threshold the meter had at Stop, in dB over the room. */
  thresholdDb: number;
  slideAt: (backMs: number) => { index: number; slideId: string } | undefined;
  /**
   * Whether the presenter was talking at a moment of the back recording, from
   * their own BunnyPad's close mic (`closeMicTalking`). It catches the voice
   * too quiet at the back to rise over the room, which is the voice that
   * matters most. Without it, a frame over the room by `voicedAboveRoomDb`
   * counts as talking, and quieter speech reads as a pause.
   */
  talkingAt?: (backMs: number) => boolean;
}): BackRowAnalysis {
  const { dbfs, frameMs, roomDbfs, roomDbfsAt, thresholdDb, slideAt, talkingAt } = args;
  const voicedDb = voicedAboveRoomDb(thresholdDb);
  const bySlide = new Map<number, BackRowSlideRow>();
  let decay = SILENT_DECAY;
  for (let i = 0; i < dbfs.length; i++) {
    decay = stepDecay(decay, dbfs[i], frameMs);
    const room = roomDbfsAt?.[i] ?? roomDbfs;
    const talking = talkingAt
      ? talkingAt(i * frameMs)
      : clampDbfs(dbfs[i]) > room + voicedDb;
    if (!talking) continue;
    const slide = slideAt(i * frameMs);
    if (!slide) continue;
    let row = bySlide.get(slide.index);
    if (!row) {
      row = { index: slide.index, slideId: slide.slideId, talkingFrames: 0, heardFrames: 0 };
      bySlide.set(slide.index, row);
    }
    row.talkingFrames++;
    if (isHeard(decay.dbfs, room, thresholdDb)) row.heardFrames++;
  }
  const rows = [...bySlide.values()].sort((a, b) => a.index - b.index);
  const totals = rows.reduce(
    (t, r) => ({
      talkingFrames: t.talkingFrames + r.talkingFrames,
      heardFrames: t.heardFrames + r.heardFrames,
    }),
    { talkingFrames: 0, heardFrames: 0 },
  );
  const minFrames = Math.round(MIN_SHARE_MS / frameMs);
  const share = (row: { talkingFrames: number; heardFrames: number }) =>
    row.talkingFrames < minFrames ? null : row.heardFrames / row.talkingFrames;
  return { rows, totals, share };
}

// Compact transport for up to ~45 minutes of frames (33,750 frames): one byte
// each at 0.5 dB steps from -100 dBFS, then base64. React Native has no
// Buffer, so the base64 is done by hand.
const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeLevels(dbfs: readonly number[]): string {
  const bytes = dbfs.map((v) => (quantizeDbfs(v) - MIN_DBFS) * 2);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out.push(
      B64[(n >> 18) & 63],
      B64[(n >> 12) & 63],
      b === undefined ? "=" : B64[(n >> 6) & 63],
      c === undefined ? "=" : B64[n & 63],
    );
  }
  return out.join("");
}

export function decodeLevels(text: string): number[] {
  const out: number[] = [];
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(((acc >> bits) & 255) / 2 + MIN_DBFS);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

// ── The presenter's own microphone: are they talking right now? ────────────
//
// Never a loudness judgment (a close mic mostly measures how near the iPad
// the scholar is): only whether they are speaking, which a mic a foot away
// hears unmistakably. Its floor is its own quietest moments over the last
// 10 s, so it follows the room and the distance without calibration.

/** Close-mic frames this far over its own floor are speech (placeholder to tune on a BunnyPad, T6). */
export const CLOSE_MIC_TALKING_ABOVE_DB = 10;
const CLOSE_FLOOR_WINDOW_FRAMES = Math.round(10_000 / METER_FRAME_MS);
const CLOSE_FLOOR_PERCENTILE = 0.1;
/** Talking starts when 2 of the last 3 frames are speech... */
const TALK_ON_FRAMES = 2;
/** ...and ends after this many quiet frames in a row (about 0.64 s, so a breath isn't a stop). */
const TALK_OFF_FRAMES = Math.round(640 / METER_FRAME_MS);

export type CloseMicTalking = {
  readonly history: readonly number[];
  readonly lastThree: readonly boolean[];
  readonly quietFrames: number;
  readonly talking: boolean;
};

export const NOT_TALKING: CloseMicTalking = {
  history: [],
  lastThree: [],
  quietFrames: 0,
  talking: false,
};

/** Feeds one close-mic frame (dBFS) and returns whether the presenter is talking. */
export function closeMicTalking(state: CloseMicTalking, dbfs: number): CloseMicTalking {
  const db = clampDbfs(dbfs);
  const history = [...state.history, db].slice(-CLOSE_FLOOR_WINDOW_FRAMES);
  const sorted = [...history].sort((a, b) => a - b);
  const floor = sorted[Math.floor((sorted.length - 1) * CLOSE_FLOOR_PERCENTILE)];
  // The first second has no floor worth the name: nothing counts as talking yet.
  const speech = history.length >= FLOOR_MIN_FRAMES / 2 && db > floor + CLOSE_MIC_TALKING_ABOVE_DB;
  const lastThree = [...state.lastThree, speech].slice(-3);
  const quietFrames = speech ? 0 : state.quietFrames + 1;
  const talking = state.talking
    ? quietFrames < TALK_OFF_FRAMES
    : lastThree.filter(Boolean).length >= TALK_ON_FRAMES;
  return { history, lastThree, quietFrames, talking };
}

/** Whether the presenter was talking at each frame of a whole recording. */
export function talkingFrames(dbfs: readonly number[]): boolean[] {
  let state = NOT_TALKING;
  return dbfs.map((d) => {
    state = closeMicTalking(state, d);
    return state.talking;
  });
}
