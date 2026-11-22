/**
 * The day's wonders (TRA-680): once a school day, each class whose Slack
 * channel is linked to its scholar group (`link_channel_to_group`) gets what
 * its kids wondered about and what Rabbithole said
 * (review/quests-rebuilt-proposal.html, "The teacher loop").
 *
 * One Slack message per wonder, each its own root in the class channel:
 *
 *   *Quinn asked:* Why can owls turn their heads so far?
 *   *Rabbithole said:* Owls have 14 neck bones, twice as many as you.
 *   Reply in this thread to write back to Quinn.        (small, grey)
 *
 * Each root is mapped (scholarMessages.recordAboutSlackThread) to exactly
 * that kid and that wonder, so every root is a single-scholar root and 4a's
 * relay sends any plain reply in its thread to the kid's thread about that
 * wonder, with no name needed. One Slack thread is one conversation (Andy,
 * 2026-11-15: "a more predictable mapping of slack convos to RH convos even
 * if it means a slightly messier slack"). Two kids with one first name go
 * under their full names.
 *
 * It rides on the end-of-day check-in: `eodCheckin.runDaily`, on the same
 * 2:05 pm cron, schedules `postForDay` once its check-ins are done, so it
 * shares their weekend skip and needs no cron of its own.
 *
 * A class's run carries the wonders asked since its previous run, so a
 * question asked in the evening or over a weekend, when kids ask at home,
 * reaches the next school day's run (`noteWindow`). With no earlier run the
 * window opens at the previous school day's run, and it never reaches back
 * more than MAX_SCHOOL_DAYS_BACK school days. Windows meet end to end, and
 * the wonders a run claims are fixed when it is claimed, so a wonder is in
 * one run at most.
 *
 * Left out:
 *   - a channel whose bindings span more than one school (the rule the EOD
 *     check-in's `deliveryAllowed` applies), or one Slack says is shared with
 *     another organization: nothing posts there;
 *   - a wonder with no finished answer yet when the run is claimed;
 *   - EVERY wonder of a FLAGGED kid: one with a `welfare` alert (the
 *     observer's safety alert) or a `parasocial_reliance` alert (its
 *     connection note) raised from FLAG_LOOKBACK_MS before the window opened
 *     onward. Per kid, not per chat, because alerts are deduped: a
 *     connection note is raised once per kid and severity for three days, so
 *     a second flagged chat in that time leaves no alert of its own;
 *   - a chat the EOD check-in would not picture either (eodCheckin
 *     `buildSessionPostable`: archived by a teacher, a test drive, or stamped
 *     to another school);
 *   - a kid not on the class roster, or not enrolled at the class's school
 *     (their real enrollment, no primary fallback, the same rule an about
 *     thread uses), and a class with no school or a suspended one;
 *   - a class with nothing in its window: no row, no post, and its next
 *     window still starts where its last run ended.
 * All of it is checked again immediately before each wonder posts
 * (`freshWonder`), so a kid who left the class, moved school or was flagged
 * after the run was claimed is skipped.
 *
 * "Could become" buttons (TRA-697): once a run is claimed, and never before it
 * is delivered, each kid in it may get up to two Quest ideas drafted from these
 * wonders in a scheduled action of their own, only on evidence
 * (lib/wonderQuestIdeas.ts, dayWonderIdeasActions.draft). They are stored
 * (`wonderQuestIdeas`) and each shows as a button under the wonder it grew
 * from, added to the posted message by `syncWonderPost`, only for a kid who
 * still passes every check above; a tap offers the Quest
 * (wonderQuestIdeaSlack.ts). A slow or failed draft leaves the note as posted.
 *
 * Only the kid's question and Rabbithole's reply reach Slack, never a seed's
 * rationale, a teacher's note or an alert.
 *
 * Once per wonder (`dayWonderNotes`, one row per class per run): the row is
 * claimed, with its wonders, before any post; every post carries delivery
 * metadata a later attempt looks for before posting again (the EOD
 * check-in's reconciliation); a wonder is mapped only once Slack has its
 * message, so no mapping ever points at a message nobody saw; and an attempt
 * holds a lease, with the next attempt scheduled for when it runs out.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DEDUP_WINDOW_MS } from "./alerts";
import { buildSessionPostable } from "./eodCheckin";
import { firstReplyExcerpt } from "./wonders";
import { ideasOnWonder } from "./wonderQuestIdeas";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import { ROLES } from "./lib/roles";
import { escapeSlackText } from "./lib/slackText";
import {
  MAKING_LINES_MAX,
  MAX_IDEAS_PER_SCHOLAR,
  ideaStamp,
  ideaBlocks,
  type IdeaCandidate,
  type IdeaForMessage,
} from "./lib/wonderQuestIdeas";
import {
  fetchConversationHistory,
  fetchConversationShape,
  messageWithDeliveryMetadata,
  postMessage,
  updateBlocks,
  type SlackMessageMetadata,
} from "./lib/slackApi";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";

const NOTE_EVENT_TYPE = "rabbithole_day_wonders";
/** How far a run reaches back with no earlier run, or after a long gap
 *  (a class newly linked, or one quiet for weeks). */
const MAX_SCHOOL_DAYS_BACK = 3;
/** Alert kinds that keep a kid out. */
const FLAGGED_ALERT_KINDS: ReadonlySet<string> = new Set([
  "welfare",
  "parasocial_reliance",
]);
/**
 * How long before a run's window an alert still keeps the kid out: the
 * longest dedup window those alerts use. The observer raises a connection
 * note with a 3-day window (observer.ts PARASOCIAL_DEDUP_MS); every other
 * alert uses alerts.ts DEDUP_WINDOW_MS. A chat flagged inside an earlier
 * alert's window gets no alert of its own, so the earlier one has to count.
 */
const FLAG_LOOKBACK_MS = Math.max(DEDUP_WINDOW_MS, 3 * 24 * 60 * 60 * 1000);
/** A bound on one kid's wonders in a run, as `wonders.todayForSelf` bounds
 *  a day. */
const WONDERS_PER_SCHOLAR_LIMIT = 50;
/** Longer than an action may run (10 minutes), so a live attempt never
 *  overlaps the next one. */
const ATTEMPT_LEASE_MS = 11 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Quest-idea drafts start this far apart, so a big class does not hit the
 *  model all at once. */
const IDEA_DRAFT_STAGGER_MS = 1_000;

type NoteWonder = {
  seedId: Id<"seeds">;
  question: string;
  reply: string;
  askedAt: number;
};
/** A kid with something to post; `wonders` is oldest first. */
type NoteScholar = { scholarId: Id<"users">; name: string; wonders: NoteWonder[] };

/**
 * The one school whose classes are bound to this channel, or null when the
 * bindings span more than one school, or one has no school. The same rule the
 * EOD check-in's `deliveryAllowed` holds a channel to.
 */
export async function channelSchool(
  ctx: QueryCtx,
  channelId: string,
): Promise<Id<"institutions"> | null> {
  const bound = await ctx.db
    .query("scholarGroups")
    .withIndex("by_slack_channel", (q) => q.eq("slackChannelId", channelId))
    .collect();
  const schools = new Set(bound.map((group) => group.institutionId));
  const [school] = [...schools];
  return schools.size === 1 && school ? school : null;
}

/**
 * The class, when it is still bound to `channelId`, at `institutionId`, which
 * is live and the only school bound to that channel. Null otherwise.
 */
async function classInChannel(
  ctx: QueryCtx,
  groupId: Id<"scholarGroups">,
  channelId: string,
  institutionId: Id<"institutions">,
): Promise<Doc<"scholarGroups"> | null> {
  const group = await ctx.db.get(groupId);
  if (!group || group.slackChannelId !== channelId) return null;
  if (group.institutionId !== institutionId) return null;
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt !== undefined) return null;
  if ((await channelSchool(ctx, channelId)) !== institutionId) return null;
  return group;
}

/**
 * Whether a kid is flagged as of `sinceMs`: a `welfare` or
 * `parasocial_reliance` alert raised from FLAG_LOOKBACK_MS before it onward.
 * A flagged kid's name and words go into no class channel (the day's wonders
 * here, and a Quest's "ready to show" message).
 */
export async function scholarIsFlagged(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  sinceMs: number,
): Promise<boolean> {
  const alerts = await ctx.db
    .query("alerts")
    .withIndex("by_scholar_created", (q) =>
      q.eq("scholarId", scholarId).gte("createdAt", sinceMs - FLAG_LOOKBACK_MS),
    )
    .collect();
  return alerts.some((alert) => FLAGGED_ALERT_KINDS.has(alert.kind));
}

/**
 * A kid's wonders asked in [windowStartMs, cutoffMs) that may post, oldest
 * first, or null when the kid may not post at all (off the roster, not
 * enrolled at the class's school, flagged, or nothing left). `onlySeedIds`
 * keeps a claimed run to the wonders it was claimed with.
 */
async function scholarForNote(
  ctx: QueryCtx,
  group: Doc<"scholarGroups">,
  institutionId: Id<"institutions">,
  scholarId: Id<"users">,
  windowStartMs: number,
  cutoffMs: number,
  onlySeedIds?: ReadonlySet<string>,
): Promise<NoteScholar | null> {
  if (!group.scholarIds.some((id) => id === scholarId)) return null;
  const scholar = await ctx.db.get(scholarId);
  const name = scholar?.name?.trim();
  if (!scholar || scholar.role !== ROLES.SCHOLAR || !name) return null;
  if ((await scholarInstitutionId(ctx, scholarId)) !== institutionId) return null;
  if (await scholarIsFlagged(ctx, scholarId, windowStartMs)) return null;
  const seeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_origin", (q) =>
      q
        .eq("scholarId", scholarId)
        .eq("origin", "wonder")
        .gte("_creationTime", windowStartMs)
        .lt("_creationTime", cutoffMs),
    )
    .order("asc")
    .take(WONDERS_PER_SCHOLAR_LIMIT);
  const wonders: NoteWonder[] = [];
  for (const seed of seeds) {
    if (onlySeedIds && !onlySeedIds.has(seed._id)) continue;
    // The chat this wonder opened: the first session stamped with it.
    const chat = await ctx.db
      .query("sessions")
      .withIndex("by_user_seed", (q) =>
        q.eq("userId", scholarId).eq("seedId", seed._id),
      )
      .first();
    if (!chat || !buildSessionPostable(chat, institutionId)) continue;
    // The same opening the kid's row shows (it skips a first-ever chat's
    // self-introduction).
    const reply = await firstReplyExcerpt(ctx, chat);
    if (!reply) continue;
    wonders.push({
      seedId: seed._id,
      question: seed.topic,
      reply,
      askedAt: seed._creationTime,
    });
  }
  return wonders.length > 0 ? { scholarId, name, wonders } : null;
}

/** The school day `count` school days (weekdays) before `dayKey`. */
function schoolDaysBefore(dayKey: string, count: number): string {
  let key = dayKey;
  for (let found = 0; found < count; ) {
    key = shiftDayKey(key, -1);
    const weekday = weekdayForDayKey(key);
    if (weekday !== 0 && weekday !== 6) found += 1;
  }
  return key;
}

/**
 * Where a class's run at `nowMs` starts: where its previous run ended, or,
 * with no earlier run, at the previous school day's run (the same time of
 * day, in the school's time zone). Never further back than
 * MAX_SCHOOL_DAYS_BACK school days. Null for a class with no school.
 */
export const noteWindow = internalQuery({
  args: { groupId: v.id("scholarGroups"), nowMs: v.number() },
  handler: async (
    ctx,
    { groupId, nowMs },
  ): Promise<{ dayKey: string; windowStartMs: number } | null> => {
    const group = await ctx.db.get(groupId);
    if (!group?.institutionId) return null;
    const institution = await ctx.db.get(group.institutionId);
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    const dayKey = dayKeyForTimezone(nowMs, timeZone);
    const sinceDayStart = nowMs - dayStartForDayKey(dayKey, timeZone);
    const runOn = (key: string) => dayStartForDayKey(key, timeZone) + sinceDayStart;
    const earliest = runOn(schoolDaysBefore(dayKey, MAX_SCHOOL_DAYS_BACK));
    const previous = await ctx.db
      .query("dayWonderNotes")
      .withIndex("by_group_day", (q) => q.eq("groupId", groupId).lt("dayKey", dayKey))
      .order("desc")
      .first();
    const start = previous ? previous.cutoffMs : runOn(schoolDaysBefore(dayKey, 1));
    return { dayKey, windowStartMs: Math.min(Math.max(start, earliest), nowMs) };
  },
});

/**
 * The class's wonders asked in [windowStartMs, cutoffMs) that may post, by
 * kid, or null when the class has no linked channel, no live school, or
 * shares its channel with another school's class. Kids come from the class
 * roster only (`scholarForNote`); a kid with nothing to post is left out.
 */
export const collectGroupDay = internalQuery({
  args: {
    groupId: v.id("scholarGroups"),
    windowStartMs: v.number(),
    cutoffMs: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    channelId: string;
    institutionId: Id<"institutions">;
    scholars: NoteScholar[];
  } | null> => {
    const loose = await ctx.db.get(args.groupId);
    if (!loose?.slackChannelId || !loose.institutionId) return null;
    const group = await classInChannel(
      ctx,
      args.groupId,
      loose.slackChannelId,
      loose.institutionId,
    );
    if (!group) return null;
    const scholars: NoteScholar[] = [];
    for (const scholarId of new Set(group.scholarIds)) {
      const scholar = await scholarForNote(
        ctx,
        group,
        loose.institutionId,
        scholarId,
        args.windowStartMs,
        args.cutoffMs,
      );
      if (scholar) scholars.push(scholar);
    }
    scholars.sort((a, b) => a.name.localeCompare(b.name));
    return {
      channelId: loose.slackChannelId,
      institutionId: loose.institutionId,
      scholars,
    };
  },
});

/**
 * A claimed run's kids as they may post right now, with only the wonders it
 * was claimed with: who is in it, for the names each message goes under.
 * Null when the class is no longer bound to the run's channel and school
 * alone.
 */
export const freshNote = internalQuery({
  args: { noteId: v.id("dayWonderNotes") },
  handler: async (ctx, { noteId }): Promise<{ scholars: NoteScholar[] } | null> => {
    const note = await ctx.db.get(noteId);
    if (!note) return null;
    const group = await classInChannel(ctx, note.groupId, note.channelId, note.institutionId);
    if (!group) return null;
    const scholars: NoteScholar[] = [];
    for (const scholarId of new Set(note.wonders.map((w) => w.scholarId))) {
      const scholar = await scholarForNote(
        ctx,
        group,
        note.institutionId,
        scholarId,
        note.windowStartMs,
        note.cutoffMs,
        new Set(note.wonders.filter((w) => w.scholarId === scholarId).map((w) => w.seedId)),
      );
      if (scholar) scholars.push(scholar);
    }
    return { scholars };
  },
});

/**
 * One claimed wonder, re-read and re-authorized immediately before it posts:
 * the class still bound to the run's channel and school alone, the kid still
 * on its roster, enrolled there and unflagged, and the wonder still allowed
 * in. Null to skip it.
 */
export const freshWonder = internalQuery({
  args: { noteId: v.id("dayWonderNotes"), seedId: v.id("seeds") },
  handler: async (
    ctx,
    { noteId, seedId },
  ): Promise<{ scholarId: Id<"users">; name: string; wonder: NoteWonder } | null> => {
    const note = await ctx.db.get(noteId);
    const claimed = note?.wonders.find((w) => w.seedId === seedId);
    if (!note || !claimed) return null;
    const group = await classInChannel(ctx, note.groupId, note.channelId, note.institutionId);
    if (!group) return null;
    const scholar = await scholarForNote(
      ctx,
      group,
      note.institutionId,
      claimed.scholarId,
      note.windowStartMs,
      note.cutoffMs,
      new Set([seedId]),
    );
    const wonder = scholar?.wonders[0];
    return scholar && wonder ? { scholarId: scholar.scholarId, name: scholar.name, wonder } : null;
  },
});

/**
 * The name each kid's messages go under: their first name, or their full
 * name when another kid in the run has the same first name, so a teacher can
 * tell the two apart.
 */
function scholarLabels(scholars: readonly { scholarId: string; name: string }[]) {
  const first = (name: string) => name.split(/\s+/)[0] ?? name;
  const counts = new Map<string, number>();
  for (const s of scholars) {
    const key = first(s.name).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    scholars.map((s) => [
      s.scholarId,
      (counts.get(first(s.name).toLowerCase()) ?? 0) > 1 ? s.name : first(s.name),
    ]),
  );
}

/** One wonder's message: the question and the opening of Rabbithole's
 *  answer, then, when the wonder has Quest ideas, a button for each
 *  ("Offer an app: …", lib/wonderQuestIdeas.ts), then a small grey line
 *  saying how to write back. Its first and last blocks are what
 *  `rebuildWonderMessage` keeps when a tap rewrites the middle. */
function wonderMessage(
  label: string,
  wonder: NoteWonder,
  ideas: readonly IdeaForMessage[] = [],
) {
  const name = escapeSlackText(label);
  const body =
    `*${name} asked:* ${escapeSlackText(wonder.question)}\n` +
    `*Rabbithole said:* ${escapeSlackText(wonder.reply)}`;
  const hint = `Reply in this thread to write back to ${name}.`;
  const { blocks: ideaBlocksHere, lines } = ideaBlocks(ideas, label);
  return {
    text: [body, ...lines.map(escapeSlackText), hint].join("\n"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: body } },
      ...ideaBlocksHere,
      { type: "context", elements: [{ type: "mrkdwn", text: hint }] },
    ],
  };
}

function deliveryMetadata(noteId: Id<"dayWonderNotes">, part: string): SlackMessageMetadata {
  return {
    event_type: NOTE_EVENT_TYPE,
    event_payload: { delivery_id: `wonders:${noteId}:${part}` },
  };
}

/**
 * Claim a class's run for a day, with the wonders it will post fixed from
 * here on, and start its delivery. Returns null, writing nothing, when the
 * class already has a run that day, so a second run never posts twice.
 */
export const claimNote = internalMutation({
  args: {
    groupId: v.id("scholarGroups"),
    dayKey: v.string(),
    channelId: v.string(),
    institutionId: v.id("institutions"),
    windowStartMs: v.number(),
    cutoffMs: v.number(),
    wonders: v.array(v.object({ scholarId: v.id("users"), seedId: v.id("seeds") })),
  },
  handler: async (ctx, args): Promise<Id<"dayWonderNotes"> | null> => {
    const existing = await ctx.db
      .query("dayWonderNotes")
      .withIndex("by_group_day", (q) =>
        q.eq("groupId", args.groupId).eq("dayKey", args.dayKey),
      )
      .first();
    if (existing) return null;
    const noteId = await ctx.db.insert("dayWonderNotes", {
      ...args,
      state: "pending",
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.dayWonders.deliverNote, { noteId });
    // Quest ideas come after, one action per kid, a second apart. Scheduled
    // here so the claim and its drafts commit together: a run that exists
    // always has its drafts scheduled, and a second claim schedules nothing.
    // The note never waits for them.
    for (const [i, scholarId] of [...new Set(args.wonders.map((w) => w.scholarId))].entries()) {
      await ctx.scheduler.runAfter(
        i * IDEA_DRAFT_STAGGER_MS,
        internal.dayWonderIdeasActions.draft,
        { noteId, scholarId },
      );
    }
    return noteId;
  },
});

/**
 * Start one delivery attempt: null when the run is done, another attempt
 * holds the lease, or the attempts ran out (the run is then failed). The
 * next attempt is scheduled for when this one's lease runs out, and does
 * nothing if this one finished.
 */
export const beginAttempt = internalMutation({
  args: { noteId: v.id("dayWonderNotes") },
  handler: async (ctx, { noteId }): Promise<Doc<"dayWonderNotes"> | null> => {
    const note = await ctx.db.get(noteId);
    if (!note || note.state !== "pending") return null;
    const now = Date.now();
    if (note.leaseUntil !== undefined && note.leaseUntil > now) return null;
    if (note.attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(noteId, { state: "failed", leaseUntil: undefined });
      console.error(
        `[DayWonders] run ${noteId} gave up after ${note.attempts} attempts: ${note.lastError ?? "unknown error"}`,
      );
      return null;
    }
    const leaseUntil = now + ATTEMPT_LEASE_MS;
    await ctx.db.patch(noteId, { attempts: note.attempts + 1, leaseUntil });
    await ctx.scheduler.runAt(leaseUntil, internal.dayWonders.deliverNote, { noteId });
    return { ...note, attempts: note.attempts + 1, leaseUntil };
  },
});

/** End an attempt: done, given up, or left for the next attempt. */
export const endAttempt = internalMutation({
  args: {
    noteId: v.id("dayWonderNotes"),
    outcome: v.union(v.literal("posted"), v.literal("failed"), v.literal("retry")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { noteId, outcome, error }) => {
    if (outcome === "retry") {
      // The lease stays: the attempt scheduled at its end is the retry.
      await ctx.db.patch(noteId, { lastError: error });
      return;
    }
    await ctx.db.patch(noteId, {
      state: outcome,
      leaseUntil: undefined,
      ...(error === undefined ? {} : { lastError: error }),
    });
  },
});

/**
 * Post one class's run: for each claimed wonder, the message an earlier
 * attempt already got into the channel (found by its delivery metadata), or
 * else a fresh, re-authorized read (`freshWonder`) and a new post. A wonder is
 * mapped to its own message only once Slack has that message, so a failed or
 * ambiguous post leaves nothing to undo.
 */
export const deliverNote = internalAction({
  args: { noteId: v.id("dayWonderNotes") },
  handler: async (ctx, { noteId }): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const note = await ctx.runMutation(internal.dayWonders.beginAttempt, { noteId });
    if (!note) return;
    const retry = async (error: string) => {
      console.warn(`[DayWonders] run ${noteId} will retry: ${error}`);
      await ctx.runMutation(internal.dayWonders.endAttempt, {
        noteId,
        outcome: "retry",
        error,
      });
    };
    const end = async (outcome: "posted" | "failed", error?: string) => {
      await ctx.runMutation(internal.dayWonders.endAttempt, { noteId, outcome, error });
    };
    try {
      const run = await ctx.runQuery(internal.dayWonders.freshNote, { noteId });
      // A class unlinked, moved to another channel or school, or now sharing
      // its channel with another school's class gets nothing more.
      if (!run) return await end("failed", "The class is no longer this channel's alone");
      const channel = note.channelId;
      // A kid's name and words never reach another organization.
      const shape = await fetchConversationShape(token, channel);
      if (!shape?.sharingKnown) return await retry("conversations.info: couldn't read the channel's sharing");
      if (shape.externallyShared) {
        console.warn(`[DayWonders] run ${noteId} not posted: the channel is shared with another organization`);
        return await end("failed", "The class channel is shared with another organization");
      }
      // Slack can take a post and lose the answer, so look first.
      const history = await fetchConversationHistory(token, channel, {
        oldest: String(note._creationTime / 1_000),
      });
      if (!history.ok) return await retry(`history: ${history.error ?? "unknown"}`);
      const labels = scholarLabels(run.scholars);
      let inChannel = 0;
      for (const claimed of note.wonders) {
        const part = String(claimed.seedId);
        let ts = messageWithDeliveryMetadata(
          history.messages,
          NOTE_EVENT_TYPE,
          `wonders:${noteId}:${part}`,
        )?.ts;
        if (!ts) {
          // Re-read and re-authorized right before this wonder's post.
          const fresh = await ctx.runQuery(internal.dayWonders.freshWonder, {
            noteId,
            seedId: claimed.seedId,
          });
          if (!fresh) continue;
          const ideas = await ctx.runQuery(internal.wonderQuestIdeas.ideasForWonder, {
            noteId,
            seedId: claimed.seedId,
          });
          const posted = await postMessage(token, {
            channel,
            ...wonderMessage(labels.get(fresh.scholarId) ?? fresh.name, fresh.wonder, ideas),
            metadata: deliveryMetadata(noteId, part),
          });
          // Not mapped: the next attempt looks for the message in the channel
          // first, and maps the wonder only if Slack has it.
          if (!posted.ok || !posted.ts) return await retry(`post: ${posted.error ?? "no ts"}`);
          ts = posted.ts;
        }
        // Slack has this wonder's message, so a teacher can see it: map its
        // thread to the kid's conversation about this wonder.
        await ctx.runMutation(internal.scholarMessages.recordAboutSlackThread, {
          channelId: channel,
          threadTs: ts,
          scholarId: claimed.scholarId,
          about: { type: "wonder", seedId: claimed.seedId },
        });
        await ctx.runMutation(internal.dayWonders.recordPostedTs, {
          noteId,
          seedId: claimed.seedId,
          ts,
        });
        // Quest ideas drafted while this was posting: their sync found no
        // recorded post, so ask for one now that there is.
        const drafted = await ctx.runQuery(internal.wonderQuestIdeas.ideasForWonder, {
          noteId,
          seedId: claimed.seedId,
        });
        if (drafted.length > 0) {
          await ctx.scheduler.runAfter(0, internal.dayWonders.syncWonderPost, {
            noteId,
            seedId: claimed.seedId,
            stamp: ideaStamp(drafted),
          });
        }
        inChannel += 1;
      }
      if (inChannel === 0) return await end("failed", "Nothing was left to post");
      await end("posted");
    } catch (error: unknown) {
      await retry(error instanceof Error ? error.message : String(error));
    }
  },
});

/**
 * Quest ideas (TRA-697) never stand between a run and its delivery: the run is
 * claimed and delivered as always, and each kid's ideas are drafted afterwards
 * in their own scheduled action (dayWonderIdeasActions.draft). A kid's draft
 * is claimed once per run, so it is paid for once however often it is
 * scheduled, and a slow or failed model call leaves the note as posted, with
 * no buttons for that kid.
 */
export const claimIdeaDraft = internalMutation({
  args: { noteId: v.id("dayWonderNotes"), scholarId: v.id("users") },
  handler: async (ctx, { noteId, scholarId }): Promise<boolean> => {
    const note = await ctx.db.get(noteId);
    if (!note || note.state === "failed") return false;
    const done = note.ideasDraftedFor ?? [];
    if (done.some((id) => id === scholarId)) return false;
    if (!note.wonders.some((w) => w.scholarId === scholarId)) return false;
    await ctx.db.patch(noteId, { ideasDraftedFor: [...done, scholarId] });
    return true;
  },
});

/** How many Quests and chats the "making" list is drawn from, and how many it
 *  shows. */
const IDEA_QUESTS_READ = 20;
const IDEA_CHATS_READ = 25;
const IDEA_FOLLOW_UPS_READ = 60;

/**
 * What the Quest-idea draft reads for one kid in a claimed run, after the same
 * checks a post gets (`scholarForNote`: still on the class, enrolled at its
 * school, not flagged): each wonder with its evidence counted from data (the
 * kid's follow-ups in its chat; whether they wrote in it on another school day
 * than they asked), and what they are making. "Making" is the kid's started or
 * approved Quests and their real chats at THIS school (unstamped legacy rows
 * pass, as everywhere in this file): never an offer or a proposal still waiting,
 * never another school's work, never a chat a teacher put away. Only what the
 * kid and Rabbithole said and the kid's own project names: never an alert, a
 * teacher's note or a seed's rationale. Null when the kid may not be drafted
 * for.
 */
export const ideaInputs = internalQuery({
  args: { noteId: v.id("dayWonderNotes"), scholarId: v.id("users") },
  handler: async (
    ctx,
    { noteId, scholarId },
  ): Promise<{
    institutionId: Id<"institutions">;
    firstName: string;
    wonders: IdeaCandidate[];
    making: string[];
  } | null> => {
    const note = await ctx.db.get(noteId);
    if (!note || note.state === "failed") return null;
    const group = await classInChannel(ctx, note.groupId, note.channelId, note.institutionId);
    if (!group) return null;
    const institutionId = note.institutionId;
    const scholar = await scholarForNote(
      ctx,
      group,
      institutionId,
      scholarId,
      note.windowStartMs,
      note.cutoffMs,
      new Set(note.wonders.filter((w) => w.scholarId === scholarId).map((w) => w.seedId)),
    );
    if (!scholar) return null;
    const institution = await ctx.db.get(institutionId);
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    const dayOf = (ms: number) => dayKeyForTimezone(ms, timeZone);
    const wonders: IdeaCandidate[] = [];
    for (const wonder of scholar.wonders) {
      const chat = await ctx.db
        .query("sessions")
        .withIndex("by_user_seed", (q) => q.eq("userId", scholarId).eq("seedId", wonder.seedId))
        .first();
      if (!chat) continue;
      const mine = await ctx.db
        .query("messages")
        .withIndex("by_session_role", (q) => q.eq("sessionId", chat._id).eq("role", "user"))
        .order("asc")
        .take(IDEA_FOLLOW_UPS_READ);
      // The first turn is the question itself; the rest are follow-ups.
      const rest = mine.slice(1);
      const askedDay = dayOf(wonder.askedAt);
      wonders.push({
        seedId: wonder.seedId,
        question: wonder.question,
        reply: wonder.reply,
        followUps: rest.map((m) => m.content),
        followUpCount: rest.length,
        cameBack: mine.some((m) => dayOf(m._creationTime) !== askedDay),
      });
    }
    const quests = await ctx.db
      .query("units")
      .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
      .order("desc")
      .take(IDEA_QUESTS_READ);
    const recent = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholarId))
      .order("desc")
      .take(IDEA_CHATS_READ);
    const making = [
      ...quests
        .filter(
          (u) =>
            u.isActive &&
            (u.institutionId === undefined || u.institutionId === institutionId) &&
            (u.questApproval === undefined || u.questApproval.state === "approved"),
        )
        .map((u) => `Quest: ${u.title}`),
      ...recent
        .filter(
          (s) =>
            buildSessionPostable(s, institutionId) &&
            !s.seedId &&
            !s.isArchived &&
            !s.isOffline &&
            s.title,
        )
        .map((s) => `Chat: ${s.title}`),
    ]
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line, i, all) => all.indexOf(line) === i)
      .slice(0, MAKING_LINES_MAX);
    return {
      institutionId,
      firstName: scholar.name.split(/\s+/)[0] ?? scholar.name,
      wonders,
      making,
    };
  },
});

/**
 * Keep a kid's drafted ideas: only on a wonder the run claimed for them, at
 * most two in all, nothing if they already have ideas in this run. Then bring
 * each affected wonder's post up to date (`syncWonderPost`), which finds the
 * post once it is mapped.
 */
export const storeIdeas = internalMutation({
  args: {
    noteId: v.id("dayWonderNotes"),
    scholarId: v.id("users"),
    ideas: v.array(
      v.object({
        seedId: v.id("seeds"),
        kind: v.union(v.literal("app"), v.literal("slides"), v.literal("python")),
        mission: v.string(),
        title: v.string(),
        reasons: v.string(),
        evidence: v.object({
          cameBack: v.boolean(),
          followUps: v.number(),
          open: v.boolean(),
          connects: v.boolean(),
        }),
      }),
    ),
  },
  handler: async (ctx, { noteId, scholarId, ideas }): Promise<number> => {
    const note = await ctx.db.get(noteId);
    if (!note || note.state === "failed") return 0;
    const claimed = new Set(
      note.wonders.filter((w) => w.scholarId === scholarId).map((w) => String(w.seedId)),
    );
    const existing = (
      await ctx.db
        .query("wonderQuestIdeas")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).filter((i) => i.noteId === noteId);
    if (existing.length > 0) return 0;
    const perWonder = new Map<string, number>();
    let stored = 0;
    for (const idea of ideas) {
      if (stored >= MAX_IDEAS_PER_SCHOLAR || !claimed.has(String(idea.seedId))) continue;
      const position = perWonder.get(idea.seedId) ?? 0;
      perWonder.set(idea.seedId, position + 1);
      await ctx.db.insert("wonderQuestIdeas", {
        noteId,
        scholarId,
        institutionId: note.institutionId,
        ...idea,
        position,
        state: "waiting",
      });
      stored += 1;
    }
    for (const seedId of perWonder.keys()) {
      const id = ctx.db.normalizeId("seeds", seedId);
      if (!id) continue;
      await ctx.scheduler.runAfter(0, internal.dayWonders.syncWonderPost, {
        noteId,
        seedId: id,
        stamp: ideaStamp(await ideasOnWonder(ctx, noteId, id)),
      });
    }
    return stored;
  },
});

/** Remember the message a wonder was posted as in this run, so a sync (and a
 *  tap) is bound to this note's own message, never another run's. */
export const recordPostedTs = internalMutation({
  args: { noteId: v.id("dayWonderNotes"), seedId: v.id("seeds"), ts: v.string() },
  handler: async (ctx, { noteId, seedId, ts }): Promise<void> => {
    const note = await ctx.db.get(noteId);
    if (!note) return;
    const posted = (note.postedTs ?? []).filter((p) => p.seedId !== seedId);
    await ctx.db.patch(noteId, { postedTs: [...posted, { seedId, ts }] });
  },
});

/**
 * A wonder's post as it should read now, for `syncWonderPost`: where it is
 * (this note's own message, null until the delivery has recorded it), the
 * kid's name as the message labels them, the question and the opening of the
 * answer, and the ideas as they stand with their stamp. Re-authorized exactly
 * as a post is (`freshWonder`): null unless the run isn't failed, the class is
 * still bound to the run's channel and school alone, and the kid is still on
 * the roster, enrolled there and unflagged. Ideas are model-written, so they
 * never reach Slack on weaker footing than the question did.
 */
export const wonderPostView = internalQuery({
  args: { noteId: v.id("dayWonderNotes"), seedId: v.id("seeds") },
  handler: async (
    ctx,
    { noteId, seedId },
  ): Promise<{
    channelId: string;
    ts: string | null;
    label: string;
    wonder: NoteWonder;
    ideas: IdeaForMessage[];
    stamp: string;
  } | null> => {
    const note = await ctx.db.get(noteId);
    const claimed = note?.wonders.find((w) => w.seedId === seedId);
    if (!note || !claimed || note.state === "failed") return null;
    const group = await classInChannel(ctx, note.groupId, note.channelId, note.institutionId);
    if (!group) return null;
    const scholar = await scholarForNote(
      ctx,
      group,
      note.institutionId,
      claimed.scholarId,
      note.windowStartMs,
      note.cutoffMs,
      new Set([seedId]),
    );
    const wonder = scholar?.wonders[0];
    if (!scholar || !wonder) return null;
    const people: { scholarId: string; name: string }[] = [];
    for (const id of new Set(note.wonders.map((w) => w.scholarId))) {
      const other = await ctx.db.get(id);
      const name = other?.name?.trim();
      if (name) people.push({ scholarId: id, name });
    }
    const label = scholarLabels(people).get(claimed.scholarId) ?? scholar.name;
    const ts = note.postedTs?.find((p) => p.seedId === seedId)?.ts ?? null;
    const ideas = await ideasOnWonder(ctx, noteId, seedId);
    return {
      channelId: note.channelId,
      ts,
      label,
      wonder,
      ideas,
      stamp: ideaStamp(ideas),
    };
  },
});

const SYNC_RETRIES = 3;

/**
 * Bring a wonder's post to the state its ideas are in: the question, the
 * answer, a button for each idea still waiting, a line for each offered. One
 * post, rebuilt from stored state every time, never patched from what a tap
 * saw. Every change schedules a sync carrying the ideas' stamp: a sync whose
 * stamp is no longer current leaves the post to the newer one, and one that
 * finds the stamp moved on while it wrote schedules itself again, so
 * concurrent taps converge on the latest state whatever order their writes
 * land in. A post not yet recorded is left to the delivery, which asks for a
 * sync once it has. Nothing is written unless the post is still allowed
 * (`wonderPostView`) and its channel is not shared with another organization.
 * Slack's transient failures, and an unreadable sharing, are retried.
 */
export const syncWonderPost = internalAction({
  args: {
    noteId: v.id("dayWonderNotes"),
    seedId: v.id("seeds"),
    stamp: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const view = await ctx.runQuery(internal.dayWonders.wonderPostView, {
      noteId: args.noteId,
      seedId: args.seedId,
    });
    if (!view?.ts || view.stamp !== args.stamp) return;
    const attempt = args.attempt ?? 0;
    // Model-written words never reach another organization: look at the
    // channel's sharing right before writing, as the delivery does.
    const shape = await fetchConversationShape(token, view.channelId);
    if (!shape?.sharingKnown) {
      console.warn("[DayWonders] post sync: couldn't read the channel's sharing");
      if (attempt < SYNC_RETRIES) {
        await ctx.scheduler.runAfter(30_000 * (attempt + 1), internal.dayWonders.syncWonderPost, {
          ...args,
          attempt: attempt + 1,
        });
      }
      return;
    }
    if (shape.externallyShared) return;
    const res = await updateBlocks(token, {
      channel: view.channelId,
      ts: view.ts,
      ...wonderMessage(view.label, view.wonder, view.ideas),
    });
    if (!res.ok) {
      console.warn(`[DayWonders] post sync failed: ${res.error ?? "unknown"}`);
      if (attempt < SYNC_RETRIES) {
        await ctx.scheduler.runAfter((res.retryAfterMs ?? 30_000) * (attempt + 1), internal.dayWonders.syncWonderPost, {
          ...args,
          attempt: attempt + 1,
        });
      }
      return;
    }
    const after = await ctx.runQuery(internal.dayWonders.wonderPostView, {
      noteId: args.noteId,
      seedId: args.seedId,
    });
    if (after && after.stamp !== view.stamp) {
      await ctx.scheduler.runAfter(0, internal.dayWonders.syncWonderPost, {
        noteId: args.noteId,
        seedId: args.seedId,
        stamp: after.stamp,
      });
    }
  },
});

/**
 * The day's runs: for each class linked to a channel, the wonders asked since
 * its previous run (`noteWindow`). A class with none is skipped without a
 * write; the rest are claimed and delivered one action each, kids in name
 * order and each kid's wonders in the order asked.
 */
export const postForDay = internalAction({
  args: {},
  handler: async (ctx): Promise<{ claimed: number }> => {
    if (!process.env.SLACK_BOT_TOKEN) return { claimed: 0 };
    const groups = await ctx.runQuery(internal.eodCheckin.linkedGroups, {});
    const now = Date.now();
    let claimed = 0;
    for (const group of groups) {
      try {
        const window = await ctx.runQuery(internal.dayWonders.noteWindow, {
          groupId: group._id,
          nowMs: now,
        });
        if (!window) continue;
        const day = await ctx.runQuery(internal.dayWonders.collectGroupDay, {
          groupId: group._id,
          windowStartMs: window.windowStartMs,
          cutoffMs: now,
        });
        if (!day || day.scholars.length === 0) continue;
        const noteId = await ctx.runMutation(internal.dayWonders.claimNote, {
          groupId: group._id,
          dayKey: window.dayKey,
          channelId: day.channelId,
          institutionId: day.institutionId,
          windowStartMs: window.windowStartMs,
          cutoffMs: now,
          wonders: day.scholars.flatMap((scholar) =>
            scholar.wonders.map((wonder) => ({
              scholarId: scholar.scholarId,
              seedId: wonder.seedId,
            })),
          ),
        });
        if (noteId) claimed += 1;
      } catch (error: unknown) {
        console.error(
          `[DayWonders] class ${group._id} skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { claimed };
  },
});
