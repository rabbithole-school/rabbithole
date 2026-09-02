/** Maximum correct first-key latency samples retained per mastery or fact row. */
export const LATENCY_SAMPLE_CAP = 10;

/** Median of an already-sorted numeric sample. */
export function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Append one sample to the capped oldest-first ring, then recompute its median
 * and median absolute deviation (MAD).
 */
export function nextLatencyStats(
  existingSamples: readonly number[] | undefined,
  sampleMs: number,
): {
  latencySamplesMs: number[];
  latencyMedianMs: number;
  latencySpreadMs: number;
} {
  const samples = [...(existingSamples ?? []), sampleMs];
  while (samples.length > LATENCY_SAMPLE_CAP) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  const latencyMedianMs = median(sorted);
  const deviations = sorted
    .map((sample) => Math.abs(sample - latencyMedianMs))
    .sort((a, b) => a - b);
  return {
    latencySamplesMs: samples,
    latencyMedianMs,
    latencySpreadMs: median(deviations),
  };
}
