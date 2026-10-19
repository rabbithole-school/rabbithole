// Wording for the teacher Apps timed-access chip (TimedAccessChip.tsx): the
// label ("Live now · Seals until 2:30 PM", "Next · Thu 9:00 AM–9:45 AM") and
// its tooltip, in the school's time zone. Pure, so it is unit-tested.

import type { AppTimedWindow } from "@/convex/appAudiences";

function time(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
}

function dayKey(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone });
}

/** "9:00–9:45 AM", "Thu 9:00–9:45 AM", or "Thu 9:00 AM" without an end. */
function nextWindow(w: AppTimedWindow, now: number): string {
  const sameDay = dayKey(w.startsAt, w.timeZone) === dayKey(now, w.timeZone);
  const day = sameDay
    ? ""
    : `${new Date(w.startsAt).toLocaleDateString("en-US", {
        timeZone: w.timeZone,
        weekday: "short",
      })} `;
  if (w.endsAt === null) return `${day}${time(w.startsAt, w.timeZone)}`;
  return `${day}${time(w.startsAt, w.timeZone)}–${time(w.endsAt, w.timeZone)}`;
}

/** The whole window for the tooltip, with its day: "Sat 1:13 PM–1:58 PM",
 *  or "Sat 1:13 PM onward" when nothing ends it on a clock. */
export function fullWindow(w: AppTimedWindow): string {
  // A grant records only when it ends; its start is just "now".
  if (w.source === "grant" && w.endsAt !== null) {
    const endDay = new Date(w.endsAt).toLocaleDateString("en-US", {
      timeZone: w.timeZone,
      weekday: "short",
    });
    return `Until ${endDay} ${time(w.endsAt, w.timeZone)}`;
  }
  const day = new Date(w.startsAt).toLocaleDateString("en-US", {
    timeZone: w.timeZone,
    weekday: "short",
  });
  const start = time(w.startsAt, w.timeZone);
  if (w.endsAt === null) return `${day} ${start} onward`;
  const sameDay = dayKey(w.startsAt, w.timeZone) === dayKey(w.endsAt, w.timeZone);
  const endDay = sameDay
    ? ""
    : `${new Date(w.endsAt).toLocaleDateString("en-US", {
        timeZone: w.timeZone,
        weekday: "short",
      })} `;
  return `${day} ${start}–${endDay}${time(w.endsAt, w.timeZone)}`;
}

export const SOURCE_LINE: Record<AppTimedWindow["source"], string> = {
  push: "Pushed with Make focus",
  schedule: "From a scheduled block",
  grant: "Open until a set time",
};

export function timedAccessLabel(
  w: AppTimedWindow,
  now: number,
  withAudience: boolean,
): string {
  const who = withAudience ? `${w.audience} ` : "";
  if (w.state === "live") {
    if (w.endsAt === null) {
      return `Live now${withAudience ? ` · ${w.audience}` : ""}`;
    }
    // An "Open until…" grant (or a push extended overnight) can end on
    // another school day: name that day.
    const endDay =
      dayKey(w.endsAt, w.timeZone) === dayKey(now, w.timeZone)
        ? ""
        : `${new Date(w.endsAt).toLocaleDateString("en-US", {
            timeZone: w.timeZone,
            weekday: "short",
          })} `;
    return `Live now · ${who}until ${endDay}${time(w.endsAt, w.timeZone)}`;
  }
  return `Next · ${nextWindow(w, now)}${withAudience ? `, ${w.audience}` : ""}`;
}
