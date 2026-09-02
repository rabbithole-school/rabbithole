// Bot DRY Layer 4 — the shared *scholar-record write* toolset.
//
// Layer 3 (lib/scholarReadTools.ts) shares the read-only scholar lookups.
// This file is its write-side sibling: every teacher-facing bot stream
// (the in-app Curriculum Assistant via /aide-stream, the Slack bot, and
// the OAuth MCP connector) builds the SAME scholar-record write tools from
// here, so a teacher can do through ANY bot what they do on the scholar
// page — log an observation, add a report, edit the dossier, set a reading
// level, fix a profile, reset a password/passkey, upload a cognitive
// assessment or a portfolio work-sample, even delete a scholar.
//
// Gating (mirrors the in-app mutations these wrap):
//   learning record  (observation/report/dossier/reading level)  teacher/admin
//   profile / password / passkey reset                           scholar-admin
//   delete_scholar                                               admin
//   document / portfolio upload                                  teacher/admin
//
// SURFACE gating: the credential-bearing + destructive tools
// (reset_scholar_password, reset_scholar_passkeys, delete_scholar) and the
// file-upload tools are built ONLY for a "private" surface (the in-app
// teacher session, a Slack DM, or MCP) — never a shared Slack channel,
// where a returned PIN or an accidental delete would be a privacy/safety
// failure. Same defense style as Slack's original DM-only gating.
//
// All writes resolve a scholar by NAME through the shared resolver (with its
// empty-query guard), and run through internal mutations that take an
// explicit callerUserId — the bot acts on behalf of a mapped user, not a
// Convex Auth identity. The role gate here picks WHICH tools; the resolver
// (and, for restricted callers, allowedScholarIds upstream) picks WHOSE data.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  isTeacherRole,
  isScholarAdminRole,
  isPlatformAdminRole,
  type Role,
} from "./roles";
import { resolveScholarByName } from "./scholarReadTools";
import type { AideEmit } from "./aideStream";
import { withBase, scholarPath } from "./channels";

/** Where the conversation lives — gates the sensitive/destructive tools. */
export type WriteSurface = "private" | "channel";

/** A file the teacher attached to this chat turn, already in Convex storage. */
export type AttachedFile = {
  storageId: Id<"_storage">;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
};

const WHOLE_CHILD_CATEGORY_LABELS = {
  execFunction: "executive function",
  socialEmotional: "social-emotional growth",
  collaboration: "collaboration & character",
  passions: "passions & quests",
  other: "other",
} as const;

const scholarNameProp = {
  type: "string" as const,
  description: "The scholar's name (case-insensitive partial match)",
};

/**
 * Build the shared scholar-write tools, closed over the calling stream's
 * action `ctx`, its SSE `emit`, the caller's role + id, the surface, and any
 * files attached to this turn. Returns an array of betaTools the caller
 * spreads into its toolset. Self-filters by role + surface, so a caller can
 * always spread the full result.
 */
export async function makeScholarWriteTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    surface: WriteSurface;
    attachedFiles?: AttachedFile[];
    // "" = relative (in-app), siteUrl() = absolute (Slack / external).
    linkBase?: string;
    /** Proven by an institution-scoped school:operations grant upstream. */
    hasSchoolOperationsAccess?: boolean;
    /** The grant-derived scholar set; every name lookup stays inside it. */
    allowedScholarIds?: Set<Id<"users">>;
  },
) {
  const {
    role,
    callerUserId,
    surface,
    attachedFiles = [],
    linkBase = "",
    hasSchoolOperationsAccess = false,
    allowedScholarIds,
  } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const isTeacher = isTeacherRole(role); // teacher | school/platform admin
  const isScholarAdmin =
    isScholarAdminRole(role) || hasSchoolOperationsAccess;
  const isAdmin = isPlatformAdminRole(role); // platform admin only
  const isPrivate = surface === "private";

  const resolve = (name: string) =>
    resolveScholarByName(ctx, name, allowedScholarIds);
  const scholarLink = (id: string) =>
    withBase(linkBase, scholarPath(id));

  /**
   * Resolve which attached file a tool should act on. Prefers an explicit
   * storageRef (the Slack DM transcript surfaces `storageRef=<id>`), then a
   * fileName match among this turn's attachments, then the lone attachment.
   */
  const resolveFile = (input: {
    storageRef?: string;
    fileName?: string;
  }):
    | { ok: true; file: { storageId: Id<"_storage">; mimeType?: string; sizeBytes?: number; fileName?: string } }
    | { ok: false; message: string } => {
    if (input.storageRef) {
      const match = attachedFiles.find((f) => f.storageId === input.storageRef);
      return {
        ok: true,
        file: {
          storageId: input.storageRef as Id<"_storage">,
          mimeType: match?.mimeType,
          sizeBytes: match?.sizeBytes,
          fileName: match?.fileName ?? input.fileName,
        },
      };
    }
    if (attachedFiles.length === 0) {
      return {
        ok: false,
        message:
          "No file is attached to this message. Attach the file first (the + button in the Chat composer, or a Slack DM attachment), then call this tool — or do it from the main Chat tab if this surface has no attach button.",
      };
    }
    if (input.fileName) {
      const m = attachedFiles.find((f) => f.fileName === input.fileName);
      if (!m)
        return {
          ok: false,
          message: `No attached file named "${input.fileName}". Attached: ${attachedFiles
            .map((f) => f.fileName)
            .join(", ")}.`,
        };
      return { ok: true, file: { ...m } };
    }
    if (attachedFiles.length === 1)
      return { ok: true, file: { ...attachedFiles[0] } };
    return {
      ok: false,
      message: `Multiple files are attached (${attachedFiles
        .map((f) => f.fileName)
        .join(", ")}). Pass fileName to pick one.`,
    };
  };

  const tools = [];

  // ── add_scholar_observation — teacher/admin, any surface ──────────────
  if (isTeacher) {
    tools.push(
      betaTool({
        name: "add_scholar_observation",
        description:
          "Record a teacher observation about a scholar — praise, concern, suggestion, intervention, or a neutral note. This is also the one tool for brief Whole Child inputs: tag `category` when the take is about executive function, social-emotional growth, collaboration & character, or passions & quests; use type `note` when it has no praise/concern valence. The observation lands on the scholar's record and category-tagged observations also pool into the team's Whole Child meeting. " +
          "Routine attendance states (present, absent, tardy, or appointment) and attendance corrections are administrative attendance, NOT observations or concerns; use set_attendance instead. " +
          "This logs the TEACHER's observation, in their voice and judgment — you are a SCRIBE, not the author. Only record what the teacher tells you to (or explicitly approves); NEVER compose, infer, editorialize, or volunteer an observation of your own. Your own read of a scholar is not a teacher observation and must never land in this human-authored record (the AI's assessments live in the separate observer channel). " +
          "Set `weight` to 'major' ONLY when the teacher's language signals it matters for the child's profile (\"this is a big one\", \"for his record\", a milestone, or an incident with follow-up actions); otherwise leave it 'minor' (the default). ALWAYS state which weight you chose in your reply so a mislabel is caught in the moment. " +
          "Confirm the scholar + note with the teacher before logging unless their message already states both unambiguously.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            type: {
              type: "string" as const,
              enum: ["praise", "concern", "suggestion", "intervention", "note"] as const,
              description:
                "The observation type. Use note for a neutral take with no praise/concern valence.",
            },
            note: {
              type: "string" as const,
              description: "The observation text, as it should appear on the record",
            },
            weight: {
              type: "string" as const,
              enum: ["minor", "major"] as const,
              description:
                "Claim-strength for the evidence binder. 'major' = worth surfacing first in the child's assessment record; 'minor' (default) = routine texture. Infer from the teacher's language; explicit words win.",
            },
            category: {
              type: "string" as const,
              enum: ["execFunction", "socialEmotional", "collaboration", "passions", "other"] as const,
              description:
                "Optional Whole Child tag: execFunction = organization/planning/self-start; socialEmotional = feelings, regulation, growth; collaboration = character, community, working with others; passions = quests, interests, extended learning; other = a Whole Child take outside those categories.",
            },
          },
          required: ["scholarName", "type", "note"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const weight = input.weight === "major" ? "major" : "minor";
          const period = input.category
            ? await ctx.runQuery(
                internal.reportingPeriods.currentInternal,
                {},
              )
            : null;
          await ctx.runMutation(internal.teacherAide.addScholarObservation, {
            teacherId: callerUserId,
            scholarId: scholar.id as Id<"users">,
            note: input.note,
            type: input.type as
              | "praise"
              | "concern"
              | "suggestion"
              | "intervention"
              | "note",
            weight,
            periodId: period?._id,
            category: input.category as
              | "execFunction"
              | "socialEmotional"
              | "collaboration"
              | "passions"
              | "other"
              | undefined,
          });
          const categoryLabel = input.category
            ? WHOLE_CHILD_CATEGORY_LABELS[input.category]
            : undefined;
          const categoryTail = categoryLabel
            ? ` · Whole Child: ${categoryLabel}`
            : "";
          emit({
            toolComplete: {
              name: "add_scholar_observation",
              result: `Logged ${weight} ${input.type} for ${scholar.name}${categoryTail}`,
            },
          });
          const majorTail =
            weight === "major"
              ? " Want to add any follow-up context?"
              : ' Say "make it major" if it belongs in their profile.';
          const wholeChildTail = categoryLabel
            ? ` Tagged **${categoryLabel}** for Whole Child.`
            : "";
          return `Logged as a **${weight}** ${input.type} observation for ${scholar.name}.${wholeChildTail}${majorTail} ${scholarLink(scholar.id)}`;
        },
      }),
    );

    // ── set_scholar_goal — teacher/admin, any surface ─────────────────────
    tools.push(
      betaTool({
        name: "set_scholar_goal",
        description:
          "Set a learning goal WITH/for a scholar (the getting-to-know-you goal-setting weeks, or a Goal for Continued Growth). Goals are long-lived — they outlive a quest — and an active goal is gently surfaced to the tutor. " +
          "Only record a goal the teacher (ideally together with the scholar) actually decided on — you are a scribe, not the author. Prefer the scholar's own words for the title.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            title: { type: "string" as const, description: "The goal, in the scholar's own words if possible." },
            description: { type: "string" as const, description: "Optional detail / how they'll pursue it." },
            kind: {
              type: "string" as const,
              enum: ["academic", "personal", "habit", "hobby"] as const,
              description: "academic = a subject/skill; personal = about them as a person; habit = a working habit; hobby = an interest to pursue.",
            },
          },
          required: ["scholarName", "title", "kind"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          await ctx.runMutation(internal.scholarGoals.createForScholarInternal, {
            scholarId: scholar.id as Id<"users">,
            createdBy: callerUserId,
            title: input.title,
            description: input.description,
            kind: input.kind as "academic" | "personal" | "habit" | "hobby",
            origin: "goalWeek",
          });
          emit({
            toolComplete: { name: "set_scholar_goal", result: `Goal set for ${scholar.name}` },
          });
          return `Set an active ${input.kind} goal for ${scholar.name}: "${input.title}". It'll show in their My Learning and gently reach the tutor. ${scholarLink(scholar.id)}`;
        },
      }),
    );

    // ── record_goal_checkin — teacher/admin, any surface ──────────────────
    tools.push(
      betaTool({
        name: "record_goal_checkin",
        description:
          "Log a moment of progress against one of a scholar's active goals (\"Kai finally built his solar oven\"). Match the goal by a few words of its title. If no active goal matches, say so rather than guessing.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            goalTitle: { type: "string" as const, description: "A few words from the goal's title to match it." },
            note: { type: "string" as const, description: "What happened — the progress moment." },
          },
          required: ["scholarName", "goalTitle", "note"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const goal = await ctx.runQuery(
            internal.scholarGoals.findActiveByTitleInternal,
            { scholarId: scholar.id as Id<"users">, titleQuery: input.goalTitle },
          );
          if (!goal)
            return `I couldn't find one active goal for ${scholar.name} matching "${input.goalTitle}". Check the goal title in their My Learning.`;
          await ctx.runMutation(internal.scholarGoals.recordCheckinInternal, {
            goalId: goal._id,
            note: input.note,
            authorType: "teacher",
          });
          emit({
            toolComplete: {
              name: "record_goal_checkin",
              result: `Goal check-in for ${scholar.name}`,
            },
          });
          return `Logged a check-in on "${goal.title}" for ${scholar.name}. ${scholarLink(scholar.id)}`;
        },
      }),
    );

    // ── Narrative REPORT tools (read/write a scholar's course report) ─────
    // The teacher drives report-writing in natural language from the bot panel
    // — the AI reads the evidence + writes/edits sections at the teacher's
    // direction (replacing the old baked-in AI draft/check). Teacher is still
    // the author; the composer shows the same sections live.
    const REPORT_SECTIONS: Record<string, string> = {
      context: "context",
      progress: "progress",
      core: "dim_core",
      connections: "dim_connections",
      practice: "dim_practice",
      identity: "dim_identity",
      goals: "goals",
    };
    const currentPeriod = async () =>
      ctx.runQuery(internal.reportingPeriods.currentInternal, {});

    tools.push(
      betaTool({
        name: "get_scholar_report",
        description:
          "Read a scholar's course narrative report for the current reporting period — its sections (context, progress, core, connections, practice, identity, goals), the 1–7 PCM ratings, and status. Use this to see what's written before you help the teacher write more. Pair it with the get_scholar_* evidence tools to ground the writing.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            subject: { type: "string" as const, description: "Course subject (e.g. Science). Omit to list all this scholar's reports this period." },
          },
          required: ["scholarName"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const period = await currentPeriod();
          if (!period) return "There's no open reporting period right now.";
          const reports = await ctx.runQuery(internal.courseNarratives.getForBot, {
            scholarId: scholar.id as Id<"users">,
            periodId: period._id,
            subject: input.subject,
          });
          if (reports.length === 0)
            return `No report started yet for ${scholar.name}${input.subject ? ` in ${input.subject}` : ""} this period. Use write_report_section to begin one.`;
          const parts = reports.map((r) => {
            const secs = r.sections
              .map((s) => `  • ${s.title}: ${s.body.trim() ? s.body.trim() : "(empty)"}`)
              .join("\n");
            const ratings = r.pcmRatings
              ? `  ratings — core ${r.pcmRatings.core ?? "–"}, connections ${r.pcmRatings.connections ?? "–"}, practice ${r.pcmRatings.practice ?? "–"}, identity ${r.pcmRatings.identity ?? "–"}; overall ${r.courseRating ?? "–"}`
              : "  ratings — none yet";
            return `### ${r.subject} (${r.status})\n${secs}\n${ratings}`;
          });
          return parts.join("\n\n");
        },
      }),
    );

    tools.push(
      betaTool({
        name: "write_report_section",
        description:
          "Write (replace) one section of a scholar's course narrative report. Sections: context, progress, core, connections, practice, identity, goals. Only write what the TEACHER asked for or approved — you are helping them author their report, in their voice, grounded in the evidence tools; do not invent claims the evidence doesn't support. The teacher can edit anything you write in the composer.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            subject: { type: "string" as const, description: "Course subject (e.g. Science)." },
            section: {
              type: "string" as const,
              enum: ["context", "progress", "core", "connections", "practice", "identity", "goals"] as const,
              description: "Which section to write.",
            },
            text: { type: "string" as const, description: "The section prose, in the teacher's voice." },
          },
          required: ["scholarName", "subject", "section", "text"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const period = await currentPeriod();
          if (!period) return "There's no open reporting period right now.";
          const narrativeId = await ctx.runMutation(internal.courseNarratives.openInternal, {
            scholarId: scholar.id as Id<"users">,
            teacherId: callerUserId,
            periodId: period._id,
            subject: input.subject,
          });
          await ctx.runMutation(internal.courseNarratives.setSectionInternal, {
            narrativeId,
            key: REPORT_SECTIONS[input.section] ?? input.section,
            body: input.text,
          });
          emit({ toolComplete: { name: "write_report_section", result: `Wrote ${input.section} for ${scholar.name}` } });
          return `Updated the **${input.section}** section of ${scholar.name}'s ${input.subject} report. The teacher can review + edit it in Reports. ${scholarLink(scholar.id)}`;
        },
      }),
    );

    tools.push(
      betaTool({
        name: "set_report_rating",
        description:
          "Set a 1–7 PCM rating on a scholar's course report (core / connections / practice / identity, or 'overall' for the Course Performance Rating). Only set a rating the teacher has decided — offer your read if asked, but the rating is the teacher's judgment.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            subject: { type: "string" as const, description: "Course subject (e.g. Science)." },
            dimension: {
              type: "string" as const,
              enum: ["core", "connections", "practice", "identity", "overall"] as const,
            },
            rating: { type: "integer" as const, description: "1–7" },
          },
          required: ["scholarName", "subject", "dimension", "rating"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const period = await currentPeriod();
          if (!period) return "There's no open reporting period right now.";
          const narrativeId = await ctx.runMutation(internal.courseNarratives.openInternal, {
            scholarId: scholar.id as Id<"users">,
            teacherId: callerUserId,
            periodId: period._id,
            subject: input.subject,
          });
          await ctx.runMutation(internal.courseNarratives.setRatingInternal, {
            narrativeId,
            dimension: input.dimension,
            value: input.rating,
          });
          emit({ toolComplete: { name: "set_report_rating", result: `Set ${input.dimension}=${input.rating} for ${scholar.name}` } });
          return `Set ${input.dimension} = ${input.rating} on ${scholar.name}'s ${input.subject} report. ${scholarLink(scholar.id)}`;
        },
      }),
    );

    // ── add_scholar_report — teacher/admin ──────────────────────────────
    tools.push(
      betaTool({
        name: "add_scholar_report",
        description:
          "Add a dated teacher report (a narrative note with a title) to a scholar's record. It's saved as a teacher-authored text document in the scholar's Documents, exactly like the 'Add report' action on their page, and a redacted version informs the tutor. Use for write-ups longer than a quick observation (a conference summary, a progress narrative). " +
          "Like observations, this is the TEACHER's write-up — you are transcribing their words/judgment, not authoring your own. Only record what the teacher gives you or explicitly approves; don't invent or editorialize a report they didn't ask for.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            title: {
              type: "string" as const,
              description: "Short report title (e.g., \"Q2 Progress\", \"Parent conference\")",
            },
            content: {
              type: "string" as const,
              description: "The report body — plain prose or markdown.",
            },
          },
          required: ["scholarName", "title", "content"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          await ctx.runMutation(internal.teacherAide.addScholarReport, {
            teacherId: callerUserId,
            scholarId: scholar.id as Id<"users">,
            title: input.title,
            content: input.content,
          });
          emit({
            toolComplete: {
              name: "add_scholar_report",
              result: `Added report "${input.title}" for ${scholar.name}`,
            },
          });
          return `Report "${input.title}" added to ${scholar.name}'s Documents. ${scholarLink(scholar.id)}`;
        },
      }),
    );

    // ── update_scholar_dossier — teacher/admin ──────────────────────────
    tools.push(
      betaTool({
        name: "update_scholar_dossier",
        description:
          "Update a scholar's dossier — the teacher-/observer-authored learning notes. mode=\"append\" adds a dated block (the safe default); mode=\"replace\" overwrites the WHOLE dossier and discards history, so only use replace when the teacher explicitly asks to rewrite it. Always confirm a replace before calling. " +
          "When you write here you are transcribing the TEACHER's note — write what they gave you, don't invent, infer, or editorialize dossier content of your own.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            content: { type: "string" as const, description: "The note text." },
            mode: {
              type: "string" as const,
              enum: ["append", "replace"] as const,
              description: "append (default, safe) or replace (overwrites all dossier history)",
            },
          },
          required: ["scholarName", "content"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const mode = input.mode === "replace" ? "replace" : "append";
          await ctx.runMutation(internal.teacherAide.updateScholarDossier, {
            scholarId: scholar.id as Id<"users">,
            content: input.content,
            mode,
          });
          emit({
            toolComplete: {
              name: "update_scholar_dossier",
              result: `Dossier ${mode === "replace" ? "replaced" : "updated"} for ${scholar.name}`,
            },
          });
          return `Dossier ${mode === "replace" ? "replaced" : "appended"} for ${scholar.name}. ${scholarLink(scholar.id)}`;
        },
      }),
    );

    // ── set_scholar_reading_level — teacher/admin ───────────────────────
    tools.push(
      betaTool({
        name: "set_scholar_reading_level",
        description:
          "Set (or clear) a scholar's reading level — the grade band the tutor calibrates its language to. Valid levels: \"K\", a grade number with an optional tenth (\"3\", \"5.4\"), or \"college\". Pass readingLevel=\"none\" to clear it. Records a teacher-sourced history entry.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            readingLevel: {
              type: "string" as const,
              description: "\"K\", a grade like \"3\" or \"5.4\", \"college\", or \"none\" to clear.",
            },
          },
          required: ["scholarName", "readingLevel"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const raw = input.readingLevel.trim();
          const level = raw.toLowerCase() === "none" || raw === "" ? null : raw;
          try {
            await ctx.runMutation(internal.teacherAide.setScholarReadingLevel, {
              callerUserId,
              scholarId: scholar.id as Id<"users">,
              readingLevel: level,
            });
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          emit({
            toolComplete: {
              name: "set_scholar_reading_level",
              result: level
                ? `Reading level → ${level} for ${scholar.name}`
                : `Cleared reading level for ${scholar.name}`,
            },
          });
          return level
            ? `Reading level set to ${level} for ${scholar.name}.`
            : `Reading level cleared for ${scholar.name}.`;
        },
      }),
    );
  }

  // ── update_scholar_profile — scholar-admin ────────────────────────────
  if (isScholarAdmin) {
    tools.push(
      betaTool({
        name: "update_scholar_profile",
        description:
          "Update a scholar's account profile — their display name and/or date of birth (YYYY-MM-DD). Only the fields you pass change. Confirm with the teacher before renaming (the name shows everywhere).",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            name: {
              type: "string" as const,
              description: "New display name (omit to leave unchanged).",
            },
            dateOfBirth: {
              type: "string" as const,
              description: "Date of birth as YYYY-MM-DD (omit to leave unchanged).",
            },
          },
          required: ["scholarName"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          if (input.name === undefined && input.dateOfBirth === undefined) {
            return "Nothing to update — pass a new name and/or dateOfBirth.";
          }
          try {
            await ctx.runMutation(internal.teacherAide.updateScholarProfile, {
              scholarId: scholar.id as Id<"users">,
              name: input.name,
              dateOfBirth: input.dateOfBirth,
            });
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          emit({
            toolComplete: {
              name: "update_scholar_profile",
              result: `Updated profile for ${scholar.name}`,
            },
          });
          return `Profile updated for ${scholar.name}. ${scholarLink(scholar.id)}`;
        },
      }),
    );
  }

  // ── reset_scholar_password — scholar-admin, PRIVATE only ───────────────
  if (isScholarAdmin && isPrivate) {
    tools.push(
      betaTool({
        name: "reset_scholar_password",
        description:
          "Reset a SCHOLAR's sign-in: returns a one-time link the scholar opens (on their iPad) to set a new PIN, then signs in. For the 'kid forgot their PIN' moment. Setting the new PIN signs them out of old sessions; the link is a credential — ALWAYS confirm the resolved scholar with the teacher before issuing it.",
        inputSchema: {
          type: "object" as const,
          properties: { scholarName: scholarNameProp },
          required: ["scholarName"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const result = await ctx.runMutation(
            internal.slackAdminOps.issueScholarPinLink,
            { callerUserId, scholarId: scholar.id as Id<"users"> },
          );
          if (!result.ok) return result.message;
          emit({
            toolComplete: {
              name: "reset_scholar_password",
              result: `Issued a PIN reset link for ${scholar.name}`,
            },
          });
          return `Here's a one-time PIN reset link for ${scholar.name} (username "${result.username ?? "(no username)"}"). Open it on their iPad to set a new PIN, then they sign in with it:\n${result.url}`;
        },
      }),
    );

    // ── reset_scholar_passkeys — scholar-admin, PRIVATE only ─────────────
    tools.push(
      betaTool({
        name: "reset_scholar_passkeys",
        description:
          "Remove ALL of a scholar's registered passkeys — the recovery for 'the kid can't get past the passkey prompt on this device'. They can re-enroll a new passkey afterward, or sign in with their password. Confirm the scholar with the teacher first.",
        inputSchema: {
          type: "object" as const,
          properties: { scholarName: scholarNameProp },
          required: ["scholarName"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          let removed = 0;
          try {
            const r = await ctx.runMutation(
              internal.teacherAide.resetScholarPasskeys,
              { scholarId: scholar.id as Id<"users"> },
            );
            removed = r.removed;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          emit({
            toolComplete: {
              name: "reset_scholar_passkeys",
              result: `Removed ${removed} passkey(s) for ${scholar.name}`,
            },
          });
          return `Removed ${removed} passkey(s) for ${scholar.name}. They can re-enroll or use their password.`;
        },
      }),
    );
  }

  // ── delete_scholar — ADMIN only, PRIVATE only, IRREVERSIBLE ────────────
  if (isAdmin && isPrivate) {
    tools.push(
      betaTool({
        name: "delete_scholar",
        description:
          "PERMANENTLY delete a scholar and ALL their data — sessions, messages, observations, mastery, seeds, dossier, reports, auth accounts. THIS CANNOT BE UNDONE. Admin only. You MUST echo the resolved scholar's full name back to the teacher and get an explicit 'yes, delete <name>' before calling. Never call speculatively.",
        inputSchema: {
          type: "object" as const,
          properties: { scholarName: scholarNameProp },
          required: ["scholarName"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          try {
            const r = await ctx.runMutation(internal.teacherAide.deleteScholar, {
              callerUserId,
              scholarId: scholar.id as Id<"users">,
            });
            emit({
              toolComplete: {
                name: "delete_scholar",
                result: `Deleted ${r.name}`,
              },
            });
            return `Scholar "${r.name}" and all their data have been permanently deleted.`;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
      }),
    );
  }

  // ── upload_scholar_document — teacher/admin, PRIVATE only ──────────────
  // Sensitive intake (cognitive assessments, IEPs, parent emails). Consumes
  // a file attached to this turn (in-app + button) OR a storageRef from a
  // Slack DM transcript. Kicks the extract→redact→summarize pipeline.
  if (isTeacher && isPrivate) {
    tools.push(
      betaTool({
        name: "upload_scholar_document",
        description:
          "Attach an uploaded file to a scholar's sensitive document record — cognitive/neuropsych assessments, IEP/504 plans, parent emails, written observations. Uses the file the teacher attached to this message (or a storageRef if one is given). THE WRITE THAT MATTERS MOST TO CONFIRM: echo the resolved scholar's full name + the file name + the document kind and get an explicit yes BEFORE calling. Processing (extraction, redaction, teacher-facing summary) starts automatically; the dossier is NOT touched — findings reach it only through the in-app review flow.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            kind: {
              type: "string" as const,
              enum: ["assessment", "iep", "parent_email", "observation", "other"] as const,
              description: "Document kind (a cognitive assessment → \"assessment\")",
            },
            title: {
              type: "string" as const,
              description: "Human title for the document (default: the file name).",
            },
            fileName: {
              type: "string" as const,
              description: "Which attached file to use, when more than one is attached.",
            },
            storageRef: {
              type: "string" as const,
              description: "A storageRef id (e.g. from a Slack [stored file …] line), if not using an attached file.",
            },
          },
          required: ["scholarName", "kind"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const f = resolveFile(input);
          if (!f.ok) return f.message;
          const title = (input.title ?? f.file.fileName ?? "Untitled document").trim();
          const result = await ctx.runMutation(
            internal.scholarDocuments.aideRegisterFromSlack,
            {
              callerUserId,
              scholarId: scholar.id as Id<"users">,
              storageId: f.file.storageId,
              kind: input.kind as
                | "assessment"
                | "iep"
                | "parent_email"
                | "observation"
                | "other",
              title,
              fileMimeType: f.file.mimeType,
              fileSizeBytes: f.file.sizeBytes,
            },
          );
          if (!result.ok) return result.message;
          emit({
            toolComplete: {
              name: "upload_scholar_document",
              result: `Attached "${title}" to ${scholar.name}`,
            },
          });
          return `Document "${title}" attached to ${scholar.name} (${input.kind}). Processing started — summary + key findings will appear on their Records tab.`;
        },
      }),
    );

    // ── add_portfolio_item — teacher/admin, PRIVATE only ────────────────
    tools.push(
      betaTool({
        name: "add_portfolio_item",
        description:
          "Add a work-sample to a scholar's portfolio from a file the teacher attached to this message — a scanned worksheet, drawing, photo of a build, project artifact. Unlike documents, portfolio items are the kid's OWN work (no redaction). A caption + searchable text are extracted automatically.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholarName: scholarNameProp,
            title: {
              type: "string" as const,
              description: "Label for the work (default: the file name).",
            },
            fileName: {
              type: "string" as const,
              description: "Which attached file to use, when more than one is attached.",
            },
            storageRef: {
              type: "string" as const,
              description: "A storageRef id, if not using an attached file.",
            },
          },
          required: ["scholarName"] as const,
        },
        run: async (input) => {
          const scholar = await resolve(input.scholarName);
          if (!scholar) return `No scholar found matching "${input.scholarName}".`;
          const f = resolveFile(input);
          if (!f.ok) return f.message;
          const title = (input.title ?? f.file.fileName ?? "Untitled work").trim();
          await ctx.runMutation(internal.teacherAide.addPortfolioItem, {
            callerUserId,
            scholarId: scholar.id as Id<"users">,
            title,
            fileStorageId: f.file.storageId,
            fileMimeType: f.file.mimeType,
            fileSizeBytes: f.file.sizeBytes,
          });
          emit({
            toolComplete: {
              name: "add_portfolio_item",
              result: `Added "${title}" to ${scholar.name}'s portfolio`,
            },
          });
          return `Work-sample "${title}" added to ${scholar.name}'s portfolio. A caption is being generated. ${scholarLink(scholar.id)}`;
        },
      }),
    );
  }

  return tools;
}
