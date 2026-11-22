/**
 * The "I wonder…" box and the one row that draws a wonder or a starter
 * (review/quests-rebuilt-proposal.html, "One row for everything", figure 12),
 * worded once for web and the BunnyPad (TRA-676 web, its BunnyPad twin).
 *
 * A row is: a mark (the thing's emoji), a bold title, one optional content
 * line (a wonder's answer), one muted meta line for people and provenance,
 * always last, and exactly one verb button on the right. This module builds
 * the row's words from the reads in convex/wonders.ts (`todayForSelf`) and
 * convex/questionQueue.ts (`startersForSelf`); the screens only draw them.
 * Quest proposal rows use the same `ListRowModel` (shared/questRows.ts:
 * solid "Continue", outline "Start building", quiet "View").
 *
 * Inputs are typed structurally, and every unknown value (a place or a starter
 * source a later backend adds) falls back to saying less, never to a wrong
 * word: an installed BunnyPad build can be days behind the server.
 *
 * Pure. Shared by web and native (native reads it via native/vendor: re-run
 * `npm run sync:vendor` in native/ after editing).
 */

import { dayKeyForTimezone, shiftDayKey } from "./institutionDay";

export const WONDER_COPY = {
  /** The box's placeholder. */
  boxPlaceholder: "I wonder…",
  /** The line under the box: the hint, then who can see it (the design's
   *  risk table: tell kids in the hint that teachers can see what they ask). */
  boxHint: "Ask anything. Your teachers can see what you ask.",
  boxSend: "Ask",
  todaysWonders: "Today’s wonders",
  /** Scholar's Prep, under Today's wonders: the kid's older wonders
   *  (`wonders.recentForSelf` minus today's). The box lives on Prep only. */
  earlierWonders: "Earlier",
  thingsToWonderAbout: "Things to wonder about",
  open: "Open",
  ask: "Ask",
  /** The chat screen's eyebrow over a wonder's chat (`session.isWonder`),
   *  in place of "Quest · you started this": a wonder is a chat the kid
   *  asked for, never a Quest. */
  chatEyebrow: "Your wonder",
  /** The end of a wonder's meta line once a teacher has written back: taps
   *  through to the conversation in Messages. `teacherName` is the display
   *  name the server found, or null. */
  repliedBy: (teacherName: string | null): string => {
    const name = teacherName?.trim();
    return name ? `${name} replied` : "A teacher replied";
  },
} as const;

/** A wonder's mark. Wonders carry no emoji of their own (the scholar typed
 *  words, nothing picked one), so every wonder row shares this one. (💭 drew
 *  as a near-white bubble on the row's pale tile.) */
export const WONDER_MARK = "🤔";

/** How many starters "Things to wonder about" shows: a few, with no count
 *  (the design: "A few at a time, newest first, with no count"). Matches
 *  Prep's "Keep going" (PREP_KEEP_GOING_COUNT). */
export const STARTERS_SHOWN = 3;

/** How many older wonders "Earlier" shows on Scholar's Prep, the same few as
 *  the starters. */
export const RECENT_WONDERS_SHOWN = 3;

/**
 * The wonders "Earlier" lists on Scholar's Prep: those asked before today,
 * by the school's calendar day, since today's are already under Today's
 * wonders. Keeps the order it is given (`recentForSelf`: newest first) and
 * takes at most RECENT_WONDERS_SHOWN. `nowMs` is the caller's ticking clock
 * (T11), so a wonder moves here once its day has passed. Pure.
 */
export function earlierWonders<T extends { askedAt: number }>(
  wonders: readonly T[],
  nowMs: number,
  timeZone: string,
): T[] {
  const todayKey = dayKeyForTimezone(nowMs, timeZone);
  return wonders
    .filter((wonder) => dayKeyForTimezone(wonder.askedAt, timeZone) < todayKey)
    .slice(0, RECENT_WONDERS_SHOWN);
}

/** How the row's one button looks: solid keeps making a Quest the kid has
 *  begun ("Continue"); outline begins or reopens something ("Start
 *  building", "Ask", "Open"); quiet looks at something waiting or finished
 *  ("View"). */
export type RowVerbWeight = "solid" | "outline" | "quiet";

/** One row, as both apps draw it. */
export type ListRowModel = {
  /** Stable React key. */
  key: string;
  /** The thing's own emoji, in a round tile. */
  mark: string;
  /** Bold, always first. */
  title: string;
  /** The optional second line: a wonder's answer, a Quest's mission. */
  content: string | null;
  /** The muted last line: what it is, who is involved, where it came from. */
  meta: string | null;
  /** The tappable end of the meta line ("Ms. Rivera replied"): opens the
   *  Messages conversation `threadId`. Null for a row nobody has replied to. */
  replyLink: { label: string; threadId: string } | null;
  /** A Quest's rocket badge on its mark (shared/questRows.ts): "ground"
   *  while a proposal waits on a teacher, "launched" once approved, "star"
   *  (a gold star) once the Quest has been shown. Absent for wonders and
   *  starters, which carry none. */
  rocket?: "ground" | "launched" | "star";
  /** The one control on the right. */
  verb: { label: string; weight: RowVerbWeight };
};

/** Where a wonder was asked, as `todayForSelf` returns it (`askedOn`). */
export type WonderPlace =
  | { surface: "quests" }
  | { surface: "prep" }
  | { surface: "build"; unitTitle: string | null }
  | { surface: string; unitTitle?: string | null };

/** The fields of a `todayForSelf` wonder row this module reads. */
export type WonderRowInput = {
  seedId: string;
  question: string;
  sessionId: string;
  askedAt: number;
  askedOn: WonderPlace | null;
  replyExcerpt: string | null;
  /** A teacher's reply in Messages (`wonders.todayForSelf`, TRA-683). Optional
   *  so a build reading an older server draws no link. */
  reply?: { teacherName: string | null; threadId: string } | null;
};

/** The fields of a `startersForSelf` row this module reads. */
export type StarterRowInput = {
  seedId: string;
  emoji: string;
  line: string;
  source: string;
  detail:
    | { skillName: string }
    | { teacherName: string }
    /** A saved question or a follow-up (TRA-682): what the kid was building. */
    | { questTitle: string }
    | null;
};

/** "Asked on Quests", "Asked on Scholar’s Prep", "Asked while building Angle
 *  croc". Null when no place was recorded, or for a place this build doesn't
 *  know. A build wonder whose unit the scholar can no longer read (no title)
 *  says only "Asked while building". */
export function wonderPlaceLine(askedOn: WonderPlace | null): string | null {
  if (!askedOn) return null;
  switch (askedOn.surface) {
    case "quests":
      return "Asked on Quests";
    case "prep":
      return "Asked on Scholar’s Prep";
    case "build": {
      const title = "unitTitle" in askedOn ? askedOn.unitTitle?.trim() : "";
      return title ? `Asked while building ${title}` : "Asked while building";
    }
    default:
      return null;
  }
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** "10:12", "1:40": the hour and minute in the school's time zone, with no
 *  AM/PM (the design's sketches). */
function clockTime(atMs: number, timeZone: string): string {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    clockFormatters.set(timeZone, formatter);
  }
  return formatter
    .formatToParts(new Date(atMs))
    .filter((part) => part.type === "hour" || part.type === "minute" || part.type === "literal")
    .map((part) => part.value)
    .join("")
    .trim();
}

/**
 * When a wonder was asked, for its meta line, by calendar day in the school's
 * time zone:
 *
 *   today            "10:12"
 *   yesterday        "Yesterday"
 *   2 to 6 days ago  "Monday"
 *   earlier          "Oct 31" (the year added when it differs)
 *
 * `nowMs` is the caller's ticking clock (T11: a minute-rounded `useNow`), never
 * a stored field, so a row crossing midnight re-words itself.
 */
export function formatWonderTime(
  askedAt: number,
  nowMs: number,
  timeZone: string,
): string {
  const askedKey = dayKeyForTimezone(askedAt, timeZone);
  const todayKey = dayKeyForTimezone(nowMs, timeZone);
  if (askedKey >= todayKey) return clockTime(askedAt, timeZone);
  if (askedKey === shiftDayKey(todayKey, -1)) return "Yesterday";
  if (askedKey >= shiftDayKey(todayKey, -6)) {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(
      new Date(askedAt),
    );
  }
  const sameYear = askedKey.slice(0, 4) === todayKey.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(askedAt));
}

/** A wonder's meta line: where, then when ("Asked on Quests · 10:12"). */
export function wonderMetaLine(
  wonder: Pick<WonderRowInput, "askedOn" | "askedAt">,
  nowMs: number,
  timeZone: string,
): string {
  return [wonderPlaceLine(wonder.askedOn), formatWonderTime(wonder.askedAt, nowMs, timeZone)]
    .filter((part): part is string => !!part)
    .join(" · ");
}

/**
 * A starter's meta line, from where it came from (`source`) and the piece the
 * server names (`detail`):
 *
 *   story     "From your prime numbers practice" / "From your practice"
 *   teacher   "Picked by Ms. Rivera" / "Picked by your teacher"
 *   idea      "An idea from Rabbithole"
 *   parked    "Saved while building Angle croc" / "Saved while building"
 *   followUp  "From your Angle croc Quest" / "From one of your Quests"
 *
 * Null for a source this build doesn't know.
 */
export function starterMetaLine(
  source: string,
  detail: StarterRowInput["detail"],
): string | null {
  switch (source) {
    case "story": {
      const skill = detail && "skillName" in detail ? detail.skillName.trim() : "";
      return skill ? `From your ${skill} practice` : "From your practice";
    }
    case "teacher": {
      const teacher = detail && "teacherName" in detail ? detail.teacherName.trim() : "";
      return teacher ? `Picked by ${teacher}` : "Picked by your teacher";
    }
    case "idea":
      return "An idea from Rabbithole";
    case "parked": {
      const quest = detail && "questTitle" in detail ? detail.questTitle.trim() : "";
      return quest ? `Saved while building ${quest}` : "Saved while building";
    }
    case "followUp": {
      const quest = detail && "questTitle" in detail ? detail.questTitle.trim() : "";
      return quest ? `From your ${quest} Quest` : "From one of your Quests";
    }
    default:
      return null;
  }
}

/** A wonder as a row: the question, Rabbithole's first reply once there is
 *  one, where and when it was asked, and "Open" (reopens the same chat). */
export function wonderListRow(
  wonder: WonderRowInput,
  nowMs: number,
  timeZone: string,
): ListRowModel {
  return {
    key: `wonder:${wonder.seedId}`,
    mark: WONDER_MARK,
    title: wonder.question,
    content: wonder.replyExcerpt?.trim() || null,
    meta: wonderMetaLine(wonder, nowMs, timeZone),
    replyLink: wonder.reply
      ? {
          label: WONDER_COPY.repliedBy(wonder.reply.teacherName),
          threadId: wonder.reply.threadId,
        }
      : null,
    verb: { label: WONDER_COPY.open, weight: "outline" },
  };
}

/** A starter as a row: its question, where it came from, and "Ask" (opens a
 *  chat from that seed). */
export function starterListRow(starter: StarterRowInput): ListRowModel {
  return {
    key: `starter:${starter.seedId}`,
    mark: starter.emoji,
    title: starter.line,
    content: null,
    meta: starterMetaLine(starter.source, starter.detail),
    replyLink: null,
    verb: { label: WONDER_COPY.ask, weight: "outline" },
  };
}
