import type { AppSnapshotLoadBoundary } from "@/lib/appSnapshot";

type SnapshotReadiness = {
  loadVersion: number;
  nonce: string | null;
};

export async function waitForAppSnapshotReady({
  afterLoad,
  deadlineAt,
  current,
  now,
  requestFrame,
}: {
  afterLoad?: AppSnapshotLoadBoundary;
  deadlineAt: number;
  current: () => SnapshotReadiness;
  now: () => number;
  requestFrame: (callback: () => void) => void;
}): Promise<boolean> {
  const targetLoad = afterLoad
    ? afterLoad.loadVersion + 1
    : Math.max(1, current().loadVersion);
  return await new Promise<boolean>((resolve) => {
    let stableReadiness: string | null = null;
    let stableChecks = 0;
    const scheduleNext = () => {
      if (now() >= deadlineAt) {
        resolve(false);
        return;
      }
      requestFrame(check);
    };
    const check = () => {
      const readiness = current();
      const ready =
        readiness.loadVersion >= targetLoad &&
        readiness.nonce !== null &&
        (!afterLoad || readiness.nonce !== afterLoad.nonce);
      if (ready) {
        const key = `${readiness.loadVersion}:${readiness.nonce}`;
        if (key === stableReadiness) {
          stableChecks += 1;
        } else {
          stableReadiness = key;
          stableChecks = 1;
        }
        if (stableChecks >= 3) {
          resolve(true);
          return;
        }
        scheduleNext();
        return;
      }
      stableReadiness = null;
      stableChecks = 0;
      scheduleNext();
    };
    check();
  });
}
