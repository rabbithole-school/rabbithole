// What earns a star on a kid's own Sky (TRA-699), and whether it still does.
// One rule, read by the per-kid refresh (which adds rows), the triggers
// (lib/skyRefresh.ts) and the kid's read (skyStars.forSelf, which drops a
// star whose source stopped qualifying; its row stays).
//
// Every star is something the kid did:
//   - A WONDER star: a seed of origin "wonder" the kid asked, or an older seed
//     of any origin whose chat the kid wrote at least one message in. Its tap
//     target is that chat.
//   - A QUEST star: one of the kid's own Quests (a unit they author) that
//     they wrote in, or that was shown. An older Custom Quest (no
//     `questApproval`) counts; a proposal still waiting or declined, and a
//     teacher's offer the kid never started, do not.
// Only the kid's current school: a Quest stamped with another school, or a
// chat stamped with one, is left out (an unstamped legacy row passes, as in
// dayWonders.ts and eodCheckin.ts). A teacher-archived chat and a test-drive
// chat never count.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isTeacherArchived } from "../../shared/teacherArchive";
import { cleanSeedLabel } from "./seedLabel";
import { scholarInstitutionId } from "./scholarEnrollment";

/** The most stars one kid's Sky holds: a bound on every read of their rows,
 *  far above a real sky (the busiest kid in the offline test had 28). */
export const SKY_STAR_MAX = 400;

/** How many of a chat's user turns are read, at most, to find the first one
 *  the kid wrote. Staff typing in the kid's session (`byStaff`), app asks and
 *  the `<start>` opener share the range, so the bound is a read limit far past
 *  a real chat, never a prefix a kid's turn could fall behind. The scan pages
 *  through the index and stops at the kid's first turn. */
const USER_TURNS_SCANNED = 500;
/** How many chats one seed or one Quest is checked through. */
const CHATS_PER_SOURCE = 10;

/** Text a kid typed or said: not an app asking the tutor, not the session
 *  screen's opener, not empty. Who sent it is the caller's check. */
export function isScholarWrittenText(turn: {
  content: string;
  inputModality?: string | null;
}): boolean {
  if (turn.inputModality === "app") return false;
  const text = turn.content.trim();
  return text !== "" && text !== "<start>";
}

/** A user turn the kid wrote themselves: not a staff member typing in their
 *  session, not an app asking the tutor, not the session screen's opener. */
export function isScholarWrittenTurn(message: Doc<"messages">): boolean {
  return message.role === "user" && message.byStaff !== true && isScholarWrittenText(message);
}

/** A chat that can carry a star at this school. */
export function chatCounts(
  chat: Doc<"sessions">,
  schoolId: Id<"institutions"> | undefined,
): boolean {
  return (
    !isTeacherArchived(chat) &&
    chat.isTestDrive !== true &&
    chat.isOffline !== true &&
    (chat.institutionId === undefined || chat.institutionId === schoolId)
  );
}

/** One of this kid's own Quests that can carry a star at this school: active,
 *  stamped with the school or unstamped, and an older Quest or an approved
 *  one (waiting, declined and offered are not Quests yet). */
function questUnitCounts(
  unit: Doc<"units">,
  scholarId: Id<"users">,
  schoolId: Id<"institutions"> | undefined,
): boolean {
  return (
    unit.authorScholarId === scholarId &&
    unit.isActive &&
    (unit.institutionId === undefined || unit.institutionId === schoolId) &&
    (!unit.questApproval || unit.questApproval.state === "approved")
  );
}

/** Does this seed earn the kid a star from `chat`, a chat of it they are
 *  writing in right now? No message is read: the turn being sent is theirs. */
export function seedQualifiesWritingIn(
  seed: Doc<"seeds">,
  chat: Doc<"sessions">,
  scholarId: Id<"users">,
  schoolId: Id<"institutions"> | undefined,
): boolean {
  return (
    seed.scholarId === scholarId &&
    chat.userId === scholarId &&
    chat.seedId === seed._id &&
    chatCounts(chat, schoolId)
  );
}

/** Does this Quest earn the kid a star from `chat`, a session on it they are
 *  writing in right now? No message is read. */
export function questQualifiesWritingIn(
  unit: Doc<"units">,
  chat: Doc<"sessions">,
  scholarId: Id<"users">,
  schoolId: Id<"institutions"> | undefined,
): boolean {
  return (
    questUnitCounts(unit, scholarId, schoolId) &&
    chat.userId === scholarId &&
    chat.unitId === unit._id &&
    chatCounts(chat, schoolId)
  );
}

/** A cap on the messages one read scans through `firstWrittenTurn`, across
 *  however many sources it checks, for a caller that must stay cheap (the
 *  Sky's unlock, skyStars.skyHasStar). Per message read, `left` counts down
 *  by one and `bytes` by the message's estimated size (`messageBytes`). */
export type MessageReadBudget = { left: number; bytes: number };

/** Thrown when a MessageReadBudget runs out before the answer is known. */
export class MessageReadBudgetSpent extends Error {
  constructor() {
    super("Message read budget spent");
    this.name = "MessageReadBudgetSpent";
  }
}

const utf8 = new TextEncoder();

/** A message's size for a MessageReadBudget: the UTF-8 length of the
 *  document as JSON, close to what the read costs in bytes. */
function messageBytes(message: Doc<"messages">): number {
  return utf8.encode(JSON.stringify(message)).length;
}

function budgetSpent(budget: MessageReadBudget | undefined): boolean {
  return budget !== undefined && (budget.left <= 0 || budget.bytes <= 0);
}

/** The first turn the kid wrote in a chat, or null. Reads from the start of
 *  the chat and stops at that turn, so a later turn never changes the answer
 *  (nor wakes a query that read it). With a `budget`, each message read
 *  spends from it, and once either allowance is empty the next message is
 *  never fetched: this throws MessageReadBudgetSpent instead. */
export async function firstWrittenTurn(
  ctx: QueryCtx,
  chatId: Id<"sessions">,
  budget?: MessageReadBudget,
): Promise<Doc<"messages"> | null> {
  if (budgetSpent(budget)) throw new MessageReadBudgetSpent();
  let read = 0;
  for await (const turn of ctx.db
    .query("messages")
    .withIndex("by_session_role", (q) => q.eq("sessionId", chatId).eq("role", "user"))
    .order("asc")) {
    if (budget) {
      budget.left--;
      budget.bytes -= messageBytes(turn);
    }
    if (isScholarWrittenTurn(turn)) return turn;
    if (++read >= USER_TURNS_SCANNED) break;
    if (budgetSpent(budget)) throw new MessageReadBudgetSpent();
  }
  return null;
}

/** The kid's current school, the one their stars are read for. */
export async function skySchoolId(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Id<"institutions"> | undefined> {
  return await scholarInstitutionId(ctx, scholarId);
}

export type WonderStarSource = {
  seed: Doc<"seeds">;
  chat: Doc<"sessions">;
  /** When the kid asked: a wonder's own time, or the first turn they wrote
   *  in an older seed's chat. */
  askedAt: number;
};

/** The wonder star a seed earns this kid, or null. A `budget` caps the
 *  messages read (`firstWrittenTurn`). */
export async function wonderStarSource(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  schoolId: Id<"institutions"> | undefined,
  seed: Doc<"seeds">,
  budget?: MessageReadBudget,
): Promise<WonderStarSource | null> {
  if (seed.scholarId !== scholarId) return null;
  const chats = await ctx.db
    .query("sessions")
    .withIndex("by_user_seed", (q) => q.eq("userId", scholarId).eq("seedId", seed._id))
    .take(CHATS_PER_SOURCE);
  for (const chat of chats) {
    if (!chatCounts(chat, schoolId)) continue;
    if (seed.origin === "wonder") return { seed, chat, askedAt: seed._creationTime };
    const turn = await firstWrittenTurn(ctx, chat._id, budget);
    if (turn) return { seed, chat, askedAt: turn._creationTime };
  }
  return null;
}

export type QuestStarSource = {
  unit: Doc<"units">;
  /** When it was shown: `questApproval.shownAt`, or an older Quest's badge. */
  shownAt: number | null;
  badge: Doc<"scholarUnitBadges"> | null;
};

/** The Quest star a unit earns this kid, or null. A `budget` caps the
 *  messages read (`firstWrittenTurn`). */
export async function questStarSource(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  schoolId: Id<"institutions"> | undefined,
  unit: Doc<"units">,
  budget?: MessageReadBudget,
): Promise<QuestStarSource | null> {
  if (!questUnitCounts(unit, scholarId, schoolId)) return null;
  const approval = unit.questApproval;

  const badge = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar_unit", (q) => q.eq("scholarId", scholarId).eq("unitId", unit._id))
    .first();
  // A Quest that came through a proposal or an offer is shown when a teacher
  // awards it (questShowing.ts stamps `shownAt`); an older Quest was shown
  // when its badge was earned.
  const shownAt = approval ? (approval.shownAt ?? null) : (badge?.earnedAt ?? null);
  if (shownAt !== null) return { unit, shownAt, badge };

  const chats = await ctx.db
    .query("sessions")
    .withIndex("by_user_unit", (q) => q.eq("userId", scholarId).eq("unitId", unit._id))
    .take(CHATS_PER_SOURCE);
  for (const chat of chats) {
    if (chatCounts(chat, schoolId) && (await firstWrittenTurn(ctx, chat._id, budget))) {
      return { unit, shownAt: null, badge };
    }
  }
  return null;
}

/** The text a star's label is tidied from: a wonder's question as the kid
 *  typed it, an older seed's topic, a Quest's title. */
export function seedStarText(seed: Doc<"seeds">): string {
  return seed.origin === "wonder" ? seed.topic : cleanSeedLabel(seed.topic);
}

/** How many of a kid's seed chats and Quests the refresh reads. */
const SEED_CHATS_READ = 600;
const QUEST_UNITS_READ = 400;

export type SkyStarSourceRef =
  | { seedId: Id<"seeds">; text: string }
  | { unitId: Id<"units">; text: string };

/** One source that earns a star, with what a report needs to say about it:
 *  a wonder the kid asked, an older seed they wrote in, or a Quest (bright
 *  when shown). */
export type SkyStarSourceDetail = {
  ref: SkyStarSourceRef;
  kind: "wonder" | "legacySeed" | "quest";
  bright: boolean;
};

/**
 * Every source that earns this kid a star today, oldest first, with its kind
 * and whether it would be bright: their seed chats (by_user_seed) and their
 * own Quests (by_authorScholar). Bounded. The same rule as
 * `collectStarSources`, which the refresh reads; the backfill's report reads
 * this (skyBackfill.ts).
 */
export async function collectStarSourceDetails(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<SkyStarSourceDetail[]> {
  const schoolId = await skySchoolId(ctx, scholarId);
  const out: { at: number; detail: SkyStarSourceDetail }[] = [];

  const seedChats = await ctx.db
    .query("sessions")
    .withIndex("by_user_seed", (q) => q.eq("userId", scholarId).gt("seedId", undefined))
    .take(SEED_CHATS_READ);
  const seedIds = [...new Set(seedChats.map((chat) => chat.seedId!))];
  for (const seedId of seedIds) {
    const seed = await ctx.db.get(seedId);
    if (!seed) continue;
    const source = await wonderStarSource(ctx, scholarId, schoolId, seed);
    if (!source) continue;
    out.push({
      at: source.askedAt,
      detail: {
        ref: { seedId, text: seedStarText(seed) },
        kind: seed.origin === "wonder" ? "wonder" : "legacySeed",
        bright: false,
      },
    });
  }

  const units = await ctx.db
    .query("units")
    .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
    .take(QUEST_UNITS_READ);
  for (const unit of units) {
    const source = await questStarSource(ctx, scholarId, schoolId, unit);
    if (!source) continue;
    out.push({
      at: unit._creationTime,
      detail: {
        ref: { unitId: unit._id, text: unit.title },
        kind: "quest",
        bright: source.shownAt !== null,
      },
    });
  }

  return out
    .sort((a, b) => a.at - b.at)
    .slice(0, SKY_STAR_MAX)
    .map(({ detail }) => detail);
}

/**
 * Every source that earns this kid a star today, oldest first: their seed
 * chats (by_user_seed) and their own Quests (by_authorScholar). Bounded.
 */
export async function collectStarSources(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<SkyStarSourceRef[]> {
  return (await collectStarSourceDetails(ctx, scholarId)).map(({ ref }) => ref);
}
