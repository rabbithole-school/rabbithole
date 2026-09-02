export const ASAM_AWAKE_WINDOW_MS = 60 * 60 * 1_000;

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
