// Pushes — "this, to these scholars, right now."
//
// The single write surface behind every "Give" (an app, a file or a link now)
// affordance: the Run page, an app tile, a curriculum node, and the staff
// aide (in-app · Slack · MCP) all land here. See review/class-focus-rethink.html.
//
// Conventions are deliberately borrowed from roomCues.ts, the closest
// existing surface (a teacher broadcasting to a group or a whole school,
// with a soft clear rather than a delete): the same institution-lens
// `scope` string, the same "absent groupId = whole institution" reading,
// and the same clearedAt/clearedBy stamping.
//
// The pure rules — liveness, audience matching, plate ordering, blocking
// eligibility — live in lib/pushes.ts and are unit-tested there.

import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authedQuery, teacherMutation, teacherQuery } from "./lib/customFunctions";
import {
  institutionIdInLens,
  resolveInstitutionLens,
  scholarInstitutionReadableInLens,
} from "./lib/institutionLens";
import type { ResolvedInstitutionLens } from "./lib/institutionLens";
import { filterToAccessibleScholars } from "./lib/access";
import { isTeacherRole } from "./lib/roles";
import { resolveAppIconUrl } from "./lib/externalAppIconUrl";
import {
  assignmentIdsCovering,
  catalogAppIsVisible,
} from "./lib/deviceAppProjection";
import { groupIdsForScholar } from "./lib/scholarGroupMembership";
import { schedulePushProjectionRefresh } from "./lib/deviceAppUnlockScheduling";
import { pushTimeLeftLabel } from "../shared/pushCopy";
import { dayKeyForTimezone, shiftDayKey } from "../shared/institutionDay";
import { timeZoneForInstitution } from "./lib/institutionTime";
import { classFieldsForPush, endFieldsForPush, unitSubjectForWork } from "./lib/classLink";
import {
  GiveQuestionError,
  bellBlockAt,
  giveChoices,
  lastBellAt,
  resolveGiveWindow,
  upcomingBellBlocks,
  type BellBlock,
  type GiveChoices,
} from "./lib/giveWindow";
import { closureForInstitutionOnDay } from "./masterSchedule";
import {
  FOCUS_DURATION_CHOICES_MIN,
  assertPushAllowed,
  endlessAppPushReason,
  explicitFocusEnd,
  focusEndsAt,
  homeworkDueAt,
  isScheduleRow,
  isPushBlocking,
  pushOpenUntil,
  isPushShowing,
  livePushesForScholar,
  type PushDoc,
  type PushTarget,
  type ScholarAudienceContext,
} from "./lib/pushes";

export { FOCUS_DURATION_CHOICES_MIN };

// ───────────────────────────── validators ─────────────────────────────

const targetValidator = v.union(
  v.object({ kind: v.literal("activity"), activityId: v.id("activities") }),
  v.object({ kind: v.literal("app"), externalAppId: v.id("externalApps") }),
  v.object({ kind: v.literal("resource"), resourceId: v.id("activityResources") }),
  v.object({
    kind: v.literal("link"),
    url: v.string(),
    title: v.string(),
    media: v.optional(v.union(v.literal("video"), v.literal("page"))),
  }),
);

/**
 * When an app, a file or a link leaves scholars' screens: the give form's
 * fading choices (TRA-580). Every one fades; an app has nothing to be late on.
 *
 *   inClass   → the end of the class meeting now (or starting within the
 *               passing period), else the end of the school day.
 *   forAWhile → `minutes` from now, at most the longest quick pick. For a
 *               window no block lines up with (an after-school session, a
 *               whole-school game over the lunch bell).
 *   openUntil → the end of `dayKey`, a later day, at most two weeks out.
 */
export const pushFinishValidator = v.union(
  v.object({ kind: v.literal("inClass") }),
  v.object({ kind: v.literal("forAWhile"), minutes: v.number() }),
  v.object({ kind: v.literal("openUntil"), dayKey: v.string() }),
);
export type PushFinish = Infer<typeof pushFinishValidator>;

// ───────────────────────────── helpers ─────────────────────────────

/**
 * The scholar-side facts a push audience resolves against. Group membership
 * comes from `lib/scholarGroupMembership.ts` and assignment rosters from
 * `lib/deviceAppProjection.ts`: the managed-app allowlist projector and the
 * launch gates resolve a live push audience the same way, so no caller
 * re-derives either rule.
 */
async function audienceContextFor(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  candidates: ReadonlyArray<Doc<"pushes">>,
): Promise<ScholarAudienceContext> {
  return {
    scholarId: scholar._id,
    institutionId: scholar.institutionId,
    groupIds: await groupIdsForScholar(ctx, scholar),
    assignmentIds: await assignmentIdsCovering(ctx, scholar, candidates),
  };
}

/**
 * Every push for an institution that is still open. Cheap: the index is
 * on (institutionId, clearedAt) and an open row has clearedAt undefined,
 * so this reads only the currently-open set — not the event history.
 */
async function openPushesForInstitution(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
): Promise<PushDoc[]> {
  const open = await ctx.db
    .query("pushes")
    .withIndex("by_institution_cleared", (q) =>
      q.eq("institutionId", institutionId).eq("clearedAt", undefined),
    )
    .collect();
  // An assignment's schedule rows are read through `readSchedule`
  // (lib/scheduleStore), which the plate and the Now tab already render.
  // Serving them here too would show the same class focus a second time,
  // under a second heading (Linear TRA-13).
  return open.filter((p) => !isScheduleRow(p));
}

/**
 * The institution an activity belongs to, through its unit.
 *
 * An unstamped unit reports `undefined`, NOT its author's current school:
 * a legacy unstamped unit belongs to the primary institution, which is
 * exactly what `institutionIdInLens` does with `undefined`, and is the
 * rule `requireUnitAccessForUser` (convex/lib/unitAccess.ts) already
 * enforces. Reading the author's institution instead would hand a legacy
 * primary-school unit to whichever school its creator has since moved to.
 *
 * A broken unit chain reports `resolved: false` — unresolvable is not the
 * same as unstamped, and must not silently read as "yours".
 */
type TargetOwner =
  | { resolved: true; institutionId: Id<"institutions"> | undefined }
  | { resolved: false };

async function activityOwner(
  ctx: QueryCtx,
  activity: Doc<"activities">,
): Promise<TargetOwner> {
  const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
  const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
  if (!unit) return { resolved: false };
  return { resolved: true, institutionId: unit.institutionId };
}

function ownerInLens(lens: ResolvedInstitutionLens, owner: TargetOwner): boolean {
  return owner.resolved && institutionIdInLens(lens, owner.institutionId);
}

/**
 * Whether a curriculum target still belongs to the school the push was
 * written for. Creation-time validation cannot cover a lesson that is
 * later moved into another school's unit, and reads hand back a title and
 * a signed storage URL, so the read path re-checks rather than trusting
 * a promise made at write time.
 */
async function targetStillOwnedBy(
  ctx: QueryCtx,
  activity: Doc<"activities"> | null,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  if (!activity) return false;
  const owner = await activityOwner(ctx, activity);
  if (!owner.resolved) return false;
  if (owner.institutionId === undefined) {
    const institution = await ctx.db.get(institutionId);
    return !!institution?.isPrimary;
  }
  return owner.institutionId === institutionId;
}

/**
 * Confirm the target exists and belongs to this institution before we
 * promise a room it is about to appear on their screens. A dangling
 * target would render as an empty card with no way to diagnose it.
 *
 * Curriculum is private per institution (`units.institutionId`), so an
 * activity or a resource carries a tenant and must be checked against the
 * lens — `hydratePush` hands scholars a resource's title and a signed
 * storage URL, so a missed check here is a cross-school file read. The app
 * catalog is deployment-global by design and has no tenant to check; a
 * link is a URL the teacher typed and owns nothing.
 */
async function validateTarget(
  ctx: QueryCtx,
  target: PushTarget,
  lens: ResolvedInstitutionLens,
): Promise<void> {
  switch (target.kind) {
    case "activity": {
      const activity = await ctx.db.get(target.activityId);
      if (!activity) throw new Error("That activity no longer exists.");
      if (!ownerInLens(lens, await activityOwner(ctx, activity))) {
        throw new Error("Forbidden: that activity belongs to another school.");
      }
      return;
    }
    case "app": {
      const app = await ctx.db.get(target.externalAppId);
      if (!app) throw new Error("That app is not in the catalog.");
      if (app.archived) {
        throw new Error(`"${app.name}" is archived — unarchive it first.`);
      }
      return;
    }
    case "resource": {
      const resource = await ctx.db.get(target.resourceId);
      if (!resource) throw new Error("That resource no longer exists.");
      const activity = await ctx.db.get(resource.activityId);
      if (
        !activity ||
        !ownerInLens(lens, await activityOwner(ctx, activity))
      ) {
        throw new Error("Forbidden: that resource belongs to another school.");
      }
      return;
    }
    case "link": {
      const url = target.url.trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("A link push needs a full http(s) URL.");
      }
      if (!target.title.trim()) {
        throw new Error("Give the link a title so scholars know what it is.");
      }
      return;
    }
  }
}

// ───────────────────────────── write ─────────────────────────────

/** A class starting this soon counts as "in that class" (the passing period). */
const PASSING_PERIOD_MS = 10 * 60_000;
/** The longest an app or a link stays open; longer access is a grant
 *  (enable_app_for_group), not a give. */
const MAX_OPEN_UNTIL_DAYS = 14;
/** "For a while" tops out at the longest quick pick; past that, the give is
 *  "in that class" or "open until". */
const MAX_FOR_A_WHILE_MIN = Math.max(...FOCUS_DURATION_CHOICES_MIN);

/**
 * The class meeting "in that class" means for a push that shows up now: the
 * roster's block under way, or one starting within the passing period. None
 * on a closed day, for a roster with no shared bell schedule, or for the
 * whole school (which shares no one block).
 */
async function pushClassBlock(
  ctx: QueryCtx,
  args: {
    rosterIds: readonly Id<"users">[];
    institutionId: Id<"institutions">;
    timeZone: string;
    now: number;
  },
): Promise<BellBlock | null> {
  const { rosterIds, institutionId, timeZone, now } = args;
  if (rosterIds.length === 0) return null;
  if (await closureForInstitutionOnDay(ctx, institutionId, now)) return null;
  const current = await bellBlockAt(ctx, rosterIds, now, timeZone);
  if (current) return current;
  const todayKey = dayKeyForTimezone(now, timeZone);
  return (
    (
      await upcomingBellBlocks(ctx, {
        scholarIds: rosterIds,
        institutionId,
        timeZone,
        nowMs: now,
        days: 0,
      })
    ).find(
      (b) => b.dayKey === todayKey && b.startsAt - now <= PASSING_PERIOD_MS,
    ) ?? null
  );
}

/** A push's end; `block` is the meeting that sets it, `lastBell` that it
 *  ends at the school day's last bell (no class meeting now). */
type PushEnd = { endsAt: number; block: BellBlock | null; lastBell: boolean };

/**
 * When a push that shows up now ends, from the teacher's finish answer.
 * Throws `GiveQuestionError` (worded for the teacher) for an answer that
 * can't be used. The one place a push's end is worked out, so the dialog's
 * hint, the dialog's write and the aide's write agree.
 */
async function pushEnd(
  ctx: QueryCtx,
  args: {
    rosterIds: readonly Id<"users">[];
    institutionId: Id<"institutions">;
    timeZone: string;
    now: number;
    finish: PushFinish;
  },
): Promise<PushEnd> {
  const { finish, timeZone, now } = args;
  switch (finish.kind) {
    case "inClass": {
      const block = await pushClassBlock(ctx, args);
      if (block) {
        // From the block's start, so resolveGiveWindow reads the same meeting.
        const window = await resolveGiveWindow(ctx, {
          scholarIds: args.rosterIds,
          timeZone,
          startsAt: block.startsAt,
          finish,
        });
        return { endsAt: window.endsAt!, block, lastBell: false };
      }
      // No class meeting now: the school day's last bell, never midnight
      // (an app stays unlocked on BunnyPads until it ends). With no bell
      // left today, "in that class" has no end, so it's refused.
      const closed = await closureForInstitutionOnDay(ctx, args.institutionId, now);
      const lastBell = closed
        ? null
        : await lastBellAt(ctx, {
            rosterIds: args.rosterIds,
            institutionId: args.institutionId,
            dayKey: dayKeyForTimezone(now, timeZone),
            timeZone,
          });
      if (lastBell == null) {
        throw new GiveQuestionError(
          `There are no classes today${args.rosterIds.length === 0 ? " on the school's bell schedule" : " for them"}, so "in that class" has no end. Give it for a while, or open until a later day.`,
        );
      }
      if (lastBell <= now) {
        throw new GiveQuestionError(
          `The last bell has rung, so "in that class" has no end. Give it for a while, or open until a later day.`,
        );
      }
      return { endsAt: lastBell, block: null, lastBell: true };
    }
    case "forAWhile": {
      const minutes = finish.minutes;
      if (!Number.isInteger(minutes) || minutes < 1) {
        throw new GiveQuestionError(
          `"For a while" needs a whole number of minutes, at least 1. How many minutes?`,
        );
      }
      if (minutes > MAX_FOR_A_WHILE_MIN) {
        throw new GiveQuestionError(
          `"For a while" is up to ${MAX_FOR_A_WHILE_MIN} minutes; for longer, give it for the class or open until a later day.`,
        );
      }
      return { endsAt: focusEndsAt(now, minutes), block: null, lastBell: false };
    }
    case "openUntil": {
      const dayKey = finish.dayKey.trim();
      const todayKey = dayKeyForTimezone(now, timeZone);
      if (dayKey > shiftDayKey(todayKey, MAX_OPEN_UNTIL_DAYS)) {
        throw new GiveQuestionError(
          `An app, a file or a link can stay open for at most ${MAX_OPEN_UNTIL_DAYS} days; for longer access, grant the app to the group.`,
        );
      }
      const window = await resolveGiveWindow(ctx, {
        scholarIds: args.rosterIds,
        timeZone,
        startsAt: now,
        finish: { kind: "openUntil", dayKey },
      });
      return { endsAt: window.endsAt!, block: null, lastBell: false };
    }
  }
}

/**
 * Put an app, a file or a link in front of scholars, right now.
 *
 * This is the mutation that makes an ad-hoc push possible at all: an app /
 * video / link can be featured for a group for twenty minutes without
 * inventing a unit, an assignment and a throwaway activity to hold it.
 *
 * `groupId` absent = the whole institution, matching callRoomCue.
 * `finish` is the give form's fading choice (TRA-580).
 *
 * `durationMin` (the retired minutes picker) is read as "for a while" and
 * `assignmentId` is ignored (TRA-575: an ad hoc push is never filed under an
 * assignment). Both are compatibility for long-lived tabs; remove after
 * 2026-12-01. With neither `finish` nor `durationMin`, an hour.
 */
export const makeFocus = teacherMutation({
  args: {
    scope: v.optional(v.string()),
    groupId: v.optional(v.id("scholarGroups")),
    scholarIds: v.optional(v.array(v.id("users"))),
    target: targetValidator,
    finish: v.optional(pushFinishValidator),
    durationMin: v.optional(v.number()),
    note: v.optional(v.string()),
    blocking: v.optional(v.boolean()),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (
    ctx,
    { assignmentId: _ignored, durationMin, finish, ...args },
  ) => {
    const result = await createFocus(ctx, ctx.user, {
      ...args,
      finish: finish ?? {
        kind: "forAWhile",
        minutes: Math.min(
          MAX_FOR_A_WHILE_MIN,
          Math.max(1, Math.round(durationMin ?? 60)),
        ),
      },
    });
    return result.pushId;
  },
});

/**
 * The give form's choices for a push to `groupId` (absent = the whole
 * school): the school's clock, when "in that class" would end, and the days
 * "open until" offers. Shaped like `assignments.giveChoices` so the same form
 * renders it; "in that class" is the push rule (`pushEnd`), with the passing
 * period, so the hint and the write agree.
 */
export const focusGiveChoices = teacherQuery({
  args: {
    scope: v.optional(v.string()),
    groupId: v.optional(v.id("scholarGroups")),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution;
    if (!institution) {
      return { refused: "Pick a specific school to give it at." };
    }
    let rosterIds: Id<"users">[] = [];
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      if (
        !group ||
        !scholarInstitutionReadableInLens(lens, group.institutionId)
      ) {
        return { refused: "That group belongs to another school." };
      }
      rosterIds = group.scholarIds;
    }
    const timeZone = await timeZoneForInstitution(ctx, institution._id);
    const choices = await giveChoices(ctx, {
      scholarIds: rosterIds,
      institutionId: institution._id,
      timeZone,
      nowMs: args.nowMs,
    });
    let inClass: GiveChoices["inClass"];
    try {
      const end = await pushEnd(ctx, {
        rosterIds,
        institutionId: institution._id,
        timeZone,
        now: args.nowMs,
        finish: { kind: "inClass" },
      });
      inClass = {
        endsAt: end.endsAt,
        blockLabel: end.block?.subject ?? null,
        lastBell: end.lastBell,
      };
    } catch (error) {
      if (!(error instanceof GiveQuestionError)) throw error;
      // The form offers the option disabled, with the reason as its hint.
      inClass = { ...choices.inClass, unavailable: error.message };
    }
    return { ...choices, inClass };
  },
});

/**
 * The one code path every "make focus" surface runs through — the web
 * dialog, the staff aide, and anything added later. Kept as ONE function
 * so an authorization or audience rule can never be enforced on one
 * surface and quietly skipped on another.
 */
async function createFocus(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    scope?: string;
    groupId?: Id<"scholarGroups">;
    scholarIds?: Id<"users">[];
    target: PushTarget;
    finish: PushFinish;
    note?: string;
    blocking?: boolean;
  },
): Promise<{
  pushId: Id<"pushes">;
  endsAt: number;
  minutes: number;
  audienceLabel: string;
  block: BellBlock | null;
  lastBell: boolean;
  timeZone: string;
}> {
  const lens = await resolveInstitutionLens(ctx, user, args.scope);
  const institution = lens.institution;
  if (!institution) {
    throw new Error("Pick a specific school to set a focus for.");
  }

  await validateTarget(ctx, args.target, lens);

  const blocking = args.blocking ?? false;

  // ── audience ──
  // Narrowest wins, so an explicit scholar list beats a group, which
  // beats the whole school. `rosterIds` is whose bell schedule "in that
  // class" reads; the whole school shares no one block.
  let audience: PushDoc["audience"];
  let audienceLabel: string;
  let rosterIds: Id<"users">[] = [];
  if (args.scholarIds && args.scholarIds.length > 0) {
    const accessible = await filterToAccessibleScholars(
      ctx,
      user,
      args.scholarIds,
    );
    if (accessible.length !== args.scholarIds.length) {
      throw new Error("Forbidden: some scholars are not in your context.");
    }
    audience = { kind: "scholars", scholarIds: accessible };
    audienceLabel = `${accessible.length} scholar${accessible.length === 1 ? "" : "s"}`;
    rosterIds = accessible;
  } else if (args.groupId) {
    const group = await ctx.db.get(args.groupId);
    if (!group) throw new Error("That group no longer exists.");
    // The lens helper, not a bare id compare: an unstamped legacy group
    // rides the PRIMARY school's lens, so `!group.institutionId` would hand
    // every other school the primary school's groups. Scholar-read standing,
    // not curriculum-only lens standing, is what a group push needs (TRA-386).
    if (!scholarInstitutionReadableInLens(lens, group.institutionId)) {
      throw new Error("Forbidden: that group belongs to another school.");
    }
    audience = { kind: "group", groupId: args.groupId };
    audienceLabel = group.name;
    rosterIds = group.scholarIds;
  } else {
    audience = { kind: "institution" };
    audienceLabel = "All scholars";
  }

  const now = Date.now();
  const timeZone = await timeZoneForInstitution(ctx, institution._id);
  let end: PushEnd;
  try {
    end = await pushEnd(ctx, {
      rosterIds,
      institutionId: institution._id,
      timeZone,
      now,
      finish: args.finish,
    });
  } catch (error) {
    // A plain Error, so the dialog's toast and the aide's reply carry the
    // question as written.
    if (error instanceof GiveQuestionError) throw new Error(error.message);
    throw error;
  }
  const endsAt = end.endsAt;
  if (endsAt <= now) {
    throw new Error("That window has already ended.");
  }
  // The teacher's finish, stored as the kind (TRA-726): "open until" a later
  // day is `openUntil`; "in that class" and "for a while" are `focus`.
  const timingKind = args.finish.kind === "openUntil" ? "openUntil" as const : "focus" as const;
  // Refuse rather than silently downgrade: a teacher who asked for a lock and
  // got a suggestion would never know. Also refuses an app give without a
  // finite end (TRA-336).
  assertPushAllowed({ target: args.target, timing: { kind: timingKind }, blocking, endsAt });

  const pushId = await ctx.db.insert("pushes", {
    institutionId: institution._id,
    target: args.target,
    audience,
    // The kind alone; the end lives in `endsAt` + `afterEnd` (TRA-580).
    timing: { kind: timingKind },
    ...endFieldsForPush(timingKind, endsAt, now, undefined, timeZone),
    // Linked to the class whose meeting sets the end: in the passing period
    // that is the class about to start, not the one ending or none.
    ...await classFieldsForPush(ctx, {
      institutionId: institution._id,
      audience,
      at: end.block ? Math.max(now, end.block.startsAt) : now,
      timeZone,
      timingKind,
      unitSubject: args.target.kind === "activity"
        ? await unitSubjectForWork(ctx, { activityId: args.target.activityId }) : undefined,
    }),
    blocking,
    note: args.note?.trim() || undefined,
    setAt: now,
    pushedBy: user._id,
  });

  // Latency optimization only — `isPushBlocking` independently refuses to
  // wall a scholar in past the window at read time, so a delayed or dropped
  // job can never trap anyone. What the job buys is tidiness: it retires the
  // card promptly instead of leaving it showing for the rest of the day.
  const scheduledFnId = await ctx.scheduler.runAt(
    endsAt,
    internal.pushes.autoClearPush,
    { pushId },
  );
  await ctx.db.patch(pushId, { scheduledFnId });

  // A live push targeting a managed native app is the "or-pushed" half of the
  // allowlist projection's predicate, so opening one is an allowlist edge:
  // nudge every covered scholar's managed iPad to re-project now instead of
  // waiting out the cron. Latency only — the reconciler re-derives the set
  // from scratch either way.
  await schedulePushProjectionRefresh(ctx, pushId);

  return {
    pushId,
    endsAt,
    minutes: Math.round((endsAt - now) / 60_000),
    audienceLabel,
    block: end.block,
    lastBell: end.lastBell,
    timeZone,
  };
}


/** Wrap it up early. No-op if already cleared. */
export const clearPush = teacherMutation({
  args: { pushId: v.id("pushes") },
  handler: async (ctx, { pushId }) => {
    const push = await ctx.db.get(pushId);
    if (!push) throw new Error("That push no longer exists.");
    // A schedule row belongs to its assignment's schedule (TRA-13) and is
    // closed through it, so the schedule's own rules (one row per activity
    // and mode, cancelling its jobs) hold.
    if (isScheduleRow(push)) {
      throw new Error(
        "That's part of an assignment's schedule; clear it from the assignment.",
      );
    }
    if (push.clearedAt !== undefined) return;

    const lens = await resolveInstitutionLens(ctx, ctx.user, undefined);
    const canReach =
      lens.institution?._id === push.institutionId ||
      lens.allowedInstitutionIds.has(push.institutionId);
    if (!canReach) {
      throw new Error("Forbidden: that push belongs to another school.");
    }

    if (push.scheduledFnId) {
      await ctx.scheduler.cancel(push.scheduledFnId);
    }
    // Stamped, never deleted — the row is the record that this happened.
    await ctx.db.patch(pushId, {
      clearedAt: Date.now(),
      clearedReason: "teacher",
      scheduledFnId: undefined,
    });
    // The closing edge of the same allowlist window (see createFocus).
    await schedulePushProjectionRefresh(ctx, pushId);
  },
});

/**
 * The scheduled close. Re-checks the window rather than trusting that it
 * fired on time: a job that runs early (or against a push whose window
 * was extended) must not close it.
 */
export const autoClearPush = internalMutation({
  args: { pushId: v.id("pushes") },
  handler: async (ctx, { pushId }) => {
    const push = await ctx.db.get(pushId);
    if (!push) return;
    if (push.clearedAt !== undefined) return;
    // Only an explicit focus window closes on a clock: an untimed focus's
    // stored end-of-day is not a window (see `explicitFocusEnd`).
    const endsAt = explicitFocusEnd(push);
    if (endsAt === null) return;
    if (endsAt > Date.now()) return;
    await ctx.db.patch(pushId, {
      clearedAt: Date.now(),
      clearedReason: "expired",
      scheduledFnId: undefined,
    });
    // Stamping `clearedAt` is what retracts the app from every covered
    // scholar's allowlist: the projector counts a push by `isPushShowing`
    // (card visible ⇒ bundle allowlisted), which an overrun-but-unwrapped
    // focus still satisfies. This refresh makes the retraction prompt.
    await schedulePushProjectionRefresh(ctx, pushId);
  },
});

// ───────────────────────────── read ─────────────────────────────

/**
 * What is live for me right now, newest focus first.
 *
 * Hydrated here rather than on the client so web and native render the
 * same card from the same fields — scholar-facing parity is not optional.
 */
export const livePushesForMe = authedQuery({
  args: {
    // Minute-rounded client clock used only to re-arm the reactive query across
    // institution-local midnight. The server still derives the effective day.
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    void args.now;
    const scholar = ctx.user;
    if (!scholar.institutionId) return [];

    const nowMs = Date.now();
    const timeZone = await timeZoneForInstitution(ctx, scholar.institutionId);
    const clock = {
      nowMs,
      todayDayKey: dayKeyForTimezone(nowMs, timeZone),
      timeZone,
    };
    const open = await openPushesForInstitution(ctx, scholar.institutionId);
    const context = await audienceContextFor(ctx, scholar, open);
    const live = livePushesForScholar(open, context, clock);
    const visible = await withoutArchivedAppPushes(ctx, live);

    return await Promise.all(visible.map((push) => hydratePush(ctx, push, clock)));
  },
});

/**
 * Drop a push targeting an app that has since been archived from the
 * catalog — the exact exclusion `livePushedAppIdsForScholar`
 * (`lib/deviceAppProjection.ts`) already applies to the launcher tile and
 * the launch gate, reused here (`catalogAppIsVisible`) so this scholar-
 * facing "Right now" read can't disagree with what the scholar is actually
 * authorized to open. This filters the READ, not the row: unarchiving the
 * app makes the push reappear with no write to `pushes` needed.
 *
 * Scoped to scholar-facing live reads only (`livePushesForMe`) — the
 * teacher's own view (`livePushesForScope`) and the staff aide
 * (`liveFocusForAide`) deliberately keep showing an archived-app push, so
 * staff can still see and clear/wrap it.
 */
async function withoutArchivedAppPushes(
  ctx: QueryCtx,
  pushes: ReadonlyArray<PushDoc>,
): Promise<PushDoc[]> {
  const visible: PushDoc[] = [];
  for (const push of pushes) {
    if (push.target.kind === "app") {
      const app = await ctx.db.get(push.target.externalAppId);
      if (!catalogAppIsVisible(app)) continue;
    }
    visible.push(push);
  }
  return visible;
}

/** Everything currently live for a school — the teacher's own view. */
export const livePushesForScope = teacherQuery({
  args: {
    scope: v.optional(v.string()),
    // Same cache-buster contract as livePushesForMe; never a time authority.
    now: v.optional(v.number()),
  },
  handler: async (ctx, { scope, now: clientNow }) => {
    void clientNow;
    const lens = await resolveInstitutionLens(ctx, ctx.user, scope);
    if (!lens.institution) return [];
    const nowMs = Date.now();
    const timeZone = await timeZoneForInstitution(ctx, lens.institution._id);
    const clock = {
      nowMs,
      todayDayKey: dayKeyForTimezone(nowMs, timeZone),
      timeZone,
    };
    const open = await openPushesForInstitution(ctx, lens.institution._id);
    const live = open.filter((push) => isPushShowing(push, clock));
    return await Promise.all(live.map((push) => hydratePush(ctx, push, clock)));
  },
});

export type HydratedPush = {
  _id: Id<"pushes">;
  kind: PushTarget["kind"];
  title: string;
  subtitle?: string;
  url?: string;
  iconUrl?: string;
  // The tile's emoji rung. Carried alongside `iconUrl` because a focus card
  // and the launcher tile for the SAME app are on screen together, and
  // shared/appTileMark.ts resolves both from the same fields.
  iconEmoji?: string;
  color?: string;
  media?: "video" | "page";
  activityId?: Id<"activities">;
  externalAppId?: Id<"externalApps">;
  // App-launch fields, carried so a focus card opens an app through the
  // exact same path the launcher tile does — not a second mechanism.
  webAllowedHosts?: string[];
  nativeUrlScheme?: string;
  nativeBundleId?: string;
  note?: string;
  blocking: boolean;
  endsAt: number | null;
  /** Set for an "Open until a date" give: when its window closes. The
   *  scholar's Now tab draws it under "Open from class" (lib/pushes.ts
   *  `pushOpenUntil`). */
  openUntil: number | null;
  dueAt: number | null;
  setAt?: number;
};

async function hydratePush(
  ctx: QueryCtx,
  push: PushDoc,
  clock: Parameters<typeof isPushBlocking>[1],
): Promise<HydratedPush> {
  const base = {
    _id: push._id,
    kind: push.target.kind,
    note: push.note,
    // The EFFECTIVE wall, not the stored flag. A focus that has run past its
    // window is still shown and still called class focus, but it no longer
    // holds anyone inside it — see `isPushBlocking`. Deriving it here means
    // every consumer, on either surface, gets the same answer without having
    // to remember the rule.
    blocking: isPushBlocking(push, clock),
    endsAt: explicitFocusEnd(push),
    openUntil: pushOpenUntil(push, clock.timeZone),
    dueAt: homeworkDueAt(push),
    setAt: push.setAt,
  };

  switch (push.target.kind) {
    case "activity": {
      const found = await ctx.db.get(push.target.activityId);
      const activity = (await targetStillOwnedBy(ctx, found, push.institutionId))
        ? found
        : null;
      return {
        ...base,
        title: activity?.title ?? "Activity",
        // Withheld when the target is gone or has moved to another school:
        // the card must not stay launchable, since `sessions.create`
        // derives its unit and lesson from this id.
        activityId: activity ? push.target.activityId : undefined,
      };
    }
    case "app": {
      const app = await ctx.db.get(push.target.externalAppId);
      return {
        ...base,
        title: app?.name ?? "App",
        url: app?.webUrl,
        // Resolved through the same helper the launcher and the catalog read
        // with, so an app whose logo was UPLOADED draws that logo here too.
        // Reading the raw `iconUrl` field made a focus card and the launcher
        // tile for the SAME app disagree on the same screen.
        iconUrl: (app ? await resolveAppIconUrl(ctx, app) : null) ?? undefined,
        iconEmoji: app?.iconEmoji,
        color: app?.color,
        webAllowedHosts: app?.webAllowedHosts,
        nativeUrlScheme: app?.nativeUrlScheme,
        nativeBundleId: app?.nativeBundleId,
        externalAppId: push.target.externalAppId,
      };
    }
    case "resource": {
      const found = await ctx.db.get(push.target.resourceId);
      const owningActivity = found ? await ctx.db.get(found.activityId) : null;
      const resource = (await targetStillOwnedBy(
        ctx,
        owningActivity,
        push.institutionId,
      ))
        ? found
        : null;
      const source = resource?.source;
      // Resolve a URL wherever the source has one, so the card is clickable.
      // A Rabbit Slides deck genuinely has no URL — it renders as a card the
      // scholar reads rather than opens, which is correct, not a gap.
      const url =
        source === undefined
          ? undefined
          : source.kind === "file"
            ? ((await ctx.storage.getUrl(source.fileStorageId)) ?? undefined)
            : source.kind === "rabbit_slides"
              ? undefined
              : source.url;
      return {
        ...base,
        title: resource?.title ?? "Resource",
        subtitle: source?.kind,
        url,
        media: source?.kind === "video" ? ("video" as const) : undefined,
      };
    }
    case "link": {
      return {
        ...base,
        title: push.target.title,
        url: push.target.url,
        media: push.target.media,
      };
    }
  }
}

// ─────────────────── Staff aide (agent-facing) ───────────────────
//
// Backs the aide's `give` for an app or a link, `get_schedule`'s live app
// and link rows, and `clear_activity` by pushId (lib/assignmentTools.ts),
// which every aide transport (in-app · Slack · MCP) assembles from
// assembleCurriculumTools. These internal functions repeat the role and
// institution checks — prompt confirmation is never treated as the
// authorization boundary.

/**
 * The aide's `give` for an app or a link (lib/assignmentTools.ts, case 4).
 * It shows up now, and the teacher's finish answer sets when it leaves, the
 * same fading choices as the web dialog (`pushEnd`). Written through
 * `createFocus`, so every check the web dialog gets applies here too.
 */
export const giveFocusFromAide = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.optional(v.string()),
    url: v.optional(v.string()),
    title: v.optional(v.string()),
    media: v.optional(v.union(v.literal("video"), v.literal("page"))),
    groupId: v.optional(v.id("scholarGroups")),
    scholarIds: v.optional(v.array(v.id("users"))),
    finish: pushFinishValidator,
    note: v.optional(v.string()),
    // The aide's institution lens (the school picked in the app).
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false as const, message: "Forbidden: teacher role required" };
    }
    const lens = await resolveInstitutionLens(ctx, caller, args.scope);
    if (!lens.institution) {
      return {
        ok: false as const,
        message: "Pick a specific school to give it at. Nothing given.",
      };
    }
    const school = lens.institution;

    let target: PushTarget;
    let title: string;
    const appName = args.appName?.trim();
    if (appName && args.url) {
      return {
        ok: false as const,
        message: "Give either an app or a url, not both. Nothing given.",
      };
    }
    if (appName) {
      // The app catalog is deployment-global (see validateTarget); archived
      // apps aren't offered.
      const apps = (await ctx.db.query("externalApps").collect()).filter(
        (app) => !app.archived,
      );
      const wanted = appName.toLowerCase();
      const exact = apps.filter(
        (app) => app.name.trim().toLowerCase() === wanted,
      );
      if (exact.length > 1) {
        return {
          ok: false as const,
          message: `More than one app in the catalog is named "${appName}" (${exact
            .map((app) => app.webUrl ?? app.name)
            .join(", ")}). Rename or archive the duplicate, then try again. Nothing given.`,
        };
      }
      if (exact.length === 0) {
        const candidates = apps
          .filter((app) => app.name.toLowerCase().includes(wanted))
          .map((app) => app.name)
          .sort();
        return {
          ok: false as const,
          message:
            candidates.length > 0
              ? `No app is named exactly "${appName}". Candidates: ${candidates.join(", ")}. Use the exact name. Nothing given.`
              : `No app named "${appName}" in the catalog. Call list_external_apps to see it. Nothing given.`,
        };
      }
      target = { kind: "app", externalAppId: exact[0]._id };
      title = exact[0].name;
    } else if (args.url) {
      const url = args.url.trim();
      title = args.title?.trim() || url;
      target = { kind: "link", url, title, media: args.media };
    } else {
      return {
        ok: false as const,
        message: "Give an appName or a url. Nothing given.",
      };
    }

    try {
      const result = await createFocus(ctx, caller, {
        scope: args.scope,
        target,
        groupId: args.groupId,
        scholarIds: args.scholarIds,
        finish: args.finish,
        note: args.note,
      });
      return {
        ok: true as const,
        pushId: result.pushId,
        title,
        audienceLabel: result.audienceLabel,
        schoolName: school.name,
        endsAt: result.endsAt,
        timeZone: result.timeZone,
        blockLabel: result.block?.subject ?? null,
        lastBell: result.lastBell,
      };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/** The ad hoc pushes on scholars' screens right now (get_schedule's live app
 *  and link rows), so the agent can report or end one. */
export const liveFocusForAide = internalQuery({
  args: { callerUserId: v.id("users"), scope: v.optional(v.string()) },
  handler: async (ctx, { callerUserId, scope }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false as const, message: "Forbidden: teacher role required" };
    }
    const lens = await resolveInstitutionLens(ctx, caller, scope);
    if (!lens.institution) return { ok: true as const, pushes: [] };

    const now = Date.now();
    const timeZone = await timeZoneForInstitution(ctx, lens.institution._id);
    const clock = {
      nowMs: now,
      todayDayKey: dayKeyForTimezone(now, timeZone),
      timeZone,
    };
    const open = await openPushesForInstitution(ctx, lens.institution._id);
    const live = open.filter((push) => isPushShowing(push, clock));
    const rows = await Promise.all(
      live.map(async (push) => {
        const hydrated = await hydratePush(ctx, push, clock);
        const pusher = await ctx.db.get(push.pushedBy);
        const group =
          push.audience.kind === "group"
            ? await ctx.db.get(push.audience.groupId)
            : null;
        return {
          pushId: push._id,
          title: hydrated.title,
          kind: hydrated.kind,
          audience: group?.name ?? (push.audience.kind === "institution"
            ? "All scholars"
            : `${push.audience.kind === "scholars" ? push.audience.scholarIds.length : 0} scholars`),
          timeLeft: pushTimeLeftLabel(hydrated.endsAt, now),
          note: hydrated.note ?? null,
          pushedBy: pusher?.name ?? "Someone",
          setAt: push.setAt ?? null,
          endsAt: hydrated.endsAt,
        };
      }),
    );
    return { ok: true as const, pushes: rows };
  },
});

/** End a live app or link early (clear_activity with a pushId). */
export const clearFocusFromAide = internalMutation({
  args: {
    callerUserId: v.id("users"),
    // A string, not v.id: the model passes it, and a malformed or
    // wrong-table id must get an answer rather than a validator throw.
    pushId: v.string(),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, { callerUserId, pushId: rawPushId, scope }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false as const, message: "Forbidden: teacher role required" };
    }
    const pushId = ctx.db.normalizeId("pushes", rawPushId.trim());
    const push = pushId ? await ctx.db.get(pushId) : null;
    if (!pushId || !push) {
      return {
        ok: false as const,
        message: "No live app or link has that pushId. Call get_schedule for the current ones.",
      };
    }
    // A schedule row belongs to its assignment, with that assignment's
    // ownership checks: same refusal as the web `clearPush`.
    if (isScheduleRow(push)) {
      return {
        ok: false as const,
        message:
          "That's part of an assignment's schedule. Clear it from the assignment (clear_activity).",
      };
    }
    const lens = await resolveInstitutionLens(ctx, caller, scope);
    // With a school picked, only that school's pushes; otherwise any school
    // the caller works at.
    const reachable =
      scope?.trim() && lens.institution
        ? lens.institution._id === push.institutionId
        : lens.institution?._id === push.institutionId ||
          lens.allowedInstitutionIds.has(push.institutionId);
    if (!reachable) {
      return {
        ok: false as const,
        message: "Forbidden: that push belongs to another school.",
      };
    }
    if (push.clearedAt !== undefined) {
      return { ok: true as const, message: "That focus had already ended." };
    }
    if (push.scheduledFnId) await ctx.scheduler.cancel(push.scheduledFnId);
    await ctx.db.patch(pushId, {
      clearedAt: Date.now(),
      clearedReason: "teacher",
      scheduledFnId: undefined,
    });
    // Same allowlist edge as the web `clearPush` — the aide surface must not
    // be the one that silently skips it.
    await schedulePushProjectionRefresh(ctx, pushId);
    return { ok: true as const, message: "Wrapped up." };
  },
});

/**
 * Inventory: app pushes that break the app-give invariant (TRA-336), i.e. an
 * app target whose timing is not a focus with a finite, fading end.
 *
 * Read-only, internal, one page per call: `pushes` holds every schedule-mirror
 * row, so a single full scan could outgrow a query's read limit. Run it from
 * the CLI until `isDone`, passing back `continueCursor`:
 *
 *   npx convex run pushes:inventoryEndlessAppPushes \
 *     '{"paginationOpts":{"numItems":2000,"cursor":null}}'
 *
 * Returns ids and shape only: no names, notes or audience members. `open`
 * means not yet cleared (the rows a soft-clear would act on); `live` adds a
 * `setAt` stamp. Since TRA-336 `isPushShowing` grants nothing for any of these
 * rows, so they are inert, but an open one still belongs cleared.
 */
export const inventoryEndlessAppPushes = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const page = await ctx.db.query("pushes").paginate(paginationOpts);
    const violations = [];
    for (const push of page.page) {
      const reason = endlessAppPushReason(push);
      if (reason === null) continue;
      violations.push({
        pushId: push._id,
        institutionId: push.institutionId,
        reason,
        timingKind: push.timing.kind,
        afterEnd: push.afterEnd,
        hasEndsAt: push.endsAt !== undefined,
        open: push.clearedAt === undefined,
        live: push.setAt !== undefined && push.clearedAt === undefined,
        fromPlacement: push.schedulePlacementId !== undefined,
      });
    }
    return {
      scanned: page.page.length,
      violations,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
