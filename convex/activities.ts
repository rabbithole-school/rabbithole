// AUTH GATING:
// - All `*Public` queries (e.g. `listByLessonPublic`, `getPublic`) are
//   scholar-safe (`authedQuery`). Use these from any scholar surface.
// - Everything else (`list`, `get`, `create`, `update`, `remove`, `reorder`)
//   is curriculum-gated (`curriculumQuery` / `curriculumMutation`) and will
//   403 for scholars.
// Scholars hit the 403 wall twice during PR #10 development — when adding a
// new scholar surface, double-check which variant you're calling.

import { v } from "convex/values";
import {
  authedMutation,
  authedQuery,
  staffQuery,
  teacherQuery,
} from "./lib/customFunctions";
import {
  requireUnitEditAccess,
  requireUnitEditAccessForUser,
} from "./lib/auth";
import { validateDeck, validateDeckLenient } from "../shared/slidesScene";
import { requireUnitAccess } from "./lib/unitAccess";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  deliverableValidator,
  advanceRubricValidator,
  normalizeDeliverable,
  normalizeAdvanceRubric,
  requireDeliverableForOnline,
  type DeliverableSpec,
} from "./lib/deliverable";
import { ensureFlairArtForActivity } from "./flairArt";
import { resolveActivityWebTarget } from "./lib/webActivityTarget";
import { duplicateActivityDesign } from "./lib/curriculumDuplication";
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
import { portfolioFamilySharingEligibility } from "./lib/schoolMediaConsent";

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
  // Vibecode app-builder workshop. The activity's systemPrompt IS the build
  // brief — no dedicated payload field; kind alone routes the scholar into
  // the full-screen VibecodeScreen (see convex/sessions.ts create).
  v.literal("vibecode"),
);

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
        kind: a.kind,
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
        kind: a.kind,
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
    return Promise.all(
      acts
        .sort((a, b) => a.order - b.order)
        .map(async (a) => {
          const process = a.processId ? await ctx.db.get(a.processId) : null;
          return {
            ...a,
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
    return activity;
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
      kind: a.kind,
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
      kind: a.kind,
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
    systemPrompt: v.optional(v.string()),
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
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { lessonId: args.lessonId });
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
      kind: args.kind,
      systemPrompt: args.systemPrompt?.trim() || undefined,
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

export const update = authedMutation({
  args: {
    id: v.id("activities"),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    scholarDescription: v.optional(v.union(v.string(), v.null())),
    kind: v.optional(kindLiteral),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    processId: v.optional(v.union(v.id("processes"), v.null())),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
    // Pass the full spec to set / replace, or null to clear it.
    deliverable: v.optional(v.union(deliverableValidator, v.null())),
    hasScholarAngles: v.optional(v.boolean()),
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
    let flairCriteria:
      | Array<{ id: string; label: string; description?: string }>
      | undefined;
    if (fields.title !== undefined) updates.title = fields.title.trim();
    if (fields.description !== undefined)
      updates.description = fields.description?.trim() || undefined;
    if (fields.scholarDescription !== undefined)
      updates.scholarDescription =
        fields.scholarDescription?.trim() || undefined;
    if (fields.kind !== undefined) updates.kind = fields.kind;
    if (fields.systemPrompt !== undefined)
      updates.systemPrompt = fields.systemPrompt?.trim() || undefined;
    if (fields.processId !== undefined)
      updates.processId = fields.processId ?? undefined;
    if (fields.durationMinutes !== undefined)
      updates.durationMinutes = fields.durationMinutes ?? undefined;
    if (fields.deliverable !== undefined) {
      const normalized = fields.deliverable
        ? normalizeDeliverable(fields.deliverable)
        : undefined;
      updates.deliverable = normalized;
      flairCriteria = normalized?.criteria;
    }
    if (fields.hasScholarAngles !== undefined)
      updates.hasScholarAngles = fields.hasScholarAngles;
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
    if (fields.kind !== undefined && fields.kind !== "shareBack") {
      updates.shareBackRecipe = undefined;
      updates.sourceActivityIds = undefined;
      updates.facilitationFocus = undefined;
    }
    // Angles only apply to online activities — clear when flipping away.
    if (fields.kind !== undefined && fields.kind !== "online") {
      updates.hasScholarAngles = undefined;
    }
    // Conversation recipes (baseline/exitTicket) apply to online activities
    // (tutor-run) AND offline activities (the uploaded artifact is assessed
    // — convex/granuleAssessment.ts). Clear only when flipping to a kind that
    // can't carry one (web / shareBack).
    if (
      fields.kind !== undefined &&
      fields.kind !== "online" &&
      fields.kind !== "offline"
    ) {
      updates.recipe = undefined;
    }
    // Web fields only apply to web activities — clear when flipping away.
    if (fields.kind !== undefined && fields.kind !== "web") {
      updates.webUrl = undefined;
      updates.webAllowedHosts = undefined;
      updates.externalAppId = undefined;
    }
    // Same for the game reference.
    if (fields.kind !== undefined && fields.kind !== "game") {
      updates.game = undefined;
    }
    // When flipping TO kind="shareBack", seed a sensible default so
    // 80% of the time the teacher doesn't have to touch anything:
    //  - default recipe to "reflection" (if unset)
    //  - default sourceActivityIds to the previous online activity in
    //    the same unit (if unset). Falls back to no sources when there
    //    isn't one — the warnings banner already nudges the teacher.
    if (fields.kind === "shareBack") {
      const existing = await ctx.db.get(id);
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
      if (pool[i].kind === "online") return pool[i];
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
    const activity = await ctx.db.get(args.activityId);
    if (!activity?.lessonId) return [];
    const lesson = await ctx.db.get(activity.lessonId);
    if (!lesson) return [];
    await requireUnitAccess(ctx, lesson.unitId);

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
        // Magic Annotations: the "magic version" of the scan (Magic Corners
        // redrawn), same file kind as the original. Exposed ALONGSIDE fileUrl
        // (which stays the original) — the data layer carries both and the UI
        // chooses which to show. null when the scan had no marker.
        const magicUrl = portfolioItem?.magicStorageId
          ? await ctx.storage.getUrl(portfolioItem.magicStorageId)
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
          magicUrl,
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
          sessionId: d.sessionId,
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
    systemPrompt: v.optional(v.string()),
    processId: v.optional(v.id("processes")),
    durationMinutes: v.optional(v.number()),
    /** Optional zero-based insertion slot. Collisions shift an occupied run. */
    position: v.optional(v.number()),
    deliverable: v.optional(deliverableValidator),
    advanceRubric: v.optional(advanceRubricValidator),
    recipe: v.optional(
      v.union(v.literal("baseline"), v.literal("exitTicket")),
    ),
  },
  handler: async (ctx, args) => {
    const parent = args.parent;
    const kind = args.kind ?? "online";
    const deliverable = normalizeDeliverable(args.deliverable);
    const advanceRubric = normalizeAdvanceRubric(args.advanceRubric);
    if (deliverable && advanceRubric) {
      throw new Error(
        "An activity takes EITHER a deliverable (document product) OR an " +
          "advanceRubric (conversation-graded, no document) — not both.",
      );
    }
    if (
      args.position !== undefined &&
      (!Number.isInteger(args.position) || args.position < 0)
    ) {
      throw new Error("position must be a non-negative integer");
    }
    // Recipes apply to online + offline activities only.
    const recipe =
      kind === "online" || kind === "offline" ? args.recipe : undefined;

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
      // Preserve the one-bar invariant across idempotent retries: the
      // current-call check above only compares the two supplied args, so a
      // row that already carries one evaluation shape must be stopped from gaining
      // the other here (e.g. create-with-deliverable, then a retry that
      // supplies only an advanceRubric).
      if (advanceRubric && existing.deliverable) {
        throw new Error(
          "This activity already has a document quality map; it can't also " +
            "take an advanceRubric (an activity has EITHER, not both). " +
            "Clear the deliverable first if you meant to switch bars.",
        );
      }
      if (deliverable && existing.advanceRubric) {
        throw new Error(
          "This activity already has a conversation advance gate; it can't also " +
            "take a deliverable (an activity has EITHER, not both). " +
            "Clear the advanceRubric first if you meant to switch bars.",
        );
      }
      const patch: Record<string, unknown> = {};
      // Patch deliverable if the caller supplied one AND it differs
      // (or the existing row had none). This is the path that fixes
      // the bot's "I forgot the deliverable" recovery.
      if (deliverable && !existing.deliverable) {
        patch.deliverable = deliverable;
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
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
      if (deliverable?.criteria.length) {
        await ensureFlairArtForActivity(
          ctx,
          existing._id,
          deliverable.criteria,
        );
      }
      // `existed: true` whenever we found the row — it was already
      // there before this call. (Previously inverted in the
      // patch-then-return branch; callers reading this flag to
      // decide "did we create it" got the wrong answer.)
      return {
        activityId: existing._id,
        existed: true as const,
        kind: existing.kind,
        deliverableAttached:
          existing.deliverable !== undefined || deliverable !== undefined,
        advanceRubricAttached:
          existing.advanceRubric !== undefined || advanceRubric !== undefined,
      };
    }

    // ── Insert branch ──────────────────────────────────────────────
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
      kind,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      processId: args.processId,
      durationMinutes: args.durationMinutes,
      order,
      deliverable,
      advanceRubric,
      recipe,
    });
    if (deliverable?.criteria.length) {
      await ensureFlairArtForActivity(ctx, insertedId, deliverable.criteria);
    }

    return {
      activityId: insertedId,
      existed: false as const,
      kind,
      deliverableAttached: deliverable !== undefined,
      advanceRubricAttached: advanceRubric !== undefined,
    };
  },
});

// Legacy wrapper — kept while call sites migrate. New code should
// call upsertInternal directly. Returns just the id to match the
// old signature.
export const createInternal = internalMutation({
  args: {
    lessonId: v.id("lessons"),
    title: v.string(),
    description: v.optional(v.string()),
    kind: kindLiteral,
    systemPrompt: v.optional(v.string()),
    processId: v.optional(v.id("processes")),
    durationMinutes: v.optional(v.number()),
    deliverable: v.optional(deliverableValidator),
  },
  handler: async (ctx, args) => {
    const deliverable = normalizeDeliverable(args.deliverable);
    requireDeliverableForOnline(args.kind, deliverable);
    const peers = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    const maxOrder = peers.reduce((max, a) => Math.max(max, a.order), -1);
    const activityId = await ctx.db.insert("activities", {
      lessonId: args.lessonId,
      title: args.title.trim() || "New activity",
      description: args.description?.trim() || undefined,
      kind: args.kind,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      processId: args.processId,
      durationMinutes: args.durationMinutes,
      order: maxOrder + 1,
      deliverable,
    });
    if (deliverable?.criteria.length) {
      await ensureFlairArtForActivity(ctx, activityId, deliverable.criteria);
    }
    return activityId;
  },
});

export const updateInternal = internalMutation({
  args: {
    id: v.id("activities"),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    scholarDescription: v.optional(v.union(v.string(), v.null())),
    kind: v.optional(kindLiteral),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    processId: v.optional(v.union(v.id("processes"), v.null())),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
    deliverable: v.optional(v.union(deliverableValidator, v.null())),
    hasScholarAngles: v.optional(v.boolean()),
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
    let flairCriteria:
      | Array<{ id: string; label: string; description?: string }>
      | undefined;
    if (fields.title !== undefined) updates.title = fields.title.trim();
    if (fields.description !== undefined)
      updates.description = fields.description?.trim() || undefined;
    if (fields.scholarDescription !== undefined)
      updates.scholarDescription =
        fields.scholarDescription?.trim() || undefined;
    if (fields.kind !== undefined) updates.kind = fields.kind;
    if (fields.systemPrompt !== undefined)
      updates.systemPrompt = fields.systemPrompt?.trim() || undefined;
    if (fields.processId !== undefined)
      updates.processId = fields.processId ?? undefined;
    if (fields.durationMinutes !== undefined)
      updates.durationMinutes = fields.durationMinutes ?? undefined;
    if (fields.deliverable !== undefined) {
      const normalized = fields.deliverable
        ? normalizeDeliverable(fields.deliverable)
        : undefined;
      updates.deliverable = normalized;
      flairCriteria = normalized?.criteria;
    }
    if (fields.hasScholarAngles !== undefined)
      updates.hasScholarAngles = fields.hasScholarAngles;
    if (fields.defaultMode !== undefined)
      updates.defaultMode = fields.defaultMode;
    if (fields.recipe !== undefined)
      updates.recipe = fields.recipe ?? undefined;
    // Recipes apply to online + offline only — clear when flipping to a kind
    // that can't carry one.
    if (
      fields.kind !== undefined &&
      fields.kind !== "online" &&
      fields.kind !== "offline"
    ) {
      updates.recipe = undefined;
    }
    await ctx.db.patch(id, updates);
    if (flairCriteria?.length) {
      await ensureFlairArtForActivity(ctx, id, flairCriteria);
    }
  },
});

/**
 * Internal: activity-create variant invoked by the scholar IS
 * planning tutor (convex/http.ts /project-stream). Verifies the
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
    systemPrompt: v.string(),
    // Optional tutor-supplied deliverable for online activities. When
    // omitted, an auto-mode text deliverable is synthesized from the
    // title/systemPrompt so the default is always scorable.
    deliverable: v.optional(
      v.object({
        prompt: v.string(),
        notes: v.optional(v.string()),
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

    // Default a scorable auto-mode text deliverable onto online activities.
    let deliverable: DeliverableSpec | undefined;
    if (args.kind === "online") {
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
    requireDeliverableForOnline(args.kind, deliverable);

    const peers = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    const maxOrder = peers.reduce((m, a) => Math.max(m, a.order), -1);
    return await ctx.db.insert("activities", {
      lessonId: args.lessonId,
      title: args.title.trim() || "New activity",
      kind: args.kind,
      systemPrompt: args.systemPrompt.trim() || undefined,
      order: maxOrder + 1,
      deliverable,
    });
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
