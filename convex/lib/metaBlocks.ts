// Pure, dependency-free helpers for the Workshop reflection chat: daily-block
// ("Prep Time") window-config validation, timezone-aware day keys, and the
// /meta-stream request/ownership validation core. Extracted for unit testing
// per .claude/rules/rabbithole-test-strategy.md §§1, 3 (no ctx, no network).

import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  isValidTimeZone,
} from "../../shared/institutionDay";

export { DEFAULT_TIMEZONE, dayKeyForTimezone, isValidTimeZone };

/** The shape of a `scholarGroups.dailyBlocks` entry (window config only). */
export interface DailyBlock {
  key: string;
  label: string;
  startLocal: string;
  endLocal: string;
  days: number[];
  timezone: string;
}

/** The Workshop's standing block is keyed "prepTime". */
export const PREP_TIME_KEY = "prepTime";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True for a 24-hour "HH:MM" string (00:00 – 23:59). */
export function isValidHHMM(s: string): boolean {
  return typeof s === "string" && HHMM.test(s);
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * The local weekday (1=Mon … 7=Sun) + "HH:MM" for an instant in an IANA
 * timezone. Shared by the Prep Time pin's client-side window math.
 */
export function localWeekdayAndTime(
  nowMs: number,
  timezone: string,
): { isoWeekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // hour12:false can emit "24" for midnight in some engines — normalize to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    isoWeekday: WEEKDAY_TO_ISO[get("weekday")] ?? 0,
    hhmm: `${hour}:${get("minute")}`,
  };
}

/**
 * True when `nowMs` falls inside the block's window — i.e. today (in the
 * block's timezone) is an allowed weekday AND the local time is within
 * [startLocal, endLocal). Pure so the pin can re-evaluate on a timer with no
 * server round-trip (§4 — the client owns the window math). A block whose end
 * is at/before its start (misconfigured) is never "within".
 */
export function isWithinPrepWindow(
  block: Pick<DailyBlock, "startLocal" | "endLocal" | "days" | "timezone">,
  nowMs: number,
): boolean {
  if (!isValidHHMM(block.startLocal) || !isValidHHMM(block.endLocal)) return false;
  if (block.endLocal <= block.startLocal) return false;
  const { isoWeekday, hhmm } = localWeekdayAndTime(nowMs, block.timezone);
  if (!block.days.includes(isoWeekday)) return false;
  return hhmm >= block.startLocal && hhmm < block.endLocal;
}

/**
 * "14:30" → "2:30 PM" for kid-facing labels (the pin/eyebrow). Falls back to
 * the raw string if it isn't a valid HH:MM.
 */
export function formatLocalTimeLabel(hhmm: string): string {
  if (!isValidHHMM(hhmm)) return hhmm;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Validate the fields a teacher supplies when setting a daily block. Returns a
 * human error string, or null when valid. HH:MM shapes + days ⊆ 1..7 + a real
 * IANA timezone (§4).
 */
export function validateDailyBlockInput(input: {
  startLocal: string;
  endLocal: string;
  days: number[];
  timezone: string;
}): string | null {
  if (!isValidHHMM(input.startLocal)) {
    return `startLocal must be a 24-hour "HH:MM" time, got "${input.startLocal}".`;
  }
  if (!isValidHHMM(input.endLocal)) {
    return `endLocal must be a 24-hour "HH:MM" time, got "${input.endLocal}".`;
  }
  if (input.endLocal <= input.startLocal) {
    return `endLocal must be after startLocal, got "${input.startLocal}" → "${input.endLocal}".`;
  }
  if (!Array.isArray(input.days) || input.days.length === 0) {
    return "days must list at least one weekday (1=Mon … 7=Sun).";
  }
  if (!input.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    return "days must be integers in 1..7 (1=Mon … 5=Fri, 6=Sat, 7=Sun).";
  }
  if (!isValidTimeZone(input.timezone)) {
    return `timezone must be a valid IANA name (e.g. "Pacific/Honolulu"), got "${input.timezone}".`;
  }
  return null;
}

export type MetaStreamValidation =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * The /meta-stream request/ownership core: the caller must be authenticated,
 * the body must carry a chatId + assistantMsgId, the metaChat must belong to
 * the caller, and the assistant message must belong to that chat. Pure so it's
 * unit-testable without an SSE client (rabbithole-test-strategy.md §3).
 */
export function validateMetaStreamRequest(input: {
  callerUserId: string | null;
  chatId?: unknown;
  assistantMsgId?: unknown;
  /** Owner (scholarId) of the metaChat, or null if the chat doesn't exist. */
  chatScholarId: string | null;
  /** The chatId the assistant message belongs to, or null if it's missing. */
  assistantChatId: string | null;
  /** Role of the assistant message row ("assistant" expected). */
  assistantRole: string | null;
}): MetaStreamValidation {
  if (!input.callerUserId) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }
  if (typeof input.chatId !== "string" || !input.chatId) {
    return { ok: false, status: 400, error: "Missing chatId" };
  }
  if (typeof input.assistantMsgId !== "string" || !input.assistantMsgId) {
    return { ok: false, status: 400, error: "Missing assistantMsgId" };
  }
  if (input.chatScholarId === null) {
    return { ok: false, status: 404, error: "Chat not found" };
  }
  if (input.chatScholarId !== input.callerUserId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  if (input.assistantChatId === null) {
    return { ok: false, status: 404, error: "Message not found" };
  }
  if (input.assistantChatId !== input.chatId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  if (input.assistantRole !== "assistant") {
    return { ok: false, status: 400, error: "Not an assistant message" };
  }
  return { ok: true };
}

/**
 * True when any of the scholar's groups runs the Scholar's Prep ritual — i.e.
 * carries a `prepTime` daily block entry. Pure — the caller supplies the groups
 * it already read (metaChat resolves membership the way fanOutScholarEvent does:
 * scan groups, keep those containing the scholar).
 *
 * Move 5 ruling: the group's `prepTime` entry is now a PARTICIPATION flag only
 * ("does this pod run the ritual?"). WHEN the ritual happens comes from the
 * bell-schedule prep block (see convex/lib/prepBlock.ts), never from the entry's
 * (now vestigial) start/end/days/timezone. This predicate replaces the former
 * `firstPrepTimeBlock`, whose arbitrary "first group with a block wins" window
 * pick the ruling deletes.
 */
export function participatesInPrep(
  groups: Array<{ dailyBlocks?: DailyBlock[] }>,
): boolean {
  return groups.some((g) =>
    (g.dailyBlocks ?? []).some((b) => b.key === PREP_TIME_KEY),
  );
}
