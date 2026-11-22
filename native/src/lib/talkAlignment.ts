/**
 * Lines up two recordings of the same talk in time: the presenter's own
 * close-mic recording and the back-of-the-room device's recording (video with
 * sound). Afterwards the presenter's iPad plays the back video and can swap its
 * sound for the close-mic one, so the two must agree to a fraction of a syllable.
 *
 * Both are loudness-per-frame series, so the method is a cross-correlation of
 * their loudness envelopes: speech bursts and pauses form a pattern that is the
 * same at both mics, however far away or noisy each is.
 *
 * Convention: `presenterTimeMs = backTimeMs + offsetMs`. The back device
 * usually starts a little after the presenter, so the offset is usually positive.
 */

import { SILENT_DBFS } from "./micLevel";

/** The correlation peak must reach this to count as a match (placeholder to tune on real talks, T6). */
const MIN_CONFIDENCE = 0.3;
/** Fewer than this much overlapping audio can't pin an offset down. */
const MIN_OVERLAP_MS = 5000;
/** Each series is clamped to its own 10th percentile so a room's hiss floor doesn't dominate. */
const FLOOR_PERCENTILE = 0.1;

export type AlignmentResult = {
  offsetMs: number;
  /** The peak correlation, -1..1. */
  confidence: number;
  matched: boolean;
};

/** dB series, clamped at its own floor and z-scored. */
function normalize(db: readonly number[]): Float64Array {
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor((sorted.length - 1) * FLOOR_PERCENTILE)];
  const out = new Float64Array(db.length);
  let sum = 0;
  for (let i = 0; i < db.length; i++) {
    out[i] = Math.max(floor, db[i]);
    sum += out[i];
  }
  const mean = sum / (db.length || 1);
  let sq = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    sq += out[i] * out[i];
  }
  const sd = Math.sqrt(sq / (db.length || 1)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

/** Pearson correlation of back[b] with presenter[b + lag] over their overlap, or null. */
function correlationAt(
  presenter: Float64Array,
  back: Float64Array,
  lag: number,
  minOverlap: number,
): number | null {
  const start = Math.max(0, -lag);
  const end = Math.min(back.length, presenter.length - lag);
  const n = end - start;
  if (n < minOverlap) return null;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let b = start; b < end; b++) {
    const x = presenter[b + lag];
    const y = back[b];
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 1e-9 || vb <= 1e-9) return null;
  return cov / Math.sqrt(va * vb);
}

export function alignRecordings(args: {
  presenterLevels: readonly number[];
  backDbfs: readonly number[];
  frameMs: number;
  priorOffsetMs: number;
  searchMs?: number;
}): AlignmentResult {
  const { presenterLevels, backDbfs, frameMs, priorOffsetMs } = args;
  const searchMs = args.searchMs ?? 4000;
  const fallback: AlignmentResult = {
    offsetMs: priorOffsetMs,
    confidence: 0,
    matched: false,
  };
  const minOverlap = Math.ceil(MIN_OVERLAP_MS / frameMs);
  if (presenterLevels.length < minOverlap || backDbfs.length < minOverlap) {
    return fallback;
  }

  // levelFromDbfs maps dB = level * 60 - 60; undo it, and clamp readings the
  // way the back-row judge does.
  const presenter = normalize(
    presenterLevels.map((l) => l * -SILENT_DBFS + SILENT_DBFS),
  );
  const back = normalize(backDbfs.map((d) => Math.max(-100, d)));

  const centre = Math.round(priorOffsetMs / frameMs);
  const radius = Math.ceil(searchMs / frameMs);
  const corr = new Map<number, number>();
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = centre - radius; lag <= centre + radius; lag++) {
    const c = correlationAt(presenter, back, lag, minOverlap);
    if (c === null) continue;
    corr.set(lag, c);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  if (best < MIN_CONFIDENCE) {
    return { ...fallback, confidence: Number.isFinite(best) ? best : 0 };
  }

  // Parabolic interpolation through the peak and its neighbours.
  let delta = 0;
  const lo = corr.get(bestLag - 1);
  const hi = corr.get(bestLag + 1);
  if (lo !== undefined && hi !== undefined) {
    const denom = lo - 2 * best + hi;
    if (denom < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (lo - hi)) / denom));
  }
  return {
    offsetMs: (bestLag + delta) * frameMs,
    confidence: best,
    matched: true,
  };
}
