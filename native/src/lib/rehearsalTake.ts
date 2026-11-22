/**
 * A recorded take of a scholar presenting slides or an app: what the
 * presenter's BunnyPad records, and what the review screen reads out of it.
 * Pure, so the review's numbers are tested here rather than on a device.
 *
 * A take is the presenter's close-mic level every `METER_FRAME_MS` and when
 * each slide was showing, both on the recording's own clock, beside an audio
 * file. Takes stay on the BunnyPad (`rehearsalStore.ts`).
 *
 * The close mic is never judged for loudness: on the presenter's own BunnyPad
 * it mostly measures how close they lean in. Whether the back of the room
 * heard comes only from a BunnyPad there (`backRowVoice.ts`), replayed here
 * through the rule its screen showed live, at the threshold it had (T1), with
 * no grade or score (T9). The close mic says only when the presenter was
 * talking, and lines the back-row video up with this take (`talkAlignment.ts`).
 */

import {
  analyzeBackRow,
  SILENT_DECAY,
  stepDecay,
  talkingFrames,
  voicedAboveRoomDb,
  type BackRowAnalysis,
} from "./backRowVoice";
import { METER_FRAME_MS } from "./micLevel";

/** How many takes of one deck or app stay on the BunnyPad; older ones are deleted. */
export const KEPT_TAKES_PER_DECK = 3;

/** One slide coming on screen during a take. It shows until the next one does. */
export type SlideShowing = { atMs: number; index: number; slideId: string };

/** A take as saved on the BunnyPad, beside its audio file. */
export type RehearsalTake = {
  version: 1;
  id: string;
  /** When the take's recording started, epoch ms on this BunnyPad's clock. */
  recordedAt: number;
  durationMs: number;
  frameMs: number;
  /** The close-mic level (0..1) of each frame, from the start of the recording. */
  levels: number[];
  /** In recording order; empty for an app. */
  slides: SlideShowing[];
  /** The audio's file name, in the same folder as the take. */
  audioFile: string;
};

// ── Recording ────────────────────────────────────────────────────────────────

/**
 * Adds a metering frame to a take's levels, keeping one level per frame on the
 * recording's clock: a late frame fills the frames it skipped with its level.
 * Returns how many frames it filled (none for a frame that came early).
 */
export function recordFrame(
  levels: number[],
  atMs: number,
  level: number,
  frameMs = METER_FRAME_MS,
): number {
  const rounded = Math.round(level * 1000) / 1000;
  let filled = 0;
  while (levels.length * frameMs <= atMs) {
    levels.push(rounded);
    filled++;
  }
  return filled;
}

/** Notes a slide coming on screen, unless it is already the one showing. */
export function recordSlide(
  slides: SlideShowing[],
  atMs: number,
  index: number,
  slideId: string,
): void {
  const last = slides.at(-1);
  if (last && last.index === index && last.slideId === slideId) return;
  slides.push({ atMs, index, slideId });
}

// ── Reading a take back ──────────────────────────────────────────────────────

export type SlideRun = {
  index: number;
  slideId: string;
  fromMs: number;
  toMs: number;
};

/** The take's slides as consecutive runs; empty runs (a slide skipped past) are dropped. */
export function slideRuns(take: Pick<RehearsalTake, "slides" | "durationMs">): SlideRun[] {
  const runs: SlideRun[] = [];
  take.slides.forEach((showing, i) => {
    const fromMs = Math.min(showing.atMs, take.durationMs);
    const toMs = Math.min(take.slides[i + 1]?.atMs ?? take.durationMs, take.durationMs);
    if (toMs <= fromMs) return;
    const last = runs.at(-1);
    if (last && last.index === showing.index && last.toMs === fromMs) {
      last.toMs = toMs;
    } else {
      runs.push({ index: showing.index, slideId: showing.slideId, fromMs, toMs });
    }
  });
  return runs;
}

/** The run showing at a moment of the take (the first before it starts, the last after it ends). */
export function runAt(runs: readonly SlideRun[], ms: number): SlideRun | undefined {
  if (runs.length > 0 && ms < runs[0].fromMs) return runs[0];
  return runs.find((run) => ms >= run.fromMs && ms < run.toMs) ?? runs.at(-1);
}

export type SlideTime = {
  index: number;
  slideId: string;
  /** Total time on screen, across every time the slide came up. */
  timeMs: number;
  /** When the slide first came on screen. */
  firstShownMs: number;
};

/** One row per slide that was on screen, in slide order. */
export function slideTimes(runs: readonly SlideRun[]): SlideTime[] {
  const bySlide = new Map<number, SlideTime>();
  for (const run of runs) {
    const row = bySlide.get(run.index);
    if (row) {
      row.timeMs += run.toMs - run.fromMs;
    } else {
      bySlide.set(run.index, {
        index: run.index,
        slideId: run.slideId,
        timeMs: run.toMs - run.fromMs,
        firstShownMs: run.fromMs,
      });
    }
  }
  return [...bySlide.values()].sort((a, b) => a.index - b.index);
}

// ── The back row ─────────────────────────────────────────────────────────────

/** What a BunnyPad at the back of the room recorded for this take. */
export type BackRowRecording = {
  /** dBFS every `frameMs`, from the start of the back video. */
  dbfs: readonly number[];
  frameMs: number;
  /** The room's own level before the take started. */
  roomDbfs: number;
  /**
   * The room the meter judged each frame against, for a meter that kept
   * following the room through the take (one with nobody linked).
   */
  roomDbfsAt?: readonly number[];
  /** The meter's green threshold at Stop, in dB over the room. */
  thresholdDb: number;
  /** `takeMs = backMs + offsetMs` (talkAlignment.ts). */
  offsetMs: number;
};

/** The whole talk, for an app take (no slides): every judged frame lands in one row. */
const WHOLE_TALK = { index: 0, slideId: "talk" } as const;

/**
 * Replays the back-row recording through the meter, at the threshold it had,
 * slide by slide. With the take's own close-mic levels (`presenterLevels`,
 * 0..1), it counts the moments the presenter was talking; without them, the
 * moments the back heard someone.
 */
export function analyzeTakeFromBack(
  runs: readonly SlideRun[],
  back: BackRowRecording,
  presenterLevels?: readonly number[],
  presenterFrameMs = METER_FRAME_MS,
): BackRowAnalysis {
  const talking = presenterLevels
    ? talkingFrames(presenterLevels.map((level) => level * 60 - 60))
    : null;
  return analyzeBackRow({
    dbfs: back.dbfs,
    frameMs: back.frameMs,
    roomDbfs: back.roomDbfs,
    roomDbfsAt: back.roomDbfsAt,
    thresholdDb: back.thresholdDb,
    talkingAt: talking
      ? (backMs) => talking[Math.floor((backMs + back.offsetMs) / presenterFrameMs)] ?? false
      : undefined,
    slideAt: (backMs) => {
      if (runs.length === 0) return WHOLE_TALK;
      const run = runAt(runs, backMs + back.offsetMs);
      return run ? { index: run.index, slideId: run.slideId } : undefined;
    },
  });
}

/** A slide the back row didn't hear for more than this share of the talking gets called out. */
const MISSED_CALLOUT_SHARE = 0.12;
/** "Watch" links start a moment before what they point at, so the run-up is heard. */
export const LISTEN_LEAD_MS = 1500;

export type Observation = {
  text: string;
  /** Where its "Watch slide N" link seeks, on the take's clock; no slide for an app ("Watch 0:31"). */
  listen?: { slideIndex: number | null; atMs: number };
};

/**
 * One to three plain sentences about a take. With a back-row recording they
 * say how well the back of the room could hear; without one they say only
 * what a single close mic can honestly say, which is how long it took.
 */
export function observeTake({
  take,
  times,
  back,
  previous,
}: {
  take: Pick<RehearsalTake, "durationMs">;
  times: readonly SlideTime[];
  back: BackRowAnalysis | null;
  previous?: Pick<RehearsalTake, "durationMs">;
}): Observation[] {
  const observations: Observation[] = [];
  if (previous) {
    observations.push({
      text: `Since your last take, the talk took ${formatClock(previous.durationMs)} → ${formatClock(take.durationMs)}.`,
    });
  }
  if (!back) return observations;

  const overall = back.share(back.totals);
  if (overall === null) {
    observations.push({
      text: "The BunnyPad at the back didn't hear enough talking to say how loud you were.",
    });
    return observations;
  }
  observations.push({
    text: `From the back of the room, they could hear you ${percent(overall)} of the time you were talking.`,
  });

  const firstShown = new Map(times.map((t) => [t.index, t.firstShownMs]));
  let worst: { index: number; missed: number } | null = null;
  for (const row of back.rows) {
    const heard = back.share(row);
    if (heard === null || !firstShown.has(row.index)) continue;
    const missed = 1 - heard;
    if (!worst || missed > worst.missed) worst = { index: row.index, missed };
  }
  if (worst && worst.missed > MISSED_CALLOUT_SHARE) {
    observations.push({
      text: `On slide ${worst.index + 1}, the back row couldn't hear you ${percent(worst.missed)} of the time you were talking.`,
      listen: {
        slideIndex: worst.index,
        atMs: Math.max(0, (firstShown.get(worst.index) ?? 0) - LISTEN_LEAD_MS),
      },
    });
  }
  return observations;
}

/**
 * The back-row line for the review's timeline: the meter's decay line (the
 * one its screen turned green by) as dB above the room, cut into `columns`
 * equal slices of the back recording, each slice's average on a 0..1 scale
 * where `heardAt` marks the take's green threshold. Null where the line had
 * fallen back to the room, so a pause shows as a gap once the decay has run
 * down, as it does on the meter.
 */
export function backRowTrace(
  back: Pick<BackRowRecording, "dbfs" | "frameMs" | "roomDbfs" | "roomDbfsAt" | "thresholdDb">,
  columns: number,
  topDb = 30,
): { trace: (number | null)[]; heardAt: number } {
  const { dbfs, frameMs, roomDbfs, roomDbfsAt, thresholdDb } = back;
  const heardAt = Math.max(0, Math.min(1, thresholdDb / topDb));
  if (columns <= 0) return { trace: [], heardAt };
  const voicedDb = voicedAboveRoomDb(thresholdDb);
  const above: number[] = [];
  let decay = SILENT_DECAY;
  dbfs.forEach((reading, i) => {
    decay = stepDecay(decay, reading, frameMs);
    above.push(decay.dbfs - (roomDbfsAt?.[i] ?? roomDbfs));
  });
  const trace = Array.from({ length: columns }, (_, c) => {
    const from = Math.floor((c * above.length) / columns);
    const to = Math.max(from + 1, Math.floor(((c + 1) * above.length) / columns));
    let sum = 0;
    let count = 0;
    for (let k = from; k < Math.min(to, above.length); k++) {
      if (above[k] <= voicedDb) continue;
      sum += above[k];
      count += 1;
    }
    return count === 0 ? null : Math.max(0, Math.min(1, sum / count / topDb));
  });
  return { trace, heardAt };
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** "1:05" */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "42%" */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Reads a saved take, or null if the file isn't one. */
export function parseTake(value: unknown): RehearsalTake | null {
  if (typeof value !== "object" || value === null) return null;
  const take = value as Partial<RehearsalTake>;
  if (
    take.version !== 1 ||
    typeof take.id !== "string" ||
    typeof take.recordedAt !== "number" ||
    typeof take.durationMs !== "number" ||
    typeof take.frameMs !== "number" ||
    take.frameMs <= 0 ||
    typeof take.audioFile !== "string" ||
    !Array.isArray(take.levels) ||
    !take.levels.every((level) => typeof level === "number") ||
    !Array.isArray(take.slides) ||
    !take.slides.every(
      (s) =>
        typeof s?.atMs === "number" &&
        typeof s.index === "number" &&
        typeof s.slideId === "string",
    )
  ) {
    return null;
  }
  return take as RehearsalTake;
}
