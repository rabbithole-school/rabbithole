/**
 * Relative time formatting for the dashboard.
 *
 * Wraps date-fns to produce strings like:
 *   - "just now"               (< 1 min)
 *   - "5 minutes ago"          (< 1 hour)
 *   - "2 hours ago"            (< 24 hours, same calendar day)
 *   - "Yesterday"              (calendar yesterday)
 *   - "3 days ago"             (within a week)
 *   - "Mar 14"                 (older, same year)
 *   - "Mar 14, 2024"           (older, prior year)
 *
 * Keep it DRY — every Assignments-tab surface uses this helper so
 * "started 1 hour ago" / "Yesterday" / "Mar 14" are consistent
 * everywhere.
 */
import {
  differenceInCalendarDays,
  differenceInMinutes,
  formatDistanceToNowStrict,
  isToday,
  isYesterday,
  format,
  isSameYear,
} from "date-fns";

export function formatRelative(timestamp: number | Date): string {
  const date = typeof timestamp === "number" ? new Date(timestamp) : timestamp;
  const now = new Date();
  const mins = differenceInMinutes(now, date);

  if (mins < 1) return "just now";
  if (isToday(date)) {
    // < 24h AND same calendar day → "X minutes/hours ago"
    return `${formatDistanceToNowStrict(date)} ago`;
  }
  if (isYesterday(date)) return "Yesterday";

  const dayDiff = differenceInCalendarDays(now, date);
  if (dayDiff >= 2 && dayDiff <= 6) return `${dayDiff} days ago`;

  if (isSameYear(date, now)) return format(date, "MMM d");
  return format(date, "MMM d, yyyy");
}

/** Capitalised variant — same output but always starts with a
 *  capital letter. Useful when the string leads a sentence ("Started
 *  yesterday" vs "Started 2 hours ago" — for the second we want
 *  "started" lowercased; for the first we want "Yesterday"). Callers
 *  decide casing context. */
export function formatRelativeCapital(timestamp: number | Date): string {
  const s = formatRelative(timestamp);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Compact variant for dense lists / status chips where a full
 * "5 minutes ago" would overflow:
 *   - "now"        (< 1 min)
 *   - "5m"         (< 1 hour)
 *   - "2h"         (< 1 day)
 *   - "3d"         (< 30 days)
 *   - "2mo"        (< 1 year)
 *   - "1y"         (older)
 */
export function formatRelativeShort(timestamp: number | Date): string {
  const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/**
 * Compact + suffixed:
 *   - "just now"   (< 1 min)
 *   - "5m ago"
 *   - "2h ago"
 *   - "3d ago"
 *   - "2mo ago"
 *   - "1y ago"
 *
 * Drop-in replacement for the per-component `timeAgo` helpers that
 * used to exist scattered across the codebase.
 */
export function formatTimeAgo(timestamp: number | Date): string {
  const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();
  if (Date.now() - ms < 60_000) return "just now";
  return `${formatRelativeShort(timestamp)} ago`;
}
