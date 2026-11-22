/**
 * How long a touch keeps a Rabbithole-locked iPad's screen on. MDM can only
 * cap iPadOS Auto-Lock, never lengthen it, and a scholar can't change it
 * inside the lock, so this stands in for a longer Auto-Lock while the iPad is
 * in use. Kept short: it was an hour until November 2026, and an
 * hour is how long a screen that relit inside a closed folio stayed on.
 */
export const ASAM_AWAKE_WINDOW_MS = 10 * 60 * 1_000;

type DisplayActivityState = {
  inSingleAppMode: boolean;
  appIsActive: boolean;
  lastActivityAt: number | null;
  now: number;
};

export function remainingAsamAwakeMs({
  inSingleAppMode,
  appIsActive,
  lastActivityAt,
  now,
}: DisplayActivityState): number {
  if (!inSingleAppMode || !appIsActive || lastActivityAt === null) return 0;
  return Math.max(0, lastActivityAt + ASAM_AWAKE_WINDOW_MS - now);
}

export function shouldKeepAsamAwake(state: DisplayActivityState): boolean {
  return remainingAsamAwakeMs(state) > 0;
}
