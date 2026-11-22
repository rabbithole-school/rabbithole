// Showing a Quest and awarding its badge (TRA-684; review/quests-rebuilt-proposal.html,
// figure 8 "Showing a Quest", "in my words", "Showing earns the badge").
//
// An approved Quest ends when its scholar shows it to its advisor, and a
// teacher awards its badge under a name they choose.
//
//  - `markReadyToShow`: the scholar says it is ready (the "I'm ready to show"
//    pill in a Quest session's header, TRA-720) and writes, in their own
//    words, how it works. The words go to the Quest's thread in Messages, as
//    the scholar. Saying it again updates the words (and the thread line); it
//    never awards anything. Only the scholar's own approved Quest. The first
//    time, the advisor gets a message in Slack with an "Award badge" button
//    (questShowingSlack.ts); new words rewrite that message, and so does an
//    award from any surface.
//  - `awardQuestBadgeAs`: ONE core, with two entry points like the other Quest
//    writers: the web's `awardBadge` (a teacher mutation) and the internal
//    `awardBadgeForUser` (the Slack button, PR 7b). Who may award is the rule
//    that decides who may approve or offer (`mayActOnScholarQuest`): any
//    teacher at the scholar's school; never the scholar, a parent, operations
//    staff, a read-only user or another school's staff. The Quest must be
//    approved; "ready to show" is not required, so a teacher can award a
//    Quest they saw in the room.
//  - `aideAwardBadge`: the same core, for the Slack aide's "award a Quest
//    badge" tool (lib/aideTools.ts). The aide resolves the scholar by name
//    inside the teacher's school; this mutation finds the scholar's approved
//    Quests and awards the one the teacher means, or hands the candidates back
//    so the model asks which. It never guesses.
//
// The badge is the existing manual badge (badges.ts insertBadgeAndMintArt):
// its name is the teacher's, its description the scholar's own `inMyWords`
// when they wrote some, else the Quest's mission (kid-facing copy), never the
// unit's teacher-facing `description`. One badge per Quest: awarding again
// returns the existing badge. RENAMING an awarded badge is out of scope.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { authedMutation, teacherMutation } from "./lib/customFunctions";
import { ROLES } from "./lib/roles";
import {
  aboutThreadInstitutionId,
  scholarThreadAccess,
} from "./lib/scholarThreadAccess";
import { sameAbout } from "./lib/threadAbout";
import { assertProposalIsOpen } from "./lib/questStructure";
import {
  DEFAULT_BADGE_COLORWAY,
  DEFAULT_BADGE_STYLE,
  isBadgeColorway,
  type BadgeStyle,
} from "./lib/badgeArt";
import { insertBadgeAndMintArt } from "./lib/badgeAward";
import { QUEST_SHOWING_LIMITS } from "../shared/questRows";
import { mayActOnScholarQuest, teacherDisplayName } from "./questProposals";
import { postScholarThreadMessage } from "./scholarMessages";
import { replaceMessageBodyKeepingHistory } from "./parentMessages";
import { internal } from "./_generated/api";
import type { QuestApproval } from "./lib/questApproval";
import { readyStamp } from "./lib/questShowingSlack";
import { noteSkyStar, runSkyHook } from "./lib/skyRefresh";

/** An edit of the words waits this long before the Slack message is
 *  rewritten, so a burst of edits is one write. */
const READY_EDIT_SETTLE_MS = 2_000;

// Bounds on what is typed when a Quest is shown: shared/questRows.ts, so the
// scholar's sheet reads the same numbers.

function cleanInMyWords(raw: string): string {
  const words = raw.trim();
  if (!words) throw new ConvexError("Say, in your own words, how it works.");
  if (words.length > QUEST_SHOWING_LIMITS.maxInMyWords) {
    throw new ConvexError(
      `Keep it under ${QUEST_SHOWING_LIMITS.maxInMyWords} characters.`,
    );
  }
  return words;
}

function cleanBadgeName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new ConvexError("A badge needs a name.");
  if (name.length > QUEST_SHOWING_LIMITS.maxBadgeName) {
    throw new ConvexError(
      `Keep the badge's name to ${QUEST_SHOWING_LIMITS.maxBadgeName} characters or fewer.`,
    );
  }
  return name;
}

/**
 * Bring the Quest's "ready to show" Slack message to `approval`
 * (questShowingSlack.syncReadyPost). Nothing to do before the scholar has
 * said it is ready: there is no message. One without a message yet is left
 * to the post, which hands a change it missed to the sync.
 */
async function scheduleReadySync(
  ctx: MutationCtx,
  unitId: Id<"units">,
  approval: QuestApproval,
  delayMs: number,
): Promise<void> {
  if (approval.readyToShowAt === undefined) return;
  await ctx.scheduler.runAfter(delayMs, internal.questShowingSlack.syncReadyPost, {
    unitId,
    stamp: readyStamp(approval),
  });
}

/** The scholar's words as they read in the Quest's thread. */
function readyLine(words: string): string {
  return `Ready to show. In my words: ${words}`;
}

/** What the scholar reads in their Quest's thread when a badge is awarded. */
function badgeAwardedLine(teacherName: string, badgeName: string): string {
  return `${teacherName} awarded you the ${badgeName} badge.`;
}

// ── The scholar says it is ready ──────────────────────────────────────────

export const markReadyToShow = authedMutation({
  args: {
    unitId: v.id("units"),
    /** How it works, in the scholar's own words. */
    inMyWords: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ unitId: Id<"units">; readyToShowAt: number }> => {
    const notFound = () => new Error("Quest not found");
    if (ctx.user.role !== ROLES.SCHOLAR) {
      throw new Error("Forbidden: only a scholar says their Quest is ready to show");
    }
    const unit = await ctx.db.get(args.unitId);
    const approval = unit?.questApproval;
    if (
      !unit ||
      !approval ||
      unit.authorScholarId !== ctx.user._id ||
      approval.state !== "approved" ||
      !unit.isActive
    ) {
      throw notFound();
    }
    const words = cleanInMyWords(args.inMyWords);
    // The Quest's school is the scholar's school now, and live.
    const schoolId = await aboutThreadInstitutionId(ctx, ctx.user);
    const school = schoolId ? await ctx.db.get(schoolId) : null;
    if (
      !schoolId ||
      !school ||
      school.disabledAt !== undefined ||
      (unit.institutionId !== undefined && unit.institutionId !== schoolId)
    ) {
      throw notFound();
    }
    // And its thread is one they may write in.
    const thread = approval.threadId ? await ctx.db.get(approval.threadId) : null;
    const access = thread ? await scholarThreadAccess(ctx, ctx.user, thread) : null;
    if (
      !thread ||
      !access ||
      access.viewer !== "scholar" ||
      access.readOnly ||
      thread.scholarId !== ctx.user._id ||
      !sameAbout(thread.about, { type: "quest", unitId: unit._id })
    ) {
      throw notFound();
    }
    if (approval.shownAt !== undefined) {
      throw new ConvexError("This Quest has already been shown.");
    }

    const now = Date.now();
    const body = readyLine(words);
    const earlier = approval.inMyWordsMessageId
      ? await ctx.db.get(approval.inMyWordsMessageId)
      : null;
    let messageId: Id<"parentMessages">;
    // A withdrawn line is never reused: the new words get a new message.
    if (
      earlier &&
      earlier.threadId === thread._id &&
      earlier.retractedAt === undefined
    ) {
      messageId = earlier._id;
      if (earlier.body !== body) {
        await replaceMessageBodyKeepingHistory(ctx, earlier, body, now);
      }
    } else {
      messageId = await postScholarThreadMessage(ctx, {
        thread,
        scholar: access.scholar,
        authorType: "scholar",
        authorUserId: ctx.user._id,
        body,
        now,
        // Slack's copy of this belongs to PR 7b's message to the advisor.
        notifyStaff: false,
      });
    }

    const first = approval.readyToShowAt === undefined;
    const readyToShowAt = approval.readyToShowAt ?? now;
    const updated = {
      ...approval,
      inMyWords: words,
      inMyWordsMessageId: messageId,
      readyToShowAt,
    };
    await ctx.db.patch(unit._id, { questApproval: updated });
    if (first) {
      // The advisor's "ready to show" message in Slack, once, on the first
      // call only (an update to the words is not a new ask).
      await ctx.scheduler.runAfter(0, internal.questShowingSlack.postReady, {
        unitId: unit._id,
      });
    } else if (approval.inMyWords !== words) {
      // New words: the same message is rewritten, under the same checks.
      await scheduleReadySync(ctx, unit._id, updated, READY_EDIT_SETTLE_MS);
    }
    return { unitId: unit._id, readyToShowAt };
  },
});

// ── A teacher awards the badge ────────────────────────────────────────────

export type AwardOutcome = {
  unitId: Id<"units">;
  badgeId: Id<"scholarUnitBadges">;
  /** The badge's name as it stands (an earlier award keeps its name). */
  badgeName: string;
  /** False on the call that minted it. */
  alreadyAwarded: boolean;
};

/**
 * The one core of awarding, for every caller. Checks who may award FIRST
 * (`mayActOnScholarQuest`), then that the Quest is approved. Not-a-Quest,
 * not-yours-to-award and not-approved read the same to a refused caller.
 */
export async function awardQuestBadgeAs(
  ctx: MutationCtx,
  teacher: Doc<"users">,
  args: {
    unitId: Id<"units">;
    badgeName: string;
    /** Art choices from the older manual award; default to the house style. */
    style?: BadgeStyle;
    colorway?: string;
  },
): Promise<AwardOutcome> {
  const notFound = () => new Error("Quest not found");
  const unit = await ctx.db.get(args.unitId);
  const approval = unit?.questApproval;
  if (!unit || !approval || !unit.authorScholarId) throw notFound();
  const scholar = await ctx.db.get(unit.authorScholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) throw notFound();
  if (!(await mayActOnScholarQuest(ctx, teacher, scholar, unit.institutionId))) {
    throw new Error("Forbidden: you can't award this Quest's badge");
  }
  // Waiting, declined and offered are not Quests yet; a withdrawn one has
  // nobody to show it to.
  // The same refusal every other guard gives a proposal that isn't open.
  assertProposalIsOpen(unit);
  if (approval.state !== "approved" || !unit.isActive) throw notFound();

  // One badge per Quest: awarding again returns the one already there.
  const existing = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar_unit", (q) =>
      q.eq("scholarId", scholar._id).eq("unitId", unit._id),
    )
    .first();
  if (existing) {
    // A badge from the older manual award or an auto-mint: the Quest now
    // records that it was shown, without a duplicate and without naming an
    // awarder nobody can vouch for (`awardedBy` stays empty).
    if (approval.badgeId === undefined) {
      const reconciled = {
        ...approval,
        shownAt: approval.shownAt ?? existing.earnedAt,
        badgeId: existing._id,
      };
      await ctx.db.patch(unit._id, { questApproval: reconciled });
      await scheduleReadySync(ctx, unit._id, reconciled, 0);
      await runSkyHook("questShowing", () => noteSkyStar(ctx, scholar._id, { unitId: unit._id }));
    }
    return {
      unitId: unit._id,
      badgeId: existing._id,
      badgeName: existing.badgeSnapshot.title,
      alreadyAwarded: true,
    };
  }

  const badgeName = cleanBadgeName(args.badgeName);
  const now = Date.now();
  const badgeId = await insertBadgeAndMintArt(ctx, {
    scholarId: scholar._id,
    unitId: unit._id,
    badgeSnapshot: {
      title: badgeName,
      // The scholar reads this in their trophy case: their own words, else
      // the Quest's kid-facing mission. Never the unit's teacher-facing
      // `description` (TRA-672).
      description:
        approval.inMyWords ??
        unit.mission?.text?.trim() ??
        unit.scholarDescription ??
        undefined,
      icon: unit.badgeOnCompletion?.icon ?? unit.emoji ?? undefined,
    },
    style: args.style ?? DEFAULT_BADGE_STYLE,
    colorway:
      args.colorway && isBadgeColorway(args.colorway)
        ? args.colorway
        : DEFAULT_BADGE_COLORWAY,
  });

  // A line in the Quest's thread, from the teacher, the way 5b's answer line
  // is posted: a staff message that is not a reply and moves no read marker.
  // A thread the teacher can't write in gets no line, and the award stands.
  let awardMessageId: Id<"parentMessages"> | undefined;
  const thread = approval.threadId ? await ctx.db.get(approval.threadId) : null;
  const access =
    thread &&
    thread.scholarId === scholar._id &&
    sameAbout(thread.about, { type: "quest", unitId: unit._id })
      ? await scholarThreadAccess(ctx, teacher, thread)
      : null;
  if (thread && access && access.viewer === "staff" && !access.readOnly) {
    awardMessageId = await postScholarThreadMessage(ctx, {
      thread,
      scholar: access.scholar,
      authorType: "teacher",
      authorUserId: teacher._id,
      body: badgeAwardedLine(teacherDisplayName(teacher), badgeName),
      now,
      marksStaffRead: false,
    });
  }
  const awarded = {
    ...approval,
    shownAt: now,
    awardedBy: teacher._id,
    badgeId,
    ...(awardMessageId ? { awardMessageId } : {}),
  };
  await ctx.db.patch(unit._id, { questApproval: awarded });
  // From whichever surface the award came, the Slack message now says so.
  await scheduleReadySync(ctx, unit._id, awarded, 0);
  // A shown Quest is the bright star on the kid's Sky (TRA-699).
  await runSkyHook("questShowing", () => noteSkyStar(ctx, scholar._id, { unitId: unit._id }));
  return { unitId: unit._id, badgeId, badgeName, alreadyAwarded: false };
}

const awardArgs = {
  unitId: v.id("units"),
  /** The badge's name, the teacher's choice. */
  badgeName: v.string(),
};

/** The web (PR 7c): the signed-in teacher awards. */
export const awardBadge = teacherMutation({
  args: awardArgs,
  handler: async (ctx, args): Promise<AwardOutcome> =>
    await awardQuestBadgeAs(ctx, ctx.user, args),
});

/**
 * The Slack button (PR 7b): the handler resolves the tapping teacher's
 * Rabbithole user and passes their id. Runs the same core, so the same check.
 */
export const awardBadgeForUser = internalMutation({
  args: { ...awardArgs, awarderId: v.id("users") },
  handler: async (ctx, { awarderId, ...args }): Promise<AwardOutcome> => {
    const awarder = await ctx.db.get(awarderId);
    if (!awarder) throw new Error("Forbidden: you can't award this Quest's badge");
    return await awardQuestBadgeAs(ctx, awarder, args);
  },
});

// ── The Slack aide's tool ─────────────────────────────────────────────────

type AwardCandidate = {
  unitId: Id<"units">;
  title: string;
  mission: string;
  readyToShow: boolean;
  alreadyAwarded: boolean;
};

type AwardScholarCandidate = {
  name: string;
  username: string | null;
  gradeLevel: string | null;
};

/** Case-, accent- and spacing-insensitive form of a name, for exact matches. */
function normalizeName(raw: string | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

type AideAwardResult =
  | {
      status: "awarded";
      scholarName: string;
      title: string;
      outcome: AwardOutcome;
    }
  /** No single scholar matched exactly: nothing is awarded, the model asks. */
  | { status: "choose_scholar"; scholars: AwardScholarCandidate[] }
  | { status: "choose"; candidates: AwardCandidate[] }
  | { status: "none" };

/**
 * `award_quest_badge`'s backing mutation. It resolves the scholar itself, by
 * exact name or username inside the teacher's school (never a loose match),
 * lists the scholar's approved Quests the teacher may award, and awards the
 * one they mean:
 *  - a `questHint` (part of a title or mission) narrows the list; a hint that
 *    matches none of their Quests awards nothing;
 *  - exactly one left: award it. Otherwise hand the candidates back (ready to
 *    show first), so the model asks which. Readiness never decides; never a
 *    guess.
 */
export const aideAwardBadge = internalMutation({
  args: {
    callerUserId: v.id("users"),
    /** The name as the teacher said it; matched exactly, never loosely. */
    scholarName: v.string(),
    /** The aide's school lens, when it has one. */
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    badgeName: v.string(),
    questHint: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AideAwardResult> => {
    const forbidden = () =>
      new Error("Forbidden: you can't award this scholar's Quest badge");
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw forbidden();

    // Pick the scholar: an EXACT match (case and accents ignored) on display
    // name or username, among the scholars this teacher may act on at their
    // school. A write is never aimed by a loose match: none, several, or only
    // partial matches award nothing and return who could be meant.
    const wanted = normalizeName(args.scholarName);
    if (!wanted) throw new ConvexError("Say which scholar.");
    const allowed = args.allowedScholarIds ? new Set(args.allowedScholarIds) : null;
    const everyone = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    const exact: Doc<"users">[] = [];
    const partial: Doc<"users">[] = [];
    for (const s of everyone) {
      if (allowed && !allowed.has(s._id)) continue;
      const name = normalizeName(s.name);
      const username = normalizeName(s.username);
      const isExact = name === wanted || (username !== "" && username === wanted);
      const isPartial = !isExact && name.includes(wanted);
      if (!isExact && !isPartial) continue;
      if (!(await mayActOnScholarQuest(ctx, caller, s, undefined))) continue;
      (isExact ? exact : partial).push(s);
    }
    const describe = (s: Doc<"users">): AwardScholarCandidate => ({
      name: s.name?.trim() || s.username || "Unknown",
      username: s.username ?? null,
      gradeLevel: s.gradeLevel ?? null,
    });
    if (exact.length !== 1) {
      const pool = exact.length > 1 ? exact : partial;
      return { status: "choose_scholar", scholars: pool.map(describe) };
    }
    const scholar = exact[0];
    // EVERY unit the scholar authored, so "only one" is a fact and not an
    // artifact of a cut-off (a scholar authors few; the eligible ones are
    // picked out below).
    const units = await ctx.db
      .query("units")
      .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholar._id))
      .collect();

    let rows: AwardCandidate[] = [];
    for (const unit of units) {
      const approval = unit.questApproval;
      if (!approval || approval.state !== "approved" || !unit.isActive) continue;
      if (!(await mayActOnScholarQuest(ctx, caller, scholar, unit.institutionId))) {
        continue;
      }
      const badge = await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholar._id).eq("unitId", unit._id),
        )
        .first();
      rows.push({
        unitId: unit._id,
        title: unit.title,
        mission: unit.mission?.text ?? "",
        readyToShow: approval.readyToShowAt !== undefined,
        alreadyAwarded: badge !== null,
      });
    }
    if (rows.length === 0) return { status: "none" };

    // Readiness only orders the list the teacher is asked about; it never
    // picks a Quest for them.
    const asked = [...rows].sort(
      (x, y) => Number(y.readyToShow) - Number(x.readyToShow),
    );
    const hint = args.questHint?.trim().toLowerCase();
    if (hint) {
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(hint) ||
          r.mission.toLowerCase().includes(hint),
      );
      // A named Quest that matches none of theirs awards nothing.
      if (rows.length === 0) return { status: "choose", candidates: asked };
    }
    if (rows.length !== 1) {
      return {
        status: "choose",
        candidates: asked.filter((r) => rows.some((m) => m.unitId === r.unitId)),
      };
    }
    const outcome = await awardQuestBadgeAs(ctx, caller, {
      unitId: rows[0].unitId,
      badgeName: args.badgeName,
    });
    return {
      status: "awarded",
      scholarName: describe(scholar).name,
      title: rows[0].title,
      outcome,
    };
  },
});
