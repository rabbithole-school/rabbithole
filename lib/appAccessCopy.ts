/**
 * Staff-facing words for WHEN a scholar can open an app: the blocks that open
 * a block-scoped app, and the last day of access opened for a day or until a
 * date (TRA-444). The device console and a scholar's Apps panel both word
 * these, and must word them the same way.
 */
import type { AppScheduleWindow } from "@/convex/lib/deviceAppAccess";
import { shiftDayKey } from "@/shared/institutionDay";

const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Robotics Block E (Mon/Wed 14:50–16:40)". The times are the app's window,
 *  which opens before the bell and closes after it, not the block's. */
function scheduleWindowLabel(window: AppScheduleWindow): string {
  const days = window.weekdays.map((d) => WEEKDAY_SHORT[d] ?? `day ${d}`).join("/");
  return `${window.subject} ${window.block} (${days} ${window.opensLocal}–${window.closesLocal})`;
}

/** Every window, as one phrase: "A", "A and B", "A, B and C". */
export function scheduleWindowsPhrase(windows: readonly AppScheduleWindow[]): string {
  const labels = windows.map(scheduleWindowLabel);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The last day of opened access: "today", "tomorrow", "Fri, Oct 2", or
 * "Mon, Jan 4, 2027" in another year. Both day keys are on the school's
 * calendar. Without `todayDayKey` it is always the full date, year included,
 * so a mistyped year can't pass for this one.
 */
export function throughDayPhrase(throughDay: string, todayDayKey?: string): string {
  if (todayDayKey === throughDay) return "today";
  if (todayDayKey && shiftDayKey(todayDayKey, 1) === throughDay) return "tomorrow";
  const sameYear = todayDayKey?.slice(0, 4) === throughDay.slice(0, 4);
  // A day key IS the school-calendar date, so read it in UTC: a second time
  // zone would move it to the wrong day.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(`${throughDay}T00:00:00Z`));
}

/** When opened access ends: tonight, or at the end of its last day. */
export function closesPhrase(throughDay: string, todayDayKey: string): string {
  return throughDay === todayDayKey
    ? "It closes at midnight on its own."
    : `It closes on its own at the end of ${throughDayPhrase(throughDay, todayDayKey)}.`;
}
