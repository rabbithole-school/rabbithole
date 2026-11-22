/**
 * BedtimeGate — native twin of components/BedtimeGate.tsx. Rabbithole sleeps
 * 8 pm–6 am for primary-institution scholars, or earlier where a parent set a
 * stricter bedtime (window + copy: vendor/shared/bedtime.ts; who:
 * convex/lib/bedtime.ts; both surfaced on `currentUser` as
 * `bedtimeTimeZone` and `bedtimeStartMinutes`/`bedtimeEndMinutes`).
 *
 * Five minutes before bedtime a banner says when the app goes to sleep; at
 * bedtime a night-sky overlay covers the app and swallows every touch until
 * 6 am. Like Freeze Mode, it covers rather than replaces — the app underneath
 * stays mounted, so a scholar's unsent work survives the night.
 *
 * BedtimeGate computes the state once at the root (above AsamHybridHost, so
 * ASAM keep-awake can let the screen go dark) and provides it to:
 * - the overlay + banner at the root — or, under ASAM, inside AsamParentGate
 *   next to Freeze Mode, so the teacher's four-finger hold still reaches
 *   Device settings overnight;
 * - every `<Modal>` through `FreezableModal`, since iOS draws a modal in its
 *   own window above the app tree;
 * - the present-mode keep-awakes (`useKeepAwakeUnlessBedtime`).
 * At bedtime it also closes an in-app Safari sheet, which iOS presents above
 * everything React draws.
 */
import { useConvexAuth, useQuery } from "convex/react";
import * as WebBrowser from "expo-web-browser";
import { useEffect } from "react";

import { BedtimeLayers } from "@/components/BedtimeLayers";
import { BedtimeContext } from "@/contexts/BedtimeContext";
import { useBedtime } from "@/hooks/useBedtime";
import { api } from "@/lib/convex";
import {
  bedtimeSubline,
  bedtimeWarningText,
  SCHOOL_BEDTIME,
} from "../../vendor/shared/bedtime";

export function BedtimeGate({
  children,
  renderLayers = true,
}: {
  children: React.ReactNode;
  /** False when AsamHybridHost renders the layers inside its gesture gate. */
  renderLayers?: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.users.currentUser, isAuthenticated ? {} : "skip");
  const timeZone = (isAuthenticated && me?.bedtimeTimeZone) || null;
  // The child's own window (a parent may set a stricter one), else the
  // school's.
  const bedtime = useBedtime(timeZone, {
    startMinutes: me?.bedtimeStartMinutes ?? SCHOOL_BEDTIME.startMinutes,
    endMinutes: me?.bedtimeEndMinutes ?? SCHOOL_BEDTIME.endMinutes,
  });
  const asleepSubline =
    bedtime?.phase === "asleep" && timeZone
      ? bedtimeSubline(bedtime.wakesAt, timeZone)
      : null;
  const warningText =
    bedtime?.phase === "warning" && timeZone
      ? bedtimeWarningText(bedtime.sleepsAt, timeZone)
      : null;

  useEffect(() => {
    if (asleepSubline) WebBrowser.dismissBrowser().catch(() => {});
  }, [asleepSubline]);

  return (
    <BedtimeContext.Provider
      value={{ asleepSubline, warningText, layers: <BedtimeLayers /> }}
    >
      {children}
      {renderLayers ? <BedtimeLayers /> : null}
    </BedtimeContext.Provider>
  );
}
