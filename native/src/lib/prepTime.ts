// Client-side "Prep Time" window math for the native Home pin. The backend
// (api.metaChat.myPrepTimeBlock) returns only the window CONFIG — the client
// decides whether *now* is inside the window, in the block's own IANA timezone
// (school is HST). Pure + dependency-free so it unit-tests without a renderer
// (mirrors convex/lib/metaBlocks.ts, which does the server-side day math).

/** The window-config shape returned by api.metaChat.myPrepTimeBlock. */
export interface PrepTimeBlock {
  key: string;
  label: string;
  /** "HH:MM" 24-hour local start. */
  startLocal: string;
  /** "HH:MM" 24-hour local end. */
  endLocal: string;
  /** ISO weekdays the block runs: 1=Mon … 7=Sun. */
  days: number[];
  /** IANA timezone the local times are expressed in. */
  timezone: string;
}

// en-US long weekday → ISO weekday number (1=Mon … 7=Sun), matching the
// `days` convention validated server-side in metaBlocks.validateDailyBlockInput.
const WEEKDAY_TO_ISO: Record<string, number> = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
};

/** Minutes-since-midnight for a 24-hour "HH:MM" string, or null if malformed. */
function minutesOfHHMM(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** The block's timezone-local weekday (ISO) + minutes-since-midnight for an
 * instant, via Intl. Returns null when the timezone or parts are unusable. */
function localNow(
  timezone: string,
  nowMs: number,
): { isoDay: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const isoDay = WEEKDAY_TO_ISO[get("weekday")] ?? 0;
    // Some ICU builds render midnight as "24" with hour12:false — normalize.
    const hour = parseInt(get("hour"), 10) % 24;
    const minute = parseInt(get("minute"), 10);
    if (!isoDay || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { isoDay, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * True when `nowMs` falls inside the block's daily window, evaluated in the
 * block's IANA timezone. Half-open window [start, end): the pin clears exactly
 * at end. Only same-day windows (start < end) are valid; a start >= end
 * config is treated as malformed. Returns false for a null/undefined block or
 * any malformed config, so the pin simply doesn't show.
 */
export function isWithinPrepTime(
  block: PrepTimeBlock | null | undefined,
  nowMs: number,
): boolean {
  if (!block) return false;
  const start = minutesOfHHMM(block.startLocal);
  const end = minutesOfHHMM(block.endLocal);
  if (start === null || end === null) return false;
  if (!Array.isArray(block.days) || block.days.length === 0) return false;

  if (end <= start) return false;

  const local = localNow(block.timezone, nowMs);
  if (!local) return false;
  if (!block.days.includes(local.isoDay)) return false;

  return local.minutes >= start && local.minutes < end;
}

/**
 * "14:30" → "2:30 PM" for the kid-facing eyebrow (mirrors
 * metaBlocks.formatLocalTimeLabel). Falls back to the raw string if it isn't a
 * valid HH:MM.
 */
export function formatLocalTimeLabel(hhmm: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return hhmm;
  const h = parseInt(m[1], 10);
  const minute = m[2];
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${minute} ${period}`;
}
