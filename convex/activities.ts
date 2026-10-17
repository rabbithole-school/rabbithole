// AUTH GATING:
// - All `*Public` queries (e.g. `listByLessonPublic`, `getPublic`) are
//   scholar-safe (`authedQuery`). Use these from any scholar surface.
// - Everything else (`list`, `get`, `create`, `update`, `remove`, `reorder`)
//   is curriculum-gated (`curriculumQuery` / `curriculumMutation`) and will
//   403 for scholars.
// Scholars hit the 403 wall twice during PR #10 development — when adding a
// new scholar surface, double-check which variant you're calling.

import { v, type ObjectType } from "convex/values";
import {
  authedMutation,
  authedQuery,
  curriculumMutation,
  staffQuery,
  teacherQuery,
} from "./lib/customFunctions";
import {
  requireUnitEditAccess,
  requireUnitEditAccessForUser,
} from "./lib/auth";
import { validateDeck, validateDeckLenient } from "../shared/slidesScene";
import { requireUnitAccess, requireUnitAccessForUser } from "./lib/unitAccess";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  deliverableValidator,
  advanceRubricValidator,
  normalizeDeliverable,
  normalizeAdvanceRubric,
  requireDeliverableForOnline,
  type AdvanceRubricSpec,
  type DeliverableSpec,
} from "./lib/deliverable";
import { ensureFlairArtForActivity } from "./flairArt";
import { resolveActivityWebTarget } from "./lib/webActivityTarget";
import {
  duplicateActivityDesign,
  forkActivityIntoOwnedUnit,
} from "./lib/curriculumDuplication";
import { activityResourceDisplayRows } from "./lib/activityResourceDisplay";
import {
  presentationState,
  removePresentation,
  upsertGoogleSlides,
  upsertRabbitSlides,
} from "./lib/activityPresentationResources";
import {
  deleteActivityCascade,
  removeScheduleStateForActivity,
} from "./lib/activityCascade";
import { GAME_CATALOG, getGame } from "../lib/games/catalog";
import { isTextArtifact } from "../shared/textArtifacts";
import { looksLikeHtml } from "../lib/vibecode/helpers";
import { portfolioFamilySharingEligibility } from "./lib/schoolMediaConsent";
import { normalizeStoredTutorModel } from "./lib/tutorModel";
import {
  buildContractPatch,
  buildContractValidator,
} from "./lib/buildContract";
import { markUnitBuiltInSession } from "./lib/independentStudy";
import { isLearningStep } from "./lib/mission";
import { generateAppToken } from "./customApps";
import { isUsableVibecodeStarterApp } from "./lib/vibecodeStarter";
import { assertInstitutionActive } from "./lib/access";
import {
  APP_ONLY_CLEARED_FIELDS,
  assertAppHasNoAdvanceRubric,
  defaultAppDeliverable,
  isUntouchedDefaultAppDeliverable,
  resolveActivityWriteTarget,
  storedShapeFields,
} from "./lib/appActivity";
import { effectiveActivityKind, isAppActivity } from "../shared/appSurface";
import { ROLES, isCurriculumRole, isTeacherRole } from "./lib/roles";
import { requireCanRunOwnedAssignment } from "./lib/curriculumRun";

const kindLiteral = v.union(
  v.literal("online"),
  v.literal("offline"),
  v.literal("shareBack"),
  v.literal("web"),
  v.literal("problem_set"),
  v.literal("game"),
  // Workbench Simulator (plan: review/workbench-terrarium-plan.html §5). The
  // simulatorSpec payload is validated by the schema arm; kind alone is enough
  // here — a simulator with no spec is a Draft, same as an online activity with
  // no prompt.
  v.literal("simulator"),
  // LEGACY INPUT for an app activity (TRA-519 A4). Still accepted from every
  // caller, but every writer stores { kind: "online", appActivity: true }
  // (lib/appActivity.ts resolveActivityWriteTarget). The activity's
  // systemPrompt IS the build brief; an app activity opens the full-screen
  // builder (lib/activityKinds.ts sessionModeForActivity).
  v.literal("vibecode"),
);

const tutorModelLiteral = v.union(
  v.literal("sonnet"),
  v.literal("fable"),
);

const scholarsStartFromLiteral = v.union(
  v.literal("blank"),
  v.literal("starter"),
);
// App designer scholar edit policy (TRA-301); see schema.ts activities.editAccess.
const editAccessLiteral = v.union(
  v.literal("always"),
  v.literal("never"),
  v.literal("afterCompletion"),
);

/**
 * The scholar edit policy steers the App designer only, so the internal
 * writers (aide + unit tools, TRA-477) refuse it on any other activity rather
 * than strand a setting nothing reads. Judged on the shape the row will have
 * after the write (either app-activity shape passes).
 */
function assertEditAccessKind(isApp: boolean) {
  if (!isApp) {
    throw new Error(
      "editAccess (scholarEdit) applies to app activities only.",
    );
  }
}

/**
 * kind="game" fields, shared by create + update. `gameId` must be a game that
 * actually ships in the binary (lib/games/catalog.ts) — an activity naming a
 * game the iPad doesn't have is a scholar-visible dead end, so it's rejected
 * at write time rather than discovered at launch. `configJson` is opaque here:
 * it's parsed by THAT game's own config codec on the client, and the server
 * never interprets it.
 */
const gameFieldsValidator = v.object({
  gameId: v.string(),
  configJson: v.optional(v.string()),
});

function validateGameFields(game: { gameId: string; configJson?: string }) {
  if (!getGame(game.gameId)) throw new Error(`Unknown game "${game.gameId}"`);
  if (game.configJson !== undefined) {
    try {
      JSON.parse(game.configJson);
    } catch {
      throw new Error("Game config must be valid JSON");
    }
  }
  return { gameId: game.gameId, configJson: game.configJson || undefined };
}

/** Trim/lowercase/dedupe a teacher-entered host allowlist. */
function normalizeHosts(hosts: string[]): string[] | undefined {
  const cleaned = [
    ...new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean)),
  ];
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Lean public query — used by the scholar UnitPickerDialog. */
export const listByLessonPublic = authedQuery({
  args: { lessonId: v.id("lessons") },
  handler: async (ctx, args) => {
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    return acts
      .filter((a) => !a.archivedAt) // scholar-facing: archived hidden
      .sort((a, b) => a.order - b.order)
      .map((a) => ({
        _id: a._id,
        title: a.title,
        description: a.scholarDescription ?? null,
        // Effective kind: an app activity projects as "vibecode" in either
        // stored shape, so every client keeps routing it as today.
        kind: effectiveActivityKind(a),
        durationMinutes: a.durationMinutes ?? null,
        hasPrompt: !!a.systemPrompt?.trim(),
        webUrl: a.webUrl ?? null,
      }));
  },
});

/**
 * Lean public query that returns ALL activities in a unit, in one shot.
 * Used by the outline tree to avoid N+1 (one query per LessonGroup).
 * Consumers group client-side by `lessonId`.
 */
export const listByUnitPublic = authedQuery({
  args: {
    unitId: v.id("units"),
    assignmentId: v.optional(v.id("assignments")),
    includeResources: v.optional(v.boolean()),
    // Teacher design surfaces (the curriculum outline) pass `true` to keep
    // archived activities in the list so they can render dimmed. Scholar-facing
    // callers and schedulable pickers omit it → archived activities are hidden.
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.includeResources) {
      await requireUnitAccess(ctx, args.unitId);
    }
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();
    const orderedLessons = lessons.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const lessonIds = orderedLessons.map((l) => l._id);
    if (lessonIds.length === 0) return [];

    // No multi-key index on `lessonId`; fan-out is the cheapest path and
    // each query is index-backed. This is still a single round-trip from
    // the client's perspective.
    const perLesson = await Promise.all(
      lessonIds.map((lid) =>
        ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lid))
          .collect(),
      ),
    );
    const flatAll = perLesson.flatMap((activities) =>
      activities.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    );
    const flat = args.includeArchived
      ? flatAll
      : flatAll.filter((a) => !a.archivedAt);
    let visible = flat;
    if (args.assignmentId) {
      const assignment = await ctx.db.get(args.assignmentId);
      if (
        !assignment ||
        assignment.archivedAt ||
        String(assignment.unitId) !== String(args.unitId)
      ) {
        visible = [];
      } else if (assignment.selfPaced) {
        visible = flat;
      } else {
        const now = Date.now();
        const liveActivityIds = new Set(
          (assignment.activitySchedule ?? [])
            .filter(
              (entry) =>
                entry.setAt != null &&
                (entry.endsAt == null || entry.endsAt > now),
            )
            .map((entry) => String(entry.activityId)),
        );
        visible = flat.filter((a) => liveActivityIds.has(String(a._id)));
      }
    }
    return await Promise.all(
      visible.map(async (a) => ({
        _id: a._id,
        lessonId: a.lessonId,
        title: a.title,
        description: a.scholarDescription ?? null,
        // Effective kind (see listByLessonPublic): old iPad builds route on it.
        kind: effectiveActivityKind(a),
        durationMinutes: a.durationMinutes ?? null,
        order: a.order,
        hasPrompt: !!a.systemPrompt?.trim(),
        webUrl: a.webUrl ?? null,
        archivedAt: a.archivedAt ?? null,
        ...(args.includeResources
          ? { resources: await activityResourceDisplayRows(ctx, a._id) }
          : {}),
      })),
    );
  },
});

/** Full query for teacher curriculum tools. */
export const listByLesson = authedQuery({
  args: { lessonId: v.id("lessons") },
  handler: async (ctx, args) => {
    // Tolerate a stale lessonId (parent just got deleted) — return
    // empty rather than throwing.
    const lesson = await ctx.db.get(args.lessonId);
    if (!lesson) return [];
    await requireUnitEditAccess(ctx, { lessonId: args.lessonId });
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    // The activity's app brief (`appRequest`) is a teacher-facing pedagogical
    // target that must NEVER reach a scholar — but this full query's gate
    // (`requireUnitEditAccess`) also admits the scholar author of an
    // Independent Study unit. Strip it for any non-curriculum caller and
    // expose the boolean `hasAppRequest` instead (matching
    // `sessions.getWithMessages`).
    const canReadAppRequest = isCurriculumRole(ctx.user.role);
    return Promise.all(
      acts
        .sort((a, b) => a.order - b.order)
        .map(async (a) => {
          const process = a.processId ? await ctx.db.get(a.processId) : null;
          const { appRequest, ...rest } = a;
          return {
            ...rest,
            ...(canReadAppRequest ? { appRequest } : {}),
            hasAppRequest: appRequest != null,
            processTitle: process?.title ?? null,
            processEmoji: process?.emoji ?? null,
          };
        }),
    );
  },
});

export const get = authedQuery({
  args: { id: v.id("activities") },
  handler: async (ctx, args) => {
    // Read-then-gate so a stale URL param pointing at a just-deleted
    // activity returns null cleanly instead of throwing. The gate
    // still fires for live rows.
    const activity = await ctx.db.get(args.id);
    if (!activity) return null;
    if (!activity.lessonId) return null;
    const lesson = await ctx.db.get(activity.lessonId);
    if (!lesson) return null;
    // Full teacher document (description, systemPrompt, rubrics…), so the gate
    // is EDIT access — curriculum staff or the IS unit's author scholar —
    // never plain unit READ access, which includes enrolled scholars. Scholars
    // read activities through the scrubbed `*Public` projections only.
    await requireUnitEditAccess(ctx, { unitId: lesson.unitId });
    const starterApp = activity.starterAppId
      ? await ctx.db.get(activity.starterAppId)
      : null;
    // Strip the teacher-facing app brief (`appRequest`) for any non-curriculum
    // caller — this full query's gate also admits the scholar author of an
    // Independent Study unit, and the brief must never reach a scholar. Expose
    // the boolean `hasAppRequest` instead (matching `sessions.getWithMessages`).
    const { appRequest, ...rest } = activity;
    return {
      ...rest,
      ...(isCurriculumRole(ctx.user.role) ? { appRequest } : {}),
      hasAppRequest: appRequest != null,
      starterApp: isUsableVibecodeStarterApp(starterApp)
        ? {
            id: starterApp._id,
            name: starterApp.name,
            updatedAt: starterApp.updatedAt,
          }
        : null,
    };
  },
});

/** Public activity fetch — scholars need this for the progress navigator. */
export const getPublic = authedQuery({
  args: { id: v.id("activities") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.id);
    if (!a) return null;
    // Web activities resolve their effective launch target from the
    // referenced catalog app (DRY): the app supplies identity + allowlist,
    // the activity's own fields are optional overrides.
    const web =
      a.kind === "web" ? await resolveActivityWebTarget(ctx, a) : null;
    const presentations = await presentationState(ctx, a);
    return {
      _id: a._id,
      lessonId: a.lessonId,
      title: a.title,
      description: a.scholarDescription ?? null,
      kind: effectiveActivityKind(a),
      durationMinutes: a.durationMinutes ?? null,
      hasGoogleSlidesDeck: !!presentations.google,
      hasScholarAngles: a.hasScholarAngles ?? false,
      deliverable: a.deliverable ?? null,
      advanceRubric: a.advanceRubric ?? null,
      webUrl: web ? web.webUrl : (a.webUrl ?? null),
      webAllowedHosts: web ? web.webAllowedHosts : (a.webAllowedHosts ?? null),
      externalAppId: web?.externalAppId ?? null,
      appName: web?.appName ?? null,
      appIconUrl: web?.appIconUrl ?? null,
      appColor: web?.appColor ?? null,
      // The gameId a scholar surface needs to resolve the game's declared
      // platform. Config stays server-side — a launcher never needs it.
      gameId: a.kind === "game" ? (a.game?.gameId ?? null) : null,
    };
  },
});

/**
 * Teacher-gated twin of {@link getPublic} for TEACHER detail panes that must
 * render a UNIT-LESS activity (e.g. an ad-hoc-dispatched activity opened from
 * the Master Schedule placement drawer). `activities.get` returns null for a
 * lessonless activity (no unit to gate on), and `getPublic` now returns the
 * SCHOLAR-facing `scholarDescription` under its `description` key — so a teacher
 * reading through `getPublic` would lose the teacher-facing design intent. This
 * returns the SAME shape as `getPublic` but sourced from the TEACHER
 * `description`, plus the scholar blurb alongside it, behind a teacher gate so
 * the teacher copy never reaches a scholar. Keeps `systemPrompt` OUT to preserve
 * the drawer's partial-detail state for unit-less placements.
 */
export const getDetailForTeacher = teacherQuery({
  args: { id: v.id("activities") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.id);
    if (!a) return null;
    const web =
      a.kind === "web" ? await resolveActivityWebTarget(ctx, a) : null;
    const presentations = await presentationState(ctx, a);
    return {
      _id: a._id,
      lessonId: a.lessonId,
      title: a.title,
      // Teacher-facing design intent (never the scholar blurb).
      description: a.description ?? null,
      scholarDescription: a.scholarDescription ?? null,
      kind: effectiveActivityKind(a),
      durationMinutes: a.durationMinutes ?? null,
      hasGoogleSlidesDeck: !!presentations.google,
      hasScholarAngles: a.hasScholarAngles ?? false,
      deliverable: a.deliverable ?? null,
      advanceRubric: a.advanceRubric ?? null,
      webUrl: web ? web.webUrl : (a.webUrl ?? null),
      webAllowedHosts: web ? web.webAllowedHosts : (a.webAllowedHosts ?? null),
      externalAppId: web?.externalAppId ?? null,
      appName: web?.appName ?? null,
      appIconUrl: web?.appIconUrl ?? null,
      appColor: web?.appColor ?? null,
      gameId: a.kind === "game" ? (a.game?.gameId ?? null) : null,
    };
  },
});

export const create = authedMutation({
  args: {
    lessonId: v.id("lessons"),
    title: v.string(),
    description: v.optional(v.string()),
    scholarDescription: v.optional(v.string()),
    kind: kindLiteral,
    // TRA-519 A4: an online activity where scholars build or use an app
    // (kind "vibecode" is the legacy spelling of the same thing).
    appActivity: v.optional(v.boolean()),
    systemPrompt: v.optional(v.string()),
    tutorModel: v.optional(tutorModelLiteral),
    processId: v.optional(v.id("processes")),
    durationMinutes: v.optional(v.number()),
    defaultMode: v.optional(
      v.union(
        v.literal("classFocus"),
        v.literal("homework"),
        v.literal("either"),
      ),
    ),
    webUrl: v.optional(v.string()),
    webAllowedHosts: v.optional(v.array(v.string())),
    externalAppId: v.optional(v.id("externalApps")),
    game: v.optional(gameFieldsValidator),
    // App activities only: the model contract + allowSilence (schema.ts).
    buildContract: v.optional(buildContractValidator),
    allowSilence: v.optional(v.boolean()),
    // Explicitly about spelling/typing (schema.ts).
    assessesWritingMechanics: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { lessonId: args.lessonId });
    const target = resolveActivityWriteTarget(null, {
      kind: args.kind,
      appActivity: args.appActivity,
    });
    const contract = buildContractPatch(storedShapeFields(target), {
      buildContract: args.buildContract,
      allowSilence: args.allowSilence,
    });
    const existing = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    const maxOrder = existing.reduce((max, a) => Math.max(max, a.order), -1);
    const newId = await ctx.db.insert("activities", {
      lessonId: args.lessonId,
      title: args.title.trim() || "New activity",
      description: args.description?.trim() || undefined,
      scholarDescription: args.scholarDescription?.trim() || undefined,
      ...storedShapeFields(target),
      systemPrompt: args.systemPrompt?.trim() || undefined,
      tutorModel: target.isApp
        ? normalizeStoredTutorModel(args.tutorModel)
        : undefined,
      // An app activity's evaluation bar is the app (lib/appActivity.ts).
      deliverable: target.isApp
        ? defaultAppDeliverable({ scholarDescription: args.scholarDescription })
        : undefined,
      processId: args.processId,
      durationMinutes: args.durationMinutes,
      defaultMode: args.defaultMode,
      webUrl: args.kind === "web" ? args.webUrl?.trim() || undefined : undefined,
      webAllowedHosts:
        args.kind === "web" && args.webAllowedHosts
          ? normalizeHosts(args.webAllowedHosts)
          : undefined,
      externalAppId: args.kind === "web" ? args.externalAppId : undefined,
      game:
        args.kind === "game" && args.game
          ? validateGameFields(args.game)
          : undefined,
      ...contract,
      assessesWritingMechanics: args.assessesWritingMechanics ? true : undefined,
      order: maxOrder + 1,
      // Seed Share Back defaults at create time so 80% of the time the
      // teacher doesn't have to touch anything before generating the
      // digest — recipe defaults to reflection, source defaults to the
      // previous online activity in the unit (if one exists).
      shareBackRecipe:
        args.kind === "shareBack" ? ("reflection" as const) : undefined,
    });
    if (args.kind === "shareBack") {
      const justCreated = await ctx.db.get(newId);
      if (justCreated) {
        const prior = await findPreviousOnlineActivityInUnit(ctx, justCreated);
        if (prior) {
          await ctx.db.patch(newId, { sourceActivityIds: [prior._id] });
        }
      }
    }
    return newId;
  },
});

/**
 * Catalog rows returned to Curriculum Bot before it creates a game or web
 * activity. The paired mutation below re-validates every identifier so a model
 * cannot turn an invented or stale catalog value into a broken activity.
 */
export const listActivityKindCatalogInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const externalApps = await ctx.db.query("externalApps").collect();
    return {
      games: Object.values(GAME_CATALOG).map((game) => ({
        gameId: game.gameId,
        title: game.title,
        blurb: game.blurb,
        platform: game.platform,
      })),
      externalApps: externalApps
        .filter((app) => !app.archived)
        .map((app) => ({
          externalAppId: app._id,
          name: app.name,
          webUrl: app.webUrl,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      shareBackRecipes: [
        "reflection",
        "galleryWalk",
        "exitTicket",
        "debateDebrief",
        "custom",
      ] as const,
    };
  },
});

/**
 * Narrow internal writer for the three catalog-backed activity kinds exposed
 * through Curriculum Bot. Callers resolve the lesson in their own access
 * boundary; this mutation owns catalog validation and the kind-specific fields.
 */
export const createCatalogActivityInternal = internalMutation({
  args: {
    callerUserId: v.id("users"),
    lessonId: v.id("lessons"),
    title: v.string(),
    description: v.optional(v.string()),
    scholarDescription: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    kind: v.union(
      v.literal("game"),
      v.literal("web"),
      v.literal("shareBack"),
    ),
    gameId: v.optional(v.string()),
    externalAppId: v.optional(v.id("externalApps")),
    shareBackRecipe: v.optional(
      v.union(
        v.literal("reflection"),
        v.literal("galleryWalk"),
        v.literal("exitTicket"),
        v.literal("debateDebrief"),
        v.literal("custom"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Caller not found");
    await requireUnitEditAccessForUser(ctx, caller, {
      lessonId: args.lessonId,
    });

    const peers = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    const maxOrder = peers.reduce((max, a) => Math.max(max, a.order), -1);

    if (args.kind === "game") {
      if (!args.gameId || !getGame(args.gameId)) {
        throw new Error(`Unknown game "${args.gameId ?? ""}"`);
      }
    }
    if (args.kind === "web") {
      if (!args.externalAppId) throw new Error("A catalog externalAppId is required");
      const app = await ctx.db.get(args.externalAppId);
      if (!app || app.archived) {
        throw new Error("Unknown or archived External App catalog entry");
      }
    }
    if (args.kind === "shareBack" && !args.shareBackRecipe) {
      throw new Error("A Share Back recipe is required");
    }

    const activityId = await ctx.db.insert("activities", {
      lessonId: args.lessonId,
      title: args.title.trim() || "New activity",
      description: args.description?.trim() || undefined,
      scholarDescription: args.scholarDescription?.trim() || undefined,
      durationMinutes: args.durationMinutes,
      kind: args.kind,
      order: maxOrder + 1,
      game:
        args.kind === "game"
          ? { gameId: args.gameId! }
          : undefined,
      externalAppId:
        args.kind === "web" ? args.externalAppId : undefined,
      shareBackRecipe:
        args.kind === "shareBack" ? args.shareBackRecipe : undefined,
    });
    if (args.kind === "shareBack") {
      const created = await ctx.db.get(activityId);
      if (created) {
        const prior = await findPreviousOnlineActivityInUnit(ctx, created);
        if (prior) await ctx.db.patch(activityId, { sourceActivityIds: [prior._id] });
      }
    }
    return { activityId, title: args.title.trim() || "New activity" };
  },
});

export const duplicate = authedMutation({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.activityId);
    if (!source) throw new Error("Activity not found");
    if (!source.lessonId) {
      throw new Error("Activity is not attached to a lesson");
    }
    await requireUnitEditAccess(ctx, { activityId: args.activityId });

    const siblings = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", source.lessonId))
      .collect();
    for (const sibling of siblings) {
      if (sibling._id !== source._id && sibling.order > source.order) {
        await ctx.db.patch(sibling._id, { order: sibling.order + 1 });
      }
    }

    return await ctx.db.insert(
      "activities",
      duplicateActivityDesign(
        source,
        source.lessonId,
        source.order + 1,
        `${source.title} (copy)`,
      ),
    );
  },
});

async function activityWithUnitId(
  ctx: MutationCtx,
  activityId: Id<"activities">,
) {
  const activity = await ctx.db.get(activityId);
  if (!activity) throw new Error("Activity not found");
  if (!activity.lessonId) {
    throw new Error("Activity is not attached to a lesson");
  }
  const lesson = await ctx.db.get(activity.lessonId);
  if (!lesson) throw new Error("Lesson not found");
  return { activity, unitId: lesson.unitId };
}

export const forkToMyUnit = curriculumMutation({
  args: {
    activityId: v.id("activities"),
    targetUnitId: v.optional(v.id("units")),
  },
  handler: async (ctx, args) => {
    await assertInstitutionActive(ctx, ctx.user);
    const { activity, unitId } = await activityWithUnitId(
      ctx,
      args.activityId,
    );
    await requireUnitAccess(ctx, unitId);
    return await forkActivityIntoOwnedUnit(
      ctx,
      activity,
      ctx.user._id,
      args.targetUnitId,
    );
  },
});

export const forkToMyUnitForAide = internalMutation({
  args: {
    callerUserId: v.id("users"),
    activityId: v.id("activities"),
    targetUnitId: v.optional(v.id("units")),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      throw new Error("Forbidden: teacher or admin role required");
    }
    await assertInstitutionActive(ctx, caller);
    const { activity, unitId } = await activityWithUnitId(
      ctx,
      args.activityId,
    );
    await requireUnitAccessForUser(ctx, caller, unitId);
    return await forkActivityIntoOwnedUnit(
      ctx,
      activity,
      caller._id,
      args.targetUnitId,
    );
  },
});

export const prepareVibecodeStarterFromArtifact = internalQuery({
  args: {
    activityId: v.id("activities"),
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Caller not found");
    const { user } = await requireUnitEditAccessForUser(ctx, caller, {
      activityId: args.activityId,
    });
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (!isAppActivity(activity)) {
      throw new Error("Activity must be an app activity");
    }

    const artifact = await ctx.db.get(args.artifactId);
    if (
      !artifact ||
      artifact.type !== "code" ||
      artifact.content.trim().length === 0 ||
      !looksLikeHtml(artifact.content)
    ) {
      throw new Error("Starter artifact must be a non-empty HTML app");
    }

    const session = await ctx.db.get(artifact.sessionId);
    if (
      !session?.isTestDrive ||
      session.userId !== user._id ||
      session.activityId !== args.activityId
    ) {
      throw new Error(
        "Starter artifact must come from your rehearsal of this activity",
      );
    }
    return {
      title: artifact.title,
      html: artifact.content,
      revision: artifact.revision ?? 0,
    };
  },
});

// Cheap idempotency probe the promotion ACTION runs BEFORE copying any asset
// blobs: if this activity's starter was already promoted from this exact
// (artifact, revision), copying would leak orphaned storage objects on the
// no-op short-circuit (F6). Returns the existing promotion result, or null.
export const vibecodeStarterAlreadyPromoted = internalQuery({
  args: {
    activityId: v.id("activities"),
    artifactId: v.id("artifacts"),
    sourceRevision: v.number(),
    callerUserId: v.id("users"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    id: Id<"customApps">;
    name: string;
    updatedAt: number;
  } | null> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Caller not found");
    await requireUnitEditAccessForUser(ctx, caller, {
      activityId: args.activityId,
    });
    const activity = await ctx.db.get(args.activityId);
    if (!activity?.starterAppId) return null;
    const starterApp = await ctx.db.get(activity.starterAppId);
    if (
      starterApp &&
      starterApp.kind === "static" &&
      starterApp.origin === "starter" &&
      starterApp.sourceArtifactId === args.artifactId &&
      starterApp.sourceRevision === args.sourceRevision
    ) {
      return {
        id: activity.starterAppId,
        name: starterApp.name,
        updatedAt: starterApp.updatedAt ?? Date.now(),
      };
    }
    return null;
  },
});

/**
 * Write an activity's vibecode starter app — the ONE writer behind rehearsal
 * promotion (`commitVibecodeStarterFromArtifact`) and the file installer
 * (`appInstall.installAppAsActivity`). Patches the activity's own starter in
 * place (deleting the storage it no longer references), forks a fresh row when
 * another activity still shares the starter, or inserts the first one. The
 * caller owns access checks, idempotency, and the activity patch.
 */
export async function writeVibecodeStarterApp(
  ctx: MutationCtx,
  args: {
    activity: Doc<"activities">;
    createdBy: Id<"users">;
    name: string;
    html: string;
    appAssetIds: Id<"_storage">[];
    thumbnailStorageId?: Id<"_storage">;
    // Rehearsal provenance; absent for an installed app (clears it on patch).
    sourceArtifactId?: Id<"artifacts">;
    sourceRevision?: number;
    appAi?: Doc<"customApps">["appAi"];
    updatedAt: number;
  },
): Promise<Id<"customApps">> {
  const fields = {
    name: args.name,
    html: args.html,
    appAssetIds: args.appAssetIds.length > 0 ? args.appAssetIds : undefined,
    thumbnailStorageId: args.thumbnailStorageId,
    updatedAt: args.updatedAt,
    sourceArtifactId: args.sourceArtifactId,
    sourceRevision: args.sourceRevision,
    appAi: args.appAi,
  };
  const insertStarter = () =>
    ctx.db.insert("customApps", {
      token: generateAppToken(),
      kind: "static",
      status: "live",
      origin: "starter",
      createdBy: args.createdBy,
      ...fields,
    });
  const starterAppId = args.activity.starterAppId;
  if (!starterAppId) return await insertStarter();
  const starterApp = await ctx.db.get(starterAppId);
  if (!starterApp) {
    throw new Error("Referenced activity starter app was not found");
  }
  if (starterApp.kind !== "static") {
    throw new Error("Referenced activity starter app must be static");
  }
  // Promotion forks a shared starter rather than editing it in place; never
  // rewrite a row another activity still points at.
  const references = await ctx.db
    .query("activities")
    .withIndex("by_starterAppId", (q) => q.eq("starterAppId", starterAppId))
    .take(2);
  if (references.length > 1) return await insertStarter();
  const retainedStorageIds = new Set<Id<"_storage">>(args.appAssetIds);
  if (args.thumbnailStorageId) retainedStorageIds.add(args.thumbnailStorageId);
  const supersededStorageIds = new Set(
    (starterApp.appAssetIds ?? []).filter((id) => !retainedStorageIds.has(id)),
  );
  if (
    starterApp.thumbnailStorageId &&
    !retainedStorageIds.has(starterApp.thumbnailStorageId)
  ) {
    supersededStorageIds.add(starterApp.thumbnailStorageId);
  }
  await ctx.db.patch(starterAppId, fields);
  for (const storageId of supersededStorageIds) {
    await ctx.storage.delete(storageId);
  }
  return starterAppId;
}

export const commitVibecodeStarterFromArtifact = internalMutation({
  args: {
    activityId: v.id("activities"),
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
    sourceRevision: v.number(),
    html: v.string(),
    appAssetIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Caller not found");
    const { user } = await requireUnitEditAccessForUser(ctx, caller, {
      activityId: args.activityId,
    });
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (!isAppActivity(activity)) {
      throw new Error("Activity must be an app activity");
    }
    const artifact = await ctx.db.get(args.artifactId);
    if (
      !artifact ||
      artifact.type !== "code" ||
      (artifact.revision ?? 0) !== args.sourceRevision
    ) {
      throw new Error("The rehearsal app changed while it was being saved.");
    }
    const session = await ctx.db.get(artifact.sessionId);
    if (
      !session?.isTestDrive ||
      session.userId !== user._id ||
      session.activityId !== args.activityId
    ) {
      throw new Error(
        "Starter artifact must come from your rehearsal of this activity",
      );
    }

    const latestSnapshotMessage = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .filter((q) => q.neq(q.field("appSnapshotStorageId"), undefined))
      .order("desc")
      .first();
    const thumbnailStorageId = latestSnapshotMessage?.appSnapshotStorageId;
    const updatedAt = Date.now();
    // Every branch below snapshots the rehearsal app's server-only AI spec
    // (character persona, judge rubrics) with its HTML, so scholars clone the
    // character the teacher rehearsed. An absent spec clears the starter's.
    // FIRST promotion: no starter existed yet. On first save the build-session
    // autosave also switches scholars onto the saved app (F8) — matching the
    // aide's existing-app hand-off, which sets `scholarsStartFrom: "starter"`
    // at convex/lib/customAppTools.ts. Without this, an autosaved starter would
    // never reach scholars (they'd open a blank slate).
    const firstPromotion = !activity.starterAppId;
    if (activity.starterAppId) {
      const starterApp = await ctx.db.get(activity.starterAppId);
      // Autosave idempotency: if this starter was already promoted from this
      // exact (artifact, revision), a re-run is a no-op. Keeps the App
      // designer's per-turn autosave from re-copying assets or churning rows.
      if (
        starterApp?.kind === "static" &&
        starterApp.origin === "starter" &&
        starterApp.sourceArtifactId === args.artifactId &&
        starterApp.sourceRevision === args.sourceRevision
      ) {
        return {
          id: activity.starterAppId,
          name: starterApp.name,
          updatedAt: starterApp.updatedAt ?? updatedAt,
        };
      }
    }
    const starterAppId = await writeVibecodeStarterApp(ctx, {
      activity,
      createdBy: user._id,
      name: artifact.title,
      html: args.html,
      appAssetIds: args.appAssetIds,
      thumbnailStorageId,
      sourceArtifactId: args.artifactId,
      sourceRevision: args.sourceRevision,
      appAi: artifact.appAi,
      updatedAt,
    });
    await ctx.db.patch(args.activityId, {
      starterAppId,
      ...(firstPromotion && activity.scholarsStartFrom === undefined
        ? { scholarsStartFrom: "starter" as const }
        : {}),
    });
    return { id: starterAppId, name: artifact.title, updatedAt };
  },
});

export const clearVibecodeStarter = authedMutation({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    await ctx.db.patch(args.activityId, {
      starterAppId: undefined,
      scholarsStartFrom: undefined,
    });
    return null;
  },
});

export const setScholarsStartFrom = authedMutation({
  args: {
    activityId: v.id("activities"),
    value: scholarsStartFromLiteral,
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (!isAppActivity(activity)) {
      throw new Error("Activity must be an app activity");
    }
    if (args.value === "starter") {
      const hasUsableStarter = activity.starterAppId
        ? isUsableVibecodeStarterApp(
            await ctx.db.get(activity.starterAppId),
          )
        : false;
      if (!hasUsableStarter) {
        throw new Error(
          "Save an activity starter before choosing Saved app",
        );
      }
    }
    await ctx.db.patch(args.activityId, {
      scholarsStartFrom: args.value,
    });
    return null;
  },
});

export const update = authedMutation({
  args: {
    id: v.id("activities"),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    scholarDescription: v.optional(v.union(v.string(), v.null())),
    kind: v.optional(kindLiteral),
    // TRA-519 A4: online activity ⇄ app activity ("Scholars build or use an
    // app"). Omitted = keep; a bare `kind` means that kind, not an app.
    appActivity: v.optional(v.boolean()),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    tutorModel: v.optional(v.union(tutorModelLiteral, v.null())),
    scholarsStartFrom: v.optional(scholarsStartFromLiteral),
    // App activities only: the App designer scholar edit policy (TRA-301).
    editAccess: v.optional(editAccessLiteral),
    // App activities only: the model contract (null clears) + allowSilence.
    buildContract: v.optional(v.union(buildContractValidator, v.null())),
    allowSilence: v.optional(v.boolean()),
    processId: v.optional(v.union(v.id("processes"), v.null())),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
    // Pass the full spec to set / replace, or null to clear it.
    deliverable: v.optional(v.union(deliverableValidator, v.null())),
    hasScholarAngles: v.optional(v.boolean()),
    // This activity is explicitly about spelling/typing (schema.ts). false
    // clears it back to the default (unset).
    assessesWritingMechanics: v.optional(v.boolean()),
    // Design-time intent for how this activity is meant to be done.
    defaultMode: v.optional(
      v.union(
        v.literal("classFocus"),
        v.literal("homework"),
        v.literal("either"),
      ),
    ),
    // Share Back fields. shareBackRecipe/sourceActivityIds/facilitationFocus
    // only have effect when kind === "shareBack" — but we allow them to be
    // set in the same patch as `kind: "shareBack"` (e.g. when flipping the
    // kind we also seed the recipe).
    shareBackRecipe: v.optional(
      v.union(
        v.literal("reflection"),
        v.literal("galleryWalk"),
        v.literal("exitTicket"),
        v.literal("debateDebrief"),
        v.literal("custom"),
      ),
    ),
    facilitationFocus: v.optional(v.union(v.string(), v.null())),
    // Web-assignment fields (kind="web"). Null clears.
    webUrl: v.optional(v.union(v.string(), v.null())),
    webAllowedHosts: v.optional(v.union(v.array(v.string()), v.null())),
    // Reference to a shared External App in the catalog (kind="web"). Null
    // clears (back to a freehand-URL one-off).
    externalAppId: v.optional(v.union(v.id("externalApps"), v.null())),
    // Game fields (kind="game"). Null clears.
    game: v.optional(v.union(gameFieldsValidator, v.null())),
    // Conversation recipe (kind="online"): baseline / exitTicket EQ
    // assessment conversations. Null clears.
    recipe: v.optional(
      v.union(v.literal("baseline"), v.literal("exitTicket"), v.null()),
    ),
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.id });
    const { id, ...fields } = args;
    const updates: Record<string, unknown> = {};
    const currentActivity = await ctx.db.get(id);
    if (!currentActivity) throw new Error("Activity not found");
    // The shape this write leaves the row in (TRA-519 A4): kind "vibecode"
    // input and appActivity both resolve here; every gate below reads it.
    const target = resolveActivityWriteTarget(currentActivity, {
      kind: fields.kind,
      appActivity: fields.appActivity,
    });
    let flairCriteria:
      | Array<{ id: string; label: string; description?: string }>
      | undefined;
    if (fields.title !== undefined) updates.title = fields.title.trim();
    if (fields.description !== undefined)
      updates.description = fields.description?.trim() || undefined;
    if (fields.scholarDescription !== undefined)
      updates.scholarDescription =
        fields.scholarDescription?.trim() || undefined;
    if (target.shapeSupplied) Object.assign(updates, storedShapeFields(target));
    if (fields.systemPrompt !== undefined)
      updates.systemPrompt = fields.systemPrompt?.trim() || undefined;
    if (fields.tutorModel !== undefined) {
      updates.tutorModel = target.isApp
        ? normalizeStoredTutorModel(fields.tutorModel)
        : undefined;
    }
    if (fields.scholarsStartFrom !== undefined)
      updates.scholarsStartFrom = fields.scholarsStartFrom;
    if (fields.editAccess !== undefined) {
      assertEditAccessKind(target.isApp);
      updates.editAccess = fields.editAccess;
    }
    if (fields.processId !== undefined)
      updates.processId = fields.processId ?? undefined;
    if (fields.durationMinutes !== undefined)
      updates.durationMinutes = fields.durationMinutes ?? undefined;
    if (fields.deliverable !== undefined) {
      const normalized = fields.deliverable
        ? normalizeDeliverable(fields.deliverable)
        : undefined;
      if (normalized) {
        assertOneEvaluationBar(currentActivity, { deliverable: normalized });
      }
      updates.deliverable = normalized;
      flairCriteria = normalized?.criteria;
    }
    if (fields.hasScholarAngles !== undefined)
      updates.hasScholarAngles = fields.hasScholarAngles;
    if (fields.assessesWritingMechanics !== undefined)
      updates.assessesWritingMechanics = fields.assessesWritingMechanics
        ? true
        : undefined;
    if (fields.defaultMode !== undefined)
      updates.defaultMode = fields.defaultMode;
    if (fields.shareBackRecipe !== undefined) {
      updates.shareBackRecipe = fields.shareBackRecipe;
      // Switching to a named recipe clears any lingering custom
      // focus — the recipe IS the focus for non-custom shapes, and
      // a leftover focus would silently re-blend into the prompt.
      if (fields.shareBackRecipe !== "custom") {
        updates.facilitationFocus = undefined;
      }
    }
    if (fields.facilitationFocus !== undefined)
      updates.facilitationFocus =
        fields.facilitationFocus?.trim() || undefined;
    if (fields.webUrl !== undefined)
      updates.webUrl = fields.webUrl?.trim() || undefined;
    if (fields.webAllowedHosts !== undefined)
      updates.webAllowedHosts = fields.webAllowedHosts
        ? normalizeHosts(fields.webAllowedHosts)
        : undefined;
    if (fields.externalAppId !== undefined) {
      updates.externalAppId = fields.externalAppId ?? undefined;
      // Linking a catalog app makes it the source of truth for the
      // allowlist; drop any stale per-activity hosts so the enforced lock
      // can't diverge from the catalog's (defense in depth — the editor
      // also clears it). The deep-link webUrl is kept (host-validated at
      // resolve time).
      if (fields.externalAppId) updates.webAllowedHosts = undefined;
    }
    if (fields.game !== undefined)
      updates.game = fields.game ? validateGameFields(fields.game) : undefined;
    if (fields.recipe !== undefined)
      updates.recipe = fields.recipe ?? undefined;
    // When flipping AWAY from kind="shareBack", clear share-back-only
    // fields so they don't dangle (and confuse the next time the user
    // flips it back).
    if (target.shapeSupplied && target.kind !== "shareBack") {
      updates.shareBackRecipe = undefined;
      updates.sourceActivityIds = undefined;
      updates.facilitationFocus = undefined;
    }
    // Angles only apply to (non-app) online activities — clear when
    // flipping away.
    if (target.shapeSupplied && target.effectiveKind !== "online") {
      updates.hasScholarAngles = undefined;
    }
    Object.assign(
      updates,
      buildContractPatch(
        storedShapeFields(target),
        {
          buildContract: fields.buildContract,
          allowSilence: fields.allowSilence,
        },
        currentActivity.buildContract,
      ),
    );
    if (target.shapeSupplied && !target.isApp) {
      // The model, contract and edit policy steer the App designer only —
      // drop them when the row stops being an app activity.
      Object.assign(updates, APP_ONLY_CLEARED_FIELDS);
    }
    // Conversation recipes (baseline/exitTicket) apply to online activities
    // (tutor-run) AND offline activities (the uploaded artifact is assessed
    // — convex/granuleAssessment.ts). Clear only when flipping to a kind that
    // can't carry one (web / shareBack / an app).
    if (
      target.shapeSupplied &&
      target.effectiveKind !== "online" &&
      target.effectiveKind !== "offline"
    ) {
      updates.recipe = undefined;
    }
    // Web fields only apply to web activities — clear when flipping away.
    if (target.shapeSupplied && target.kind !== "web") {
      updates.webUrl = undefined;
      updates.webAllowedHosts = undefined;
      updates.externalAppId = undefined;
    }
    // Same for the game reference.
    if (target.shapeSupplied && target.kind !== "game") {
      updates.game = undefined;
    }
    Object.assign(updates, appDeliverablePatch(currentActivity, target, updates));
    // When flipping TO kind="shareBack", seed a sensible default so
    // 80% of the time the teacher doesn't have to touch anything:
    //  - default recipe to "reflection" (if unset)
    //  - default sourceActivityIds to the previous online activity in
    //    the same unit (if unset). Falls back to no sources when there
    //    isn't one — the warnings banner already nudges the teacher.
    if (fields.kind === "shareBack") {
      const existing = currentActivity;
      if (!existing?.shareBackRecipe && updates.shareBackRecipe === undefined) {
        updates.shareBackRecipe = "reflection";
      }
      const haveSources =
        (updates.sourceActivityIds as unknown[] | undefined)?.length ||
        existing?.sourceActivityIds?.length;
      if (!haveSources && existing?.lessonId) {
        const previousOnline = await findPreviousOnlineActivityInUnit(
          ctx,
          existing,
        );
        if (previousOnline) {
          updates.sourceActivityIds = [previousOnline._id];
        }
      }
    }
    await ctx.db.patch(id, updates);
    if (flairCriteria?.length) {
      await ensureFlairArtForActivity(ctx, id, flairCriteria, ctx.user._id);
    }
  },
});

/**
 * The deliverable side of an activity write (TRA-519 A4). An app activity's
 * evaluation bar is the app: a write that leaves an app with neither a
 * deliverable nor an advanceRubric gets the default app deliverable, and a
 * write that turns a row with a conversation advance gate into an app is
 * refused. A row that stops being an app drops the default deliverable it was
 * given if nobody edited it, so a plain online activity doesn't inherit an
 * "artifact" deliverable it never asked for.
 */
function appDeliverablePatch(
  current: Doc<"activities">,
  target: ReturnType<typeof resolveActivityWriteTarget>,
  updates: Record<string, unknown>,
): { deliverable?: DeliverableSpec | undefined } {
  const resultingDeliverable = (
    "deliverable" in updates ? updates.deliverable : current.deliverable
  ) as DeliverableSpec | undefined;
  if (target.isApp) {
    if (target.becomesApp) {
      assertAppHasNoAdvanceRubric(true, current.advanceRubric);
    }
    if (!resultingDeliverable && !current.advanceRubric) {
      const scholarDescription = (
        "scholarDescription" in updates
          ? updates.scholarDescription
          : current.scholarDescription
      ) as string | undefined;
      return { deliverable: defaultAppDeliverable({ scholarDescription }) };
    }
    return {};
  }
  if (
    target.leavesApp &&
    !("deliverable" in updates) &&
    isUntouchedDefaultAppDeliverable(
      current.deliverable,
      current.scholarDescription,
    )
  ) {
    return { deliverable: undefined };
  }
  return {};
}

/**
 * Find the most-recent ONLINE activity in the same unit that comes
 * before the given Share Back activity, by (lesson order, activity
 * order). Used to auto-seed the Share Back's first source when the
 * teacher flips an activity's kind to "shareBack" without picking one.
 */
async function findPreviousOnlineActivityInUnit(
  ctx: MutationCtx,
  shareBack: Doc<"activities">,
): Promise<Doc<"activities"> | null> {
  if (!shareBack.lessonId) return null;
  const ownLesson = await ctx.db.get(shareBack.lessonId);
  if (!ownLesson) return null;
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", ownLesson.unitId))
    .collect();
  lessons.sort((a, b) => a.order - b.order);
  const ownLessonIdx = lessons.findIndex((l) => l._id === ownLesson._id);
  // Walk lessons from this one backwards. In the same lesson, only
  // consider activities ordered before this share back; in earlier
  // lessons, every activity is fair game.
  for (let li = ownLessonIdx; li >= 0; li--) {
    const lesson = lessons[li];
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
      .collect();
    acts.sort((a, b) => a.order - b.order);
    const pool =
      lesson._id === ownLesson._id
        ? acts.filter((a) => a.order < shareBack.order)
        : acts;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (effectiveActivityKind(pool[i]) === "online") return pool[i];
    }
  }
  return null;
}

// createForQuest dropped — Quests removed in the kill-quests refactor.
// All activities now belong to a Lesson (which belongs to a Unit).

// Legacy scholar-scoped activities (createForScholar /
// listScholarScoped / listMyScholarScoped / updateForScholar /
// removeForScholar) removed. One-off IS tasks are now scholar-authored
// IS Units (units.createAndOfferQuestForScholar +
// units.listScholarAuthored). homeworkForScholar removed — homework
// moved from activity-level to assignment-level
// (focusSettings.isHomework + focus.homeworkForMe). See
// review/homework-on-assignment.md.

/**
 * Per-activity submissions — every scholar's submitted deliverable for
 * one activity, side-by-side. Backs the "Submissions" panel in the
 * activity editor (view + download). Distinct from the Share Back
 * feature (which collates ACROSS activities — see convex/shareBack.ts).
 */
export const collateDeliverablesForActivity = staffQuery({
  args: {
    activityId: v.id("activities"),
    // Optional cohort scope. When provided, only deliverables from
    // THIS Assignment are returned — the Assignment Page passes this
    // so cohort A and cohort B see independent submission lists.
    // Absent = lifetime (legacy editor preview path).
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    // Gate: staff-only (staffQuery already excludes scholars, parents, and
    // lifelong learners), then scoped to the activity's unit institution.
    // This backs staff-only surfaces (the assignment Run page and the
    // curriculum activity detail) and returns cohort-wide submissions —
    // including signed file + program-capture media URLs — so it must never
    // reach a scholar (who could otherwise guess an activityId and pull the
    // whole cohort's work + capture videos) or a staffer in another school.
    // Read-then-gate mirrors `get` above: a stale activityId returns an empty
    // list, while a live row still enforces the institution lens via
    // requireUnitAccess.
    //
    // Base `staff` (operations staff included) passes the unit lens but may
    // not read scholars' work: a cohort's submissions are the learning record.
    // Empty rather than a throw, mirroring scholars.rosterPulse — with ONE
    // exception below: a curriculum:run holder's own runnable assignment.
    const activity = await ctx.db.get(args.activityId);
    if (!activity?.lessonId) return [];
    const lesson = await ctx.db.get(activity.lessonId);
    if (!lesson) return [];
    await requireUnitAccess(ctx, lesson.unitId);
    // Base `staff` (curriculum:edit / curriculum:run / operations grants) holds
    // no cohort read: a staffer sees hand-ins only on an assignment she OWNS,
    // through the same owner + runner gate as the Run page. Teachers and
    // curriculum roles keep the cohort and lifetime views.
    if (ctx.user.role === ROLES.STAFF) {
      if (!args.assignmentId) return [];
      const assignment = await ctx.db.get(args.assignmentId);
      if (!assignment || assignment.teacherId !== ctx.user._id) return [];
      try {
        await requireCanRunOwnedAssignment(ctx, ctx.user, assignment);
      } catch {
        return [];
      }
    }

    const allDeliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();
    const deliverables = args.assignmentId
      ? allDeliverables.filter((d) => d.assignmentId === args.assignmentId)
      : allDeliverables;
    // Newest submission per (scholar, activity, artifact).
    return Promise.all(
      deliverables.map(async (d) => {
        const scholar = await ctx.db.get(d.scholarId);
        const artifact = d.artifactId
          ? await ctx.db.get(d.artifactId)
          : null;
        // Scanned work (offline project): the file + caption live on the
        // linked portfolio item. Surface its thumbnail + caption + a link
        // to open the scan so the Run page shows it like any submission.
        const portfolioItem = d.portfolioItemId
          ? await ctx.db.get(d.portfolioItemId)
          : null;
        // Resolve download target: text/artifact bodies download as text
        // client-side; binary files (photo/audio/slides export) and scans
        // download via a storage URL.
        const mapContent =
          d.mapContent ??
          (artifact?.type === "map" ? artifact.content : null);
        const textContent =
          d.textContent ??
          (artifact && isTextArtifact(artifact) ? artifact.content : null);
        const fileUrl = d.fileStorageId
          ? await ctx.storage.getUrl(d.fileStorageId)
          : portfolioItem?.fileStorageId
            ? await ctx.storage.getUrl(portfolioItem.fileStorageId)
            : null;
        const thumbUrl = portfolioItem?.thumbStorageId
          ? await ctx.storage.getUrl(portfolioItem.thumbStorageId)
          : null;
        const capture =
          portfolioItem?.source === "capture_station"
            ? await ctx.db
                .query("captureStationCaptures")
                .withIndex("by_portfolio_item", (q) =>
                  q.eq("portfolioItemId", portfolioItem._id),
                )
                .unique()
            : null;
        const videoThumbUrl = capture?.videoThumbStorageId
          ? await ctx.storage.getUrl(capture.videoThumbStorageId)
          : null;
        const contentKind:
          | "text"
          | "map"
          | "file"
          | "portfolio"
          | "none" =
          portfolioItem
            ? "portfolio"
            : mapContent
              ? "map"
            : textContent
              ? "text"
              : fileUrl
                ? "file"
                : "none";
        const hasFamilySnapshotSource =
          !portfolioItem &&
          (d.mapContent !== undefined ||
            (!!d.textContent?.trim() &&
              activity.deliverable?.kind !== "slides"));
        const familyShareable =
          hasFamilySnapshotSource &&
          (
            await portfolioFamilySharingEligibility(
              ctx,
              [d.scholarId],
              false,
            )
          ).allowed;
        return {
          _id: d._id,
          scholarId: d.scholarId,
          scholarName: scholar?.name ?? scholar?.username ?? "(unknown)",
          submittedAt: d.submittedAt,
          rubricPassed: d.rubricPassed ?? null,
          overall: d.overall ?? null,
          // Lets the grade control prefill the note input so a teacher
          // override edits the existing reason instead of silently dropping it.
          rubricFeedback: d.rubricFeedback ?? null,
          // For scans, the "text" is the AI caption (a short description).
          textContent: portfolioItem
            ? (portfolioItem.aiCaption ?? null)
            : textContent,
          mapContent,
          fileUrl,
          thumbUrl,
          videoThumbUrl,
          videoDurationMs: capture?.videoDurationMs ?? null,
          contentKind,
          // Provenance: true when any of this writing reached the page because
          // the tutor typed the scholar's own words down for them. Must follow
          // the SAME source as `textContent` above, not fall through
          // independently: a frozen submitted snapshot predates any later
          // transcription into the live artifact, so consulting the artifact
          // here would label older, wholly scholar-written text as transcribed.
          // Absent on a stored snapshot means "not transcribed", not "ask the
          // artifact" — which is also the correct reading for the pre-migration
          // rows that have no marker at all.
          hasTutorTranscription:
            d.textContent !== undefined
              ? (d.hasTutorTranscription ?? false)
              : (artifact?.hasTutorTranscription ?? false),
          lastAction:
            d.lastAction ??
            (d.rubricCheckedBy === "ai" ? "check" : "send"),
          familyVisibility: d.familyVisibility ?? "staff_only",
          familyShareable,
          // The session id is the transcript link. Base `staff` (a
          // curriculum:run owner) stops at the deliverable itself; teachers and
          // curriculum designers keep the link they always had.
          sessionId: ctx.user.role === ROLES.STAFF ? null : d.sessionId,
        };
      }),
    ).then((rows) =>
      rows.sort((a, b) => b.submittedAt - a.submittedAt),
    );
  },
});

// updateForQuest dropped — Quests removed. Use the general `update`
// mutation for activity edits.

/**
 * Attach a Google Slides deck to an activity. Used by the Picker flow
 * (teacher selected an existing deck) and by the Curriculum Bot after
 * it creates one.
 */
export const attachGoogleSlidesDeck = authedMutation({
  args: {
    id: v.id("activities"),
    presentationId: v.string(),
    url: v.string(),
    ownedByUs: v.boolean(), // did we (this Rabbithole user) create the deck?
    name: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUnitEditAccess(ctx, { activityId: args.id });
    await ctx.db.patch(args.id, {
      googleSlidesPresentationId: args.presentationId,
      googleSlidesUrl: args.url,
      // The Picker always acts through this user's personal OAuth credential.
      // Keep the argument for client compatibility; ownership is no longer a
      // permission signal.
      googleSlidesOwnerId: user._id,
      googleSlidesName: args.name,
      googleSlidesThumbnailUrl: args.thumbnailUrl,
    });
    await upsertGoogleSlides(ctx, {
      activityId: args.id,
      uploadedBy: user._id,
      presentationId: args.presentationId,
      url: args.url,
      name: args.name,
      thumbnailUrl: args.thumbnailUrl,
      principal: { kind: "personal_oauth", userId: user._id },
    });
  },
});

/** Detach the Google Slides deck (does NOT delete the deck in Drive). */
export const detachGoogleSlidesDeck = authedMutation({
  args: { id: v.id("activities") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.id });
    await ctx.db.patch(args.id, {
      googleSlidesPresentationId: undefined,
      googleSlidesUrl: undefined,
      googleSlidesOwnerId: undefined,
      googleSlidesName: undefined,
      googleSlidesThumbnailUrl: undefined,
    });
    await removePresentation(ctx, args.id, "google_slides");
  },
});

// Internal counterpart for Google actions that already performed the
// user-scoped unit access check through getForExportInternal.
export const attachGoogleSlidesDeckInternal = internalMutation({
  args: {
    id: v.id("activities"),
    presentationId: v.string(),
    url: v.string(),
    name: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    principal: v.union(
      v.object({ kind: v.literal("personal_oauth"), userId: v.id("users") }),
      v.object({
        kind: v.literal("workspace_bot"),
        institutionId: v.id("institutions"),
        credentialId: v.id("institutionGoogleAccounts"),
      }),
      v.object({ kind: v.literal("legacy_unknown") }),
    ),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.id);
    if (!activity) throw new Error("Activity not found");
    const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
    const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
    if (!unit) throw new Error("Activity unit not found");
    await ctx.db.patch(args.id, {
      googleSlidesPresentationId: args.presentationId,
      googleSlidesUrl: args.url,
      googleSlidesOwnerId:
        args.principal.kind === "personal_oauth"
          ? args.principal.userId
          : undefined,
      googleSlidesName: args.name,
      googleSlidesThumbnailUrl: args.thumbnailUrl,
    });
    await upsertGoogleSlides(ctx, {
      activityId: args.id,
      uploadedBy: unit.teacherId,
      presentationId: args.presentationId,
      url: args.url,
      name: args.name,
      thumbnailUrl: args.thumbnailUrl,
      principal: args.principal,
    });
  },
});

export const remove = authedMutation({
  args: { id: v.id("activities") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.id });
    await deleteActivityCascade(ctx, args.id);
  },
});

/**
 * Soft-archive / unarchive an activity. Archiving retires the activity from
 * the ACTIVE curriculum: it disappears from scholar-facing reads + schedulable
 * pickers (server-side, so both frontends inherit it), and its schedule state
 * — placements and planned/live activitySchedule entries — is removed, so the
 * timetable never keeps pushing a class scholars can't see. History (sessions,
 * completions, deliverables, portfolio) stays intact and resolvable. It stays
 * visible, dimmed, on teacher design surfaces; unarchive restores the activity
 * but the teacher re-places it on the schedule explicitly.
 */
export const setArchived = authedMutation({
  args: { id: v.id("activities"), archived: v.boolean() },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.id });
    if (args.archived) {
      await removeScheduleStateForActivity(ctx, args.id);
    }
    await ctx.db.patch(args.id, {
      archivedAt: args.archived ? Date.now() : undefined,
    });
  },
});

export const reorder = authedMutation({
  args: { activityIds: v.array(v.id("activities")) },
  handler: async (ctx, args) => {
    if (args.activityIds.length === 0) return;
    // Gate on the first activity's unit; reorder is always within a
    // single lesson (the UI never crosses lessons), so checking one is
    // sufficient.
    await requireUnitEditAccess(ctx, { activityId: args.activityIds[0] });
    for (let i = 0; i < args.activityIds.length; i++) {
      await ctx.db.patch(args.activityIds[i], { order: i });
    }
  },
});

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Internal: minimal projection for the slide-export + Slides API
 * actions (`slidesActions.*`). Lives here because
 * internal queries cannot be defined in `"use node"` files.
 */
export const getForExportInternal = internalQuery({
  args: { id: v.id("activities"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");
    const { unit } = await requireUnitEditAccessForUser(ctx, user, {
      activityId: args.id,
    });
    const a = await ctx.db.get(args.id);
    if (!a) return null;
    const presentations = await presentationState(ctx, a);
    if (
      presentations.google?.principal.kind === "workspace_bot" &&
      presentations.google.principal.institutionId !== unit.institutionId
    ) {
      throw new Error(
        "Google Slides credential does not belong to this activity's institution",
      );
    }
    if (presentations.google?.principal.kind === "workspace_bot") {
      const credential = await ctx.db.get(
        presentations.google.principal.credentialId,
      );
      if (
        credential?.institutionId !== unit.institutionId ||
        credential?.purpose !== "workspace_bot"
      ) {
        throw new Error(
          "Google Slides credential is no longer this institution's Workspace bot",
        );
      }
    }
    return {
      _id: a._id,
      title: a.title,
      googleSlidesPresentationId: presentations.google?.presentationId ?? null,
      googleSlidesUrl: presentations.google?.url ?? null,
      googleSlidesOwnerId:
        presentations.google?.principal.kind === "personal_oauth"
          ? presentations.google.principal.userId
          : null,
      googleSlidesName: presentations.google?.name ?? null,
      googleSlidesThumbnailUrl: presentations.google?.thumbnailUrl ?? null,
      googleSlidesPrincipal: presentations.google?.principal ?? null,
    };
  },
});

export const listByLessonInternal = internalQuery({
  args: { lessonId: v.id("lessons") },
  handler: async (ctx, args) => {
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    return acts.sort((a, b) => a.order - b.order);
  },
});

// ── Canonical activity write primitive ────────────────────────────────
//
// `upsertInternal` is the single mutation every activity-creation path
// funnels through (Curriculum Bot tools, teacherAide, seed scripts,
// the legacy `createInternal` wrapper). All activities belong to a
// lesson now — the legacy "scholar" parent kind was removed when
// one-off IS tasks were unified under scholar-authored IS Units.
//
// `match.byTitle` makes the call idempotent — passing the same title
// for the same parent returns the existing row (and patches in a
// missing deliverable / systemPrompt if the caller supplied a new
// one).
//
// Single guard location: deliverable normalization + the
// "online needs deliverable" check live here, so every path enforces
// the same rules.

const parentValidator = v.object({
  kind: v.literal("lesson"),
  lessonId: v.id("lessons"),
});

/**
 * An activity carries EITHER a deliverable OR an advanceRubric, never both.
 * Beyond the schema's intent this keeps two writers apart: a photo/text
 * submission and the conversation-rubric upsert both key their `deliverables`
 * row on `(sessionId, activityId, artifactId === undefined)`, so an activity
 * holding both would have them overwrite each other's verdicts (TRA-340).
 * Checks what is being ADDED against what the row already carries.
 */
function assertOneEvaluationBar(
  existing: Pick<Doc<"activities">, "deliverable" | "advanceRubric">,
  adding: {
    deliverable?: DeliverableSpec;
    advanceRubric?: AdvanceRubricSpec;
  },
) {
  if (adding.advanceRubric && existing.deliverable) {
    throw new Error(
      "This activity already has a document quality map; it can't also " +
        "take an advanceRubric (an activity has EITHER, not both). " +
        "Clear the deliverable first if you meant to switch bars.",
    );
  }
  if (adding.deliverable && existing.advanceRubric) {
    throw new Error(
      "This activity already has a conversation advance gate; it can't also " +
        "take a deliverable (an activity has EITHER, not both). " +
        "Clear the advanceRubric first if you meant to switch bars.",
    );
  }
}

export const upsertInternal = internalMutation({
  args: {
    parent: parentValidator,
    /** Idempotency hint. byTitle does a case-insensitive lookup within
     *  the parent scope; byId is a direct fetch. When neither is set
     *  the call is a pure insert. */
    match: v.optional(
      v.object({
        byTitle: v.optional(v.string()),
        byId: v.optional(v.id("activities")),
      }),
    ),
    title: v.string(),
    description: v.optional(v.string()),
    scholarDescription: v.optional(v.string()),
    kind: v.optional(kindLiteral),
    // TRA-519 A4: an online activity where scholars build or use an app
    // (kind "vibecode" is the legacy spelling; both store the new shape).
    appActivity: v.optional(v.boolean()),
    systemPrompt: v.optional(v.string()),
    tutorModel: v.optional(tutorModelLiteral),
    // Starter validation lives in resolveStaticAppForCoachedActivity; create_scholar_activity must never expose these args.
    starterAppId: v.optional(v.id("customApps")),
    scholarsStartFrom: v.optional(scholarsStartFromLiteral),
    // Teacher build request carried in by make_app_a_coached_activity's
    // hand-off path; never scholar-facing. create_scholar_activity must never
    // expose this arg.
    appRequest: v.optional(v.string()),
    // App activities only: the model contract + allowSilence (schema.ts).
    // Supplied = replace; omitted = keep.
    buildContract: v.optional(buildContractValidator),
    allowSilence: v.optional(v.boolean()),
    // App activities only: the scholar edit policy (TRA-301). Supplied =
    // replace; omitted = keep (absent on the row reads as "always").
    editAccess: v.optional(editAccessLiteral),
    processId: v.optional(v.id("processes")),
    durationMinutes: v.optional(v.number()),
    /** Optional zero-based insertion slot. Collisions shift an occupied run. */
    position: v.optional(v.number()),
    deliverable: v.optional(deliverableValidator),
    advanceRubric: v.optional(advanceRubricValidator),
    recipe: v.optional(
      v.union(v.literal("baseline"), v.literal("exitTicket")),
    ),
    // Explicitly about spelling/typing (schema.ts). Supplied = set/clear
    // (false clears); omitted = keep.
    assessesWritingMechanics: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const parent = args.parent;
    // The shape an insert would store (a legacy "vibecode" input folds to
    // online + appActivity, lib/appActivity.ts).
    const target = resolveActivityWriteTarget(null, {
      kind: args.kind ?? "online",
      appActivity: args.appActivity,
    });
    const kind = target.kind;
    const tutorModel = normalizeStoredTutorModel(args.tutorModel);
    const suppliedDeliverable = normalizeDeliverable(args.deliverable);
    const advanceRubric = normalizeAdvanceRubric(args.advanceRubric);
    if (suppliedDeliverable && advanceRubric) {
      throw new Error(
        "An activity takes EITHER a deliverable (document product) OR an " +
          "advanceRubric (conversation-graded, no document) — not both.",
      );
    }
    assertAppHasNoAdvanceRubric(target.isApp, advanceRubric);
    // An app activity's evaluation bar is the app itself.
    const deliverable =
      suppliedDeliverable ??
      (target.isApp
        ? defaultAppDeliverable({ scholarDescription: args.scholarDescription })
        : undefined);
    if (
      args.position !== undefined &&
      (!Number.isInteger(args.position) || args.position < 0)
    ) {
      throw new Error("position must be a non-negative integer");
    }
    // Recipes apply to (non-app) online + offline activities only.
    const recipe =
      target.effectiveKind === "online" || target.effectiveKind === "offline"
        ? args.recipe
        : undefined;

    requireDeliverableForOnline(kind, deliverable, advanceRubric);

    // ── Idempotency lookup ─────────────────────────────────────────
    let existing: Doc<"activities"> | null = null;
    if (args.match?.byId) {
      existing = await ctx.db.get(args.match.byId);
    } else if (args.match?.byTitle) {
      const titleLower = args.match.byTitle.trim().toLowerCase();
      const lessonId = parent.lessonId;
      const candidates = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
        .collect();
      existing =
        candidates.find(
          (a) => a.title.trim().toLowerCase() === titleLower,
        ) ?? null;
    }

    // ── Patch-existing branch ──────────────────────────────────────
    if (existing) {
      const existingIsApp = isAppActivity(existing);
      assertAppHasNoAdvanceRubric(existingIsApp, advanceRubric);
      // The deliverable this retry may attach: what the caller supplied, or
      // the default app deliverable when the row it found is an app activity.
      const retryDeliverable =
        suppliedDeliverable ??
        (existingIsApp && !existing.advanceRubric
          ? defaultAppDeliverable(existing)
          : undefined);
      // Preserve the one-bar invariant across idempotent retries: the
      // current-call check above only compares the two supplied args, so a
      // row that already carries one evaluation shape must be stopped from gaining
      // the other here (e.g. create-with-deliverable, then a retry that
      // supplies only an advanceRubric).
      assertOneEvaluationBar(existing, {
        deliverable: suppliedDeliverable,
        advanceRubric,
      });
      const patch: Record<string, unknown> = {};
      // Patch deliverable if the caller supplied one AND it differs
      // (or the existing row had none). This is the path that fixes
      // the bot's "I forgot the deliverable" recovery.
      if (retryDeliverable && !existing.deliverable) {
        patch.deliverable = retryDeliverable;
      }
      // Attach an advance (conversation) rubric on recovery too — the
      // path that fixes "I created a bare interactive activity, now add
      // its evaluation shape". Only set when supplied and the row lacks one.
      if (advanceRubric && !existing.advanceRubric) {
        patch.advanceRubric = advanceRubric;
      }
      if (
        args.systemPrompt !== undefined &&
        (args.systemPrompt.trim() || "") !==
          (existing.systemPrompt ?? "")
      ) {
        patch.systemPrompt = args.systemPrompt.trim() || undefined;
      }
      // The patch branch never changes an existing row's shape; a retry is
      // judged against the shape the row keeps. "Same shape" compares
      // effective kinds, so a legacy "vibecode" input matches a folded row.
      const sameShape =
        (args.kind === undefined && args.appActivity === undefined) ||
        target.effectiveKind === effectiveActivityKind(existing);
      if (!existingIsApp || !sameShape) {
        if (existing.tutorModel !== undefined) {
          patch.tutorModel = undefined;
        }
      } else if (
        args.tutorModel !== undefined &&
        tutorModel !== existing.tutorModel
      ) {
        patch.tutorModel = tutorModel;
      }
      if (
        args.starterAppId !== undefined &&
        args.starterAppId !== existing.starterAppId
      ) {
        patch.starterAppId = args.starterAppId;
      }
      if (
        args.scholarsStartFrom !== undefined &&
        args.scholarsStartFrom !== existing.scholarsStartFrom
      ) {
        patch.scholarsStartFrom = args.scholarsStartFrom;
      }
      // The contract is judged against the shape the row keeps. A retry
      // naming a DIFFERENT shape (e.g. vibecode + contract against a row
      // that is a plain online activity) gets the row as it is: its contract
      // fields are dropped rather than thrown, so a retry stays a no-throw
      // recovery and a contract is never stranded on an activity the designer
      // never runs.
      if (sameShape) {
        Object.assign(
          patch,
          buildContractPatch(
            existing,
            {
              buildContract: args.buildContract,
              allowSilence: args.allowSilence,
            },
            existing.buildContract,
          ),
        );
        if (args.editAccess !== undefined) {
          assertEditAccessKind(existingIsApp);
          if (args.editAccess !== existing.editAccess) {
            patch.editAccess = args.editAccess;
          }
        }
      }
      if (
        args.appRequest !== undefined &&
        (args.appRequest.trim() || "") !== (existing.appRequest ?? "")
      ) {
        patch.appRequest = args.appRequest.trim() || undefined;
      }
      if (
        args.description !== undefined &&
        (args.description.trim() || "") !==
          (existing.description ?? "")
      ) {
        patch.description = args.description.trim() || undefined;
      }
      if (
        args.scholarDescription !== undefined &&
        (args.scholarDescription.trim() || "") !==
          (existing.scholarDescription ?? "")
      ) {
        patch.scholarDescription =
          args.scholarDescription.trim() || undefined;
      }
      if (
        args.durationMinutes !== undefined &&
        args.durationMinutes !== existing.durationMinutes
      ) {
        patch.durationMinutes = args.durationMinutes;
      }
      if (recipe !== undefined && recipe !== existing.recipe) {
        patch.recipe = recipe;
      }
      if (
        args.assessesWritingMechanics !== undefined &&
        args.assessesWritingMechanics !== (existing.assessesWritingMechanics === true)
      ) {
        patch.assessesWritingMechanics = args.assessesWritingMechanics
          ? true
          : undefined;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
      if (suppliedDeliverable?.criteria.length) {
        await ensureFlairArtForActivity(
          ctx,
          existing._id,
          suppliedDeliverable.criteria,
        );
      }
      // `existed: true` whenever we found the row — it was already
      // there before this call. (Previously inverted in the
      // patch-then-return branch; callers reading this flag to
      // decide "did we create it" got the wrong answer.)
      return {
        activityId: existing._id,
        existed: true as const,
        // Effective kind: an app activity reports "vibecode" in either shape.
        kind: effectiveActivityKind(existing),
        deliverableAttached:
          existing.deliverable !== undefined || retryDeliverable !== undefined,
        advanceRubricAttached:
          existing.advanceRubric !== undefined || advanceRubric !== undefined,
      };
    }

    // ── Insert branch ──────────────────────────────────────────────
    if (args.editAccess !== undefined) assertEditAccessKind(target.isApp);
    const contract = buildContractPatch(storedShapeFields(target), {
      buildContract: args.buildContract,
      allowSilence: args.allowSilence,
    });
    const lessonId = parent.lessonId;
    const peers = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
      .collect();
    const order =
      args.position ??
      peers.reduce((m, a) => Math.max(m, a.order), -1) + 1;
    if (args.position !== undefined) {
      const occupiedOrders = new Set(peers.map((sibling) => sibling.order));
      let firstOpenOrder = order;
      while (occupiedOrders.has(firstOpenOrder)) firstOpenOrder += 1;
      for (const sibling of peers) {
        if (sibling.order >= order && sibling.order < firstOpenOrder) {
          await ctx.db.patch(sibling._id, { order: sibling.order + 1 });
        }
      }
    }

    const insertedId = await ctx.db.insert("activities", {
      lessonId,
      title: args.title.trim() || "New activity",
      description: args.description?.trim() || undefined,
      scholarDescription: args.scholarDescription?.trim() || undefined,
      ...storedShapeFields(target),
      systemPrompt: args.systemPrompt?.trim() || undefined,
      tutorModel: target.isApp ? tutorModel : undefined,
      starterAppId: args.starterAppId,
      scholarsStartFrom: args.scholarsStartFrom,
      appRequest: args.appRequest?.trim() || undefined,
      editAccess: args.editAccess,
      ...contract,
      processId: args.processId,
      durationMinutes: args.durationMinutes,
      order,
      deliverable,
      advanceRubric,
      recipe,
      assessesWritingMechanics: args.assessesWritingMechanics ? true : undefined,
    });
    if (deliverable?.criteria.length) {
      await ensureFlairArtForActivity(ctx, insertedId, deliverable.criteria);
    }

    return {
      activityId: insertedId,
      existed: false as const,
      kind: target.effectiveKind,
      deliverableAttached: deliverable !== undefined,
      advanceRubricAttached: advanceRubric !== undefined,
    };
  },
});

// Legacy wrapper — kept while call sites migrate. New code should
// call upsertInternal directly. Returns just the id to match the
// old signature.
const createInternalArgs = {
  lessonId: v.id("lessons"),
  title: v.string(),
  description: v.optional(v.string()),
  kind: kindLiteral,
  // TRA-519 A4 (kind "vibecode" input stores the same shape).
  appActivity: v.optional(v.boolean()),
  systemPrompt: v.optional(v.string()),
  tutorModel: v.optional(tutorModelLiteral),
  processId: v.optional(v.id("processes")),
  durationMinutes: v.optional(v.number()),
  deliverable: v.optional(deliverableValidator),
  buildContract: v.optional(buildContractValidator),
  allowSilence: v.optional(v.boolean()),
  assessesWritingMechanics: v.optional(v.boolean()),
};

/** The body of `createInternal`, shared with the app installer
 *  (`appInstall.installAppAsActivity`) so there is one activity-insert path. */
export async function createActivityCore(
  ctx: MutationCtx,
  args: ObjectType<typeof createInternalArgs>,
): Promise<Id<"activities">> {
  const target = resolveActivityWriteTarget(null, {
    kind: args.kind,
    appActivity: args.appActivity,
  });
  const deliverable =
    normalizeDeliverable(args.deliverable) ??
    (target.isApp ? defaultAppDeliverable({}) : undefined);
  requireDeliverableForOnline(target.kind, deliverable);
  const contract = buildContractPatch(storedShapeFields(target), {
    buildContract: args.buildContract,
    allowSilence: args.allowSilence,
  });
  const peers = await ctx.db
    .query("activities")
    .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
    .collect();
  const maxOrder = peers.reduce((max, a) => Math.max(max, a.order), -1);
  const activityId = await ctx.db.insert("activities", {
    lessonId: args.lessonId,
    title: args.title.trim() || "New activity",
    description: args.description?.trim() || undefined,
    ...storedShapeFields(target),
    systemPrompt: args.systemPrompt?.trim() || undefined,
    tutorModel: target.isApp
      ? normalizeStoredTutorModel(args.tutorModel)
      : undefined,
    processId: args.processId,
    durationMinutes: args.durationMinutes,
    order: maxOrder + 1,
    deliverable,
    ...contract,
    assessesWritingMechanics: args.assessesWritingMechanics ? true : undefined,
  });
  if (deliverable?.criteria.length) {
    await ensureFlairArtForActivity(ctx, activityId, deliverable.criteria);
  }
  return activityId;
}

export const createInternal = internalMutation({
  args: createInternalArgs,
  handler: createActivityCore,
});

export const updateInternal = internalMutation({
  args: {
    id: v.id("activities"),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    scholarDescription: v.optional(v.union(v.string(), v.null())),
    kind: v.optional(kindLiteral),
    // TRA-519 A4 — same semantics as `update`.
    appActivity: v.optional(v.boolean()),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    tutorModel: v.optional(v.union(tutorModelLiteral, v.null())),
    scholarsStartFrom: v.optional(scholarsStartFromLiteral),
    // App activities only: the App designer scholar edit policy (TRA-301).
    editAccess: v.optional(editAccessLiteral),
    // App activities only: the model contract (null clears) + allowSilence.
    buildContract: v.optional(v.union(buildContractValidator, v.null())),
    allowSilence: v.optional(v.boolean()),
    processId: v.optional(v.union(v.id("processes"), v.null())),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
    deliverable: v.optional(v.union(deliverableValidator, v.null())),
    hasScholarAngles: v.optional(v.boolean()),
    // Explicitly about spelling/typing (schema.ts); false clears.
    assessesWritingMechanics: v.optional(v.boolean()),
    defaultMode: v.optional(
      v.union(
        v.literal("classFocus"),
        v.literal("homework"),
        v.literal("either"),
      ),
    ),
    recipe: v.optional(
      v.union(v.literal("baseline"), v.literal("exitTicket"), v.null()),
    ),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    const updates: Record<string, unknown> = {};
    const currentActivity = await ctx.db.get(id);
    if (!currentActivity) throw new Error("Activity not found");
    const target = resolveActivityWriteTarget(currentActivity, {
      kind: fields.kind,
      appActivity: fields.appActivity,
    });
    let flairCriteria:
      | Array<{ id: string; label: string; description?: string }>
      | undefined;
    if (fields.title !== undefined) updates.title = fields.title.trim();
    if (fields.description !== undefined)
      updates.description = fields.description?.trim() || undefined;
    if (fields.scholarDescription !== undefined)
      updates.scholarDescription =
        fields.scholarDescription?.trim() || undefined;
    if (target.shapeSupplied) Object.assign(updates, storedShapeFields(target));
    if (fields.systemPrompt !== undefined)
      updates.systemPrompt = fields.systemPrompt?.trim() || undefined;
    if (fields.tutorModel !== undefined) {
      updates.tutorModel = target.isApp
        ? normalizeStoredTutorModel(fields.tutorModel)
        : undefined;
    }
    if (fields.scholarsStartFrom !== undefined)
      updates.scholarsStartFrom = fields.scholarsStartFrom;
    if (fields.editAccess !== undefined) {
      assertEditAccessKind(target.isApp);
      updates.editAccess = fields.editAccess;
    }
    if (fields.processId !== undefined)
      updates.processId = fields.processId ?? undefined;
    if (fields.durationMinutes !== undefined)
      updates.durationMinutes = fields.durationMinutes ?? undefined;
    if (fields.deliverable !== undefined) {
      const normalized = fields.deliverable
        ? normalizeDeliverable(fields.deliverable)
        : undefined;
      if (normalized) {
        assertOneEvaluationBar(currentActivity, { deliverable: normalized });
      }
      updates.deliverable = normalized;
      flairCriteria = normalized?.criteria;
    }
    if (fields.hasScholarAngles !== undefined)
      updates.hasScholarAngles = fields.hasScholarAngles;
    if (fields.assessesWritingMechanics !== undefined)
      updates.assessesWritingMechanics = fields.assessesWritingMechanics
        ? true
        : undefined;
    if (fields.defaultMode !== undefined)
      updates.defaultMode = fields.defaultMode;
    if (fields.recipe !== undefined)
      updates.recipe = fields.recipe ?? undefined;
    // Recipes apply to (non-app) online + offline only — clear when flipping
    // to a kind that can't carry one.
    if (
      target.shapeSupplied &&
      target.effectiveKind !== "online" &&
      target.effectiveKind !== "offline"
    ) {
      updates.recipe = undefined;
    }
    Object.assign(
      updates,
      buildContractPatch(
        storedShapeFields(target),
        {
          buildContract: fields.buildContract,
          allowSilence: fields.allowSilence,
        },
        currentActivity.buildContract,
      ),
    );
    if (target.shapeSupplied && !target.isApp) {
      // The contract steers the App designer only — drop it on a kind flip.
      Object.assign(updates, APP_ONLY_CLEARED_FIELDS);
    }
    Object.assign(updates, appDeliverablePatch(currentActivity, target, updates));
    await ctx.db.patch(id, updates);
    if (flairCriteria?.length) {
      await ensureFlairArtForActivity(ctx, id, flairCriteria);
    }
  },
});

/** B6: what a Quest's co-design hears when it tries to put a build step
 * before any learning step. Model-facing; worded so it can act on it. */
export const QUEST_BUILD_NEEDS_LEARNING_STEP =
  "Add a learning step first — the build comes after they've figured it out. " +
  "Create an online activity with a deliverable where they work out how it " +
  "works, then add the app activity after it.";

/**
 * Internal: activity-create variant invoked by the scholar IS
 * planning tutor (convex/http.ts /session-stream). Verifies the
 * scholar owns the IS unit before writing — same gate as
 * `lessons.aiCreateForIsUnit`.
 *
 * A scholar's own quest activity earns rubric stars just like a
 * teacher-authored one. Online activities get an AUTO-mode `text`
 * deliverable by default: the scholar writes their work into a
 * document, per-scholar rubric criteria are generated at session start
 * (convex/sessions.ts → generateCriteriaForSession), and the tutor
 * scores them on the same pass/check path as any assigned activity
 * (PR #644, via session.deliverableCriteria). Without this, the
 * create_activity path bypassed requireDeliverableForOnline and a kid's
 * quest could never pay stars (week-1 pilot finding). The planning tutor
 * MAY supply a concrete deliverable prompt/notes; when it doesn't, we
 * derive a sensible default so the quest is never left rubric-less.
 * Offline activities are real-world tasks with no tutor session, so no
 * deliverable (unchanged).
 */
export const aiCreateForIsUnit = internalMutation({
  args: {
    lessonId: v.id("lessons"),
    scholarId: v.id("users"),
    unitId: v.id("units"),
    title: v.string(),
    kind: kindLiteral,
    // TRA-519 A4 (kind "vibecode" input stores the same shape).
    appActivity: v.optional(v.boolean()),
    systemPrompt: v.string(),
    tutorModel: v.optional(tutorModelLiteral),
    // Optional tutor-supplied deliverable for online activities. When
    // omitted, an auto-mode text deliverable is synthesized from the
    // title/systemPrompt so the default is always scorable.
    deliverable: v.optional(
      v.object({
        prompt: v.string(),
        notes: v.optional(v.string()),
      }),
    ),
    // The planning session whose tutor is building the unit (TRA-464).
    sessionId: v.optional(v.id("sessions")),
    // The activity's MISSION (TRA-519 B1/B4): gate + freedoms on any online
    // activity; invariants (the mechanism as cause→effect) only on an app.
    mission: v.optional(
      v.object({
        gate: v.optional(v.string()),
        freedoms: v.optional(v.array(v.string())),
        invariants: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unit not found");
    if (unit.authorScholarId !== args.scholarId) {
      throw new Error("Forbidden: not your IS unit");
    }
    const lesson = await ctx.db.get(args.lessonId);
    if (!lesson || lesson.unitId !== args.unitId) {
      throw new Error("Lesson not in this unit");
    }

    const target = resolveActivityWriteTarget(null, {
      kind: args.kind,
      appActivity: args.appActivity,
    });
    // B6 learn before you build: in a Quest, a build step comes after at
    // least one learning step. The new activity lands at the end of this
    // lesson, so this lesson and every earlier lesson precede it.
    if (target.isApp) {
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
        .collect();
      let learnedFirst = false;
      for (const l of lessons) {
        if (l._id !== args.lessonId && (l.order ?? 0) >= (lesson.order ?? 0)) {
          continue;
        }
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        if (acts.some((a) => isLearningStep(a))) {
          learnedFirst = true;
          break;
        }
      }
      if (!learnedFirst) throw new Error(QUEST_BUILD_NEEDS_LEARNING_STEP);
    }
    // Default a scorable auto-mode text deliverable onto online activities;
    // an app activity's deliverable is the app itself, graded like any Quest
    // step (auto: per-scholar criteria are generated at session start).
    let deliverable: DeliverableSpec | undefined;
    if (target.isApp) {
      deliverable = normalizeDeliverable({
        kind: "artifact",
        prompt:
          args.deliverable?.prompt?.trim() ||
          `Your app, running, showing ${args.title.trim() || "what you figured out"}.`,
        mode: "auto",
        notes:
          args.deliverable?.notes?.trim() ||
          args.systemPrompt.trim() ||
          undefined,
        criteria: [],
      });
    } else if (args.kind === "online") {
      const prompt =
        args.deliverable?.prompt?.trim() ||
        "Show what you learned in this activity — write up your key " +
          "findings, ideas, or the thing you made.";
      const notes =
        args.deliverable?.notes?.trim() ||
        args.systemPrompt.trim() ||
        undefined;
      deliverable = normalizeDeliverable({
        kind: "text",
        prompt,
        mode: "auto",
        notes,
        criteria: [],
      });
    }
    requireDeliverableForOnline(target.kind, deliverable);

    const peers = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    const maxOrder = peers.reduce((m, a) => Math.max(m, a.order), -1);
    const activityId = await ctx.db.insert("activities", {
      lessonId: args.lessonId,
      title: args.title.trim() || "New activity",
      ...storedShapeFields(target),
      systemPrompt: args.systemPrompt.trim() || undefined,
      tutorModel: target.isApp
        ? normalizeStoredTutorModel(args.tutorModel)
        : undefined,
      order: maxOrder + 1,
      deliverable,
      ...(args.mission
        ? buildContractPatch(storedShapeFields(target), {
            buildContract: {
              invariants: args.mission.invariants ?? [],
              freedoms: args.mission.freedoms ?? [],
              ...(args.mission.gate ? { gate: args.mission.gate } : {}),
            },
          })
        : {}),
    });
    await markUnitBuiltInSession(ctx, {
      sessionId: args.sessionId,
      scholarId: args.scholarId,
      unitId: args.unitId,
    });
    return activityId;
  },
});

export const removeInternal = internalMutation({
  args: { id: v.id("activities") },
  handler: async (ctx, args) => {
    await deleteActivityCascade(ctx, args.id);
  },
});

/** Internal twin of `setArchived` for the Curriculum Bot's archive_activity tool. */
export const setArchivedInternal = internalMutation({
  args: { id: v.id("activities"), archived: v.boolean() },
  handler: async (ctx, args) => {
    if (args.archived) {
      await removeScheduleStateForActivity(ctx, args.id);
    }
    await ctx.db.patch(args.id, {
      archivedAt: args.archived ? Date.now() : undefined,
    });
  },
});

export const reorderInternal = internalMutation({
  args: { activityIds: v.array(v.id("activities")) },
  handler: async (ctx, args) => {
    for (let i = 0; i < args.activityIds.length; i++) {
      await ctx.db.patch(args.activityIds[i], { order: i });
    }
  },
});

// Note: a one-shot `migrateEmbeddedActivities` mutation lived here while we
// transitioned from `lessons.activities[]` (embedded array) to the activities
// table. It's been removed now that all dev/prod data is migrated and the
// embedded field is gone from the schema.

// (Legacy createForQuestInternal / updateForQuestInternal were
// removed in the Bot DRY Layer 2 commit — the quest designer stream
// now calls upsertInternal / updateInternal directly.)

/**
 * A teacher saves a Rabbit Slides deck they edited in Rabbithole — the honest twin
 * of the Curriculum Bot's write (`lib/unitDesignerTools:storeActivitySlidesDeck`).
 *
 * Whole-deck rather than an op batch, because the teacher editor is a controlled
 * host that already holds the applied `Deck`. That makes two guards mandatory
 * rather than optional, and both were argued away in the design note this
 * implements — wrongly:
 *
 *  • `baseRevision` is REQUIRED. "The teacher is the sole human editor" is true
 *    and irrelevant: the BOT writes this same field, so a whole-deck save on a
 *    stale view silently discards whatever it authored in between. Convex's
 *    serializability does not protect against that — it is the one operation
 *    that can destroy concurrent work, which is why the scholar path forbids it.
 *  • Image assets are CHECKED. `deckJson` is client-supplied, so without this a
 *    caller could embed any storage id — `_storage` is one namespace shared with
 *    scanned health documents — and then present or export it. Same exfiltration
 *    path closed on the scholar side; a teacher's deck is not a reason to reopen it.
 */
export const saveTeacherSlidesDeck = authedMutation({
  args: {
    id: v.id("activities"),
    deckJson: v.string(),
    baseRevision: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; revision: number; slideCount: number }
    | { ok: false; error: string; staleRevision?: number }
  > => {
    await requireUnitEditAccess(ctx, { activityId: args.id });
    const activity = await ctx.db.get(args.id);
    if (!activity) return { ok: false, error: "Activity not found." };

    const presentations = await presentationState(ctx, activity);
    let current = null;
    if (!presentations.rabbit && activity.slidesDeck) {
      return {
        ok: false,
        error: "The saved deck is corrupt. Reopen or replace it before editing.",
      };
    }
    if (presentations.rabbit?.deck) {
      try {
        current = validateDeckLenient(JSON.parse(presentations.rabbit.deck));
      } catch {
        return {
          ok: false,
          error: "The saved deck is corrupt. Reopen or replace it before editing.",
        };
      }
    }
    if (current && current.revision !== args.baseRevision) {
      return {
        ok: false,
        error:
          "Someone else changed this deck while you were editing. Reopen it to pick up their changes.",
        staleRevision: current.revision,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(args.deckJson);
    } catch {
      return { ok: false, error: "deckJson must be valid JSON." };
    }
    const validated = validateDeck(raw);
    if (!validated.ok) {
      return { ok: false, error: `Deck validation failed: ${validated.errors.join("; ")}` };
    }

    // Every media asset must be one this user uploaded (see registerSlideAsset).
    for (const slide of validated.deck.slides) {
      for (const eid of slide.elementIds) {
        const el = slide.elements[eid];
        if (el?.type !== "image" && el?.type !== "video") continue;
        const row = await ctx.db
          .query("slideAssets")
          .withIndex("by_storage", (q) => q.eq("storageId", el.assetId as Id<"_storage">))
          .first();
        if (!row || row.uploaderId !== ctx.user._id) {
          return { ok: false, error: "That media isn't available to this deck." };
        }
      }
    }

    const deck = JSON.stringify(validated.deck);
    await ctx.db.patch(args.id, { slidesDeck: deck });
    await upsertRabbitSlides(ctx, {
      activityId: args.id,
      uploadedBy: ctx.user._id,
      deck,
      title: validated.deck.title,
    });
    return {
      ok: true,
      revision: validated.deck.revision,
      slideCount: validated.deck.slides.length,
    };
  },
});
