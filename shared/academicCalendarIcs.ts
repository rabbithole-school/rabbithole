// RFC 5545 serializer for a school's public academic-calendar subscription
// feed. Deliberately framework-free (no Convex types) so the same renderer can
// be unit-tested standalone and reused by any transport.
//
// NOTHING here is school-specific: the calendar name and the X-WR-TIMEZONE hint
// are arguments, resolved per institution by the caller. A hardcoded
// "Pacific/Honolulu" would silently hand a mainland school Hawaii's day
// boundaries.
import { addDaysToDayKey } from "./birthday";

export type AcademicCalendarIcsEvent = {
  uid: string;
  startDayKey: string;
  endDayKey: string;
  summary: string;
  description?: string;
  location?: string;
  category: string;
  updatedAt: number;
};

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function formatDate(dayKey: string): string {
  return dayKey.replaceAll("-", "");
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const min = date.getUTCMinutes().toString().padStart(2, "0");
  const ss = date.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${min}${ss}Z`;
}

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let limit = 75;

  for (const character of line) {
    if (encoder.encode(chunk + character).length > limit) {
      chunks.push(chunk);
      chunk = ` ${character}`;
      limit = 74;
    } else {
      chunk += character;
    }
  }
  chunks.push(chunk);
  return chunks.join("\r\n");
}

export function academicCalendarIcs(
  calendar: { name: string; timeZone: string },
  events: readonly AcademicCalendarIcsEvent[],
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rabbithole//School calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `X-WR-TIMEZONE:${escapeText(calendar.timeZone)}`,
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${formatTimestamp(event.updatedAt)}`,
      `LAST-MODIFIED:${formatTimestamp(event.updatedAt)}`,
      `DTSTART;VALUE=DATE:${formatDate(event.startDayKey)}`,
      `DTEND;VALUE=DATE:${formatDate(addDaysToDayKey(event.endDayKey, 1))}`,
      `SUMMARY:${escapeText(event.summary)}`,
      ...(event.description
        ? [`DESCRIPTION:${escapeText(event.description)}`]
        : []),
      ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
      `CATEGORIES:${escapeText(event.category)}`,
      "STATUS:CONFIRMED",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
