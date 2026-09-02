// Bot DRY Layer 5 (unit scope) — the Curriculum Bot's unit-CRUD toolset.
//
// Sibling to aideTools.ts (global Curriculum Assistant scope). Pulls the
// ~700 lines of unit-designer tool definitions (read_unit_structure,
// lesson/activity CRUD, prompt generation, slide decks) out of the
// unitDesignerStream http action so both aide scopes assemble their tools
// from lib/* and the unified aide endpoint can dispatch on scope.
//
// The scholar-read tools are shared via makeScholarReadTools (the bot can
// look up the scholar it's designing for); everything else here is
// unit-scoped CRUD closed over the request's teacherId + unitId.
//
// Runtime note: dynamically imports betaTool, no static SDK import (keeps
// node:* out of the edge bundle).

import {
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { isTeacherRole, type Role } from "./roles";
import {
  deliverableSchemaFragment,
  advanceRubricSchemaFragment,
  parseDeliverableArg,
  parseAdvanceRubricArg,
  refusedRecoveryMessage,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  type RawBotDeliverable,
  type RawBotAdvanceRubric,
} from "./botTools";
import {
  makeScholarReadTools,
  makeListScholarGroupsTool,
} from "./scholarReadTools";
import { makeScholarWriteTools } from "./scholarWriteTools";
import { makePhysicalEnvTools } from "./physicalEnvTools";
import { makeListGeomapAssetsTool } from "./geomapAssetsTool";
import { makeListSimulatorTemplatesTool } from "./simulatorTemplatesCatalog";
import { makeActivityKindTools } from "./activityKindTools";
import { makeAssignmentTools } from "./assignmentTools";
import { granuleTexts } from "./granules";
import type { AideEmit } from "./aideStream";
import {
  applySlideOps,
  emptyDeck,
  summarizeDeckForModel,
  validateDeck,
  type Deck,
  type IdFactory,
  type SlideOp,
} from "../../shared/slidesScene";
import {
  parsedPresentationDeck,
  presentationPrincipalForActingUser,
  presentationState,
  upsertRabbitSlides,
} from "./activityPresentationResources";
import {
  GoogleSlidesEditor,
  parseGoogleSlidesEditorInput,
} from "./googleSlidesEditor";
import {
  GoogleReconsentRequiredError,
  getValidAccessToken,
  getValidAccessTokenForCredential,
} from "./googleTokens";
import {
  GOOGLE_SLIDES_SCOPES,
  INSTITUTION_WORKSPACE_BOT_SCOPES,
} from "./google";

type CurriculumSlideSeed = {
  title: string;
  body: string;
  notes?: string;
};

type CreateActivitySlidesDeckArgs = {
  activityId: Id<"activities">;
  deckTitle: string;
  slides: CurriculumSlideSeed[];
};

type ApplyActivitySlideOpsArgs = {
  activityId: Id<"activities">;
  ownerId: Id<"users">;
  opsJson: string;
  baseRevision: number;
};

type ReadActivitySlidesDeckArgs = {
  activityId: Id<"activities">;
};

type ActivitySlidesDeckState = {
  slidesDeck?: string;
  googleSlidesPresentationId?: string;
  googleSlidesName?: string;
};

type ActivityDeckMutationResult =
  | {
      ok: true;
      revision: number;
      slideCount: number;
      summary: string;
      createdIds: string[];
    }
  | { ok: false; error: string };

const storeActivitySlidesDeckRef = makeFunctionReference<
  "mutation",
  CreateActivitySlidesDeckArgs,
  ActivityDeckMutationResult
>(
  "lib/unitDesignerTools:storeActivitySlidesDeck",
);

const applyActivitySlideOpsRef = makeFunctionReference<
  "mutation",
  ApplyActivitySlideOpsArgs,
  ActivityDeckMutationResult
>(
  "lib/unitDesignerTools:applyActivitySlideOps",
);

const readActivitySlidesDeckRef = makeFunctionReference<
  "query",
  ReadActivitySlidesDeckArgs,
  ActivitySlidesDeckState | null
>(
  "lib/unitDesignerTools:readActivitySlidesDeck",
);

/**
 * Mint retry-safe ids from the current deck. Counters are independent so a
 * deck's first slide and first element are naturally `sl1` and `el1`.
 */
function deckIdFactory(deck: Deck): IdFactory {
  const seed = { slide: 0, element: 0 };
  const bump = (id: string, prefix: string, kind: "slide" | "element") => {
    if (!id.startsWith(prefix)) return;
    const n = Number(id.slice(prefix.length));
    if (Number.isFinite(n) && n > seed[kind]) seed[kind] = n;
  };
  for (const slide of deck.slides) {
    bump(slide.id, "sl", "slide");
    for (const elementId of slide.elementIds) {
      bump(elementId, "el", "element");
    }
  }
  return (kind) =>
    kind === "slide" ? `sl${++seed.slide}` : `el${++seed.element}`;
}

function deckFromSlideList(
  title: string,
  seeds: CurriculumSlideSeed[],
): Deck | null {
  if (seeds.length === 0) return null;

  const deck = emptyDeck(title, "sl1");
  const mintId = deckIdFactory(deck);
  deck.slides = seeds.map((seed, index) => {
    const slideId = index === 0 ? deck.slides[0].id : mintId("slide");
    const titleId = mintId("element");
    const bodyId = mintId("element");
    return {
      id: slideId,
      background: "#ffffff",
      elementIds: [titleId, bodyId],
      elements: {
        [titleId]: {
          id: titleId,
          type: "text",
          frame: { x: 80, y: 56, w: 1120, h: 96, rotation: 0 },
          text: seed.title,
          style: {
            fontSize: 44,
            bold: true,
            italic: false,
            color: "#222656",
            align: "left",
            verticalAlign: "middle",
          },
        },
        [bodyId]: {
          id: bodyId,
          type: "text",
          frame: { x: 96, y: 184, w: 1088, h: 456, rotation: 0 },
          text: seed.body,
          style: {
            fontSize: 28,
            bold: false,
            italic: false,
            color: "#222656",
            align: "left",
            verticalAlign: "top",
          },
        },
      },
      ...(seed.notes?.trim() ? { speakerNotes: seed.notes.trim() } : {}),
    };
  });
  return deck;
}

export const storeActivitySlidesDeck = internalMutation({
  args: {
    activityId: v.id("activities"),
    deckTitle: v.string(),
    slides: v.array(
      v.object({
        title: v.string(),
        body: v.string(),
        notes: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<ActivityDeckMutationResult> => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return { ok: false, error: "Activity not found." };
    const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
    const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
    if (!unit) return { ok: false, error: "Activity unit not found." };

    const rawDeck = deckFromSlideList(args.deckTitle, args.slides);
    if (!rawDeck) {
      return {
        ok: false,
        error:
          "create_slides_deck requires at least one slide. Pass a non-empty slides array.",
      };
    }
    const validated = validateDeck(rawDeck);
    if (!validated.ok) {
      return {
        ok: false,
        error: `Deck validation failed: ${validated.errors.join("; ")}`,
      };
    }

    const deck = validated.deck;
    const encoded = JSON.stringify(deck);
    await ctx.db.patch(args.activityId, {
      slidesDeck: encoded,
    });
    await upsertRabbitSlides(ctx, {
      activityId: args.activityId,
      uploadedBy: unit.teacherId,
      deck: encoded,
      title: deck.title,
    });
    return {
      ok: true,
      revision: deck.revision,
      slideCount: deck.slides.length,
      summary: summarizeDeckForModel(deck),
      createdIds: [],
    };
  },
});

export const readActivitySlidesDeck = internalQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args): Promise<ActivitySlidesDeckState | null> => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return null;
    const presentations = await presentationState(ctx, activity);
    return {
      slidesDeck: presentations.rabbit?.deck,
      googleSlidesPresentationId: presentations.google?.presentationId,
      googleSlidesName: presentations.google?.name,
    };
  },
});

export const applyActivitySlideOps = internalMutation({
  args: {
    activityId: v.id("activities"),
    ownerId: v.id("users"),
    opsJson: v.string(),
    baseRevision: v.number(),
  },
  handler: async (ctx, args): Promise<ActivityDeckMutationResult> => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return { ok: false, error: "Activity not found." };
    const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
    const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
    if (!unit) return { ok: false, error: "Activity unit not found." };
    const presentations = await presentationState(ctx, activity);
    if (!presentations.rabbit?.deck) {
      return {
        ok: false,
        error: presentations.google
          ? "This activity has a Google Slides reference but no Rabbit Slides deck. Call create_slides_deck to add an editable deck without removing the Google reference."
          : "This activity has no Rabbit Slides deck. Call create_slides_deck first.",
      };
    }

    const deck = parsedPresentationDeck(presentations.rabbit.deck);
    if (!deck) {
      return {
        ok: false,
        error: "The stored Rabbit Slides deck is invalid and was not changed.",
      };
    }
    if (args.baseRevision !== deck.revision) {
      return {
        ok: false,
        error: `Your deck view is stale (you read revision ${args.baseRevision}; current revision is ${deck.revision}). Call read_deck again, then retry against that revision.`,
      };
    }

    let ops: unknown;
    try {
      ops = JSON.parse(args.opsJson);
    } catch {
      return { ok: false, error: "ops must be valid JSON." };
    }
    if (!Array.isArray(ops)) {
      return { ok: false, error: "ops must be an array." };
    }
    for (const op of ops as SlideOp[]) {
      const raw =
        op?.op === "addElement"
          ? (op.element as Record<string, unknown> | undefined)
          : undefined;
      const assetId =
        raw?.type === "image" || raw?.type === "video"
          ? String(raw.assetId ?? "")
          : "";
      if (!assetId) continue;
      const asset = await ctx.db
        .query("slideAssets")
        .withIndex("by_storage", (q) =>
          q.eq("storageId", assetId as Id<"_storage">),
        )
        .first();
      if (!asset || asset.uploaderId !== args.ownerId) {
        return { ok: false, error: "That media isn't available to this deck." };
      }
    }

    const applied = applySlideOps(
      deck,
      ops as SlideOp[],
      deckIdFactory(deck),
    );
    if (!applied.ok) return { ok: false, error: applied.error };

    const validated = validateDeck(applied.deck);
    if (!validated.ok) {
      return {
        ok: false,
        error: `Edited deck failed validation: ${validated.errors.join("; ")}`,
      };
    }
    const encoded = JSON.stringify(validated.deck);
    await ctx.db.patch(args.activityId, { slidesDeck: encoded });
    await upsertRabbitSlides(ctx, {
      activityId: args.activityId,
      uploadedBy: unit.teacherId,
      deck: encoded,
      title: validated.deck.title,
    });
    return {
      ok: true,
      revision: validated.deck.revision,
      slideCount: validated.deck.slides.length,
      summary: summarizeDeckForModel(validated.deck),
      createdIds: applied.createdIds,
    };
  },
});

/**
 * Build the unit-designer (Curriculum Bot) toolset: scholar-read tools
 * (role-scoped) + unit-scoped CRUD over the given unit. Closed over the
 * request's teacherId + unitId.
 */
export async function assembleUnitDesignerTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    teacherId: Id<"users">;
    unitId: Id<"units">;
    role: Role | null | undefined;
    /** The open unit's title, when the caller already has it loaded (the
     * bot stream reads it off its designer context). Only used to tell the
     * assignment tools which unit "this unit" means; omitting it costs the
     * model one list_units round-trip, nothing more. */
    unitTitle?: string;
    /** Institution id/slug owning the open unit. Falls back to the caller's
     * home institution for transports that do not have a loaded unit yet. */
    institutionScope?: string;
  },
) {
  const { teacherId, unitId, role, unitTitle, institutionScope } = opts;

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const lens = await ctx.runQuery(
    internal.curriculumAssistant.resolveAideScholarLens,
    { callerUserId: teacherId, scope: institutionScope ?? "" },
  );
  const allowedScholarIds =
    lens.unrestricted === false
      ? new Set<Id<"users">>(lens.scholarIds ?? [])
      : undefined;

  // Scholar-read tools — role-scoped so a curriculum_designer using the
  // bot can't reach scholar records (roster, mastery, assessment docs).
  const scholarReadTools = await makeScholarReadTools(
    ctx,
    emit,
    role,
    allowedScholarIds,
    "",
    lens.lensLabel,
  );

  // Scholar-RECORD write tools — role + surface filtered internally. The unit
  // Curriculum Bot is a private teacher surface (no shared channel), so the
  // full set is available to teacher/admin. The unit composer DOES accept
  // uploads now (the bot reads them inline via buildAideUserContent), but we
  // don't plumb attachedFiles into the scholar-record write tools here — so
  // those tools ask the teacher to use the global Curriculum Assistant / Slack
  // to file an uploaded document onto a scholar record.
  const scholarWriteTools = await makeScholarWriteTools(ctx, emit, {
    role,
    callerUserId: teacherId,
    surface: "private",
    allowedScholarIds,
  });

  // Scholar-groups roster lookup — teacher/admin only (member names are
  // roster data), so a curriculum_designer never reaches it. Lets a teacher
  // tailor a unit to a named cohort ("design this for the Seals").
  const listScholarGroupsTool = isTeacherRole(role)
    ? await makeListScholarGroupsTool(ctx, emit, allowedScholarIds)
    : null;

  // School physical-inventory READ — so the Curriculum Bot can reference what
  // rooms/equipment the school actually has when designing a unit (e.g. build a
  // lesson around the hand bells it can see are available). Read-only here;
  // editing the inventory is the global aide's / Slack's job.
  const physicalEnvTools = await makePhysicalEnvTools(ctx, emit, {
    callerUserId: teacherId,
  });

  // Curated map-asset catalog (registry datasets + historical era basemaps,
  // with provenance) — so the Curriculum Bot can see which real overlays /
  // eras the tutor's show_map can draw and name their exact keys in an
  // activity prompt. Pure read of checked-in modules; no scholar data.
  const listGeomapAssetsTool = await makeListGeomapAssetsTool(emit);

  // Simulator template catalog — so the bot can author a Simulator
  // activity actually is (a fixed-physics systems simulation, NOT a map or a
  // civilization/culture builder) and author one against the real spec shape.
  // Pure read of checked-in modules; no scholar data.
  const listSimulatorTemplatesTool = await makeListSimulatorTemplatesTool(emit);

  // Assignment tools — the SAME shared group the global Curriculum Assistant
  // gets (lib/assignmentTools.ts), teacher/admin gated inside the factory so a
  // curriculum_designer still gets none of it. Without these, a teacher
  // standing on a unit page could design the unit but not RUN it: asking the
  // bot to "assign this unit to the Geckos" got a truthful refusal and a trip
  // to another surface. `currentUnit` states the open unit so "this unit"
  // resolves with no title matching.
  const assignmentTools = await makeAssignmentTools(ctx, emit, {
    role,
    callerUserId: teacherId,
    currentUnit: unitTitle ? { id: unitId, title: unitTitle } : null,
    allowedScholarIds,
  });

  const readUnitStructureTool = betaTool({
    name: "read_unit_structure",
    description:
      "Read the full unit structure: Big Idea, EQs, EUs, and all lessons with their strands, processes, and prompts. Pass includeActivityDetails: true to also get every activity's full systemPrompt and deliverable criteria — required for coverage judgments (e.g. a unit review), since titles alone don't tell you what an activity actually engages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        includeActivityDetails: {
          type: "boolean" as const,
          description:
            "When true, include each activity's full systemPrompt and deliverable (prompt + criteria). Larger output; use for reviews/coverage checks.",
        },
      },
      required: [] as const,
    },
    run: async (input) => {
      // Re-fetch fresh data
      const freshCtx = await ctx.runQuery(
        internal.curriculumAssistant.getUnitDesignerContext,
        { teacherId, unitId },
      );
      if (!freshCtx) return "Unit not found.";
      const u = freshCtx.unit;
      const lessonLines = await Promise.all(
        freshCtx.lessons.map(async (l) => {
          const head = `  [${l.strand ?? "none"}] ${l.title}${l.processTitle ? ` (${l.processEmoji} ${l.processTitle}, processId: ${l.processId})` : " (no process)"} (lessonId: ${l._id})`;
          const acts = l.activities ?? [];
          if (acts.length === 0) return [head, "      activities: (none)"];
          const activityLines = await Promise.all(
            acts.map(async (a, i) => {
              const deck = await ctx.runQuery(readActivitySlidesDeckRef, {
                activityId: a._id,
              });
              const promptMark =
                a.kind === "online"
                  ? a.systemPrompt
                    ? " ✓prompt"
                    : " ✗no prompt"
                  : "";
              const deckMark =
                deck?.slidesDeck || deck?.googleSlidesPresentationId
                  ? " 🖼️slides"
                  : "";
              const recipeMark = a.recipe ? ` [recipe: ${a.recipe}]` : "";
              const line = `        ${i + 1}. [${a.kind}] ${a.title}${a.description ? `: ${a.description}` : ""}${promptMark}${deckMark}${recipeMark} (activityId: ${a._id})`;
              if (!input.includeActivityDetails) return [line];
              const detail: string[] = [line];
              if (a.systemPrompt) {
                detail.push(
                  "           systemPrompt:",
                  ...a.systemPrompt
                    .split("\n")
                    .map((ln: string) => `             ${ln}`),
                );
              }
              if (a.deliverable) {
                detail.push(
                  `           deliverable [${a.deliverable.kind}, criteria: ${a.deliverable.mode}]: ${a.deliverable.prompt}`,
                  ...a.deliverable.criteria.map(
                    (c: { label: string; description?: string }) =>
                      `             - ${c.label}${c.description ? `: ${c.description}` : ""}`,
                  ),
                );
              }
              return detail;
            }),
          );
          return [head, "      activities:", ...activityLines.flat()];
        }),
      );
      const lines = [
        `Unit: ${u.title}`,
        u.subject ? `Subject: ${u.subject}` : null,
        u.gradeLevel ? `Grade: ${u.gradeLevel}` : null,
        u.bigIdea ? `Big Idea: ${u.bigIdea}` : "Big Idea: (not set)",
        u.essentialQuestions?.length
          ? `Essential Questions:\n${granuleTexts(u.essentialQuestions).map((q) => `  - ${q}`).join("\n")}`
          : "Essential Questions: (none)",
        u.enduringUnderstandings?.length
          ? `Enduring Understandings:\n${granuleTexts(u.enduringUnderstandings).map((eu) => `  - ${eu}`).join("\n")}`
          : "Enduring Understandings: (none)",
        "",
        `Lessons (${freshCtx.lessons.length}):`,
        ...lessonLines.flat(),
        "",
        "Available processes:",
        ...freshCtx.processes.map((p) => `  - ${p.emoji} ${p.title} (id: ${p.id})`),
      ].filter(Boolean);
      emit({ toolComplete: { name: "read_unit_structure", result: `${freshCtx.lessons.length} lessons loaded` } });
      return lines.join("\n");
    },
  });

  const updateUnitTool = betaTool({
    name: "update_unit",
    description:
      "Update unit fields: Big Idea, Essential Questions, Enduring Understandings, subject, grade level.",
    inputSchema: {
      type: "object" as const,
      properties: {
        bigIdea: { type: "string" as const, description: "The unit's Big Idea" },
        essentialQuestions: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Essential Questions (replaces all existing)",
        },
        enduringUnderstandings: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Enduring Understandings (replaces all existing)",
        },
        subject: { type: "string" as const, description: "Subject area" },
        gradeLevel: { type: "string" as const, description: "Grade level" },
      },
      required: [] as const,
    },
    run: async (input) => {
      const updates: Record<string, unknown> = {};
      if (input.bigIdea !== undefined) updates.bigIdea = input.bigIdea || null;
      if (input.essentialQuestions !== undefined) updates.essentialQuestions = input.essentialQuestions;
      if (input.enduringUnderstandings !== undefined) updates.enduringUnderstandings = input.enduringUnderstandings;
      if (input.subject !== undefined) updates.subject = input.subject || null;
      if (input.gradeLevel !== undefined) updates.gradeLevel = input.gradeLevel || null;

      await ctx.runMutation(internal.curriculumAssistant.updateUnitInternal, {
        unitId,
        ...updates,
      });
      emit({ toolComplete: { name: "update_unit", result: "Unit updated" } });
      return "Unit updated successfully.";
    },
  });

  const createLessonTool = betaTool({
    name: "create_lesson",
    description:
      "Create a new lesson in this unit. Lessons form one freely-ordered list (new ones append to the end); `strand` is an OPTIONAL PCM tag, not a required bucket — leave it off if the lesson doesn't cleanly belong to one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Lesson title — just the title itself, with NO sequence number or strand-name prefix (e.g. 'Microbes Are Everywhere', not '1. Microbes...' or 'Core: Microbes...'). Order and strand are shown by the UI, not the title." },
        strand: {
          type: "string" as const,
          enum: ["core", "connections", "practice", "identity"] as const,
          description:
            "Optional PCM strand tag (core / connections / practice / identity). Omit if unsure — a lesson can be untagged.",
        },
        processId: { type: "string" as const, description: "Process ID (from available processes)" },
        systemPrompt: { type: "string" as const, description: "System prompt for the AI tutor" },
        durationMinutes: { type: "number" as const, description: "Expected duration in minutes" },
      },
      required: ["title"] as const,
    },
    run: async (input) => {
      await ctx.runMutation(internal.curriculumAssistant.createLessonInternal, {
        unitId,
        title: input.title,
        strand: input.strand as
          | "core"
          | "connections"
          | "practice"
          | "identity"
          | undefined,
        processId: input.processId as Id<"processes"> | undefined,
        systemPrompt: input.systemPrompt,
        durationMinutes: input.durationMinutes,
      });
      emit({ toolComplete: { name: "create_lesson", result: `Created "${input.title}"` } });
      return input.strand
        ? `Lesson "${input.title}" created in the ${input.strand} strand.`
        : `Lesson "${input.title}" created (untagged).`;
    },
  });

  const updateLessonTool = betaTool({
    name: "update_lesson",
    description: "Update an existing lesson's fields.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Title of the lesson to update (case-insensitive match)" },
        title: { type: "string" as const, description: "New title — just the title itself, no sequence number or strand-name prefix" },
        strand: {
          type: "string" as const,
          enum: ["core", "connections", "practice", "identity"] as const,
          description: "New strand",
        },
        processId: { type: "string" as const, description: "New process ID (empty string to remove)" },
        systemPrompt: { type: "string" as const, description: "New system prompt" },
        durationMinutes: { type: "number" as const, description: "New duration in minutes" },
      },
      required: ["lessonTitle"] as const,
    },
    run: async (input) => {
      // Find lesson by title
      const freshCtx = await ctx.runQuery(
        internal.curriculumAssistant.getUnitDesignerContext,
        { teacherId, unitId },
      );
      if (!freshCtx) return "Unit not found.";
      const lower = input.lessonTitle.toLowerCase();
      const lesson = freshCtx.lessons.find(
        (l) => l.title.toLowerCase().includes(lower)
      );
      if (!lesson) return `No lesson found matching "${input.lessonTitle}".`;

      const updates: Record<string, unknown> = {};
      if (input.title) updates.title = input.title;
      if (input.strand) updates.strand = input.strand;
      if (input.processId !== undefined) updates.processId = input.processId || null;
      if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt || null;
      if (input.durationMinutes !== undefined) updates.durationMinutes = input.durationMinutes;

      await ctx.runMutation(internal.curriculumAssistant.updateLessonInternal, {
        lessonId: lesson._id,
        ...updates,
      });
      emit({ toolComplete: { name: "update_lesson", result: `Updated "${lesson.title}"` } });
      return `Lesson "${lesson.title}" updated.`;
    },
  });

  const deleteLessonTool = betaTool({
    name: "delete_lesson",
    description:
      "Delete a lesson from this unit. This only works when NO scholar has worked on any of its activities — if scholars have, the delete is refused; archive_activity the worked activities instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Title of the lesson to delete (case-insensitive match)" },
      },
      required: ["lessonTitle"] as const,
    },
    run: async (input) => {
      const freshCtx = await ctx.runQuery(
        internal.curriculumAssistant.getUnitDesignerContext,
        { teacherId, unitId },
      );
      if (!freshCtx) return "Unit not found.";
      const lower = input.lessonTitle.toLowerCase();
      const lesson = freshCtx.lessons.find(
        (l) => l.title.toLowerCase().includes(lower)
      );
      if (!lesson) return `No lesson found matching "${input.lessonTitle}".`;

      try {
        await ctx.runMutation(internal.curriculumAssistant.deleteLessonInternal, {
          lessonId: lesson._id,
        });
      } catch (e) {
        // The execution guard throws a teacher-facing message when scholars
        // have worked on a child activity. Surface it as the tool result.
        return e instanceof Error ? e.message : String(e);
      }
      emit({ toolComplete: { name: "delete_lesson", result: `Deleted "${lesson.title}"` } });
      return `Lesson "${lesson.title}" deleted.`;
    },
  });

  const generateLessonPromptTool = betaTool({
    name: "generate_lesson_prompt",
    description: "Generate a system prompt for a specific lesson based on the unit context and lesson details. Writes the prompt directly to the lesson.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Title of the lesson" },
        prompt: { type: "string" as const, description: "The generated system prompt to save" },
      },
      required: ["lessonTitle", "prompt"] as const,
    },
    run: async (input) => {
      const freshCtx = await ctx.runQuery(
        internal.curriculumAssistant.getUnitDesignerContext,
        { teacherId, unitId },
      );
      if (!freshCtx) return "Unit not found.";
      const lower = input.lessonTitle.toLowerCase();
      const lesson = freshCtx.lessons.find(
        (l) => l.title.toLowerCase().includes(lower)
      );
      if (!lesson) return `No lesson found matching "${input.lessonTitle}".`;

      await ctx.runMutation(internal.curriculumAssistant.updateLessonInternal, {
        lessonId: lesson._id,
        systemPrompt: input.prompt,
      });
      emit({ toolComplete: { name: "generate_lesson_prompt", result: `Prompt saved for "${lesson.title}"` } });
      return `System prompt saved for "${lesson.title}".`;
    },
  });

  const generateAllPromptsTool = betaTool({
    name: "generate_all_prompts",
    description: "Batch generate system prompts for all lessons that don't have one yet. Returns a list of lessons that need prompts — you should then generate each one.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as const,
    },
    run: async () => {
      const freshCtx = await ctx.runQuery(
        internal.curriculumAssistant.getUnitDesignerContext,
        { teacherId, unitId },
      );
      if (!freshCtx) return "Unit not found.";
      const missing = freshCtx.lessons.filter((l) => !l.systemPrompt?.trim());
      if (missing.length === 0) {
        emit({ toolComplete: { name: "generate_all_prompts", result: "All lessons have prompts" } });
        return "All lessons already have system prompts.";
      }
      emit({ toolComplete: { name: "generate_all_prompts", result: `${missing.length} lessons need prompts` } });
      return `${missing.length} lessons need prompts:\n${missing.map((l) => `- ${l.title} [${l.strand ?? "none"}]${l.processTitle ? ` (${l.processTitle})` : ""}`).join("\n")}\n\nGenerate a prompt for each using the generate_lesson_prompt tool.`;
    },
  });

  // ── Activity tools ──────────────────────────────────────────────

  type FreshLesson = NonNullable<
    Awaited<ReturnType<typeof ctx.runQuery<typeof internal.curriculumAssistant.getUnitDesignerContext>>>
  >["lessons"][number];
  type FreshActivity = FreshLesson["activities"][number];
  type LessonResult = { ok: true; lesson: FreshLesson } | { ok: false; error: string };
  type ActivityResult =
    | { ok: true; lesson: FreshLesson; activity: FreshActivity }
    | { ok: false; error: string };

  // Pick the best title match from a list. Prefer exact (case-insensitive)
  // → startsWith → includes. Without this, two activities like "Mini-lecture"
  // and "Mini-lecture: ABO genetics" would silently route to whichever
  // appeared first in the list.
  const pickByTitle = <T extends { title: string }>(
    items: T[],
    query: string,
  ): T | undefined => {
    const lower = query.toLowerCase();
    return (
      items.find((x) => x.title.toLowerCase() === lower) ??
      items.find((x) => x.title.toLowerCase().startsWith(lower)) ??
      items.find((x) => x.title.toLowerCase().includes(lower))
    );
  };

  const findLesson = async (titleQuery: string): Promise<LessonResult> => {
    const freshCtx = await ctx.runQuery(
      internal.curriculumAssistant.getUnitDesignerContext,
      { teacherId, unitId },
    );
    if (!freshCtx) return { ok: false, error: "Unit not found." };
    const lesson = pickByTitle(freshCtx.lessons, titleQuery);
    if (!lesson) return { ok: false, error: `No lesson found matching "${titleQuery}".` };
    return { ok: true, lesson };
  };

  const findActivity = async (
    lessonTitle: string,
    activityTitle: string,
  ): Promise<ActivityResult> => {
    const f = await findLesson(lessonTitle);
    if (!f.ok) return f;
    const act = pickByTitle(f.lesson.activities ?? [], activityTitle);
    if (!act)
      return {
        ok: false,
        error: `No activity matching "${activityTitle}" found on lesson "${f.lesson.title}".`,
      };
    return { ok: true, lesson: f.lesson, activity: act };
  };

  const createActivityTool = betaTool({
    name: "create_activity",
    description:
      "Add a new activity to a lesson.\n\n" +
      "Online activities (kind='online') drive a Rabbithole AI tutor session. They REQUIRE EITHER a deliverable OR an advanceRubric (never both):\n" +
      "  • deliverable { kind, prompt, criteria } — when the scholar produces an ARTIFACT/product, including a map that is itself the work. Its criteria are a private quality map for the tutor, NOT a scholar checklist or a completion gate (criteria in systemPrompt are decorative). The AI verdicts each 'not'/'half'/'full'; a full criterion permanently awards it as scholar-visible flair, with its label and description shown together, while half/not-full remain private. Distill the teacher's quality bar into 3-6 concrete dimensional criteria.\n" +
      "  • advanceRubric { criteria } — when the learning happens IN CONVERSATION with NO produced artifact: a Socratic discussion or an interactive map/geography discovery activity. The tutor grades the scholar's talk + map interactions against the criteria and a full pass completes the activity. For a geography/map activity, use advanceRubric when the learning is the discovery sequence; use deliverable kind 'map' only when the saved map itself is the product scholars should check or send.\n\n" +
      "Make criteria DIMENSIONAL (specificity, length, structure, mechanics; or 'located the places', 'explained the why', 'transferred the pattern') — not procedural (drafted, revised, published). Give each a short label and put the concrete quality bar in its description. Vague criteria produce vague verdicts.\n\n" +
      "Offline activities (kind='offline') are teacher-planned classroom moments — lab demos, discussions, worksheets. No tutor session or evaluation shape.\n\n" +
      "TWO AUDIENCES — keep them separate: `description` is teacher-facing (design intent, facilitation notes; the tutor also reads it) and is NEVER shown to scholars; `scholarDescription` is the scholar-facing card blurb, written TO the scholar in the 2nd person and free of any pedagogy/assessment framing. Author both when you know them.\n\n" +
      "CONVERSATION RECIPE (recipe='baseline' | 'exitTicket'): mark an activity as the unit's pre/post understanding assessment of its essential questions / enduring understandings. 'baseline' opens the unit (surface current thinking, no teaching); 'exitTicket' closes it (revisit the EQs, show growth). Works for BOTH kinds: an ONLINE recipe runs through the tutor; an OFFLINE recipe assesses the scholar's uploaded written work (typed or scanned). Both feed the teacher's Understanding grid. Only set a recipe when the teacher wants a stealth assessment activity — most activities have no recipe. Requires the unit to have essential questions / enduring understandings set.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Title of the lesson to add the activity to (case-insensitive match)" },
        title: { type: "string" as const, description: "Short activity title — just the title, with NO leading sequence number or category/type prefix (e.g. 'Blood typing demo', not '2. Blood typing demo', 'Connection 1: ...', or 'Project 3: ...')." },
        description: { type: "string" as const, description: "TEACHER-FACING description: design intent + facilitation notes, and (for online activities) context the AI tutor reads. NEVER shown to scholars. This is NOT the scholar's card copy — use scholarDescription for what the scholar reads." },
        scholarDescription: { type: "string" as const, description: "SCHOLAR-FACING blurb shown on the scholar's home card and activity nav. Write TO the scholar, 2nd person, invitational and concrete (e.g. \"You'll design a terrarium, then predict what happens when a species disappears\"). Do NOT reveal pedagogy or assessment framing — never mention 'stealth pre-assessment', 'baseline', 'exit ticket', rubrics, or 'we're measuring'. Optional; if omitted the scholar sees a title-only card (there is no fallback to the teacher description)." },
        kind: { type: "string" as const, enum: ["online", "offline", "vibecode", "simulator"] as const, description: "online = AI tutor session; offline = classroom task; vibecode = full-screen app-builder workshop (systemPrompt is the BUILD BRIEF) — scholars BUILD an app themselves; world = a Simulator activity (fixed-physics terrarium: ecosystem grid or prisoner's dilemma) the scholar TUNES. A 'simulation/game/model' ask is ambiguous between vibecode and a Simulator — ask which before assuming. To author a Simulator, DON'T use this tool — use create_simulator_activity (it sets the required simulatorSpec). A Simulator made here would be an empty Draft. A Simulator is NOT a map or a build-your-own place/civilization — see list_simulator_templates." },
        systemPrompt: { type: "string" as const, description: "For online = the AI tutor system prompt. For vibecode = the BUILD BRIEF (what the scholar should build + the learning goal). Ignored for offline/Simulator. Quality criteria DON'T belong here; they belong in deliverable.criteria." },
        processId: { type: "string" as const, description: "Process ID (only for online activities)" },
        durationMinutes: { type: "number" as const, description: "Expected duration in minutes" },
        deliverable: deliverableSchemaFragment(),
        advanceRubric: advanceRubricSchemaFragment(),
        recipe: { type: "string" as const, enum: ["baseline", "exitTicket"] as const, description: "Optional. Marks this as the unit's baseline (opening) or exit-ticket (closing) EQ/EU assessment. Online → tutor-run; offline → assesses uploaded written work. Omit for a normal activity." },
      },
      required: ["lessonTitle", "title", "kind"] as const,
    },
    run: async (input) => {
      const f = await findLesson(input.lessonTitle);
      if (!f.ok) return f.error;
      const deliverable = parseDeliverableArg(
        input.deliverable as RawBotDeliverable | undefined,
      );
      const advanceRubric = parseAdvanceRubricArg(
        input.advanceRubric as RawBotAdvanceRubric | undefined,
      );
      try {
        await ctx.runMutation(internal.activities.upsertInternal, {
          parent: { kind: "lesson", lessonId: f.lesson._id },
          match: { byTitle: input.title },
          title: input.title,
          description: input.description,
          scholarDescription: input.scholarDescription,
          kind: input.kind as "online" | "offline" | "shareBack" | "vibecode" | "simulator",
          systemPrompt:
            input.kind === "online" || input.kind === "vibecode"
              ? input.systemPrompt
              : undefined,
          processId: input.processId
            ? (input.processId as Id<"processes">)
            : undefined,
          durationMinutes: input.durationMinutes,
          deliverable,
          advanceRubric,
          recipe: input.recipe as "baseline" | "exitTicket" | undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          toolComplete: {
            name: "create_activity",
            result: `Refused: ${msg.slice(0, 200)}`,
          },
        });
        return JSON.stringify({
          ...refusedRecoveryMessage("create_activity", "lessonTitle + title"),
          error: msg,
        });
      }
      emit({
        toolComplete: {
          name: "create_activity",
          result: `Added "${input.title}" to "${f.lesson.title}"`,
        },
      });
      // Be honest about what actually persisted, so the bot doesn't narrate a
      // rich tutor/build prompt it never saved. An online/vibecode activity
      // with no systemPrompt is a stub until a prompt is generated.
      const needsPrompt = input.kind === "online" || input.kind === "vibecode";
      const gotPrompt = Boolean(
        typeof input.systemPrompt === "string" && input.systemPrompt.trim(),
      );
      let note = "";
      if (needsPrompt && !gotPrompt) {
        note =
          input.kind === "online"
            ? " NOTE: no system prompt was saved yet — call generate_activity_prompt to give the tutor its prompt before you tell the teacher it's ready."
            : " NOTE: no build brief was saved yet — set the systemPrompt (the build brief) before you tell the teacher it's ready.";
      }
      if (input.kind === "simulator") {
        note =
          " NOTE: this is an EMPTY Simulator (a Draft) — it has no physics/spec. Call create_simulator_activity (or update_simulator_spec on this activity) with a real simulatorSpec, or it won't run.";
      }
      return `Activity "${input.title}" (${input.kind}) created on lesson "${f.lesson.title}".${note}`;
    },
  });

  const activityKindTools = await makeActivityKindTools(ctx, emit, {
    callerUserId: teacherId,
    lessonAddress: {
      properties: {
        lessonTitle: {
          type: "string",
          description:
            "Title of the lesson to add the activity to (case-insensitive match).",
        },
      },
      required: ["lessonTitle"],
      recoveryArg: "lessonTitle",
      resolve: (input) => findLesson(input.lessonTitle as string),
    },
    activityAddress: {
      properties: {
        lessonTitle: {
          type: "string",
          description:
            "Title of the lesson the activity is on (case-insensitive match).",
        },
        activityTitle: {
          type: "string",
          description:
            "Title of the activity to configure (case-insensitive match).",
        },
      },
      required: ["lessonTitle", "activityTitle"],
      recoveryArg: "lessonTitle + activityTitle",
      resolve: (input) =>
        findActivity(
          input.lessonTitle as string,
          input.activityTitle as string,
        ),
    },
  });

  const updateActivityTool = betaTool({
    name: "update_activity",
    description:
      "Update an existing activity's fields. Find by lesson title + activity title.\n\n" +
      "Use the `deliverable` arg to add or replace the private artifact quality rubric. Pass a full { kind, prompt, criteria: [{label, description}, ...] } object to set; omit the field to leave it untouched. Each full criterion becomes scholar-visible flair, with its label and description shown together.\n\n" +
      "CONVERSATION RECIPE (recipe): set 'baseline'/'exitTicket' to make this the unit's pre/post EQ/EU assessment, or 'none' to clear it. Online recipe → tutor-run; offline recipe → the scholar's uploaded written work is assessed. Both feed the Understanding grid. Requires the unit to have essential questions / enduring understandings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Title of the parent lesson" },
        activityTitle: { type: "string" as const, description: "Current title of the activity to update" },
        title: { type: "string" as const, description: "New title — just the title, no leading number or category prefix" },
        description: { type: "string" as const, description: "New TEACHER-FACING description (design intent + facilitation notes; the tutor reads it for online activities; never shown to scholars). NOT the scholar's card copy — use scholarDescription for that. Pass an empty string to clear it." },
        scholarDescription: { type: "string" as const, description: "New SCHOLAR-FACING card blurb — 2nd person, invitational, concrete, with no pedagogy/assessment framing (no 'stealth pre-assessment', 'baseline', rubrics). Pass an empty string to clear it (cleared = scholars see a title-only card, no fallback)." },
        kind: { type: "string" as const, enum: ["online", "offline", "vibecode", "simulator"] as const, description: "Switch the activity kind (online / offline / vibecode / Simulator; use `world` for the Simulator identifier)." },
        systemPrompt: { type: "string" as const, description: "New system prompt — the tutor prompt for online, the BUILD BRIEF for vibecode." },
        processId: { type: "string" as const, description: "New process ID (empty string clears)" },
        durationMinutes: { type: "number" as const, description: "New duration in minutes" },
        deliverable: deliverableSchemaFragment(),
        recipe: { type: "string" as const, enum: ["baseline", "exitTicket", "none"] as const, description: "Conversation recipe: 'baseline' (opens unit) / 'exitTicket' (closes unit) marks this as an EQ/EU assessment; 'none' clears it. Works for online (tutor-run) and offline (assesses uploaded work)." },
      },
      required: ["lessonTitle", "activityTitle"] as const,
    },
    run: async (input) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      const deliverable = parseDeliverableArg(
        input.deliverable as RawBotDeliverable | undefined,
      );
      const patch: Record<string, unknown> = {
        id: f.activity._id,
      };
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description || null;
      if (input.scholarDescription !== undefined)
        patch.scholarDescription = input.scholarDescription || null;
      if (input.kind !== undefined) patch.kind = input.kind;
      if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt || null;
      if (input.processId !== undefined)
        patch.processId = input.processId ? (input.processId as Id<"processes">) : null;
      if (input.durationMinutes !== undefined) patch.durationMinutes = input.durationMinutes;
      if (deliverable !== undefined) patch.deliverable = deliverable;
      if (input.recipe !== undefined)
        patch.recipe = input.recipe === "none" ? null : input.recipe;
      await ctx.runMutation(internal.activities.updateInternal, patch as Parameters<typeof ctx.runMutation>[1]);
      emit({
        toolComplete: {
          name: "update_activity",
          result: `Updated "${f.activity.title}"`,
        },
      });
      return `Activity "${f.activity.title}" updated.`;
    },
  });

  const deleteActivityTool = betaTool({
    name: "delete_activity",
    description:
      "Delete an activity from a lesson. This only works for an activity NO scholar has worked on yet (no real sessions, completions, or deliverables). If scholars HAVE worked on it, the delete is refused — archive_activity it instead, which hides it from scholars while preserving their record.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Parent lesson title" },
        activityTitle: { type: "string" as const, description: "Title of the activity to delete" },
      },
      required: ["lessonTitle", "activityTitle"] as const,
    },
    run: async (input) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      try {
        await ctx.runMutation(internal.activities.removeInternal, { id: f.activity._id });
      } catch (e) {
        // The execution guard throws a teacher-facing message when scholars have
        // worked on the activity. Surface it as the tool result, not a crash.
        return e instanceof Error ? e.message : String(e);
      }
      emit({
        toolComplete: { name: "delete_activity", result: `Deleted "${f.activity.title}"` },
      });
      return `Activity "${f.activity.title}" deleted.`;
    },
  });

  const archiveActivityTool = betaTool({
    name: "archive_activity",
    description:
      "Archive (or unarchive) an activity — the non-destructive alternative to delete_activity. Archiving hides an activity from scholars and from schedulable pickers but keeps it (dimmed) on the design surface and preserves any existing scholar work/sessions. Use this when scholars have already worked on an activity you want to retire, or when delete_activity was refused. Pass archived:false to restore an archived activity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Parent lesson title" },
        activityTitle: { type: "string" as const, description: "Title of the activity to archive/unarchive" },
        archived: {
          type: "boolean" as const,
          description: "true to archive (default), false to unarchive/restore.",
        },
      },
      required: ["lessonTitle", "activityTitle"] as const,
    },
    run: async (input) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      const archived = input.archived !== false;
      await ctx.runMutation(internal.activities.setArchivedInternal, {
        id: f.activity._id,
        archived,
      });
      const verb = archived ? "Archived" : "Unarchived";
      emit({
        toolComplete: { name: "archive_activity", result: `${verb} "${f.activity.title}"` },
      });
      return `Activity "${f.activity.title}" ${verb.toLowerCase()}.`;
    },
  });

  const reorderActivitiesTool = betaTool({
    name: "reorder_activities",
    description:
      "Reorder the activities within a lesson. Pass the lesson title plus the COMPLETE list of activity titles in the desired new order — every existing activity on the lesson must appear exactly once. Use this for asks like 'move the lab demo before the reading', 'swap activities 2 and 3', or 'put the debrief last'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: {
          type: "string" as const,
          description: "Title of the parent lesson (case-insensitive match)",
        },
        activityTitles: {
          type: "array" as const,
          description:
            "All activity titles on the lesson, in the desired new order. Must include every existing activity exactly once.",
          items: { type: "string" as const },
        },
      },
      required: ["lessonTitle", "activityTitles"] as const,
    },
    run: async (input) => {
      const f = await findLesson(input.lessonTitle);
      if (!f.ok) return f.error;
      const existing = f.lesson.activities ?? [];
      if (existing.length === 0)
        return `Lesson "${f.lesson.title}" has no activities to reorder.`;
      if (input.activityTitles.length !== existing.length)
        return `Got ${input.activityTitles.length} titles but lesson "${f.lesson.title}" has ${existing.length} activities. Pass the complete list in the desired order — every activity must appear exactly once.`;

      const remaining = [...existing];
      const orderedIds: Id<"activities">[] = [];
      for (const t of input.activityTitles) {
        const idx = remaining.findIndex(
          (a) => a.title.trim().toLowerCase() === t.trim().toLowerCase(),
        );
        if (idx === -1)
          return `No activity matching "${t}" found on lesson "${f.lesson.title}" (or it was already used). Existing titles: ${existing.map((a) => `"${a.title}"`).join(", ")}.`;
        orderedIds.push(remaining[idx]._id);
        remaining.splice(idx, 1);
      }

      const isNoop = existing.every((a, i) => a._id === orderedIds[i]);
      if (isNoop) {
        emit({
          toolComplete: {
            name: "reorder_activities",
            result: `Already in that order on "${f.lesson.title}"`,
          },
        });
        return `Activities on "${f.lesson.title}" are already in that order — nothing to change.`;
      }

      await ctx.runMutation(internal.activities.reorderInternal, {
        activityIds: orderedIds,
      });
      emit({
        toolComplete: {
          name: "reorder_activities",
          result: `Reordered ${orderedIds.length} activities on "${f.lesson.title}"`,
        },
      });
      return `Reordered activities on "${f.lesson.title}": ${input.activityTitles.map((t, i) => `${i + 1}. ${t}`).join(" → ")}.`;
    },
  });

  const generateActivityPromptTool = betaTool({
    name: "generate_activity_prompt",
    description: "Generate and save a system prompt for an online activity. Use when an online activity needs a tutor prompt. Only valid for kind='online' activities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Parent lesson title" },
        activityTitle: { type: "string" as const, description: "Activity title" },
        prompt: { type: "string" as const, description: "The generated system prompt to save" },
      },
      required: ["lessonTitle", "activityTitle", "prompt"] as const,
    },
    run: async (input) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      if (f.activity.kind !== "online")
        return `Activity "${f.activity.title}" is offline; system prompts only apply to online activities.`;
      await ctx.runMutation(internal.activities.updateInternal, {
        id: f.activity._id,
        systemPrompt: input.prompt,
      });
      emit({
        toolComplete: {
          name: "generate_activity_prompt",
          result: `Prompt saved for "${f.activity.title}"`,
        },
      });
      return `System prompt saved for activity "${f.activity.title}".`;
    },
  });

  const googleSlidesEditor = new GoogleSlidesEditor();
  type GoogleSlidesAccess =
    | { error: string }
    | {
        token: string;
        presentationId: string;
        principalKey: string;
        name: string;
        url: string;
      };
  const resolveGoogleSlidesAccess = async (
    activityId: Id<"activities">,
  ): Promise<GoogleSlidesAccess> => {
    let activity;
    try {
      activity = await ctx.runQuery(
        internal.activities.getForExportInternal,
        { id: activityId, userId: teacherId },
      );
    } catch (error) {
      return {
        error: `GOOGLE_ACCESS_REFUSED: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (
      !activity?.googleSlidesPresentationId ||
      !activity.googleSlidesPrincipal
    ) {
      return {
        error:
          "NO_GOOGLE_DECK: this activity has no attached Google Slides deck.",
      };
    }

    let principal;
    try {
      principal = presentationPrincipalForActingUser(
        activity.googleSlidesPrincipal,
        teacherId,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        error: activity.googleSlidesPrincipal.kind === "legacy_unknown"
          ? `REATTACH_REQUIRED: ${detail}`
          : `OTHER_OWNER: ${detail}`,
      };
    }

    try {
      const token =
        principal.kind === "personal_oauth"
          ? await getValidAccessToken(ctx, teacherId, GOOGLE_SLIDES_SCOPES)
          : await getValidAccessTokenForCredential(
              ctx,
              principal.credentialId,
              INSTITUTION_WORKSPACE_BOT_SCOPES,
            );
      return {
        token,
        presentationId: activity.googleSlidesPresentationId,
        principalKey:
          principal.kind === "personal_oauth"
            ? `personal:${principal.userId}`
            : `workspace:${principal.credentialId}`,
        name: activity.googleSlidesName ?? "Untitled Google Slides deck",
        url:
          activity.googleSlidesUrl ??
          `https://docs.google.com/presentation/d/${activity.googleSlidesPresentationId}/edit`,
      };
    } catch (error) {
      if (error instanceof GoogleReconsentRequiredError) {
        return {
          error: `GOOGLE_RECONSENT_REQUIRED: ${error.message}`,
        };
      }
      return {
        error: `GOOGLE_ACCESS_REFUSED: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const createSlidesDeckTool = betaTool({
    name: "create_slides_deck",
    description:
      "Create or replace an activity's Rabbit Slides deck. Pass an ordered list of title/body slides; each becomes a clean 1280x720 title-and-body slide, with optional speaker notes. Any attached Google Slides deck stays as a separate teacher reference. The server validates the Deck JSON and mints stable ids. Call read_deck before later edits so you have the current slide/element ids and revision.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: {
          type: "string" as const,
          description: "Parent lesson title (case-insensitive match)",
        },
        activityTitle: {
          type: "string" as const,
          description: "Activity title to attach the deck to",
        },
        deckTitle: {
          type: "string" as const,
          description: "Title of the Rabbit Slides deck.",
        },
        slides: {
          type: "array" as const,
          description:
            "Ordered slide list. Aim for 3-6 slides. Body text is plain text; use line breaks for separate bullets or ideas (no HTML).",
          minItems: 1,
          items: {
            type: "object" as const,
            properties: {
              title: {
                type: "string" as const,
                description: "Slide title.",
              },
              body: {
                type: "string" as const,
                description:
                  "Slide body text. Use line breaks for separate bullets/lines.",
              },
              notes: {
                type: "string" as const,
                description:
                  "Optional speaker notes for this slide.",
              },
            },
            required: ["title", "body"] as const,
          },
        },
      },
      required: ["lessonTitle", "activityTitle", "deckTitle", "slides"] as const,
    },
    run: async (input) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      const result = await ctx.runMutation(storeActivitySlidesDeckRef, {
        activityId: f.activity._id,
        deckTitle: input.deckTitle,
        slides: input.slides,
      });
      if (!result.ok) {
        return `The deck was not created: ${result.error}`;
      }
      emit({
        toolComplete: {
          name: "create_slides_deck",
          result: `Created ${result.slideCount}-slide deck on "${f.activity.title}"`,
        },
      });
      return `Created Rabbit Slides deck "${input.deckTitle}" with ${result.slideCount} slide${result.slideCount === 1 ? "" : "s"} on activity "${f.activity.title}" (revision ${result.revision}). Call read_deck before applying edits so you address the current ids.`;
    },
  });

  const readDeckTool = betaTool({
    name: "read_deck",
    description:
      "Read one of an activity's presentation decks. Use target='rabbit' before apply_deck_edits, or target='google' before edit_google_deck. Rabbit returns its full editable scene summary. Google returns only safe text, speaker-note, and layout handles; complex teacher-created objects are counted but remain opaque and untouched. If target is omitted, Rabbit wins when both exist, otherwise the attached deck is read.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Parent lesson title" },
        activityTitle: { type: "string" as const, description: "Activity title" },
        target: {
          type: "string" as const,
          enum: ["rabbit", "google"] as const,
          description:
            "Deck to read. Omit only when the activity has one obvious deck; Rabbit is the default when both coexist.",
        },
      },
      required: ["lessonTitle", "activityTitle"] as const,
    },
    run: async (input) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      const activity = await ctx.runQuery(readActivitySlidesDeckRef, {
        activityId: f.activity._id,
      });
      if (!activity) return "Activity not found.";
      const target =
        input.target ??
        (activity.slidesDeck
          ? "rabbit"
          : activity.googleSlidesPresentationId
            ? "google"
            : "rabbit");
      if (target === "google") {
        if (!activity.googleSlidesPresentationId) {
          return `Activity "${f.activity.title}" has no Google Slides deck attached.${activity.slidesDeck ? " Read target=\"rabbit\" for its Rabbit Slides deck." : ""}`;
        }
        const access = await resolveGoogleSlidesAccess(f.activity._id);
        if ("error" in access) return access.error;
        const view = await googleSlidesEditor.view(
          access.token,
          access.presentationId,
          access.principalKey,
        );
        emit({
          toolComplete: {
            name: "read_deck",
            result: `Read Google Slides deck "${access.name}"`,
          },
        });
        return `Google Slides deck "${access.name}" (${access.url}). Use edit_google_deck for bounded text, speaker-note, or layout-preserving append edits; richer design remains untouched.\n${view}`;
      }
      if (activity.slidesDeck) {
        const deck = parsedPresentationDeck(activity.slidesDeck);
        if (!deck) {
          return `Activity "${f.activity.title}" has an invalid Rabbit Slides deck. It cannot be read or edited until it is replaced with create_slides_deck.`;
        }
        emit({
          toolComplete: {
            name: "read_deck",
            result: `Read ${deck.slides.length}-slide deck "${deck.title}"`,
          },
        });
        return (
          `Rabbit Slides deck (revision ${deck.revision}). Apply edits against this baseRevision, addressing slides and elements by the ids below:\n` +
          summarizeDeckForModel(deck)
        );
      }
      if (activity.googleSlidesPresentationId) {
        return `Activity "${f.activity.title}" has no Rabbit Slides deck. Read target="google" to inspect its attached Google Slides deck, or use create_slides_deck to add Rabbit Slides without removing the Google deck.`;
      }
      return `Activity "${f.activity.title}" has no deck. Use create_slides_deck for editable Rabbit Slides, or the teacher can attach a Google Slides reference from Drive.`;
    },
  });

  const applyDeckEditsTool = betaTool({
    name: "apply_deck_edits",
    description:
      "Edit an activity's Rabbit Slides deck (NOT its Google Slides reference). ALWAYS call read_deck first, then pass its revision as baseRevision and a small id-addressed `ops` batch. Canvas: fixed 1280x720 logical units, origin TOP-LEFT, +x right, +y down. Text is axis-aligned; colors are \"#rrggbb\".\n\n" +
      "Ops are applied ALL-OR-NOTHING (one bad op leaves the deck unchanged):\n" +
      "  addElement{slideId,afterId?,element}  patchElement{slideId,id,frame?,text?,style?}  removeElement{slideId,id}\n" +
      "  moveElement{slideId,id,afterId?}  addSlide{afterSlideId?}  removeSlide{slideId}\n" +
      "  setBackground{slideId,color}  setSpeakerNotes{slideId,notes}  setTitle{title}\n\n" +
      "Element shapes:\n" +
      "  text {type:\"text\",frame:{x,y,w,h},text,style?:{fontSize,bold,italic,color,align:left|center|right,verticalAlign:top|middle|bottom}}\n" +
      "  shape {type:\"rect\"|\"ellipse\"|\"line\",frame:{x,y,w,h,rotation?},style?:{fill,stroke,strokeWidth}}\n" +
      "  image {type:\"image\",frame:{x,y,w,h,rotation?},assetId,alt}\n" +
      "The server mints ids for addElement/addSlide and returns them. If the revision is stale, read_deck again and retry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Parent lesson title" },
        activityTitle: { type: "string" as const, description: "Activity title" },
        ops: {
          type: "array" as const,
          description:
            "Small id-addressed SlideOp batch. Example: [{\"op\":\"patchElement\",\"slideId\":\"sl1\",\"id\":\"el1\",\"text\":\"New title\"}].",
          items: { type: "object" as const, additionalProperties: true },
        },
        baseRevision: {
          type: "number" as const,
          description:
            "The revision returned by the latest read_deck call. A stale revision is refused rather than overwriting newer work.",
        },
      },
      required: ["lessonTitle", "activityTitle", "ops", "baseRevision"] as const,
    },
    run: async (input) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      const result = await ctx.runMutation(applyActivitySlideOpsRef, {
        activityId: f.activity._id,
        ownerId: opts.teacherId,
        opsJson: JSON.stringify(input.ops),
        baseRevision: input.baseRevision,
      });

      if (!result.ok) {
        return `The deck was not changed: ${result.error}`;
      }
      emit({
        toolComplete: {
          name: "apply_deck_edits",
          result: `Applied ${input.ops.length} edit${input.ops.length === 1 ? "" : "s"} to "${f.activity.title}"`,
        },
      });

      const newIds = result.createdIds.length
        ? ` New ids: ${result.createdIds.join(", ")}.`
        : "";
      return `Applied ${input.ops.length} edit${input.ops.length === 1 ? "" : "s"}; the deck is now revision ${result.revision}.${newIds}`;
    },
  });

  const editGoogleDeckTool = betaTool({
    name: "edit_google_deck",
    description:
      "Safely edit the activity's attached Google Slides deck after read_deck target=\"google\". This is intentionally narrower than Rabbit Slides: replace all text in one plain single-style text box, replace speaker notes, or append a slide using an existing slide's Google layout. Complex text, tables, charts, groups, media, styling, deletion, and raw Google API requests are refused so the teacher's richer design remains intact. Every command requires the opaque base_revision from the latest Google read.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonTitle: { type: "string" as const, description: "Parent lesson title" },
        activityTitle: { type: "string" as const, description: "Activity title" },
        command: {
          type: "string" as const,
          enum: ["replace_text", "set_speaker_notes", "append_slide"] as const,
          description: "The bounded Google Slides edit to perform.",
        },
        base_revision: {
          type: "string" as const,
          description:
            "Opaque Revision returned by the latest read_deck target=\"google\" call.",
        },
        slide_object_id: {
          type: "string" as const,
          description:
            "For replace_text/set_speaker_notes: slide_object_id from read_deck.",
        },
        object_id: {
          type: "string" as const,
          description: "For replace_text: editable object_id from read_deck.",
        },
        expected_text: {
          type: "string" as const,
          description:
            "For text/notes edits: exact text from read_deck. A mismatch is refused.",
        },
        new_text: {
          type: "string" as const,
          description: "For text/notes edits: complete replacement text.",
        },
        layout_from_slide_object_id: {
          type: "string" as const,
          description:
            "For append_slide: slide whose Google layout should be reused.",
        },
        after_slide_object_id: {
          type: "string" as const,
          description:
            "For append_slide: optional slide after which to insert. Omit to append.",
        },
        placeholders: {
          type: "object" as const,
          description:
            "For append_slide: optional title/body text for matching placeholders in the reused layout.",
          properties: {
            title: { type: "string" as const },
            body: { type: "string" as const },
          },
          required: [] as const,
          additionalProperties: false,
        },
      },
      required: [
        "lessonTitle",
        "activityTitle",
        "command",
        "base_revision",
      ] as const,
    },
    run: async (
      input,
      context?: { toolUseBlock: { id: string } },
    ) => {
      const f = await findActivity(input.lessonTitle, input.activityTitle);
      if (!f.ok) return f.error;
      const toolUseId = context?.toolUseBlock.id;
      if (!toolUseId) {
        return "IDEMPOTENCY_KEY_MISSING: edit_google_deck requires the tool_use id.";
      }
      let command;
      try {
        command = parseGoogleSlidesEditorInput(input);
      } catch (error) {
        return `INVALID_COMMAND: ${error instanceof Error ? error.message : String(error)}`;
      }
      const access = await resolveGoogleSlidesAccess(f.activity._id);
      if ("error" in access) return access.error;
      const result = await googleSlidesEditor.execute(
        access.token,
        access.presentationId,
        access.principalKey,
        command,
        { toolUseId },
      );
      const firstLine = result.split("\n", 1)[0];
      emit({
        toolComplete: {
          name: "edit_google_deck",
          result: `${firstLine} — "${access.name}"`,
        },
      });
      return `Google Slides deck "${access.name}" (${access.url}):\n${result}`;
    },
  });

  // Persist a coherence Review the bot just performed → the durable
  // "Reviewed" rung of the maturity rail (review/curriculum-rehearse-and-
  // maturity.md). The bot does the EQ/EU↔activity audit with its read
  // tools, then calls this to record the verdict (replacing the old
  // ephemeral "Review unit" chat message with a re-runnable artifact).
  const recordUnitReviewTool = betaTool({
    name: "record_unit_review",
    description:
      "Persist the result of a coherence Review of THIS unit — the EQ/EU ↔ activity coverage audit you just performed (check, in both directions, which Essential Questions / Enduring Understandings each activity genuinely engages). Call this AFTER presenting the review to the teacher. `openGapCount` = how many EQs/EUs no activity genuinely engages (verdict 'uncovered'); 0 means the unit is coherent and lights the 'Reviewed' lamp on the maturity rail. Makes the review a durable, re-runnable artifact instead of a one-off message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        openGapCount: {
          type: "number" as const,
          description: "How many EQs/EUs no activity genuinely engages (uncovered). 0 = coherent.",
        },
        coverage: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              item: { type: "string" as const },
              kind: {
                type: "string" as const,
                enum: ["essentialQuestion", "enduringUnderstanding"] as const,
              },
              verdict: {
                type: "string" as const,
                enum: ["covered", "weak", "uncovered"] as const,
              },
              activityTitles: { type: "array" as const, items: { type: "string" as const } },
            },
            required: ["item", "kind", "verdict"] as const,
          },
          description: "Per-EQ/EU coverage rows.",
        },
        missing: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "EQs/EUs the activities imply but the unit's lists are missing.",
        },
        bloomGaps: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Bloom's-level gaps (e.g. all activities are remember/understand).",
        },
        note: { type: "string" as const, description: "One-line summary of the review." },
      },
      required: ["openGapCount"] as const,
    },
    run: async (input) => {
      await ctx.runMutation(internal.unitReviews.recordInternal, {
        unitId,
        reviewedBy: teacherId,
        openGapCount: input.openGapCount,
        summary: {
          coverage: input.coverage,
          missing: input.missing,
          bloomGaps: input.bloomGaps,
          note: input.note,
        },
      });
      emit({
        toolComplete: {
          name: "record_unit_review",
          result:
            input.openGapCount === 0
              ? "Reviewed — coherent"
              : `Reviewed — ${input.openGapCount} gap${input.openGapCount === 1 ? "" : "s"}`,
        },
      });
      return `Recorded the unit review (${input.openGapCount} open coverage gap${input.openGapCount === 1 ? "" : "s"}). The maturity rail's Reviewed lamp ${input.openGapCount === 0 ? "is now lit" : "stays unlit until the gaps are closed"}.`;
    },
  });

  return [
    readUnitStructureTool,
    updateUnitTool,
    createLessonTool,
    updateLessonTool,
    deleteLessonTool,
    generateLessonPromptTool,
    generateAllPromptsTool,
    createActivityTool,
    ...activityKindTools,
    updateActivityTool,
    deleteActivityTool,
    archiveActivityTool,
    reorderActivitiesTool,
    generateActivityPromptTool,
    createSlidesDeckTool,
    readDeckTool,
    applyDeckEditsTool,
    editGoogleDeckTool,
    recordUnitReviewTool,
    // Curated map-asset catalog (registry overlays/regions + historical era
    // basemaps) — a pure read so the bot can author map-using activities that
    // name real registry / era keys. No scholar data, safe for every role here.
    listGeomapAssetsTool,
    // Simulator template catalog (read) — lets the bot see the two physics
    // templates + their spec shape before it authors a Simulator.
    listSimulatorTemplatesTool,
    ...scholarReadTools,
    // Scholar-RECORD write tools (observation, report, dossier, reading
    // level, profile, account recovery, document/portfolio upload) — the
    // same scholar-page parity the global Curriculum Assistant + Slack get.
    // Role + surface filtered internally (empty for non-teacher roles); the
    // unit Curriculum Bot is a private teacher surface, so surface="private".
    ...scholarWriteTools,
    ...(listScholarGroupsTool ? [listScholarGroupsTool] : []),
    // Run the unit, not just design it: assign it to a cohort, read progress,
    // schedule / push its activities, edit the roster. Teacher/admin only
    // (gated inside makeAssignmentTools); empty otherwise.
    ...assignmentTools,
    // School inventory reference (read-only) — design lessons around gear the
    // school actually has.
    physicalEnvTools.read,
    // Web search + fetch — generic Anthropic-hosted capabilities for
    // grounding a unit in current events / recent facts. Search finds
    // pages; fetch reads a specific url the teacher pastes. Safe for every
    // role here.
    WEB_SEARCH_TOOL,
    WEB_FETCH_TOOL,
  ];
}
