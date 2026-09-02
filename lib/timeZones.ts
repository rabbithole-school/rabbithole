// Time-zone data + labels for the "home time zone" picker used by school
// onboarding (/join) and School Settings.
//
// The zone list comes from the platform via Intl.supportedValuesOf("timeZone")
// — the full IANA list (~450 zones), always current with the runtime's ICU
// database. We deliberately do NOT bundle a library snapshot, which goes stale
// as zones are added/renamed. A tiny fallback to the pre-multi-tenant shortlist
// keeps the field usable on the rare runtime without supportedValuesOf.
//
// The stored value is always the IANA identifier string (institutions.timeZone)
// — these helpers only affect presentation, never the data contract.

/** The pre-multi-tenant hardcoded shortlist, kept ONLY as a graceful fallback
 *  for runtimes without Intl.supportedValuesOf. */
const FALLBACK_ZONE_IDS: readonly string[] = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Puerto_Rico",
  "UTC",
];

/** The full IANA zone list, or the shortlist fallback. UTC is always present. */
export function listTimeZones(): string[] {
  try {
    const supportedValuesOf = (
      Intl as unknown as {
        supportedValuesOf?: (key: string) => string[];
      }
    ).supportedValuesOf;
    if (typeof supportedValuesOf === "function") {
      const zones = supportedValuesOf("timeZone");
      if (Array.isArray(zones) && zones.length > 0) {
        return zones.includes("UTC") ? zones : ["UTC", ...zones];
      }
    }
  } catch {
    // fall through to the shortlist
  }
  return [...FALLBACK_ZONE_IDS];
}

/** The visitor's own IANA zone, or "UTC" if it can't be resolved. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The visitor's zone if it's a real offerable zone, else a sensible default.
 *  Used to seed the picker so it lands on the user's own zone, not Hawaii. */
export function defaultTimeZone(): string {
  const zones = new Set(listTimeZones());
  const tz = browserTimeZone();
  return zones.has(tz) ? tz : "UTC";
}

/** The current UTC offset for a zone, in minutes (DST-correct — reflects the
 *  offset in effect at `at`). null if the zone can't be formatted. */
export function tzOffsetMinutes(id: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: id,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const asUTC = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

/** A short UTC-offset label: "UTC+12", "UTC-4", "UTC+5:30", "UTC+0". */
export function tzOffsetLabel(id: string, at: Date = new Date()): string {
  const min = tzOffsetMinutes(id, at);
  if (min === null) return "UTC";
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/** The city portion of a zone id, underscores removed: "Pacific/Auckland" →
 *  "Auckland", "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function timeZoneCity(id: string): string {
  const segment = id.split("/").pop() ?? id;
  return segment.replace(/_/g, " ");
}

/** Human-readable label: "Auckland (Pacific/Auckland, UTC+12)". Single-segment
 *  zones (UTC, GMT, …) drop the redundant identifier: "UTC (UTC+0)". */
export function formatTimeZoneLabel(id: string, at: Date = new Date()): string {
  const city = timeZoneCity(id);
  const offset = tzOffsetLabel(id, at);
  return id.includes("/")
    ? `${city} (${id}, ${offset})`
    : `${city} (${offset})`;
}

export type TimeZoneOption = { value: string; label: string };

/** Every offerable zone as {value: iana, label}, sorted by identifier so the
 *  flat list stays regionally grouped (Africa…, America…, Asia…, …). Pass the
 *  current value to guarantee an already-stored exotic zone is still present. */
export function timeZoneOptions(ensure?: string): TimeZoneOption[] {
  const at = new Date();
  const ids = listTimeZones();
  if (ensure && !ids.includes(ensure)) ids.push(ensure);
  return ids
    .map((id) => ({ value: id, label: formatTimeZoneLabel(id, at) }))
    .sort((a, b) => a.value.localeCompare(b.value));
}
