/**
 * Wonders (TRA-669): the scholar's own questions from the "I wonder…" box on
 * the Quests tab and Scholar's Prep. A wonder is a chat that answers first. It
 * needs no approval, has no mission or badge, and never becomes a Quest
 * (review/quests-rebuilt-proposal.html, "What a wonder chat is").
 *
 * A wonder is a seed with origin "wonder" plus the plain, unit-less session it
 * opens, the same kind of chat a seed start opens (sessions.createFromSeed).
 * This file is the ONLY way a wonder reaches a client: every older seed read
 * leaves them out (lib/seeds.ts `isWonderSeed`), because installed BunnyPad
 * builds have never seen the value.
 *
 * Asking, for both clients:
 *   1. `ask({ question, askedOn })` → `{ seedId, sessionId }`, where
 *      `askedOn` is the box's place (`{ surface: "quests" }` or `"prep"`).
 *   2. Send the same words as the chat's first turn, exactly like any other
 *      turn: `sessions.sendMessage({ sessionId, message: question,
 *      inputModality })`, then POST `/session-stream` with the returned
 *      `streamId` / `assistantMsgId`.
 * The tutor takes the ANSWER FIRST stance in this chat (sessionHelpers
 * `tutorStanceFor`: a seed chat with no unit, activity, story, card answer or
 * cross-domain preview). A chat opened before step 2 lands falls back to the
 * session screen's usual "<start>" opener, which answers the seed's topic (the
 * same question) first.
 *
 * Both clients word these rows the same way through shared/wonderRows.ts (the
 * meta line, the time, the starter's "From your … practice").
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { ROLES } from "./lib/roles";
import {
  plantWonderSeed,
  WONDER_QUESTION_MAX_CHARS,
  wonderAskedOnValidator,
  type WonderAskedOn,
} from "./lib/seeds";
import { createSessionFromSeedCore } from "./sessions";
import { timeZoneForScholar } from "./lib/institutionTime";
import { requireUnitAccessForUser } from "./lib/unitAccess";
import { dayStartForDayKey, shiftDayKey } from "../shared/institutionDay";
import { stripMarkdownFormatting } from "./lib/practice/plainText";
import { wonderReplyForScholar } from "./scholarMessages";
import { noteSkyStar, runSkyHook } from "./lib/skyRefresh";

/** The question as the seed keeps it: whitespace collapsed, trimmed, and cut
 *  to WONDER_QUESTION_MAX_CHARS whole characters. Empty when nothing is left. */
export function wonderQuestion(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return Array.from(compact).slice(0, WONDER_QUESTION_MAX_CHARS).join("").trim();
}

/**
 * Ask a wonder: save the scholar's words as a "wonder" seed and open its chat.
 * Self only (no scholar id is taken); anyone but a scholar is refused. The
 * chat is a plain session with no unit that never bakes a Quest. The client
 * then sends the words as the first turn (see the file header).
 *
 * `askedOn` says where the box was: `{ surface: "quests" }`, `{ surface:
 * "prep" }`, or `{ surface: "build", unitId }` for a question asked while
 * building in a unit. A build unit must be one the scholar may read
 * (requireUnitAccessForUser, the check units.get makes) and has a session in,
 * so a client can't label a wonder with, and then read back the title of, a
 * unit that isn't theirs. The session alone is not proof: a session's unit
 * can be repointed by its owner.
 */
export const ask = authedMutation({
  args: {
    question: v.string(),
    askedOn: v.optional(wonderAskedOnValidator),
  },
  handler: async (ctx, args) => {
    if (ctx.user.role !== ROLES.SCHOLAR) {
      throw new Error("Only a scholar can ask a wonder");
    }
    const question = wonderQuestion(args.question);
    if (!question) throw new Error("Type what you wonder about first");
    const askedOn = args.askedOn;
    if (askedOn?.surface === "build") {
      const unitId = askedOn.unitId;
      await requireUnitAccessForUser(ctx, ctx.user, unitId);
      const buildSession = await ctx.db
        .query("sessions")
        .withIndex("by_user_unit", (q) =>
          q.eq("userId", ctx.user._id).eq("unitId", unitId),
        )
        .first();
      if (!buildSession) throw new Error("That unit isn't one you're building in");
    }
    const seedId = await plantWonderSeed(ctx, {
      scholarId: ctx.user._id,
      question,
      askedOn,
    });
    // The one seed-chat path: learner-institution check, the session stamped
    // with this seedId, no unit, no bake (a wonder never bakes).
    const { id: sessionId } = await createSessionFromSeedCore(
      ctx,
      ctx.user._id,
      seedId,
    );
    // A wonder is a star on the kid's own Sky (TRA-699).
    await runSkyHook("wonders.ask", () => noteSkyStar(ctx, ctx.user._id, { seedId }));
    return { seedId, sessionId };
  },
});

/** At most this many of a day's wonders come back: a bound on the read, far
 *  above a real day. */
const TODAY_WONDERS_LIMIT = 50;

/** How much of the first reply a wonder row shows. */
const REPLY_EXCERPT_MAX_CHARS = 160;

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const IMAGE_RE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
// Bare tags only (`<your-turn>`, `</your-turn>`), so "3 < 5 and 7 > 2" stays.
const TAG_RE = /<\/?[a-z][a-z0-9-]*>/gi;
const LIST_MARKER_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm;
const QUOTE_MARKER_RE = /^\s{0,3}>\s?/gm;

/** The opening of a reply as one line of plain text, cut at a word boundary
 *  with an ellipsis. Null when nothing readable is left. Pure; exported for
 *  tests. */
export function replyExcerpt(content: string): string | null {
  const text = stripMarkdownFormatting(
    content
      .replace(CODE_BLOCK_RE, " ")
      .replace(IMAGE_RE, "$1")
      .replace(TAG_RE, " ")
      .replace(LIST_MARKER_RE, "")
      .replace(QUOTE_MARKER_RE, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= REPLY_EXCERPT_MAX_CHARS) return text;
  const cut = chars.slice(0, REPLY_EXCERPT_MAX_CHARS).join("");
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > REPLY_EXCERPT_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,;:.!?-]+$/, "")}…`;
}

/** Where a wonder was asked, as its row returns it: the stored `askedOn`,
 *  with a build unit's title for "Asked while building …". The title is
 *  re-authorized on every read (requireUnitAccessForUser) and is null once the
 *  scholar may no longer read that unit, or it is gone. Null for a wonder that
 *  recorded no place. */
async function askedOnForRow(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  askedOn: WonderAskedOn | undefined,
): Promise<
  | { surface: "quests" }
  | { surface: "prep" }
  | { surface: "build"; unitId: Id<"units">; unitTitle: string | null }
  | null
> {
  if (!askedOn) return null;
  if (askedOn.surface !== "build") return { surface: askedOn.surface };
  let unitTitle: string | null = null;
  try {
    unitTitle = (await requireUnitAccessForUser(ctx, scholar, askedOn.unitId)).title;
  } catch {
    // Not found, or no longer this scholar's to read: no title.
  }
  return { surface: "build", unitId: askedOn.unitId, unitTitle };
}

/** A blank line: the boundary between a reply's paragraphs. */
const PARAGRAPH_BREAK_RE = /\n[ \t]*\n/;

/**
 * A reply without its first paragraph, when it has another one to stand on;
 * otherwise the reply as it is. The opening reply of a scholar's first-ever
 * session leads with the tutor's self-introduction (prompts.ts
 * `buildNonHumanIntroSection`), which a wonder row's preview skips so it
 * starts at the answer (firstReplyExcerpt). The boundary is structural (a
 * blank line), never the introduction's wording, which the model writes
 * itself: an introduction run into the answer's own paragraph stays in the
 * preview. Pure; exported for tests.
 */
export function withoutFirstParagraph(content: string): string {
  const parts = content.trim().split(PARAGRAPH_BREAK_RE);
  const rest = parts.slice(1).join("\n\n").trim();
  return rest ? rest : content;
}

/** How many of a scholar's sessions before a chat are read to tell whether
 *  it was their first-ever session: a bound on the read; a scholar with this
 *  many test-drive or offline sessions and nothing else is not a real case. */
const EARLIER_SESSIONS_READ = 25;

/**
 * Was this chat the scholar's first-ever real session, the one whose opening
 * reply carries the tutor's self-introduction? The same rule the prompt uses
 * (sessionContextHelpers `resolveSessionHistory`: test-drive and offline
 * sessions don't count), read as of the chat's creation, so later sessions
 * don't change the answer. One indexed read (`by_user`, before the chat).
 */
async function isFirstEverSession(
  ctx: QueryCtx,
  chat: Doc<"sessions">,
): Promise<boolean> {
  const earlier = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) =>
      q.eq("userId", chat.userId).lt("_creationTime", chat._creationTime),
    )
    .order("desc")
    .take(EARLIER_SESSIONS_READ);
  return !earlier.some((session) => !session.isTestDrive && !session.isOffline);
}

/** The first finished reply in a chat, as an excerpt (replyExcerpt). In the
 *  scholar's first-ever session it starts after the reply's first paragraph,
 *  the self-introduction (withoutFirstParagraph); the chat keeps it. Also
 *  what the day's wonders quote in Slack (dayWonders.ts), so Slack and the
 *  kid's row open the same way. */
export async function firstReplyExcerpt(
  ctx: QueryCtx,
  chat: Doc<"sessions">,
): Promise<string | null> {
  return await firstReplyExcerptFor(ctx, chat, () => isFirstEverSession(ctx, chat));
}

/** `firstReplyExcerpt` for a reader that already knows whether `chat` is the
 *  scholar's first-ever session (the kid's Sky reads many chats at once:
 *  skyStars.ts). Asked only once the chat has a reply. */
export async function firstReplyExcerptFor(
  ctx: QueryCtx,
  chat: Doc<"sessions">,
  isFirstEver: () => boolean | Promise<boolean>,
): Promise<string | null> {
  const replies = await ctx.db
    .query("messages")
    .withIndex("by_session_role", (q) =>
      q.eq("sessionId", chat._id).eq("role", "assistant"),
    )
    .order("asc")
    .take(5);
  // A placeholder still streaming (or one that died empty) is not a reply.
  const first = replies.find(
    (message) => !message.streamId && message.content.trim() !== "",
  );
  if (!first) return null;
  const content = (await isFirstEver())
    ? withoutFirstParagraph(first.content)
    : first.content;
  return replyExcerpt(content);
}

/** One wonder as `todayForSelf` and `recentForSelf` return it, or null when
 *  its chat is gone: the question, the chat it opened (the first session
 *  stamped with it), when and where it was asked (askedOnForRow), the
 *  opening of Rabbithole's first reply once there is one, and a teacher's
 *  reply in Messages when there is one (`reply`: scholarMessages
 *  `wonderReplyForScholar`, TRA-683); shared/wonderRows.ts words it as the
 *  row's "<name> replied" link. */
async function wonderRow(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  seed: Doc<"seeds">,
) {
  const chat = await ctx.db
    .query("sessions")
    .withIndex("by_user_seed", (q) =>
      q.eq("userId", scholar._id).eq("seedId", seed._id),
    )
    .first();
  if (!chat) return null;
  return {
    seedId: seed._id,
    question: seed.topic,
    sessionId: chat._id,
    askedAt: seed._creationTime,
    askedOn: await askedOnForRow(ctx, scholar, seed.askedOn),
    replyExcerpt: await firstReplyExcerpt(ctx, chat),
    reply: await wonderReplyForScholar(ctx, scholar, seed._id),
  };
}

/**
 * Today's wonders for the signed-in scholar, newest first: what Scholar's Prep
 * shows under the box. "Today" is the school's day in the institution's time
 * zone, for the `dayKey` the client sends from `useInstitutionDay` (T11): the
 * range comes only from that key, never the server clock, so a device clock a
 * few minutes off at midnight still gets the day it asked for and re-arms
 * cleanly. Any real "YYYY-MM-DD" is answered (they are the scholar's own
 * wonders); anything else throws (dayStartForDayKey's RangeError). Each row
 * is the wonder, its chat, when and where it was asked (askedOnForRow), and
 * the opening of Rabbithole's first reply once there is one. A wonder whose
 * chat is gone is left out.
 * Anyone but a scholar gets an empty list.
 */
export const todayForSelf = authedQuery({
  args: { dayKey: v.string() },
  handler: async (ctx, args) => {
    if (ctx.user.role !== ROLES.SCHOLAR) {
      return { dayKey: args.dayKey, wonders: [] };
    }
    const scholarId = ctx.user._id;
    const timeZone = await timeZoneForScholar(ctx, scholarId);
    const dayKey = args.dayKey;
    const dayStart = dayStartForDayKey(dayKey, timeZone);
    const nextDayStart = dayStartForDayKey(shiftDayKey(dayKey, 1), timeZone);
    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_origin", (q) =>
        q
          .eq("scholarId", scholarId)
          .eq("origin", "wonder")
          .gte("_creationTime", dayStart)
          .lt("_creationTime", nextDayStart),
      )
      .order("desc")
      // A wonder the scholar dismissed from Prep (seeds.dismissForSelf) is
      // left out before the bound. Teachers still see it (dayWonders).
      .filter((q) => q.neq(q.field("status"), "dismissed"))
      .take(TODAY_WONDERS_LIMIT);

    const rows = await Promise.all(
      seeds.map((seed) => wonderRow(ctx, ctx.user, seed)),
    );
    return {
      dayKey,
      wonders: rows.filter((row) => row !== null),
    };
  },
});

/** How many of a scholar's newest wonders `recentForSelf` returns: enough for
 *  "Your wonders" to show a few, far below a read limit. */
const RECENT_WONDERS_LIMIT = 10;

/**
 * "Your wonders" at the end of the Quests tab (TRA-678): the signed-in
 * scholar's newest wonders, today's included, newest first, at most
 * RECENT_WONDERS_LIMIT, each the same row `todayForSelf` returns. It takes no
 * time argument and reads no clock (T11): "newest" is the index's order, so
 * the result changes only when a wonder is asked or its chat changes. A wonder
 * whose chat is gone is left out. Anyone but a scholar gets an empty list.
 */
export const recentForSelf = authedQuery({
  args: {},
  handler: async (ctx) => {
    if (ctx.user.role !== ROLES.SCHOLAR) return [];
    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_origin", (q) =>
        q.eq("scholarId", ctx.user._id).eq("origin", "wonder"),
      )
      .order("desc")
      // Dismissed from Prep (seeds.dismissForSelf): left out before the bound.
      .filter((q) => q.neq(q.field("status"), "dismissed"))
      .take(RECENT_WONDERS_LIMIT);
    const rows = await Promise.all(
      seeds.map((seed) => wonderRow(ctx, ctx.user, seed)),
    );
    return rows.filter((row) => row !== null);
  },
});
