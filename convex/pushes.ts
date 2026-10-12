// Pushes — "this, to these scholars, right now."
//
// The single write surface behind every "Make focus" / "Dispatch as focus"
// affordance: the Run page, an app tile, a curriculum node, and the Slack
// agent all land here. See review/class-focus-rethink.html.
//
// Conventions are deliberately borrowed from roomCues.ts, the closest
// existing surface (a teacher broadcasting to a group or a whole school,
// with a soft clear rather than a delete): the same institution-lens
// `scope` string, the same "absent groupId = whole institution" reading,
// and the same clearedAt/clearedBy stamping.
//
// The pure rules — liveness, audience matching, plate ordering, blocking
// eligibility — live in lib/pushes.ts and are unit-tested there.

import { v } from "convex/values";
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
import { pushSummaryLine, pushTimeLeftLabel } from "../shared/pushCopy";
import { dayKeyForTimezone } from "../shared/institutionDay";
import { timeZoneForInstitution } from "./lib/institutionTime";
import {
  FOCUS_DURATION_CHOICES_MIN,
  assertBlockingAllowed,
  focusEndsAt,
  isPushBlocking,
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
  // MIGRATION SCAFFOLDING — delete with `activitySchedule` itself.
  // A schedule mirror is a copy of an entry the plate and the Now tab
  // already render from `activitySchedule`. Serving it here would show
  // the same class focus a second time, under a second heading, which is
  // the exact duplication this migration exists to remove. Mirrors stay
  // write-only until the read switch deletes the thing they mirror.
  // See Linear TRA-13.
  return open.filter((p) => p.scheduleMirror !== true);
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

/**
 * Make something the class focus, right now.
 *
 * This is the mutation that makes an ad-hoc push possible at all: with no
 * `assignmentId`, an app / video / link can be featured for a group for
 * twenty minutes without inventing a unit, an assignment and a throwaway
 * activity to hold it.
 *
 * `groupId` absent = the whole institution, matching callRoomCue.
 * `durationMin` absent = 60 minutes.
 */
export const makeFocus = teacherMutation({
  args: {
    scope: v.optional(v.string()),
    groupId: v.optional(v.id("scholarGroups")),
    scholarIds: v.optional(v.array(v.id("users"))),
    target: targetValidator,
    durationMin: v.optional(v.number()),
    note: v.optional(v.string()),
    blocking: v.optional(v.boolean()),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const result = await createFocus(ctx, ctx.user, args);
    return result.pushId;
  },
});

/**
 * The one code path every "make focus" surface runs through — the web
 * dialog, the Slack agent, and anything added later. Kept as ONE function
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
    durationMin?: number;
    note?: string;
    blocking?: boolean;
    assignmentId?: Id<"assignments">;
  },
): Promise<{
  pushId: Id<"pushes">;
  endsAt: number;
  minutes: number;
  audienceLabel: string;
}> {
  const lens = await resolveInstitutionLens(ctx, user, args.scope);
  const institution = lens.institution;
  if (!institution) {
    throw new Error("Pick a specific school to set a focus for.");
  }

  await validateTarget(ctx, args.target, lens);

  const blocking = args.blocking ?? false;
  // Refuse rather than silently downgrade: a teacher who asked for a
  // lock and got a suggestion would never know.
  assertBlockingAllowed(args.target, blocking);

  // ── audience ──
  // Narrowest wins, so an explicit scholar list beats a group, which
  // beats the whole school.
  let audience: PushDoc["audience"];
  let audienceLabel: string;
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
  } else {
    audience = { kind: "institution" };
    audienceLabel = "All scholars";
  }

  const now = Date.now();
  const endsAt = focusEndsAt(now, args.durationMin);

  const pushId = await ctx.db.insert("pushes", {
    institutionId: institution._id,
    target: args.target,
    audience,
    timing: { kind: "focus", endsAt },
    blocking,
    note: args.note?.trim() || undefined,
    setAt: now,
    assignmentId: args.assignmentId,
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
  };
}


/** Wrap it up early. No-op if already cleared. */
export const clearPush = teacherMutation({
  args: { pushId: v.id("pushes") },
  handler: async (ctx, { pushId }) => {
    const push = await ctx.db.get(pushId);
    if (!push) throw new Error("That push no longer exists.");
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
    if (push.timing.kind !== "focus") return;
    if (push.timing.endsAt > Date.now()) return;
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
 * teacher's own view (`livePushesForScope`) and the Slack surface
 * (`liveFocusForSlack`) deliberately keep showing an archived-app push, so
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
    endsAt: push.timing.kind === "focus" ? push.timing.endsAt : null,
    dueAt: push.timing.kind === "homework" ? (push.timing.dueAt ?? null) : null,
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

// ───────────────────── Slack surface (agent-facing) ─────────────────────
//
// Read-before-write, the same split deviceLock.ts uses: the model resolves
// opaque ids and shows the requester the exact app + group + window before
// anything lands on a scholar's screen. These internal functions repeat the
// role and institution checks — prompt confirmation is never treated as the
// authorization boundary.

/**
 * Everything the agent needs to name a target and an audience: the app
 * catalog, this school's groups, and the durations the UI offers.
 */
export const focusOptionsForSlack = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, { callerUserId }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false as const, message: "Forbidden: teacher role required" };
    }
    const lens = await resolveInstitutionLens(ctx, caller, undefined);
    if (!lens.institution) {
      return {
        ok: false as const,
        message: "No school context — ask an admin to add your membership.",
      };
    }

    const apps = (await ctx.db.query("externalApps").collect())
      .filter((a) => !a.archived)
      .map((a) => ({ appId: a._id, name: a.name, webUrl: a.webUrl }));

    const groups = (await ctx.db.query("scholarGroups").collect())
      .filter((g) => scholarInstitutionReadableInLens(lens, g.institutionId))
      .map((g) => ({
        groupId: g._id,
        name: g.name,
        scholarCount: g.scholarIds.length,
      }));

    return {
      ok: true as const,
      school: lens.institution.name,
      apps,
      groups,
      allScholarsOption:
        "Omit group_id to push to every enrolled scholar at this school.",
      durationChoicesMin: FOCUS_DURATION_CHOICES_MIN,
      defaultDurationMin: 60,
    };
  },
});

/** Put an app or a link in front of a group for a bounded window. */
export const makeFocusFromSlack = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appId: v.optional(v.id("externalApps")),
    url: v.optional(v.string()),
    title: v.optional(v.string()),
    media: v.optional(v.union(v.literal("video"), v.literal("page"))),
    groupId: v.optional(v.id("scholarGroups")),
    durationMin: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false as const, message: "Forbidden: teacher role required" };
    }

    let target: PushTarget;
    if (args.appId) {
      target = { kind: "app", externalAppId: args.appId };
    } else if (args.url) {
      target = {
        kind: "link",
        url: args.url,
        title: args.title?.trim() || args.url,
        media: args.media,
      };
    } else {
      return {
        ok: false as const,
        message: "Give either an app_id or a url to make the focus.",
      };
    }

    try {
      const result = await createFocus(ctx, caller, {
        target,
        groupId: args.groupId,
        durationMin: args.durationMin,
        note: args.note,
      });
      const title =
        target.kind === "link"
          ? target.title
          : ((await ctx.db.get(target.externalAppId))?.name ?? "App");
      return {
        ok: true as const,
        pushId: result.pushId,
        message: pushSummaryLine({
          title,
          audienceLabel: result.audienceLabel,
          minutes: result.minutes,
        }),
      };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/** What is on scholars' screens right now, so the agent can report or wrap. */
export const liveFocusForSlack = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, { callerUserId }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false as const, message: "Forbidden: teacher role required" };
    }
    const lens = await resolveInstitutionLens(ctx, caller, undefined);
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
        };
      }),
    );
    return { ok: true as const, pushes: rows };
  },
});

/** End a live focus early. */
export const clearFocusFromSlack = internalMutation({
  args: { callerUserId: v.id("users"), pushId: v.id("pushes") },
  handler: async (ctx, { callerUserId, pushId }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false as const, message: "Forbidden: teacher role required" };
    }
    const push = await ctx.db.get(pushId);
    if (!push) return { ok: false as const, message: "No such push." };
    const lens = await resolveInstitutionLens(ctx, caller, undefined);
    if (
      lens.institution?._id !== push.institutionId &&
      !lens.allowedInstitutionIds.has(push.institutionId)
    ) {
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
    // Same allowlist edge as the web `clearPush` — the Slack surface must not
    // be the one that silently skips it.
    await schedulePushProjectionRefresh(ctx, pushId);
    return { ok: true as const, message: "Wrapped up." };
  },
});
