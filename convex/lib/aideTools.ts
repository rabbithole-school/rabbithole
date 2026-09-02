// Bot DRY Layer 5 — the shared *aide tool assembler*.
//
// Layer 3 (scholarReadTools.ts) shared the seven read-only scholar
// lookup tools + the role→tool ACL. This layer pulls the rest of the
// global Curriculum Assistant's toolset (general unit reads + the
// scholar-scoped WRITE tools: directives, seeds, scholar units/lessons/
// activities, session tagging) out of the 2,900-line http.ts and behind
// a single `assembleCurriculumTools(role, scope)` call.
//
// Why this is the convergence point: "what an agent may see for a user"
// now resolves through ONE function keyed on role + scope. The unified
// aide endpoint (Tier 1) and the future OAuth MCP connector (Tier 3)
// both call this instead of re-deriving tool lists — a new persona is a
// gating change here, not a third inlined copy.
//
// Runtime note: like scholarReadTools, this dynamically imports
// `betaTool` and does NO static `@anthropic-ai/sdk` import (keeps
// node:* out of the edge bundle — see the SDK-pin TODO).

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ROLES, isTeacherRole, type Role } from "./roles";
import { postMessage, escapeSlackText } from "./slackApi";
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
  resolveScholarByName,
  matchScholarByName,
} from "./scholarReadTools";
import {
  makeScholarWriteTools,
  type WriteSurface,
  type AttachedFile,
} from "./scholarWriteTools";
import { makePhysicalEnvTools } from "./physicalEnvTools";
import { makeCustomAppTools } from "./customAppTools";
import { makeSuggestionTools } from "./suggestionTools";
import { makePracticePoolTools } from "./practicePoolTools";
import { makePracticeSkillTreeTools } from "./practiceSkillTreeTools";
import { makeMasterScheduleTools } from "./masterScheduleTools";
import { makeExternalAppsTools } from "./externalAppsTools";
import { makeHealthRecordTools } from "./healthRecordTools";
import { makeListGeomapAssetsTool } from "./geomapAssetsTool";
import { makeAssignmentTools } from "./assignmentTools";
import { makeActivityKindTools } from "./activityKindTools";
import {
  makeGoogleDocsTools,
  type GoogleDocsEmbeddableImage,
} from "./googleDocsTools";
import { makeUnitResolver } from "./aideResolvers";
import { withBase, unitPath, hstLabel } from "./channels";
import type { AideEmit, AideTool } from "./aideStream";

// hstLabel now lives in lib/channels (a pure, Convex-free module) so the
// MCP queries + Next route can format HST times the same way. Re-exported
// here because callers (slackBot) import it from the aide tool layer.
export { hstLabel };

/** Convert a transport's authorized stored attachments into the shared Docs
 * factory's single approved-image shape. */
export function googleDocsImagesFromAttachedFiles(
  files: readonly AttachedFile[],
  institutionId: Id<"institutions">,
) {
  return files.flatMap((file) =>
    typeof file.mimeType === "string" &&
    ["image/png", "image/jpeg", "image/gif"].includes(file.mimeType)
      ? [
          {
            storageId: file.storageId,
            mimeType: file.mimeType,
            institutionId,
          },
        ]
      : [],
  );
}

export function pickActivityByTitle<T extends { title: string }>(
  activities: T[],
  query: string,
): T | undefined {
  const lower = query.trim().toLowerCase();
  if (!lower) return undefined;
  return (
    activities.find((activity) => activity.title.toLowerCase() === lower) ??
    activities.find((activity) =>
      activity.title.toLowerCase().startsWith(lower),
    ) ??
    activities.find((activity) =>
      activity.title.toLowerCase().includes(lower),
    )
  );
}

/**
 * Build the global Curriculum Assistant's full toolset, role-gated.
 *
 * Composition (mirrors the previous inline assembly in http.ts):
 * - scholar-read tools — already role-filtered inside makeScholarReadTools
 *   (operations staff → list_scholars only; curriculum_designer → none).
 * - general unit reads (list_units / get_unit_details) — every staff role
 *   EXCEPT operations staff (scholar-agnostic, safe for designers).
 * - scholar-scoped writes (directive / seed / unit / lesson / activity) —
 *   teacher + admin only. They resolve a scholar by name, so handing them
 *   to a designer would both write per-scholar records and leak the roster.
 * - tag_session — teacher/admin AND only when a sessionId is in scope.
 */
export async function assembleCurriculumTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    sessionId?: Id<"chats"> | null;
    // Where deep links point: "" = relative (in-app UI), siteUrl() =
    // absolute (Slack / external channels). See lib/channels.ts.
    linkBase?: string;
    // Conversation surface — gates the credential-bearing + destructive +
    // file-upload scholar-write tools (private only, never a Slack channel).
    // Defaults to "private" (the in-app teacher session / MCP). Slack passes
    // its real surface.
    surface?: WriteSurface;
    // Guardian-form answers use their own approved boundary: Slack group DMs
    // are deliberately composed private rooms, unlike channels. Other tools
    // continue to use `surface` above.
    guardianFormAnswersSurface?: "private" | "shared";
    // Files the teacher attached to THIS turn (the in-app + button, or a
    // Slack DM attachment). Consumed by upload_scholar_document /
    // add_portfolio_item.
    attachedFiles?: AttachedFile[];
    // Image references are opt-in: a transport must prove its stored
    // attachments are scoped to this conversation and institution before the
    // shared Docs factory may embed them.
    docsEmbeddableImages?: () => readonly GoogleDocsEmbeddableImage[];
    // Institution-lens scoping for the scholar-READ tools. When set, the
    // roster + every named scholar lookup is restricted to this id set, and
    // `lensLabel` is surfaced to the model (see makeScholarReadTools). The
    // in-app aide passes its selected lens; Slack passes the requester's home
    // lens because Slack has no institution picker.
    allowedScholarIds?: Set<Id<"users">>;
    // Distinguishes "no lens supplied" from an admin's explicitly resolved
    // unrestricted all-institutions lens (both otherwise have no id set).
    scholarLensResolved?: boolean;
    lensLabel?: string | null;
    institutionScope?: string;
    institutionId?: Id<"institutions">;
    /** Established by the transport through schoolOperationsScopeForUser. */
    hasSchoolOperationsAccess?: boolean;
    /** Established by the transport through the server-side health capability. */
    hasHealthManagementAccess?: boolean;
    /** Transport-owned file delivery; intentionally absent outside Slack. */
    attachFile?: (args: {
      filename: string;
      mimeType: string;
      bytes: Uint8Array;
      title: string;
      initialComment: string;
    }) => Promise<{ ok: boolean }>;
  },
) {
  const {
    role,
    callerUserId,
    sessionId,
    linkBase = "",
    surface = "private",
    guardianFormAnswersSurface = "private",
    attachedFiles,
    docsEmbeddableImages,
    allowedScholarIds,
    scholarLensResolved,
    lensLabel,
    institutionScope,
    institutionId,
    hasSchoolOperationsAccess = false,
    hasHealthManagementAccess = false,
    attachFile,
  } = opts;
  const isSchoolOperator =
    role === ROLES.STAFF && hasSchoolOperationsAccess;
  // curriculum_designers design general curriculum and must NOT reach
  // scholar records — roster, mastery, or the per-scholar write tools.
  const canSeeScholarData = isTeacherRole(role);
  // Designing GENERAL curriculum (units not bound to a scholar) is open to
  // teacher/admin AND curriculum_designer — the broader set than
  // canSeeScholarData. Gates the create_unit tool (the Curriculum landing's
  // generative entry point), which writes no scholar data.
  const canDesignCurriculum =
    isTeacherRole(role) || role === ROLES.CURRICULUM_DESIGNER;

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  // Scholar-detail read tools (list_scholars, dossier, mastery, signals,
  // seeds, observations, sessions, documents) — role-filtered internally.
  // `allowedScholarIds`/`lensLabel` scope the roster + named lookups to the
  // caller's active institution lens when the aide passes them (undefined
  // elsewhere → unscoped).
  const scholarReadTools = await makeScholarReadTools(
    ctx,
    emit,
    role,
    allowedScholarIds,
    linkBase,
    lensLabel,
    institutionId,
    hasSchoolOperationsAccess,
  );

  // Scholar-groups roster lookup — teacher/admin only (member names are
  // roster data, same gate as the scholar-write tools). Lets the bot resolve
  // a group a teacher names ("make a lesson for the Seals") to its members.
  const listScholarGroupsTool = await makeListScholarGroupsTool(
    ctx,
    emit,
    allowedScholarIds,
  );

  // Scholar-RECORD write tools (observation, report, dossier, reading level,
  // profile, password/passkey reset, delete, document/portfolio upload) —
  // role + surface filtered internally (see lib/scholarWriteTools.ts). This
  // is what lets a teacher do through the bot what they do on the scholar
  // page. Shared verbatim with the Slack bot + MCP.
  const scholarWriteTools = await makeScholarWriteTools(ctx, emit, {
    role,
    callerUserId,
    surface,
    attachedFiles,
    linkBase,
    hasSchoolOperationsAccess,
    allowedScholarIds,
  });
  const healthRecordTools = await makeHealthRecordTools(ctx, emit, {
    role,
    callerUserId,
    surface,
    institutionScope,
    hasHealthManagementAccess,
  });

  // School physical-inventory tools (rooms + equipment) — read + write, for
  // ALL staff (same audience as the /school-space editor). Read lets the bot
  // reference "what's available" when designing; write lets a teacher say "the
  // metronome broke, remove it" (works in a Slack channel too — it's school
  // infrastructure, not sensitive scholar data, so it's NOT surface-gated).
  const physicalEnvTools = await makePhysicalEnvTools(ctx, emit, {
    callerUserId,
  });


  // Custom-app install tools (install an existing URL, vibecode + install a
  // static HTML app instantly, or dispatch a coded app that auto-installs on
  // merge) — teacher roles only (installing an app for a student is a teaching
  // action), checked inside makeCustomAppTools; returns [] for a non-teaching
  // caller, so this spreads unconditionally.
  const customAppTools = await makeCustomAppTools(ctx, emit, {
    role,
    callerUserId,
    sessionId,
    allowedScholarIds,
    lensLabel,
    // Same derivation as the master-schedule tools: an explicit resolved flag
    // from the transport, or the presence of an id set, both prove a lens was
    // actually considered. Lets the install mutations fail closed on callers
    // that never resolved one.
    scholarLensResolved:
      scholarLensResolved === true || allowedScholarIds !== undefined,
  });

  // Workshop tools (read the scholar-idea queue + reply to an idea) —
  // teacher+ ONLY (no env flag; the Workshop isn't behind INTROSPECTION_
  // ENABLED and ships dark until a scholar UI exists). Gated inside
  // makeSuggestionTools; returns [] for non-teachers, so this spreads
  // unconditionally.
  const suggestionTools = await makeSuggestionTools(ctx, emit, {
    role,
    callerUserId,
    allowedScholarIds,
    // Same derivation as the custom-app / master-schedule tools: an explicit
    // resolved flag from the transport, or the presence of an id set, both
    // prove a lens was actually considered — letting the backing internal fns
    // fail closed on callers that never resolved one.
    scholarLensResolved:
      scholarLensResolved === true || allowedScholarIds !== undefined,
  });

  // Practice item-pool tools (the chat transport over the teacher item-pool
  // surface) — gated to canDesignCurriculum inside makePracticePoolTools;
  // returns [] otherwise, so this spreads unconditionally.
  const practicePoolTools = await makePracticePoolTools(ctx, emit, { role });

  // Practice skill-tree tool (read the skill tree for a named scholar) —
  // teacher/admin only, gated inside makePracticeSkillTreeTools; [] otherwise,
  // so this spreads unconditionally.
  const practiceSkillTreeTools = await makePracticeSkillTreeTools(ctx, emit, {
    role,
    callerUserId,
    allowedScholarIds,
  });

  // Master-schedule tools (the recurring weekly timetable: blocks, class
  // placements, the shelf, teleport, bulk teacher reassignment, materialize a
  // live week) — the full parity surface so the bot can drive the grid ("field
  // trip Wednesday, help me shuffle"; "Lehua's out sick, cover her blocks").
  // Gated to teacher/admin inside makeMasterScheduleTools (shows teacher +
  // roster names, same audience as the assignment tools); [] otherwise.
  const masterScheduleTools = await makeMasterScheduleTools(ctx, emit, {
    role,
    callerUserId,
    allowedScholarIds,
    scholarLensResolved:
      scholarLensResolved === true || allowedScholarIds !== undefined,
  });
  const externalAppsTools = await makeExternalAppsTools(ctx, emit, {
    role,
    callerUserId,
    hasSchoolOperationsAccess,
  });
  const googleDocsTools = await makeGoogleDocsTools(ctx, emit, {
    role,
    callerUserId,
    institutionScope,
    availableImages: docsEmbeddableImages,
  });

  // Assignment-scheduling tools (assign a unit / an activity, read the agenda
  // + progress, schedule / reschedule / clear / push, edit the roster,
  // archive) — the shared group in lib/assignmentTools.ts, which the unit-page
  // Curriculum Bot spreads too. Gated to teacher/admin inside the factory
  // (reads the roster + edits the agenda), so it returns [] otherwise; it is
  // still spread inside the canSeeScholarData branch below so the assembled
  // order is unchanged. No `currentUnit`: the global aide has no unit in scope.
  const assignmentTools = await makeAssignmentTools(ctx, emit, {
    role,
    callerUserId,
    linkBase,
    allowedScholarIds,
  });

  const activityKindTools = canSeeScholarData
    ? await makeActivityKindTools(ctx, emit, {
        callerUserId,
        lessonAddress: {
          properties: {
            lessonId: {
              type: "string",
              description:
                "Direct lessonId returned from create_scholar_lesson. Required.",
            },
          },
          required: ["lessonId"],
          recoveryArg: "lessonId",
          resolve: async (input) => {
            const lessonId = input.lessonId as Id<"lessons">;
            const resolved = await ctx.runQuery(
              internal.curriculumAssistant.getLessonForActivityAuthoring,
              { lessonId },
            );
            return resolved
              ? { ok: true as const, lesson: resolved.lesson }
              : {
                  ok: false as const,
                  error: `No lesson found for lessonId "${lessonId}".`,
                };
          },
        },
        activityAddress: {
          properties: {
            lessonId: {
              type: "string",
              description:
                "Direct lessonId returned from create_scholar_lesson. Required.",
            },
            activityTitle: {
              type: "string",
              description:
                "Title of the activity to configure (case-insensitive match).",
            },
          },
          required: ["lessonId", "activityTitle"],
          recoveryArg: "lessonId + activityTitle",
          resolve: async (input) => {
            const lessonId = input.lessonId as Id<"lessons">;
            const resolved = await ctx.runQuery(
              internal.curriculumAssistant.getLessonForActivityAuthoring,
              { lessonId },
            );
            if (!resolved) {
              return {
                ok: false as const,
                error: `No lesson found for lessonId "${lessonId}".`,
              };
            }
            const activity = pickActivityByTitle(
              resolved.activities,
              input.activityTitle as string,
            );
            return activity
              ? {
                  ok: true as const,
                  lesson: resolved.lesson,
                  activity,
                }
              : {
                  ok: false as const,
                  error: `No activity matching "${input.activityTitle}" found on lesson "${resolved.lesson.title}".`,
                };
          },
        },
        activityUrl: (lesson, activityId) =>
          withBase(
            linkBase,
            unitPath(lesson.unitId, {
              lessonId: lesson._id,
              activityId,
            }),
          ),
      })
    : [];

  // Helper: resolve scholar name → row. Delegates to the shared resolver so
  // the matching (incl. its empty/whitespace guard — without it an empty
  // scholarName `includes("")`-matches the FIRST scholar and a write tool
  // would land a directive/seed on the wrong child) stays identical to the
  // read tools. The active institution lens applies to these generic writes too:
  // a teacher role alone must not make a program guest or another school's
  // scholar resolvable in Slack.
  const resolveScholar = (scholarName: string) =>
    resolveScholarByName(ctx, scholarName, allowedScholarIds);

  // Strict unit-title resolution — the SHARED implementation in
  // lib/aideResolvers.ts, so the assignment tools (lib/assignmentTools.ts)
  // and these curriculum tools resolve "the Elements of Culture unit" the
  // same way. An exact title wins, a unique partial wins, an ambiguous
  // partial refuses with the candidates, and a miss returns a nearby-titles
  // menu the model can self-correct from.
  const resolveUnitStrict = makeUnitResolver(ctx);

  const listUnitsTool = betaTool({
    name: "list_units",
    description:
      "List all curriculum units with title, description, target Bloom's level, and building block names (persona, perspective, process).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as const,
    },
    run: async () => {
      const units = await ctx.runQuery(
        internal.curriculumAssistant.listUnitsInternal,
        {},
      );
      const withUrls = units.map((u) => ({
        ...u,
        url: withBase(linkBase, unitPath(u.id)),
      }));
      emit({ toolComplete: { name: "list_units", result: `Found ${units.length} units` } });
      return JSON.stringify(withUrls);
    },
  });

  const getUnitDetailsTool = betaTool({
    name: "get_unit_details",
    description:
      "Get unit-level curriculum details, building blocks, and the ordered lesson/activity structure. By default, activities include only IDs, titles, and kinds. Set includeActivityDetails=true before assessing, diagnosing, or discussing an activity's instructions or quality bar; that adds each activity's systemPrompt and deliverable. Unit and activity prompts are separate: never infer an activity's prompt from the unit fields or claim you read an activity prompt unless activityDetailsIncluded is true.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unitTitle: {
          type: "string" as const,
          description: "The unit's title (case-insensitive partial match)",
        },
        includeActivityDetails: {
          type: "boolean" as const,
          description:
            "Include each activity's description, systemPrompt, deliverable, and advance rubric. Required for judgments about an activity's design or tutor behavior.",
        },
      },
      required: ["unitTitle"] as const,
    },
    run: async (input) => {
      const r = await resolveUnitStrict(input.unitTitle);
      if (!r.ok) return r.error;
      const unit = r.unit;
      const details = await ctx.runQuery(
        internal.curriculumAssistant.getUnitDetails,
        {
          unitId: unit.id as Id<"units">,
          includeActivityDetails: input.includeActivityDetails ?? false,
        },
      );
      emit({
        toolComplete: {
          name: "get_unit_details",
          result: input.includeActivityDetails
            ? `Loaded "${unit.title}" with activity prompts and deliverables`
            : `Loaded "${unit.title}" metadata and activity list; activity prompts and deliverables were not read`,
        },
      });
      return JSON.stringify({
        ...details,
        url: withBase(linkBase, unitPath(unit.id)),
      });
    },
  });

  // Rehearse + Debrief — kick off the curriculum-quality runs from chat
  // (UI↔tool parity: the same ops the teacher clicks in the Rehearse tab).
  // Both resolve the activity by title within a named unit and delegate to
  // the shared coreStart/coreGround behind explicit-actor internal
  // mutations. Curriculum-role only (gated with the unit reads below).
  const rehearseTool = betaTool({
    name: "rehearse_activity",
    description:
      "Rehearse an online (AI-tutor) activity: run a set of sims through it and score how the team (tutor + activity design) did. Set `revise` to also propose a prompt edit (it is NOT auto-applied — the teacher promotes it in the Rehearse tab). The result includes the exact activity prompt and deliverable snapshot used for the run; read that snapshot before characterizing the design. Use get_unit_details / list_units first if unsure of the exact titles.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unitTitle: { type: "string" as const, description: "The unit's title (case-insensitive partial match)." },
        activityTitle: { type: "string" as const, description: "The activity's title within that unit (case-insensitive partial match)." },
        revise: { type: "boolean" as const, description: "Also propose a prompt edit alongside the run (default false)." },
      },
      required: ["unitTitle", "activityTitle"] as const,
    },
    run: async (input) => {
      const r = await resolveUnitStrict(input.unitTitle);
      if (!r.ok) return r.error;
      const unit = r.unit;
      const res = await ctx.runMutation(
        internal.curriculumExperiments.aideStartRehearsal,
        {
          unitId: unit.id as Id<"units">,
          activityTitle: input.activityTitle,
          callerUserId,
          revise: input.revise ?? false,
        },
      );
      emit({ toolComplete: { name: "rehearse_activity", result: res.message } });
      return JSON.stringify({
        ...res,
        url: withBase(linkBase, unitPath(unit.id)),
      });
    },
  });

  const debriefTool = betaTool({
    name: "debrief_activity",
    description:
      "Debrief an activity's most recent finished rehearsal: compare the sims' scorecards against real scholar transcripts to check whether the sims ran optimistic/pessimistic. Requires a completed Rehearse on that activity first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unitTitle: { type: "string" as const, description: "The unit's title (case-insensitive partial match)." },
        activityTitle: { type: "string" as const, description: "The activity's title within that unit (case-insensitive partial match)." },
      },
      required: ["unitTitle", "activityTitle"] as const,
    },
    run: async (input) => {
      const r = await resolveUnitStrict(input.unitTitle);
      if (!r.ok) return r.error;
      const unit = r.unit;
      const res = await ctx.runMutation(
        internal.curriculumExperiments.aideGroundLatest,
        {
          unitId: unit.id as Id<"units">,
          activityTitle: input.activityTitle,
          callerUserId,
        },
      );
      emit({ toolComplete: { name: "debrief_activity", result: res.message } });
      return JSON.stringify({
        ...res,
        url: withBase(linkBase, unitPath(unit.id)),
      });
    },
  });

  const upsertTeacherDirectiveTool = betaTool({
    name: "upsert_teacher_directive",
    description:
      "Create or update a teacher directive — a persistent pedagogical instruction for the AI tutor about a specific scholar. Directives are standing rules (e.g., \"Use Structured Word Inquiry, not phonics drills\", \"Frame math as visual reasoning\", \"Cognitive profile and accommodations\") that the tutor treats as governing behavior for that scholar. Directives persist across sessions and are separate from the scholar dossier (which is observer/tutor-authored learning notes). If a directive with the same label already exists for this scholar, its content is REPLACED; otherwise a new directive is CREATED.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar's name (case-insensitive partial match)",
        },
        label: {
          type: "string" as const,
          description:
            "Short human-readable label identifying this directive (e.g., \"SWI directives\", \"Family context\", \"Cognitive profile\"). Used as the directive key — re-using the same label (case-insensitive) replaces the existing directive.",
        },
        content: {
          type: "string" as const,
          description:
            "The teacher-authored body of the directive. Preserves formatting verbatim; use plain prose or markdown bullets as you like.",
        },
      },
      required: ["scholarName", "label", "content"] as const,
    },
    run: async (input) => {
      const scholar = await resolveScholar(input.scholarName);
      if (!scholar) return `No scholar found matching "${input.scholarName}".`;
      const result = await ctx.runMutation(
        internal.teacherAide.upsertTeacherDirective,
        {
          scholarId: scholar.id as Id<"users">,
          label: input.label,
          content: input.content,
          authorId: callerUserId,
        },
      );
      emit({
        toolComplete: {
          name: "upsert_teacher_directive",
          result: `${result.action === "updated" ? "Updated" : "Created"} "${result.label}" directive for ${scholar.name}`,
        },
      });
      return `Teacher directive "${result.label}" ${result.action} for ${scholar.name}.`;
    },
  });

  const createScholarSeedTool = betaTool({
    name: "create_scholar_seed",
    description:
      "Create an active teacher-authored exploration seed for a scholar. Seeds are suggested topics the AI tutor will weave into future sessions — the teacher equivalent of the AI observer's own seed suggestions. Use this when you want to steer a specific scholar toward a topic (e.g., \"The -spect- morpheme family\" for a kid working on SWI).",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar's name (case-insensitive partial match)",
        },
        topic: {
          type: "string" as const,
          description: "Short topic phrase (e.g., \"Latin and Greek roots in filmmaking\")",
        },
        domain: {
          type: "string" as const,
          description:
            "Optional broad academic domain (e.g., \"Language Arts\", \"Mathematics\", \"Science\").",
        },
        rationale: {
          type: "string" as const,
          description:
            "Why this topic, for this scholar, right now. Informs the tutor on how to frame it.",
        },
        approachHint: {
          type: "string" as const,
          description:
            "Optional hint on how the tutor should approach the topic (pedagogical steer, example, on-ramp).",
        },
      },
      required: ["scholarName", "topic", "rationale"] as const,
    },
    run: async (input) => {
      const scholar = await resolveScholar(input.scholarName);
      if (!scholar) return `No scholar found matching "${input.scholarName}".`;
      await ctx.runMutation(internal.teacherAide.createScholarSeed, {
        scholarId: scholar.id as Id<"users">,
        teacherId: callerUserId,
        topic: input.topic,
        domain: input.domain,
        rationale: input.rationale,
        approachHint: input.approachHint,
      });
      emit({
        toolComplete: {
          name: "create_scholar_seed",
          result: `Seeded "${input.topic}" for ${scholar.name}`,
        },
      });
      return `Active seed "${input.topic}" created for ${scholar.name}.`;
    },
  });

  const createScholarQuestTool = betaTool({
    name: "create_scholar_quest",
    description:
      "Create a QUEST — an independent study owned by ONE scholar. This is NOT the general unit-creation tool; use create_unit for anything a class, cohort, pod, or group will do. Ownership is real and visible: the unit becomes that scholar's personal property (teacherId and authorScholarId are both set to them), it is hidden from every other scholar's unit picker, and it gets an automatic \"<title> — completed\" badge. Only reach for it when the teacher explicitly asks for a Quest (independent study) for one named scholar (e.g., \"set Maya up with her own Word Detective study\"). Having a scholar's page open, or naming the cohort a unit is for, is NOT such a request. Idempotent by (scholarName, title) — if a unit with the same title already exists for this scholar, returns the existing unitId without creating a duplicate. OUTCOME — tell the teacher exactly what the scholar will see: creating a quest leaves it DORMANT — it appears as a not-started card on the scholar's Home and on the teacher Quests board, but it is NOT an invitation star on their Sky (use offer_scholar_quest for that), and it is an empty container with nothing inside to do until you add lessons with create_scholar_lesson. A complete setup is usually create → populate → offer; if the teacher's ask is ambiguous (e.g. \"add these to X's quests\"), ask which they want, and always end by stating the visibility outcome in these terms. If you create one by mistake, clean it up with delete_empty_unit rather than leaving it on the scholar's board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar's name (case-insensitive partial match)",
        },
        title: {
          type: "string" as const,
          description: "Unit title (e.g., \"Word Detective\", \"Fractions Deep Dive\")",
        },
        emoji: {
          type: "string" as const,
          description: "Optional emoji to represent the unit in the UI",
        },
        description: {
          type: "string" as const,
          description: "Short description of what this unit is about",
        },
        bigIdea: {
          type: "string" as const,
          description: "The enduring big idea of the unit (PCM curriculum field)",
        },
        essentialQuestions: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Essential questions driving inquiry",
        },
        enduringUnderstandings: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Enduring understandings scholars should take away",
        },
        subject: {
          type: "string" as const,
          description: "Broad subject (e.g., \"Language Arts\", \"Mathematics\")",
        },
        gradeLevel: {
          type: "string" as const,
          description: "Grade level (e.g., \"3\", \"K-2\")",
        },
      },
      required: ["scholarName", "title"] as const,
    },
    run: async (input) => {
      const scholar = await resolveScholar(input.scholarName);
      if (!scholar) return `No scholar found matching "${input.scholarName}".`;
      const result = await ctx.runMutation(
        internal.teacherAide.createScholarQuest,
        {
          scholarId: scholar.id as Id<"users">,
          authorId: callerUserId,
          title: input.title,
          emoji: input.emoji,
          description: input.description,
          bigIdea: input.bigIdea,
          essentialQuestions: input.essentialQuestions,
          enduringUnderstandings: input.enduringUnderstandings,
          subject: input.subject,
          gradeLevel: input.gradeLevel,
        },
      );
      emit({
        toolComplete: {
          name: "create_scholar_quest",
          result: result.existed
            ? `Quest "${input.title}" already exists for ${scholar.name}`
            : `Created quest "${input.title}" for ${scholar.name}`,
        },
      });
      return JSON.stringify({
        unitId: result.unitId,
        existed: result.existed,
        scholarName: scholar.name,
        title: input.title,
        url: withBase(linkBase, unitPath(result.unitId)),
      });
    },
  });

  // General curriculum unit (NOT scholar-scoped) — the Curriculum landing's
  // generative entry point ("describe a unit and I'll build it"). The unit
  // appears in the general curriculum index for every teacher, owned by the
  // caller. Use create_scholar_quest instead only when a unit should be
  // private to one scholar's independent study.
  const createUnitTool = betaTool({
    name: "create_unit",
    description:
      "Create a new GENERAL curriculum unit (visible to all teachers in the curriculum index, owned by you). THIS IS THE DEFAULT unit-creation tool: use it whenever a teacher describes a unit they want to build, including every unit meant for a class, cohort, pod, or group — translate their description into a real unit. Idempotent by title for this author — re-running with the same title returns the existing unitId instead of duplicating. IMPORTANT: a unit is an empty container; after creating it, populate it with create_scholar_lesson (pass the returned unitId) — or tell the teacher to open the unit and keep designing with the unit's Curriculum Bot. Use create_scholar_quest instead ONLY when the teacher explicitly asks for a Quest (independent study) owned by one named scholar.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string" as const,
          description: "Unit title (e.g., \"Tide Pool Ecosystems\", \"Fractions Deep Dive\")",
        },
        emoji: {
          type: "string" as const,
          description: "Optional emoji to represent the unit in the UI",
        },
        description: {
          type: "string" as const,
          description: "Short description of what this unit is about",
        },
        bigIdea: {
          type: "string" as const,
          description: "The enduring big idea of the unit (PCM curriculum field)",
        },
        essentialQuestions: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Essential questions driving inquiry",
        },
        enduringUnderstandings: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Enduring understandings scholars should take away",
        },
        subject: {
          type: "string" as const,
          description: "Broad subject (e.g., \"Science\", \"Language Arts\", \"Mathematics\")",
        },
        gradeLevel: {
          type: "string" as const,
          description: "Grade level (e.g., \"3\", \"K-2\")",
        },
      },
      required: ["title"] as const,
    },
    run: async (input) => {
      const result = await ctx.runMutation(
        internal.teacherAide.createCurriculumUnit,
        {
          authorId: callerUserId,
          title: input.title,
          emoji: input.emoji,
          description: input.description,
          bigIdea: input.bigIdea,
          essentialQuestions: input.essentialQuestions,
          enduringUnderstandings: input.enduringUnderstandings,
          subject: input.subject,
          gradeLevel: input.gradeLevel,
        },
      );
      emit({
        toolComplete: {
          name: "create_unit",
          result: result.existed
            ? `Unit "${input.title}" already exists`
            : `Created unit "${input.title}"`,
        },
      });
      return JSON.stringify({
        unitId: result.unitId,
        existed: result.existed,
        title: input.title,
        url: withBase(linkBase, unitPath(result.unitId)),
      });
    },
  });

  // SELF-UNDO for a unit created by mistake — above all a `create_scholar_quest`
  // call that should have been `create_unit`, which leaves a stray Quest on a
  // real child's board (prod, 2026-07-31). Intentionally EMPTY-ONLY: the
  // backing mutation refuses a unit with any lesson, assignment, session,
  // completion, or badge, so this can never cascade away real work.
  const deleteEmptyUnitTool = betaTool({
    name: "delete_empty_unit",
    description:
      "Delete an EMPTY unit — your undo for a unit created by mistake, above all a create_scholar_quest call that should have been create_unit (that mistake leaves a stray Quest sitting on a real child's board, so clean it up rather than abandoning it). Refuses unless the unit is genuinely untouched: any lesson, assignment, session, completion, earned badge, offer seed, or recorded review blocks the delete, and the unit must be archived (or, for a quest that was offered to a scholar, retracted) instead. Deletion is permanent and not reversible. Use it freely and immediately to take back a unit YOU just created in this conversation; for anything the teacher authored, name the exact unit and get an explicit yes first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unitId: {
          type: "string" as const,
          description:
            "The unit's id — normally the one a create_unit / create_scholar_quest call just returned to you.",
        },
      },
      required: ["unitId"] as const,
    },
    run: async (input: { unitId: string }) => {
      try {
        const res = await ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
          callerUserId,
          unitId: input.unitId as Id<"units">,
        });
        emit({
          toolComplete: {
            name: "delete_empty_unit",
            result: `Deleted the empty unit "${res.title}"`,
          },
        });
        return JSON.stringify(res);
      } catch (e) {
        return `Could not delete: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const createScholarLessonTool = betaTool({
    name: "create_scholar_lesson",
    description:
      "Create a lesson inside a unit. Provide EITHER a direct unitId (returned from create_unit or create_scholar_quest) OR a unitTitle + scholarName pair that will be resolved to a scholar-scoped unit. Idempotent by (unitId, title) — if a lesson with the same title already exists under this unit, returns the existing lessonId without creating a duplicate. Strand is an OPTIONAL pedagogical tag (core = main concept, connections = interdisciplinary links, practice = application, identity = reflection / ownership) — omit it if the lesson doesn't cleanly fit one. Lessons form one freely-ordered list. When creating multiple lessons for the same unit, ALWAYS pass each lesson's zero-based position in the intended curriculum sequence (0, 1, 2, ...) because tool calls may run in parallel. Without position, a new lesson appends. If position is already occupied, the lesson inserts there and shifts the consecutive occupied slots after it by one — but when the unit ALREADY has lessons, prefer positions continuing after the existing ones (existing count, +1, +2, ...): parallel insert-at into occupied slots can land relative to pre-existing lessons in arrival order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unitId: {
          type: "string" as const,
          description: "Direct unitId (preferred if available). If omitted, supply unitTitle + scholarName.",
        },
        unitTitle: {
          type: "string" as const,
          description: "Unit title to resolve (case-insensitive partial match). Required if unitId is not provided.",
        },
        scholarName: {
          type: "string" as const,
          description: "Scholar name, used together with unitTitle to disambiguate a scholar-scoped unit.",
        },
        title: {
          type: "string" as const,
          description: "Lesson title",
        },
        strand: {
          type: "string" as const,
          enum: ["core", "connections", "practice", "identity"] as const,
          description: "Optional pedagogical strand tag: core | connections | practice | identity. Omit if the lesson doesn't cleanly fit one.",
        },
        systemPrompt: {
          type: "string" as const,
          description: "Optional system prompt specifically for the tutor when this lesson is the current focus",
        },
        durationMinutes: {
          type: "number" as const,
          description: "Optional expected duration in minutes",
        },
        position: {
          type: "integer" as const,
          minimum: 0,
          description:
            "Zero-based position in the intended lesson sequence. Required on every call when creating multiple lessons for one unit in the same turn.",
        },
      },
      required: ["title"] as const,
    },
    run: async (input) => {
      // Resolve unit: unitId takes precedence, else unitTitle (+ scholar scope).
      let unitId: Id<"units"> | null = null;
      let unitLabel = "(unknown)";
      if (input.unitId) {
        unitId = input.unitId as Id<"units">;
        const details = await ctx.runQuery(
          internal.curriculumAssistant.getUnitDetails,
          { unitId },
        );
        unitLabel = details?.title ?? "(unknown)";
      } else if (input.unitTitle) {
        // Strict resolution — same as assign_unit. The old first-substring
        // match here could silently create a lesson under the wrong
        // same-prefix unit (e.g. the Grades 3–5 sibling of a K–2 unit).
        // (Post-IS-refactor, the scholarName hint can't narrow the unit
        // search — units no longer carry scholarId — so it is ignored here.)
        const r = await resolveUnitStrict(input.unitTitle);
        if (!r.ok) return r.error;
        unitId = r.unit.id;
        unitLabel = r.unit.title;
      } else {
        return "Either unitId or unitTitle must be provided.";
      }

      const strand = input.strand as
        | "core"
        | "connections"
        | "practice"
        | "identity"
        | undefined;

      const result = await ctx.runMutation(
        internal.teacherAide.createScholarLesson,
        {
          unitId,
          title: input.title,
          strand,
          systemPrompt: input.systemPrompt,
          durationMinutes: input.durationMinutes,
          position: input.position,
        },
      );
      emit({
        toolComplete: {
          name: "create_scholar_lesson",
          result: result.existed
            ? `Lesson "${input.title}" already exists in "${unitLabel}"`
            : `Created lesson "${input.title}" in "${unitLabel}"`,
        },
      });
      return JSON.stringify({
        lessonId: result.lessonId,
        existed: result.existed,
        unitTitle: unitLabel,
        title: input.title,
        // Lands the teacher on this lesson in the unit designer (where its
        // activities show too) — so a created activity is reachable here.
        url: withBase(linkBase, unitPath(unitId, { lessonId: result.lessonId })),
      });
    },
  });

  const moveLessonTool = betaTool({
    name: "move_lesson",
    description:
      "Move a lesson — and every activity inside it, which follows automatically — from its current unit to a different unit. Use this to reorganize curriculum (e.g. \"move the fractions lesson into Number Sense\") instead of proposing a rebuild-from-scratch workaround; a lesson move never touches historical scholar progress records. Provide EITHER a direct targetUnitId OR a targetUnitTitle (case-insensitive partial match). Idempotent: moving a lesson into the unit it's already in is a safe no-op. The lesson is appended to the end of the destination unit's lesson order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonId: {
          type: "string" as const,
          description:
            "The lesson's Convex ID (from list_units, get_unit_details, or a prior create_scholar_lesson result).",
        },
        targetUnitId: {
          type: "string" as const,
          description: "Direct destination unitId (preferred if available). If omitted, supply targetUnitTitle.",
        },
        targetUnitTitle: {
          type: "string" as const,
          description: "Destination unit title to resolve (case-insensitive partial match). Required if targetUnitId is not provided.",
        },
      },
      required: ["lessonId"] as const,
    },
    run: async (input) => {
      let targetUnitId: Id<"units"> | null = null;
      let targetUnitLabel = "(unknown)";
      if (input.targetUnitId) {
        targetUnitId = input.targetUnitId as Id<"units">;
        const details = await ctx.runQuery(
          internal.curriculumAssistant.getUnitDetails,
          { unitId: targetUnitId },
        );
        targetUnitLabel = details?.title ?? "(unknown)";
      } else if (input.targetUnitTitle) {
        const r = await resolveUnitStrict(input.targetUnitTitle);
        if (!r.ok) return r.error;
        targetUnitId = r.unit.id as Id<"units">;
        targetUnitLabel = r.unit.title;
      } else {
        return "Either targetUnitId or targetUnitTitle must be provided.";
      }

      let result: {
        movedLessonId: Id<"lessons">;
        lessonTitle: string;
        fromUnitId: Id<"units">;
        toUnitId: Id<"units">;
        moved: boolean;
      };
      try {
        result = await ctx.runMutation(internal.teacherAide.moveLesson, {
          lessonId: input.lessonId as Id<"lessons">,
          targetUnitId,
        });
      } catch (e) {
        return `Could not move lesson: ${e instanceof Error ? e.message : String(e)}`;
      }

      const summary = result.moved
        ? `Moved "${result.lessonTitle}" to "${targetUnitLabel}"`
        : `"${result.lessonTitle}" is already in "${targetUnitLabel}"`;
      emit({ toolComplete: { name: "move_lesson", result: summary } });
      return JSON.stringify({
        lessonId: result.movedLessonId,
        lessonTitle: result.lessonTitle,
        fromUnitId: result.fromUnitId,
        toUnitId: result.toUnitId,
        moved: result.moved,
        url: withBase(linkBase, unitPath(targetUnitId, { lessonId: result.movedLessonId })),
      });
    },
  });

  const createScholarActivityTool = betaTool({
    name: "create_scholar_activity",
    description:
      "Create an activity inside a lesson. Idempotent by (lessonId, title). When creating multiple activities for the same lesson, ALWAYS pass each activity's zero-based position in the intended sequence (0, 1, 2, ...) because tool calls may run in parallel. Without position, a new activity appends. If position is already occupied, the activity inserts there and shifts the consecutive occupied slots after it by one — but when the lesson ALREADY has activities, prefer positions continuing after the existing ones: parallel insert-at into occupied slots can land relative to pre-existing activities in arrival order.\n\n**kind** selects the activity type (default `online`):\n  - `online` — the scholar opens this in Rabbithole and it drives an AI tutor session. Give it a `systemPrompt` AND exactly ONE evaluation shape — a `deliverable` OR an `advanceRubric` (see below).\n  - `offline` — a teacher-run classroom task (discussion, lab, worksheet). Not opened in Rabbithole; no systemPrompt or rubric needed.\n  - `vibecode` — a full-screen app-builder workshop: the scholar describes an app/game and DIRECTS an AI builder that writes + iterates a live web app; the app is the artifact. Reach for this whenever the teacher wants scholars to make/build/\"vibecode\" something interactive. Here the `systemPrompt` IS the BUILD BRIEF (what to build + the learning goal), NOT a tutor prompt. No rubric needed. (If the teacher may instead want a fixed simulation the scholar TUNES and observes, that's a Simulator — use `create_simulator_activity`, and ask first if it's ambiguous.)\nFor a Simulator activity (stored as `world`), use `create_simulator_activity`; for `problem_set`, use `create_problem_set`. Do NOT widen this tool's kind: both dedicated tools validate payloads this generic writer cannot carry. For `game`, `web`, or `shareBack`, create the lesson, link its Edit surface, and hand off to the teacher to choose the catalog-backed activity there.\n\n**Choosing the evaluation shape for an ONLINE activity — the most important decision.** Pick ONE:\n\n  • **`deliverable`** — when the scholar produces any ARTIFACT/PRODUCT (a story, drawing, photo, code, slide deck, audio, a written write-up). This explicitly includes kind 'map' when the saved map itself is the work scholars should repeatedly 'Check my work' or 'Send'. Its criteria are a private quality map for the tutor, NOT a scholar checklist or a completion gate. The scholar clicks 'Check my work' and the AI verdicts each criterion 'not'/'half'/'full'. A full criterion permanently awards it as scholar-visible flair; its label and description are shown together. Half/not-full remain private, and normal completion is separate.\n\n  • **`advanceRubric`** — when the learning happens IN CONVERSATION or through interactions and there is NO produced artifact: a Socratic discussion, or an INTERACTIVE MAP / GEOGRAPHY DISCOVERY activity. The tutor grades the scholar's talk + map interactions (pins, predictions, explanations) against the criteria and a full pass completes the activity — with no noise document. Criteria grade what the scholar DEMONSTRATES ('Located the requested places', 'Predicted before revealing', 'Explained the pattern in their own words', 'Transferred it to a new case').\n\nCriteria written only into `systemPrompt` are decorative and cannot award flair or complete an advance rubric.\n\n**GEOGRAPHY / MAP activities specifically:** do NOT build a rapid verbal quiz over a mute base map, and do NOT force a write-up document onto it. For a discovery sequence, build it as an `online` activity whose `systemPrompt` drives the tutor's `show_map` tool — open ONE map (op 'create', once), then before each change call op 'read' and reveal ONE variable with op 'patch'. Ask a question between patches, and have the scholar COMMIT a pin BEFORE each reveal (predict-before-reveal). Set a checkable `task` on the map when there's a right answer to locate, and design the prompt so the scholar drops a pin before each reveal. Give discovery sequences an `advanceRubric`; when the saved map itself is the product scholars should repeatedly 'Check my work' or 'Send', use a kind 'map' deliverable instead. (See the seeded Geography Quests for the canonical shape.)\n\n**criteria** (in either shape) is an array of 3-6 DIMENSIONAL items, each { label, description }. Give each a short label and put the concrete quality bar in its description. State what counts as 'full' vs 'half'/'not'. Never attach BOTH a deliverable and an advanceRubric.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lessonId: {
          type: "string" as const,
          description:
            "Direct lessonId, returned from create_scholar_lesson. Required.",
        },
        title: {
          type: "string" as const,
          description: "Activity title (what the scholar sees as 'task name')",
        },
        kind: {
          type: "string" as const,
          enum: ["online", "offline", "vibecode"] as const,
          description:
            "Activity type. online (default) = AI tutor session (needs systemPrompt + exactly ONE evaluation shape: a deliverable OR an advanceRubric); offline = teacher-run classroom task (no rubric); vibecode = full-screen app-builder workshop where systemPrompt is the BUILD BRIEF (no rubric). Set vibecode whenever the teacher wants scholars to make/build/'vibecode' something interactive.",
        },
        description: {
          type: "string" as const,
          description:
            "TEACHER-FACING description: design intent + facilitation notes, and (for online activities) context the AI tutor reads. NEVER shown to scholars. This is NOT the scholar's card copy — use scholarDescription for what the scholar reads. It may be full facilitation prose; preserve teacher-provided paragraphs rather than trimming to a one-liner.",
        },
        scholarDescription: {
          type: "string" as const,
          description:
            "SCHOLAR-FACING blurb shown on the scholar's home card + activity nav. Write TO the scholar, 2nd person, invitational and concrete (e.g. \"You'll design a terrarium, then predict what happens when a species disappears\"). Do NOT reveal pedagogy or assessment framing — never mention 'stealth pre-assessment', 'baseline', 'exit ticket', rubrics, or 'we're measuring'. Optional; if omitted the scholar sees a title-only card (there is no fallback to the teacher description).",
        },
        systemPrompt: {
          type: "string" as const,
          description:
            "For online: the AI tutor's system prompt during this activity (overrides lesson/unit prompts). For vibecode: the BUILD BRIEF (what to build + the learning goal). Omit for offline.",
        },
        durationMinutes: {
          type: "number" as const,
          description: "Optional expected duration in minutes.",
        },
        position: {
          type: "integer" as const,
          minimum: 0,
          description:
            "Zero-based position in the intended activity sequence. Required on every call when creating multiple activities for one lesson in the same turn.",
        },
        deliverable: deliverableSchemaFragment(),
        advanceRubric: advanceRubricSchemaFragment(),
      },
      required: ["lessonId", "title"] as const,
    },
    run: async (input) => {
      const kind =
        (input.kind as "online" | "offline" | "vibecode" | undefined) ??
        "online";
      let result;
      try {
        // Only ONLINE activities are exit-bar-gated. offline = a teacher-run
        // classroom task; vibecode = a build-brief workshop (systemPrompt is
        // the brief). Neither takes an exit bar.
        const deliverable =
          kind === "online"
            ? parseDeliverableArg(input.deliverable as RawBotDeliverable)
            : undefined;
        const advanceRubric =
          kind === "online"
            ? parseAdvanceRubricArg(input.advanceRubric as RawBotAdvanceRubric)
            : undefined;
        if (kind === "online" && deliverable && advanceRubric) {
          throw new Error(
            "Attach EITHER a deliverable (document product) OR an advanceRubric " +
              "(conversation-graded, no document) — not both.",
          );
        }
        if (kind === "online" && !deliverable && !advanceRubric) {
          throw new Error(
            "An online activity must have an exit bar. Pass a deliverable " +
              "({ kind, prompt, criteria: [{label, description}, ...] }) when the scholar " +
              "produces a document, OR an advanceRubric ({ criteria: [{label, description}, ...] }) " +
              "when the learning happens in conversation with no document (a discussion or a " +
              "map/geography discovery quiz — grade the talk + map interactions). " +
              "If this is an offline classroom task or a vibecode build workshop, pass " +
              "kind:'offline' or kind:'vibecode' instead — those need no exit bar.",
          );
        }
        result = await ctx.runMutation(
          internal.teacherAide.createScholarActivity,
          {
            lessonId: input.lessonId as Id<"lessons">,
            title: input.title,
            kind,
            description: input.description,
            scholarDescription: input.scholarDescription,
            systemPrompt: input.systemPrompt,
            durationMinutes: input.durationMinutes,
            position: input.position,
            deliverable,
            advanceRubric,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          toolComplete: {
            name: "create_scholar_activity",
            result: `Refused: ${msg.slice(0, 200)}`,
          },
        });
        return JSON.stringify({
          ...refusedRecoveryMessage("create_scholar_activity", "lessonId + title"),
          error: msg,
        });
      }

      const sseSummary = result.existed
        ? `Activity "${input.title}" already exists; left as-is.`
        : result.kind === "vibecode"
          ? `Created vibecode activity "${input.title}".`
          : result.kind === "offline"
            ? `Created offline activity "${input.title}".`
            : `Created online activity "${input.title}".`;
      emit({
        toolComplete: {
          name: "create_scholar_activity",
          result: sseSummary,
        },
      });

      return JSON.stringify({
        activityId: result.activityId,
        existed: result.existed,
        title: input.title,
        kind: result.kind,
        deliverableAttached: result.deliverableAttached,
        // Deep link straight to the activity in the curriculum column-view.
        // ALWAYS link this — it's the thing the teacher most wants to open
        // (the unit/lesson links land a level up).
        ...(result.unitId
          ? {
              url: withBase(
                linkBase,
                unitPath(result.unitId, {
                  lessonId: input.lessonId,
                  activityId: result.activityId,
                }),
              ),
            }
          : {}),
      });
    },
  });

  // tag_session: lets the AI associate a global session with a specific scholar
  const tagSessionTool =
    sessionId != null
      ? betaTool({
          name: "tag_session",
          description:
            "Tag this chat session with the scholar it is primarily about. " +
            "Call this as soon as you determine one specific scholar is the focus of the conversation " +
            "(e.g. teacher asks 'what should I do for Kai?'). " +
            "Only call once per session and only when confident. " +
            "Do NOT call for general or multi-scholar questions.",
          inputSchema: {
            type: "object" as const,
            properties: {
              scholarId: { type: "string", description: "The scholar's Convex user ID" },
            },
            required: ["scholarId"] as const,
          },
          run: async (input: { scholarId: string }) => {
            await ctx.runMutation(internal.curriculumAssistant.tagSession, {
              sessionId,
              scholarId: input.scholarId as Id<"users">,
              callerUserId: opts.callerUserId,
            });
            return JSON.stringify({ tagged: true });
          },
        })
      : null;

  // Quest lifecycle transitions — offer / retract / reopen a scholar's
  // independent quest. Thin wrappers over the convex/quests.ts transition
  // surface; the backing internal mutations re-check the teacher role +
  // scholar-access boundary server-side.
  const offerScholarQuestTool = betaTool({
    name: "offer_scholar_quest",
    description:
      "Offer a quest to a scholar — plants the invitation star on their Sky/Home pointing at an existing unit (state becomes `offered`; the scholar taps the star to begin). This is the step that makes a quest VISIBLE AS AN INVITATION: create_scholar_quest alone leaves a quest dormant (a not-started card, no star). Idempotent per (scholar, unit) — re-offering while an offer is open returns the existing star. Needs the unit id (from create_scholar_quest, list_units, or a scholar read) plus the scholar's name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar receiving the quest (case-insensitive partial match)",
        },
        unitId: {
          type: "string" as const,
          description: "The quest's unit id (e.g. from create_scholar_quest or list_units)",
        },
        topic: {
          type: "string" as const,
          description: "Optional invitation-star topic; defaults to the unit title",
        },
        rationale: {
          type: "string" as const,
          description: "Optional rationale shown with the invitation",
        },
      },
      required: ["scholarName", "unitId"] as const,
    },
    run: async (input: {
      scholarName: string;
      unitId: string;
      topic?: string;
      rationale?: string;
    }) => {
      const scholar = await resolveScholar(input.scholarName);
      if (!scholar) return `No scholar found matching "${input.scholarName}".`;
      try {
        const res = await ctx.runMutation(internal.quests.aideOfferScholarQuest, {
          callerUserId,
          scholarId: scholar.id as Id<"users">,
          unitId: input.unitId as Id<"units">,
          topic: input.topic,
          rationale: input.rationale,
        });
        const title = res.unitTitle;
        const outcome = res.existed
          ? `invitation star already open (state: ${res.state ?? "unknown"})`
          : `invitation star planted (state: ${res.state ?? "unknown"})`;
        const result = `Offered "${title}" to ${scholar.name} — ${outcome}.`;
        emit({ toolComplete: { name: "offer_scholar_quest", result } });
        return result;
      } catch (e) {
        return `Could not offer: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const retractScholarQuestTool = betaTool({
    name: "retract_scholar_quest",
    description:
      "Retract a scholar's quest (an independent-study unit / teacher-offered quest) in ONE action: it deactivates the unit, dismisses its open offer stars, and archives its sessions — clearing it from the scholar's Home and Sky. Nothing is deleted and it's fully reversible with reopen_scholar_quest (the unit is deactivated, sessions soft-archived). You need the unit's id (from list_units or a scholar read) plus the scholar's name. ALWAYS confirm the specific scholar + quest with the teacher before retracting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar who owns the quest (case-insensitive partial match)",
        },
        unitId: {
          type: "string" as const,
          description: "The quest's unit id (e.g. from list_units or create_scholar_quest)",
        },
      },
      required: ["scholarName", "unitId"] as const,
    },
    run: async (input: { scholarName: string; unitId: string }) => {
      const scholar = await resolveScholar(input.scholarName);
      if (!scholar) return `No scholar found matching "${input.scholarName}".`;
      try {
        const res = await ctx.runMutation(internal.quests.aideRetractScholarQuest, {
          callerUserId,
          unitId: input.unitId as Id<"units">,
          expectedScholarId: scholar.id as Id<"users">,
        });
        emit({
          toolComplete: {
            name: "retract_scholar_quest",
            result: `Retracted a quest for ${scholar.name} (${res.sessionsArchived} session(s) archived, ${res.seedsDismissed} offer(s) dismissed)`,
          },
        });
        return JSON.stringify({ ...res, scholarName: scholar.name });
      } catch (e) {
        return `Could not retract: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const reopenScholarQuestTool = betaTool({
    name: "reopen_scholar_quest",
    description:
      "Reopen a previously retracted scholar quest — the inverse of retract_scholar_quest. It reactivates the unit and unarchives its sessions, so the scholar can pick the quest back up. The offer stars stay dismissed, so use offer_scholar_quest if you want a fresh star on the scholar's Sky. Needs the unit's id and the scholar's name. Confirm the specific scholar + quest with the teacher first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar who owns the quest (case-insensitive partial match)",
        },
        unitId: {
          type: "string" as const,
          description: "The quest's unit id",
        },
      },
      required: ["scholarName", "unitId"] as const,
    },
    run: async (input: { scholarName: string; unitId: string }) => {
      const scholar = await resolveScholar(input.scholarName);
      if (!scholar) return `No scholar found matching "${input.scholarName}".`;
      try {
        const res = await ctx.runMutation(internal.quests.aideReopenScholarQuest, {
          callerUserId,
          unitId: input.unitId as Id<"units">,
          expectedScholarId: scholar.id as Id<"users">,
        });
        emit({
          toolComplete: {
            name: "reopen_scholar_quest",
            result: `Reopened a quest for ${scholar.name} (${res.sessionsUnarchived} session(s) restored)`,
          },
        });
        return JSON.stringify({ ...res, scholarName: scholar.name });
      } catch (e) {
        return `Could not reopen: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // Aide model preference — the "vote with your feet" switch (see
  // lib/aideModel.ts). Every staff role, every surface, so a Slack user
  // can opt in by just asking ("switch my aide to fable"). The backing
  // mutation re-checks the caller's role server-side.
  const setAideModelTool = betaTool({
    name: "set_aide_model",
    description:
      "Switch which Claude model powers this assistant for the person you're talking to — a per-person preference covering all their aide surfaces (this chat, the Curriculum Bot, Slack). Options: 'sonnet' (Claude Sonnet 5 — fast, balanced, the cheapest), 'opus' (Claude Opus 4.8 — quickest to start answering, terse), 'fable' (Claude Fable 5 — Anthropic's most capable model, and the current default; pauses to think ~10-30s before each answer). Takes effect from their next message. Use when they ask to switch, try, or reset their aide/assistant model.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model: {
          type: "string" as const,
          enum: ["sonnet", "opus", "fable"],
          description:
            "Each value pins that model for this person; 'fable' is the current fleet default, 'sonnet' is the cheapest.",
        },
      },
      required: ["model"] as const,
    },
    run: async (input) => {
      const choice = input.model as "sonnet" | "opus" | "fable";
      await ctx.runMutation(internal.users.setAideModelInternal, {
        callerUserId,
        model: choice,
      });
      const label =
        choice === "fable"
          ? "Claude Fable 5"
          : choice === "opus"
            ? "Claude Opus 4.8"
            : "Claude Sonnet 5";
      emit({
        toolComplete: {
          name: "set_aide_model",
          result: `Aide model set to ${label}`,
        },
      });
      return `Done — this assistant now runs on ${label} for you, starting with your next message.${
        choice === "fable"
          ? " Heads up: Fable thinks before it speaks, so expect a longer pause before the first words of each reply."
          : ""
      }`;
    },
  });

  // Relay a Slack DM to a linked staff member ON BEHALF of the current staff
  // user — the courier the aide was missing ("send that to Andy on Slack").
  // Every staff role, every surface (in-app dock, Slack, MCP). The DM is
  // posted by the bot but ALWAYS opens with a bold attribution line naming the
  // HUMAN sender so it can never read as the bot's own words, then their
  // message verbatim (escaped). Recipient must be a STAFF user WITH a linked
  // slackUserId — never a scholar/parent (they aren't even candidates: the
  // backing directory query is staff-only). Mirrors the parentMessageSlack
  // attribution + escape + markdown posting pattern.
  const sendSlackDmTool = betaTool({
    name: "send_slack_dm",
    description:
      "Send a REAL Slack direct message to another STAFF member, as a relay FROM the current staff user — you are a courier, not the author. Use when the person asks to 'message / DM / tell / ping <someone> on Slack'. The DM is posted by the Rabbithole bot but ALWAYS opens with a bold line attributing it to the human sender, followed by their message verbatim; you must never write your own words into it or reword theirs. BEFORE calling, show the person the EXACT message text and the resolved recipient and get an explicit yes — never send speculatively. `recipient` is a staff member's name or username; an ambiguous name is rejected with the candidate list so you can ask which one they mean. Only staff who are linked to Slack can be reached (an admin links them in /admin); scholars and parents can never be DMed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipient: {
          type: "string" as const,
          description:
            "The STAFF recipient's name or username (case-insensitive). An ambiguous partial name is rejected with the candidate list rather than guessed.",
        },
        message: {
          type: "string" as const,
          description:
            "The exact message to relay, in the sender's own words. It is sent verbatim (escaped) under a bold 'From <sender> (via Rabbithole):' line — do NOT add your own attribution or reword it.",
        },
      },
      required: ["recipient", "message"] as const,
    },
    run: async (input) => {
      const recipient = (input.recipient ?? "").trim();
      const message = (input.message ?? "").trim();
      if (!recipient) {
        return "Tell me who to send the Slack DM to (a staff member's name or username).";
      }
      if (!message) {
        return "There's no message to relay — give me the text to send.";
      }

      // Resolve against the STAFF directory (staff-only, so a scholar/parent
      // never matches). Exact username wins outright (usernames are unique);
      // otherwise fall back to the strict, ambiguity-rejecting name matcher the
      // emergency-info tool uses.
      const staff = await ctx.runQuery(
        internal.users.listStaffForSlackDmInternal,
        {},
      );
      const lower = recipient.toLowerCase();
      const byUsername = staff.filter(
        (s) => s.username && s.username.toLowerCase() === lower,
      );
      const m =
        byUsername.length === 1
          ? ({ kind: "match", scholar: byUsername[0] } as const)
          : matchScholarByName(recipient, staff);
      if (m.kind === "none") {
        return `I couldn't find a staff member named "${recipient}" to DM on Slack. I can only send Slack DMs to staff (teachers, admins, and other staff) — not scholars or parents.`;
      }
      if (m.kind === "ambiguous") {
        const candidates = m.candidates
          .map((c) => (c.username ? `${c.name} (@${c.username})` : c.name))
          .join(", ");
        return `"${recipient}" is ambiguous — more than one staff member matches: ${candidates}. Ask which one they mean, then try again with a full name or username.`;
      }
      const target = m.scholar;
      if (!target.slackUserId) {
        return `${target.name} isn't linked to Slack, so I can't DM them. An admin can link their Slack account in /admin.`;
      }

      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) {
        return "Slack isn't configured on this deployment, so I can't send Slack DMs.";
      }

      // Attribution is mandatory: the DM opens with a bold line naming the
      // HUMAN sender, then their message verbatim — both interpolated values
      // run through escapeSlackText so the bot never emits text that could read
      // as its own (or someone else's) authored words.
      const sender = await ctx.runQuery(internal.users.getByIdInternal, {
        id: callerUserId,
      });
      const senderName =
        sender?.name ?? sender?.username ?? "a Rabbithole staff member";
      const text = `*From ${escapeSlackText(senderName)} (via Rabbithole):*\n${escapeSlackText(
        message,
      )}`;

      let res: { ok: boolean; ts?: string };
      try {
        // chat.postMessage with channel: <slackUserId> opens the IM implicitly
        // (im:write) — the same pattern slackNotifications.postNow uses.
        res = await postMessage(token, {
          channel: target.slackUserId,
          text,
          markdown: true,
        });
      } catch (err) {
        console.error("send_slack_dm postMessage threw:", err);
        return `Something went wrong reaching Slack to DM ${target.name}. Please try again in a moment.`;
      }
      if (!res.ok) {
        return `Slack wouldn't deliver the DM to ${target.name}. An admin may need to re-check their Slack link in /admin.`;
      }
      emit({
        toolComplete: {
          name: "send_slack_dm",
          result: `DM sent to ${target.name}`,
        },
      });
      return `Sent to ${target.name} on Slack.`;
    },
  });

  // Curated map-asset catalog (registry datasets + historical era basemaps) —
  // a pure read of checked-in modules, no ctx/query. Assembled onto the
  // curriculum-design surfaces below.
  const listGeomapAssetsTool = await makeListGeomapAssetsTool(emit);

  // Built by push into a pre-typed array rather than as one literal: a
  // literal holding this many tools makes TS materialise the union of every
  // tool's input schema, which exceeds its complexity limit (TS2590) — same
  // fix as slackBot.ts's tool assembly.
  const tools: AideTool[] = [];
  // A base staff account acquires no ambient authority. A current
  // school:operations grant exposes only the legacy operations-staff-safe account and
  // roster surface, and every scholar lookup is constrained to its grants.
  // Keep this return before generic "all staff" conveniences so a new tool
  // cannot accidentally become authority for an operations-only operator.
  if (role === ROLES.STAFF) {
    if (isSchoolOperator) {
      tools.push(
        ...scholarReadTools,
        ...scholarWriteTools,
        ...externalAppsTools,
      );
    }
    if (hasHealthManagementAccess) tools.push(...healthRecordTools);
    return tools;
  }
  tools.push(
    // scholarReadTools is already role-filtered inside makeScholarReadTools
    // (base staff → gated by school:operations; curriculum_designer → none).
    ...scholarReadTools,
    // Scholar-RECORD write tools — already role + surface filtered inside
    // makeScholarWriteTools (empty for non-teacher roles), so spread
    // unconditionally. This is the scholar-page parity surface.
    ...scholarWriteTools,
    // Canonical scholar emergency/medical information — scholar-admin roles,
    // independently re-authorized in the backing query. Channel calls return
    // only a DM instruction; private surfaces receive the minimum emergency set.
    ...healthRecordTools,
    // General curriculum reads + the quality-run kickoffs — teacher /
    // admin / curriculum_designer. Scholar-agnostic, so safe for designers
    // (rehearse/debrief gate the same as the public start/groundExperiment,
    // which allow any curriculum role).
    listUnitsTool,
    getUnitDetailsTool,
    rehearseTool,
    debriefTool,
    // Curated map-asset catalog — a pure read of checked-in registry
    // datasets + historical era basemaps (with provenance), so an author
    // can point a map-using activity at real keys. Same curriculum-design
    // audience as the reads above (teacher / admin / designer); carries no
    // scholar data.
    listGeomapAssetsTool,
    // Create a GENERAL (non-scholar) unit — the Curriculum landing's
    // generative entry point. Same curriculum-design set as the reads
    // above (teacher / admin / curriculum_designer); it
    // writes no scholar data, so designers get it too.
    // create_unit + its undo. Same curriculum-design gate; the delete
    // mutation separately requires scholar access before it will remove a
    // SCHOLAR-owned unit, so a designer can undo their own unit without
    // reaching into a scholar's Quests board.
    ...(canDesignCurriculum ? [createUnitTool, deleteEmptyUnitTool] : []),
    // Scholar-targeted writes — teacher/admin only. They resolve a scholar
    // by name, so handing them to a designer both writes per-scholar records
    // and leaks the roster.
    ...(canSeeScholarData
      ? [
          // Scholar-groups roster lookup — names map to members, so
          // teacher/admin only (same gate as the writes below).
          listScholarGroupsTool,
          upsertTeacherDirectiveTool,
          createScholarSeedTool,
          createScholarQuestTool,
          createScholarLessonTool,
          moveLessonTool,
          createScholarActivityTool,
          ...activityKindTools,
          // Assignment scheduling (create / read / schedule / push / roster /
          // archive) — the SHARED group from lib/assignmentTools.ts, which the
          // unit-page Curriculum Bot registers too. It re-checks the same
          // isTeacherRole gate internally, so the set here is unchanged.
          ...assignmentTools,
          // Quest lifecycle transitions (offer / retract / reopen).
          offerScholarQuestTool,
          retractScholarQuestTool,
          reopenScholarQuestTool,
        ]
      : []),
    // tag_session scopes a chat thread to a scholar — scholar-record
    // territory, so teacher/admin only (and only when a session is in scope).
    ...(tagSessionTool && canSeeScholarData ? [tagSessionTool] : []),
    // Per-person model preference — every staff role, every surface (the
    // Slack opt-in path; the web UI also has a picker).
    setAideModelTool,
    // Relay a Slack DM to a linked staff member on behalf of the caller —
    // every staff role, every surface (the recipient directory is staff-only,
    // and the backing send re-reads identity server-side).
    sendSlackDmTool,
    // Web search + fetch — generic, non-sensitive capabilities
    // (Anthropic-hosted), available to every staff role the aide serves.
    // Search grounds lessons/answers in current events past the training
    // cutoff; fetch reads a specific url a teacher pastes.
    WEB_SEARCH_TOOL,
    WEB_FETCH_TOOL,
    // School physical inventory — read + write for every staff role (the
    // /school-space editor's audience). Not surface-gated: managing school gear
    // ("the metronome broke, remove it") is fine from a Slack channel.
    physicalEnvTools.read,
    ...physicalEnvTools.write,
    // Custom-app install tools (install existing URL / instant static app /
    // dispatch coded app) — teacher roles only, already gated inside
    // makeCustomAppTools; empty (dormant) for a non-teaching caller.
    ...customAppTools,
    // Workshop staff tools (read the scholar-idea queue + reply to an idea)
    // — teacher+ only, already gated inside makeSuggestionTools; empty
    // otherwise.
    ...suggestionTools,
    // Practice item-pool tools (survey a domain's pools, read/author/edit/
    // delete a node's stored items, run the verified-LLM generator) —
    // design-side catalog content, gated to canDesignCurriculum inside
    // makePracticePoolTools (same audience as create_problem_set); empty
    // otherwise.
    ...practicePoolTools,
    // Practice skill-tree tool (get_scholar_skill_tree) — teacher/admin only,
    // already gated inside makePracticeSkillTreeTools; empty otherwise.
    ...practiceSkillTreeTools,
    // Master-schedule tools (weekly timetable direct-manipulation parity for
    // the bot) — teacher/admin only, gated inside makeMasterScheduleTools;
    // empty otherwise.
    ...masterScheduleTools,
    ...externalAppsTools,
    ...googleDocsTools,
  );
  return tools;
}

// Re-export the role constants the streams branch on, so callers can import
// the ACL surface from one module.
export { ROLES, isTeacherRole, type Role };
