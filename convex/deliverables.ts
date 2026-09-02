// Deliverables — what scholars submit + AI rubric checks.
//
// Single flow (post-Quests):
//   1. Scholar produces work in the chat / artifact panel.
//   2. Scholar clicks "Check my work" OR the tutor decides to grade
//      mid-conversation via update_rubric_score.
//   3. AI judges each criterion not/half/full; pass marks an
//      activityCompletions row + may earn a unit badge.
//
// One deliverable per (session, activity, artifact). Re-submitting updates the
// content in place; the next completed rubric check atomically replaces the
// previous verdict (unlimited retries).

import { v } from "convex/values";
import {
  authedMutation,
  authedQuery,
  teacherMutation,
} from "./lib/customFunctions";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import { requireActiveScholarAccess } from "./lib/access";
import {
  institutionPromptProfileForScholar,
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  type InstitutionPromptProfile,
} from "./lib/institutionPromptProfile";
import { isTeacherRole } from "./lib/roles";
import { ROLES } from "./lib/roles";
import { reconcileActivityCompletion } from "./lib/activityCompletionCore";
import { fanOutScholarEvent, scholarDeepLink } from "./slackNotifications";
import { maybeScheduleArtifactAssessment } from "./granuleAssessment";
import {
  normalizeDeliverable,
  renderCriteriaForRubricCheck,
  scoreRubricVerdicts,
} from "./lib/deliverable";
import { ensureFlairArtForSession } from "./flairArt";
import type { Doc, Id } from "./_generated/dataModel";
import { isTextArtifact } from "../shared/textArtifacts";
import {
  summarizeDeckForModel,
  validateDeck,
} from "../shared/slidesScene";
import { finalizeAndSplit } from "./sessionHelpers";
import {
  parseStoredMapArtifact,
  projectStoredMapForScholar,
} from "../lib/geomap/stored";
import { portfolioFamilySharingEligibility } from "./lib/schoolMediaConsent";

// ── Queries ───────────────────────────────────────────────────────────

/**
 * Find the deliverable for an activity within a session. When
 * `artifactId` is passed, dedupe is per-document — two drafts of the
 * same story get independent rubric verdicts.
 */
export const getForSessionActivity = authedQuery({
  args: {
    sessionId: v.id("sessions"),
    activityId: v.id("activities"),
    artifactId: v.optional(v.id("artifacts")),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return null;
    const accessScholarId = session.isTestDrive
      ? session.testDriveAsScholarId
      : session.userId;
    if (accessScholarId && accessScholarId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, accessScholarId);
    }
    const rows = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const deliverable =
      rows.find((r) => {
        if (r.activityId !== args.activityId) return false;
        if (args.artifactId !== undefined) {
          return r.artifactId === args.artifactId;
        }
        return true;
      }) ?? null;
    if (!deliverable || isTeacher || !deliverable.mapContent) {
      return deliverable;
    }
    const mapContent = projectStoredMapForScholar(deliverable.mapContent);
    return {
      ...deliverable,
      mapContent: mapContent ?? undefined,
    };
  },
});

// ── Submission ────────────────────────────────────────────────────────

/**
 * Scholar submits a deliverable (or re-submits after a failing check).
 * A re-check of unchanged content leaves the durable submission untouched.
 * Changed content preserves the previous rubric verdict until the replacement
 * score lands, so an interrupted check cannot erase a valid result.
 */
export const submit = authedMutation({
  args: {
    activityId: v.id("activities"),
    sessionId: v.id("sessions"),
    artifactId: v.optional(v.id("artifacts")),
    fileStorageId: v.optional(v.id("_storage")),
    textContent: v.optional(v.string()),
    intent: v.optional(v.union(v.literal("check"), v.literal("send"))),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.userId !== ctx.user._id) throw new Error("Forbidden");
    const scholarId = session.userId;

    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (!activity.deliverable) {
      throw new Error("Activity does not require a deliverable");
    }
    // Linkage guard: the activity MUST be this session's own activity. Without
    // it, an authenticated scholar could submit against an arbitrary
    // deliverable-bearing activity in their OWN session and, via assessment,
    // mint mastery for an activity they were never assigned (a self-scoped
    // curriculum-integrity bypass — it can't
    // touch another scholar, since scholarId is derived from the owned session).
    // A session is the pass through exactly one activity (session.activityId,
    // set at creation in sessions.ts), so equality is the correct invariant.
    if (session.activityId !== args.activityId) {
      throw new Error("Activity is not part of this session");
    }
    // Omitted preserves the legacy Send behavior for older clients.
    const intent = args.intent ?? "send";
    let submittedTextContent = args.textContent;
    let submittedMapContent: string | undefined;
    // Snapshot the transcription provenance with the content it describes: the
    // artifact keeps changing, but a graded submission has to stay honest about
    // whether the tutor typed any of these words for the scholar.
    let hasTutorTranscription = false;
    if (args.artifactId) {
      const artifact = await ctx.db.get(args.artifactId);
      if (!artifact || artifact.sessionId !== args.sessionId) {
        throw new Error("Artifact is not part of this session");
      }
      if (activity.deliverable.kind === "map" && artifact.type === "map") {
        const stored = parseStoredMapArtifact(artifact.content);
        if (!stored) throw new Error("Map content is invalid");
        if (stored.scholarPins.length === 0) {
          throw new Error("Add something to your map before checking it");
        }
        submittedMapContent = artifact.content;
      } else if (activity.deliverable.kind === "map") {
        throw new Error("Choose the map for this deliverable");
      } else if (isTextArtifact(artifact)) {
        submittedTextContent = artifact.content;
      }
      hasTutorTranscription = artifact.hasTutorTranscription === true;
    }
    if (activity.deliverable.kind === "map" && !submittedMapContent) {
      throw new Error("Open the map before checking this work");
    }
    if (
      activity.deliverable.mode === "none" &&
      args.fileStorageId === undefined &&
      submittedMapContent === undefined &&
      !submittedTextContent?.trim()
    ) {
      throw new Error("Add something to your work before sending it");
    }
    // NOTE (provenance): `fileStorageId` is caller-supplied and not bound to a
    // verified upload by this scholar. A signed-in scholar who already knows
    // another valid opaque storage id could attach it here and have the assess
    // path read it. Binding uploads to their uploader is a separate hardening
    // follow-up, not fixed here (the resolver layer, files.getUrl/getUrls, now
    // at least requires auth). Storage ids are opaque and not enumerable
    // through this path.

    // Find-or-insert. Dedupe key: (sessionId, activityId, artifactId).
    const rows = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const existing =
      rows.find((r) => {
        if (r.activityId !== args.activityId) return false;
        if (args.artifactId !== undefined) {
          return r.artifactId === args.artifactId;
        }
        return r.artifactId === undefined;
      }) ?? null;

    // Slack: submissions ping any group channel this scholar's groups
    // opted into (no-op when nothing is linked).
    const notifySubmission = async (deliverableId: Id<"deliverables">) => {
      if (intent !== "send") return;
      const scholar = await ctx.db.get(scholarId);
      await fanOutScholarEvent(ctx, {
        scholarId,
        text: `*${scholar?.name ?? "A scholar"}* sent *${activity.title}* — <${scholarDeepLink(scholarId)}|open>`,
        dedupeKey: `deliverable:${deliverableId}`,
      });
    };

    if (existing) {
      const contentChanged =
        (args.fileStorageId !== undefined &&
          existing.fileStorageId !== args.fileStorageId) ||
        (submittedTextContent !== undefined &&
          existing.textContent !== submittedTextContent) ||
        (submittedMapContent !== undefined &&
          existing.mapContent !== submittedMapContent);
      await ctx.db.patch(existing._id, {
        sessionId: args.sessionId,
        assignmentId: session.assignmentId,
        artifactId: args.artifactId,
        lastAction: intent,
        ...(contentChanged
          ? {
              ...(args.fileStorageId !== undefined
                ? { fileStorageId: args.fileStorageId }
                : {}),
              ...(submittedTextContent !== undefined
                ? { textContent: submittedTextContent }
                : {}),
              ...(submittedMapContent !== undefined
                ? { mapContent: submittedMapContent }
                : {}),
              // Mirrors the content above. An unchanged re-check keeps the
              // original snapshot provenance and submission timestamp.
              hasTutorTranscription,
              submittedAt: Date.now(),
            }
          : {}),
      });
      if (contentChanged) {
        await notifySubmission(existing._id);
        await maybeScheduleArtifactAssessment(ctx, existing._id);
      }
      if (activity.deliverable.mode === "none") {
        await markActivityCompleted(
          ctx,
          scholarId,
          args.activityId,
          args.sessionId,
        );
      }
      return existing._id;
    }
    const deliverableId = await ctx.db.insert("deliverables", {
      activityId: args.activityId,
      scholarId,
      sessionId: args.sessionId,
      assignmentId: session.assignmentId,
      artifactId: args.artifactId,
      fileStorageId: args.fileStorageId,
      textContent: submittedTextContent,
      mapContent: submittedMapContent,
      hasTutorTranscription,
      submittedAt: Date.now(),
      lastAction: intent,
    });
    await notifySubmission(deliverableId);
    await maybeScheduleArtifactAssessment(ctx, deliverableId);
    if (activity.deliverable.mode === "none") {
      await markActivityCompleted(
        ctx,
        scholarId,
        args.activityId,
        args.sessionId,
      );
    }
    return deliverableId;
  },
});

/**
 * Publish or hide the current digital-work checkpoint in the existing family
 * portfolio. Publishing copies one frozen revision; later checks keep changing
 * the working checkpoint without silently changing what families can see.
 */
export const setFamilyVisibility = teacherMutation({
  args: {
    deliverableId: v.id("deliverables"),
    familyVisibility: v.union(
      v.literal("staff_only"),
      v.literal("attributed_families"),
    ),
  },
  handler: async (ctx, args) => {
    const deliverable = await ctx.db.get(args.deliverableId);
    if (!deliverable) throw new Error("Work not found");
    const session = await ctx.db.get(deliverable.sessionId);
    if (!session || session.userId !== deliverable.scholarId) {
      throw new Error("Session not found");
    }
    if (session.isTestDrive) {
      throw new Error("Rehearsal work cannot be shared with families");
    }
    await requireActiveScholarAccess(
      ctx,
      ctx.user,
      deliverable.scholarId,
    );

    if (args.familyVisibility === "staff_only") {
      await ctx.db.patch(deliverable._id, {
        familyVisibility: "staff_only",
      });
      return;
    }

    const artifact = deliverable.artifactId
      ? await ctx.db.get(deliverable.artifactId)
      : null;
    const activity = await ctx.db.get(deliverable.activityId);
    const title =
      artifact?.title?.trim() || activity?.title?.trim() || "Scholar work";
    const familySnapshot = deliverable.mapContent
      ? (() => {
          const content = projectStoredMapForScholar(deliverable.mapContent);
          if (!content) throw new Error("Map checkpoint is invalid");
          return { kind: "map" as const, title, content };
        })()
      : deliverable.textContent?.trim() &&
          activity?.deliverable?.kind !== "slides"
        ? {
            kind: "text" as const,
            title,
            content: deliverable.textContent,
            hasTutorTranscription:
              deliverable.hasTutorTranscription === true
                ? true
                : undefined,
          }
        : null;
    if (!familySnapshot) {
      throw new Error("Only map and document work can be shared here");
    }
    const eligibility = await portfolioFamilySharingEligibility(
      ctx,
      [deliverable.scholarId],
      false,
    );
    if (!eligibility.allowed) {
      throw new Error(
        eligibility.blocker ?? "Family sharing is unavailable.",
      );
    }

    await ctx.db.patch(deliverable._id, {
      familyVisibility: "attributed_families",
      familySnapshot,
      familyPublishedAt: Date.now(),
      familyPublishedBy: ctx.user._id,
    });
  },
});

// ── Tool-call rubric scoring ──────────────────────────────────────────
//
// The scholar tutor calls update_rubric_score (defined in http.ts) when
// it has assessed the scholar's work against the rubric. This internal
// mutation records the verdicts and runs pass-side effects.

/**
 * Resolve the artifact that matches the activity's deliverable kind. Slides
 * activities use the session's one deck; text/artifact activities keep the
 * newest-text fallback used when the tutor omits artifact_id.
 *
 * "Newest" = greatest _creationTime. There is no edit timestamp on artifacts,
 * so most-recently-CREATED is the best available signal; on a single-document
 * activity (the common shape) it's unambiguous.
 *
 * Exported (and typed against the read ctx) so the fallback is unit-testable
 * without the streaming HTTP handler — see __tests__/rubricVerdicts.test.ts.
 */
export async function resolveScorableArtifactId(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<Id<"artifacts"> | null> {
  const session = await ctx.db.get(sessionId);
  const activity = session?.activityId
    ? await ctx.db.get(session.activityId)
    : null;
  const artifacts = await ctx.db
    .query("artifacts")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  if (activity?.deliverable?.kind === "slides") {
    return artifacts.find((artifact) => artifact.type === "slides")?._id ?? null;
  }
  if (activity?.deliverable?.kind === "map") {
    return artifacts.find((artifact) => artifact.type === "map")?._id ?? null;
  }

  const textArtifacts = artifacts.filter(isTextArtifact);
  if (textArtifacts.length === 0) return null;
  let newest = textArtifacts[0];
  for (const a of textArtifacts) {
    if (a._creationTime > newest._creationTime) newest = a;
  }
  return newest._id;
}

export const applyRubricScoreFromTool = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    // Optional: the tutor SHOULD pass the work's artifact id, but when it
    // omits it we fall back to the activity's scorable artifact
    // artifact (resolveScorableArtifactId) so the stars still pay out.
    artifactId: v.optional(v.id("artifacts")),
    preserveSubmittedSnapshot: v.optional(v.boolean()),
    // The tutor stream passes this so scoring + the transcript notice commit
    // atomically. That keeps the notice ahead of the delayed permanent chip
    // without relying on two independent subscription updates racing each other.
    streamSplit: v.optional(
      v.object({
        currentMessageId: v.id("messages"),
        contentSoFar: v.string(),
      }),
    ),
    verdicts: v.array(
      v.object({
        criterionId: v.string(),
        level: v.union(
          v.literal("not"),
          v.literal("half"),
          v.literal("full"),
        ),
        // One sentence about THIS submission. Persisted with the verdict and
        // snapshotted onto any flair it earns — it is the only scholar-readable
        // explanation of a mark (a criterion's `description` is grader-facing).
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.activityId) {
      throw new Error("Project has no activity to score against");
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity?.deliverable) {
      throw new Error("Activity has no rubric");
    }
    const artifactId =
      args.artifactId ??
      (await resolveScorableArtifactId(ctx, args.sessionId));
    if (!artifactId) {
      throw new Error("Pass artifact_id to score the work rubric.");
    }
    const artifact = await ctx.db.get(artifactId);
    if (!artifact || artifact.sessionId !== args.sessionId) {
      throw new Error("Artifact not found for this project");
    }
    let snapshotContent: string | undefined;
    let snapshotMapContent: string | undefined;
    if (activity.deliverable.kind === "slides" && artifact.type === "slides") {
      let rawDeck: unknown;
      try {
        rawDeck = JSON.parse(artifact.content);
      } catch {
        throw new Error("Slides artifact content is invalid");
      }
      const validated = validateDeck(rawDeck);
      if (!validated.ok) {
        throw new Error(
          `Slides artifact content is invalid: ${validated.errors.join("; ")}`,
        );
      }
      // Match the generous cap used by buildSlidesSection so the provenance
      // snapshot reflects the deck evidence the rubric judge actually saw.
      snapshotContent = summarizeDeckForModel(validated.deck, 600);
    } else if (
      activity.deliverable.kind === "map" &&
      artifact.type === "map"
    ) {
      const stored = parseStoredMapArtifact(artifact.content);
      if (!stored) throw new Error("Map artifact content is invalid");
      if (stored.scholarPins.length === 0) {
        throw new Error("Add something to the map before checking it");
      }
      snapshotMapContent = artifact.content;
    } else if (
      activity.deliverable.kind !== "slides" &&
      activity.deliverable.kind !== "map" &&
      isTextArtifact(artifact)
    ) {
      snapshotContent = artifact.content;
    } else {
      throw new Error("This artifact does not match the deliverable kind");
    }
    const hasTutorTranscription = artifact.hasTutorTranscription === true;

    // Sanitize the model-supplied verdicts against the real rubric BEFORE
    // storing them (drop unknown criteria, collapse duplicates, fill omitted
    // with "not"). Shared with the chat advance-rubric path.
    //
    // Auto-mode deliverables keep their per-scholar criteria on the SESSION
    // (`session.deliverableCriteria`); `activity.deliverable.criteria` is empty
    // in auto mode. Scoring against that empty set made every auto rubric
    // "pass" vacuously — scoreRubricVerdicts([], …) returns overall "full"
    // with zero verdicts, so the scholar saw "Goal met!" next to a row of
    // empty stars. Resolve the same way the AI-action check path does
    // (internalGetCheckContext) so the tutor grades the criteria the scholar
    // actually sees.
    const criteria =
      session.deliverableCriteria ?? activity.deliverable.criteria;
    const { verdicts, overall, passed, earned } = scoreRubricVerdicts(
      criteria,
      args.verdicts,
    );
    // Find existing deliverable or insert.
    const rows = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const existing = rows.find(
      (r) =>
        r.activityId === session.activityId &&
        r.artifactId === artifactId,
    );
    const scoreTime = Date.now();
    const flairEarned = [...(existing?.flairEarned ?? [])];
    const earnedCriterionIds = new Set(
      flairEarned.map((flair) => flair.criterionId),
    );
    const newlyEarnedFlair: Array<{
      criterionId: string;
      label: string;
    }> = [];
    for (const verdict of verdicts) {
      if (
        verdict.level !== "full" ||
        earnedCriterionIds.has(verdict.criterionId)
      ) {
        continue;
      }
      flairEarned.push({
        criterionId: verdict.criterionId,
        earnedAt: scoreTime,
        // Snapshot the awarding note: it is what the scholar reads on the
        // mark, and re-checks overwrite `verdicts`.
        ...(verdict.note?.trim() ? { note: verdict.note.trim() } : {}),
      });
      earnedCriterionIds.add(verdict.criterionId);
      const criterion = criteria.find(
        (candidate) => candidate.id === verdict.criterionId,
      );
      newlyEarnedFlair.push({
        criterionId: verdict.criterionId,
        label: criterion?.label ?? verdict.criterionId,
      });
    }

    let deliverableId: Id<"deliverables">;
    if (existing) {
      // The snapshot the model assessed, and the provenance describing it,
      // have to move together — see the comment on textContent below.
      const preservingSnapshot =
        args.preserveSubmittedSnapshot === true &&
        (activity.deliverable.kind === "map"
          ? existing.mapContent !== undefined
          : existing.textContent !== undefined);
      await ctx.db.patch(existing._id, {
        assignmentId: session.assignmentId,
        // An explicit submission snapshots the exact artifact projection the
        // model assessed. Preserve it while the stream runs even if the scholar
        // continues editing the live artifact.
        ...(snapshotContent !== undefined
          ? {
              textContent: preservingSnapshot
                ? existing.textContent
                : snapshotContent,
            }
          : {}),
        ...(snapshotMapContent !== undefined
          ? {
              mapContent: preservingSnapshot
                ? existing.mapContent
                : snapshotMapContent,
            }
          : {}),
        // Mirrors the ternary above rather than being monotonic: the marker
        // describes the text actually stored. A preserved snapshot keeps its
        // own provenance, because a transcription that landed AFTER it is not
        // in it — claiming otherwise would understate what the scholar wrote.
        hasTutorTranscription: preservingSnapshot
          ? (existing.hasTutorTranscription ?? false)
          : hasTutorTranscription,
        submittedAt: scoreTime,
        lastAction: "check",
        verdicts,
        overall,
        rubricPassed: passed,
        rubricFeedback: "",
        rubricCheckedAt: scoreTime,
        rubricCheckedBy: "ai",
        ...(flairEarned.length > 0 ? { flairEarned } : {}),
      });
      deliverableId = existing._id;
    } else {
      deliverableId = await ctx.db.insert("deliverables", {
        activityId: session.activityId,
        scholarId: session.userId,
        sessionId: args.sessionId,
        assignmentId: session.assignmentId,
        artifactId,
        ...(snapshotContent !== undefined ? { textContent: snapshotContent } : {}),
        ...(snapshotMapContent !== undefined
          ? { mapContent: snapshotMapContent }
          : {}),
        // Describes `snapshotContent` on the line above.
        hasTutorTranscription,
        submittedAt: scoreTime,
        lastAction: "check",
        verdicts,
        overall,
        rubricPassed: passed,
        rubricFeedback: "",
        rubricCheckedAt: scoreTime,
        rubricCheckedBy: "ai",
        ...(flairEarned.length > 0 ? { flairEarned } : {}),
      });
    }

    const newAssistantMessageId = args.streamSplit
      ? await finalizeAndSplit(ctx, {
          ...args.streamSplit,
          sessionId: args.sessionId,
          toolAction:
            newlyEarnedFlair.length > 0 ? "Earned flair" : "Reviewed work",
          ...(newlyEarnedFlair.length > 0 ? { flairAwards: newlyEarnedFlair } : {}),
        })
      : undefined;

    return {
      deliverableId,
      overall,
      passed,
      earned,
      total: criteria.length,
      rejectedCompletion: false,
      newlyEarnedFlair,
      newlyEarnedFlairLabels: newlyEarnedFlair.map((flair) => flair.label),
      newAssistantMessageId,
    };
  },
});

// ── Tool-call: score the CHAT "advance" rubric (no artifact) ──────────
//
// The conversation twin of applyRubricScoreFromTool: the tutor calls
// update_rubric_score with NO artifact_id when an activity has an
// `advanceRubric` (a rubric graded against the discussion, not a submitted
// document). We store the result as an artifact-less `deliverables` row
// (the table already allows that — portfolio rows have no artifact either)
// and, on pass, run the completion effects reserved for this rubric shape — so
// "ready to advance" === the activity is complete and the Continue CTA
// surfaces. DRY: shares scoreRubricVerdicts + markActivityCompleted (which
// runs the one shared reconcileActivityCompletion cascade).
export const applyAdvanceRubricScoreFromTool = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    rejectPassingScore: v.optional(v.boolean()),
    verdicts: v.array(
      v.object({
        criterionId: v.string(),
        level: v.union(
          v.literal("not"),
          v.literal("half"),
          v.literal("full"),
        ),
        // Accepted for parity with the document-rubric path: the tutor tool
        // emits one `verdicts` array and both mutations receive it, so a
        // validator without `note` would reject every conversation rubric.
        // Conversation rubrics mint no flair, so it is only stored, not shown.
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.activityId) {
      throw new Error("Project has no activity to score against");
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity?.advanceRubric) {
      throw new Error("Activity has no advance rubric");
    }
    const criteria = activity.advanceRubric.criteria;
    const { verdicts, overall, passed, earned } = scoreRubricVerdicts(
      criteria,
      args.verdicts,
    );
    if (session.activityCompletedAt) {
      return {
        deliverableId: null,
        overall,
        passed,
        earned,
        total: criteria.length,
        rejectedCompletion: false,
        alreadyComplete: true,
      };
    }
    if (passed && args.rejectPassingScore) {
      return {
        deliverableId: null,
        overall,
        passed: false,
        earned,
        total: criteria.length,
        rejectedCompletion: true,
        alreadyComplete: false,
      };
    }

    // Upsert the artifact-less rubric row for this (session, activity).
    const rows = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const existing = rows.find(
      (r) => r.activityId === session.activityId && r.artifactId === undefined,
    );
    let deliverableId: Id<"deliverables">;
    if (existing) {
      await ctx.db.patch(existing._id, {
        submittedAt: Date.now(),
        verdicts,
        overall,
        rubricPassed: passed,
        rubricFeedback: "",
        rubricCheckedAt: Date.now(),
        rubricCheckedBy: "ai",
      });
      deliverableId = existing._id;
    } else {
      deliverableId = await ctx.db.insert("deliverables", {
        activityId: session.activityId,
        scholarId: session.userId,
        sessionId: args.sessionId,
        assignmentId: session.assignmentId,
        submittedAt: Date.now(),
        verdicts,
        overall,
        rubricPassed: passed,
        rubricFeedback: "",
        rubricCheckedAt: Date.now(),
        rubricCheckedBy: "ai",
      });
    }

    if (passed) {
      await markActivityCompleted(ctx, session.userId, session.activityId, args.sessionId);
    }

    return {
      deliverableId,
      overall,
      passed,
      earned,
      total: criteria.length,
      rejectedCompletion: false,
      alreadyComplete: false,
    };
  },
});

// ── Tool-call: set the scholar's angle on a hasScholarAngles activity ─
//
// Replaces the old `applySetAngleFromTool` (which wrote to
// scholarQuests). Now writes to scholarActivityAngles — one row per
// (scholar, activity).
export const applySetAngleFromTool = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.activityId) {
      throw new Error("Project has no activity");
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity) throw new Error("Activity not found");
    if (!activity.hasScholarAngles) {
      throw new Error("Activity does not allow per-scholar angles");
    }
    // Use the session owner as the scholar identity (test-drive will
    // need a separate path later if it's ever wired for angles).
    const scholarId = session.userId;
    const existing = await ctx.db
      .query("scholarActivityAngles")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholarId).eq("activityId", session.activityId!),
      )
      .first();
    const title = args.title.trim().slice(0, 120);
    const description = args.description.trim().slice(0, 500);
    if (existing) {
      await ctx.db.patch(existing._id, {
        title,
        description,
        setAt: Date.now(),
        setBy: "ai",
      });
      return { angleId: existing._id, title };
    }
    const angleId = await ctx.db.insert("scholarActivityAngles", {
      scholarId,
      activityId: session.activityId,
      title,
      description,
      setAt: Date.now(),
      setBy: "ai",
    });
    return { angleId, title };
  },
});

// ── AI rubric check (action) ──────────────────────────────────────────

const buildRubricSystemPrompt = (
  profile: InstitutionPromptProfile = DEFAULT_INSTITUTION_PROMPT_PROFILE,
): string => `You evaluate a scholar's deliverable against an explicit rubric. The scholar is a gifted elementary-age child at ${profile.schoolName}. Be DIRECT and HONEST. Do not be sycophantic.

Your job: judge each numbered criterion individually, then give an overall verdict. Critique is the point — when something misses a criterion, say so clearly and specifically. When it lands, acknowledge it concisely and move on.

Per-criterion verdicts:
- "full"  — the criterion is met as written.
- "half"  — partially met. Something concrete is still missing or imprecise.
- "not"   — not met at all, or the submission is off-topic for this criterion.

Overall:
- "full"  — every criterion is "full". This is a PASS.
- "half"  — at least one criterion is "half" or "not", but the submission shows real engagement. Scholar should revise.
- "not"   — the submission doesn't engage with the rubric at all.

Tone:
- Speak to the scholar in second person.
- Respectful but not coddling. Bright kids handle — and want — honest feedback.
- No reflexive praise. Avoid "Great job!", "Nice effort!", "I love that you...", "I appreciate...", or any other empty validation.
- Specific beats generic. "Your explanation of lift conflates Bernoulli's principle with Newton's third law" beats "Your physics could be clearer."
- Per-criterion notes are 1 sentence each. The summary is 1–3 short paragraphs.

Calibration:
- Apply each criterion as written. If a criterion demands specifics, vague answers don't earn "full". If it demands a count (e.g., "3-5 sentences"), enforce it.
- At the boundary, lean toward "half" with a specific path forward — not "full" with hedging. Re-submission is unlimited; honest "almost, here's what's missing" is more useful than a wishy-washy pass.
- If the scholar wrote something clever but off-topic for the criterion, that's "not" or "half" — acknowledge the cleverness briefly, redirect to what was asked for.
- Length isn't quality. A short tight answer can be "full"; a long meandering one can be "half".

You MUST call the report_rubric_check tool with your verdicts. Do not respond with raw text.`;

export const RUBRIC_TOOL = {
  name: "report_rubric_check",
  description:
    "Report per-criterion verdicts + overall verdict + honest, specific feedback for the scholar.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdicts: {
        type: "array" as const,
        description:
          "One entry per numbered criterion, in order. Each entry references the criterion's id (shown in the rubric as '[id]') and assigns a verdict + a one-sentence note.",
        items: {
          type: "object" as const,
          properties: {
            criterionId: { type: "string" as const },
            level: {
              type: "string" as const,
              enum: ["not", "half", "full"] as const,
            },
            note: {
              type: "string" as const,
              description:
                "One sentence — what about the submission earned this level for this criterion. Specific, not generic.",
            },
          },
          required: ["criterionId", "level", "note"] as const,
        },
      },
      overall: {
        type: "string" as const,
        enum: ["not", "half", "full"] as const,
        description:
          "Aggregate verdict. 'full' = every criterion full = PASS. 'half' = needs revision. 'not' = off-topic / no engagement.",
      },
      feedback: {
        type: "string" as const,
        description:
          "1–3 short paragraphs of scholar-facing prose summarizing the verdict. Direct, specific, not sycophantic. If overall != 'full', end with the next concrete step.",
      },
      conceptLabel: {
        type: "string" as const,
        description:
          "Short concept name this deliverable demonstrates mastery of (or attempts to). E.g., 'How airplane wings produce lift'. Used for mastery tracking.",
      },
      domain: {
        type: "string" as const,
        description:
          "Broad domain the concept lives in. E.g., 'Physics', 'Writing', 'Mathematics', 'Engineering'.",
      },
      masteryLevel: {
        type: "number" as const,
        description:
          "Bloom's level from 0 (remember) to 5 (create). Use 0–5 floats; 2.5 means halfway between understand and apply.",
      },
      confidence: {
        type: "number" as const,
        description: "How confident you are in this mastery rating, 0.0–1.0.",
      },
    },
    required: [
      "verdicts",
      "overall",
      "feedback",
      "conceptLabel",
      "domain",
      "masteryLevel",
      "confidence",
    ],
  },
};

type VerdictLevel = "not" | "half" | "full";
interface RubricVerdict {
  criterionId: string;
  level: VerdictLevel;
  note: string;
}
interface RubricResult {
  verdicts: RubricVerdict[];
  overall: VerdictLevel;
  passed: boolean; // derived: overall === "full"
  feedback: string;
  conceptLabel: string;
  domain: string;
  masteryLevel: number;
  confidence: number;
}

export const checkRubric = action({
  args: { deliverableId: v.id("deliverables") },
  handler: async (ctx, args): Promise<RubricResult> => {
    const ctxBundle = await ctx.runQuery(
      internal.deliverables.internalGetCheckContext,
      { deliverableId: args.deliverableId },
    );
    if (!ctxBundle) throw new Error("Deliverable not found");
    const {
      deliverable,
      activity,
      angle,
      resolvedCriteria,
      readingLevel,
      institutionProfile,
    } = ctxBundle;
    if (!activity.deliverable) {
      throw new Error("Activity has no deliverable spec");
    }
    if (resolvedCriteria.length === 0) {
      throw new Error(
        "Rubric criteria are not ready yet for this deliverable. " +
          "Wait for auto-generation to complete, or check the project's " +
          "deliverableCriteriaStatus.",
      );
    }

    // Per-scholar angle (if this activity has hasScholarAngles).
    const angleLine = angle
      ? `\n\nThe scholar's chosen angle: ${angle.title} — ${angle.description}`
      : "";

    const rubricBlock = renderCriteriaForRubricCheck(resolvedCriteria);
    const readingLevelLine = readingLevel
      ? `Scholar reading level: ${readingLevel}. CALIBRATE level-dependent criteria (length, mechanics, vocabulary) to this level — but apply level-INDEPENDENT criteria (specificity, structure, engagement, originality) at the same bar regardless of level. Don't grade-inflate.`
      : null;
    const userMessage = [
      `Activity: ${activity.title}${activity.description ? ` — ${activity.description}` : ""}`,
      `Deliverable prompt: ${activity.deliverable.prompt}`,
      readingLevelLine,
      `RUBRIC (numbered criteria — return one verdict per id):`,
      rubricBlock,
      angleLine ? angleLine : null,
      "",
      "── The scholar's submission ──",
      deliverable.textContent ?? "(non-text deliverable; see attached content if present)",
    ]
      .filter((s) => s !== null)
      .join("\n");

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });

    type ToolReturn = Omit<RubricResult, "passed">;
    let parsed: RubricResult;
    try {
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 2048,
        system: buildRubricSystemPrompt(institutionProfile),
        tools: [RUBRIC_TOOL],
        tool_choice: { type: "tool", name: "report_rubric_check" },
        messages: [{ role: "user", content: userMessage }],
      });
      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        throw new Error("AI did not call report_rubric_check");
      }
      await recordAnthropicUsage(ctx, {
        source: "rubric-check",
        role: ROLES.SCHOLAR,
        model: MODELS.SONNET,
        usage: response.usage,
        institutionId: await ctx.runQuery(internal.usage.resolveInstitution, {
          userId: deliverable.scholarId,
          principal: "scholar",
        }),
      });
      const raw = toolBlock.input as ToolReturn;
      const validIds = new Set(resolvedCriteria.map((c) => c.id));
      const seenIds = new Set<string>();
      const cleanVerdicts: RubricVerdict[] = [];
      for (const v of raw.verdicts ?? []) {
        if (!validIds.has(v.criterionId)) continue;
        if (seenIds.has(v.criterionId)) continue;
        seenIds.add(v.criterionId);
        cleanVerdicts.push({
          criterionId: v.criterionId,
          level: v.level,
          note: v.note,
        });
      }
      for (const c of resolvedCriteria) {
        if (!seenIds.has(c.id)) {
          cleanVerdicts.push({
            criterionId: c.id,
            level: "not",
            note: "(no verdict returned by checker)",
          });
        }
      }
      parsed = {
        ...raw,
        verdicts: cleanVerdicts,
        passed: raw.overall === "full",
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[checkRubric] Anthropic call failed:", message);
      parsed = {
        verdicts: resolvedCriteria.map((c) => ({
          criterionId: c.id,
          level: "not" as const,
          note: "(automatic check errored — ask your teacher to review)",
        })),
        overall: "not",
        passed: false,
        feedback: `The automatic rubric check ran into an error: ${message}. Ask your teacher to review your submission.`,
        conceptLabel: activity.title,
        domain: "general",
        masteryLevel: 1,
        confidence: 0.2,
      };
    }

    await ctx.runMutation(internal.deliverables.applyCheckResult, {
      deliverableId: args.deliverableId,
      verdicts: parsed.verdicts,
      overall: parsed.overall,
      feedback: parsed.feedback,
      conceptLabel: parsed.conceptLabel,
      domain: parsed.domain,
      masteryLevel: parsed.masteryLevel,
      confidence: parsed.confidence,
    });
    return parsed;
  },
});

// ── Teacher manual override ───────────────────────────────────────────

/**
 * Teacher manually sets a deliverable's verdict (Not yet / Partial / Full) —
 * "classic manual grading." This is the only assessment path for work a rubric
 * check can't read: scanned/offline deliverables (an offline session's
 * materialized scan) and binary file submissions. It also lets a teacher
 * override an AI verdict on any deliverable.
 *
 * The verdict is orthogonal to completion. For an offline deliverable the
 * activity is already marked complete at materialize-time (turning in the
 * paper = done), so a "not"/"half" grade does NOT un-complete it — it just
 * records quality. A "full" grade records the teacher's human decision to
 * finish the activity (idempotent when a completion already exists).
 */
export const teacherSetCheck = teacherMutation({
  args: {
    deliverableId: v.id("deliverables"),
    overall: v.union(v.literal("not"), v.literal("half"), v.literal("full")),
    feedback: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliverableId);
    if (!d) throw new Error("Deliverable not found");
    await requireActiveScholarAccess(ctx, ctx.user, d.scholarId);
    const patch: Partial<Doc<"deliverables">> = {
      rubricPassed: args.overall === "full",
      rubricCheckedAt: Date.now(),
      rubricCheckedBy: "teacher",
      overall: args.overall,
    };
    // Only overwrite the existing reason when the teacher gives a new one.
    // An empty string is an explicit clear (the control sends it when the
    // teacher deletes a prefilled note); undefined preserves what's there.
    if (args.feedback !== undefined) {
      const trimmed = args.feedback.trim();
      patch.rubricFeedback = trimmed.length > 0 ? trimmed : undefined;
      patch.verdicts = undefined;
    }
    await ctx.db.patch(args.deliverableId, patch);
    if (args.overall === "full") {
      await markActivityCompleted(ctx, d.scholarId, d.activityId, d.sessionId as Id<"sessions">);
    }
  },
});

// ── Internal helpers ──────────────────────────────────────────────────

export const internalGetCheckContext = internalQuery({
  args: { deliverableId: v.id("deliverables") },
  handler: async (ctx, args) => {
    const deliverable = await ctx.db.get(args.deliverableId);
    if (!deliverable) return null;
    const activity = await ctx.db.get(deliverable.activityId);
    if (!activity) return null;
    const session = await ctx.db.get(deliverable.sessionId);

    // Per-scholar angle (if this activity has hasScholarAngles).
    const angle =
      activity.hasScholarAngles && session
        ? await ctx.db
            .query("scholarActivityAngles")
            .withIndex("by_scholar_activity", (q) =>
              q
                .eq("scholarId", session.userId)
                .eq("activityId", deliverable.activityId),
            )
            .first()
        : null;

    const resolvedCriteria =
      session?.deliverableCriteria ?? activity.deliverable?.criteria ?? [];

    let readingLevel: string | null = null;
    if (session) {
      if (session.isTestDrive && session.testDriveSyntheticReadingLevel) {
        readingLevel = session.testDriveSyntheticReadingLevel;
      } else if (session.testDriveAsScholarId) {
        const s = await ctx.db.get(session.testDriveAsScholarId);
        readingLevel = s?.readingLevel ?? null;
      } else {
        const s = await ctx.db.get(session.userId);
        readingLevel = s?.readingLevel ?? null;
      }
      if (session.readingLevelOverride) {
        readingLevel = session.readingLevelOverride;
      }
    }
    return {
      deliverable,
      activity,
      session,
      angle,
      resolvedCriteria,
      readingLevel,
      institutionProfile: await institutionPromptProfileForScholar(
        ctx,
        deliverable.scholarId,
      ),
    };
  },
});

/**
 * Resolve the ORIGINAL file a multimodal assessment should read for this
 * deliverable, from either source:
 *   - a materialized SCAN → the linked portfolio item's `fileStorageId`
 *     (deliberately the original, never the Magic redraw), or
 *   - a scholar-SUBMITTED photo → the deliverable's own `fileStorageId`.
 * Returns null when the deliverable has no readable file (e.g. a text/artifact
 * deliverable), which the assess action treats as "wrong deliverable type".
 *
 * The mimeType is null for a submitted photo (the storage upload doesn't stamp
 * one) — the assess action sniffs it from the bytes. A scan always carries the
 * portfolio item's fileMimeType (PDFs go through the document block).
 */
export const getAssessFile = internalQuery({
  args: { deliverableId: v.id("deliverables") },
  handler: async (
    ctx,
    { deliverableId },
  ): Promise<
    | {
        storageId: Id<"_storage">;
        mimeType: string | null;
        aiCaption: string | null;
        source: "scan" | "submission";
      }
    | null
  > => {
    const d = await ctx.db.get(deliverableId);
    if (!d) return null;
    // Prefer the scan backlink (the paper pipeline's single source of truth for
    // the blob) when present; otherwise the scholar's directly-submitted file.
    if (d.portfolioItemId) {
      const item = await ctx.db.get(d.portfolioItemId);
      if (!item?.fileStorageId) return null;
      return {
        storageId: item.fileStorageId,
        mimeType: item.fileMimeType ?? "application/pdf",
        aiCaption: item.aiCaption ?? null,
        source: "scan",
      };
    }
    if (d.fileStorageId) {
      return {
        storageId: d.fileStorageId,
        mimeType: null,
        aiCaption: null,
        source: "submission",
      };
    }
    return null;
  },
});

export const applyCheckResult = internalMutation({
  args: {
    deliverableId: v.id("deliverables"),
    verdicts: v.array(
      v.object({
        criterionId: v.string(),
        level: v.union(
          v.literal("not"),
          v.literal("half"),
          v.literal("full"),
        ),
        note: v.optional(v.string()),
      }),
    ),
    overall: v.union(
      v.literal("not"),
      v.literal("half"),
      v.literal("full"),
    ),
    feedback: v.string(),
    conceptLabel: v.string(),
    domain: v.string(),
    masteryLevel: v.number(),
    confidence: v.number(),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliverableId);
    if (!d) return;
    const passed = args.overall === "full";
    await ctx.db.patch(args.deliverableId, {
      verdicts: args.verdicts,
      overall: args.overall,
      rubricPassed: passed,
      rubricFeedback: args.feedback,
      rubricCheckedAt: Date.now(),
      rubricCheckedBy: "ai",
      lastAction: "check",
    });

    // Mastery write-through (DRY with observer). For a scanned deliverable
    // (offline session) there's no textContent — fall back to the linked
    // portfolio item's caption + transcription so the observation carries
    // real evidence text, not "(non-text deliverable)".
    let transcriptExcerpt = (d.textContent ?? "").slice(0, 800);
    if (!transcriptExcerpt && d.portfolioItemId) {
      const item = await ctx.db.get(d.portfolioItemId);
      transcriptExcerpt = [item?.aiCaption, item?.extractedText]
        .filter((s): s is string => !!s && s.trim().length > 0)
        .join("\n\n")
        .slice(0, 800);
    }
    if (!transcriptExcerpt) transcriptExcerpt = "(non-text deliverable)";
    try {
      await ctx.runMutation(internal.masteryObservations.record, {
        scholarId: d.scholarId,
        conceptLabel: args.conceptLabel,
        domain: args.domain,
        sessionId: d.sessionId as Id<"sessions">,
        transcriptExcerpt,
        masteryLevel: args.masteryLevel,
        confidenceScore: args.confidence,
        evidenceSummary: args.feedback.slice(0, 500),
        evidenceType: "rubricCheck",
        attemptContext: "deliverable submission",
        studentInitiated: true,
      });
    } catch (err) {
      console.error("[applyCheckResult] mastery write failed", err);
    }

  },
});

/**
 * Idempotently mark a (scholar, activity) as completed. Runs the ONE shared
 * completion cascade (`reconcileActivityCompletion`: canonical row → unit badge
 * → session card state → seed/quest completion — see lib/activityCompletionCore);
 * this wrapper adds the Slack ping fired only on a fresh completion.
 */
async function markActivityCompleted(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  sessionId?: Id<"sessions">,
) {
  const { created } = await reconcileActivityCompletion(ctx, {
    scholarId,
    activityId,
    sessionId,
  });
  if (!created) return;

  // Slack: rubric-backed completions ping linked group channels too
  // (same opt-in as the manual markComplete path).
  const activity = await ctx.db.get(activityId);
  const scholar = await ctx.db.get(scholarId);
  await fanOutScholarEvent(ctx, {
    scholarId,
    text: `*${scholar?.name ?? "A scholar"}* completed *${activity?.title ?? "an activity"}* (rubric passed) — <${scholarDeepLink(scholarId)}|open>`,
  });
}

/**
 * When a scholar completes an activity, check if the parent unit has a
 * `badgeOnCompletion` config AND every activity is now complete; if so,
 * award the badge. Shared across every completion path — see
 * convex/lib/badgeAward.ts.
 */

// ── Auto-mode rubric generation ──────────────────────────────────────

const buildCriteriaGenSystemPrompt = (
  profile: InstitutionPromptProfile = DEFAULT_INSTITUTION_PROMPT_PROFILE,
): string => `You write rubric criteria for an AI tutor at ${profile.schoolName}, a gifted elementary school.

A scholar is about to work on an activity. Your job: produce 3-5 dimensional rubric criteria that capture the quality bar for THIS scholar, given their reading level and the teacher's intent. The criteria are a private map for the AI tutor, not a scholar checklist and not a completion gate. The tutor later judges each criterion not/half/full. Only a full criterion is revealed to the scholar: its label and description appear together as permanent flair.

CALIBRATION RULES:
- Level-dependent dimensions (length, mechanics like spelling/capitalization, vocabulary): SCALE to the scholar's reading level. A 6-year-old emerging reader's "Length: full" might be 2 sentences; a 5th grader's might be 6 with varied structure. Don't hold a 1st grader to a 5th grader's bar.
- Level-INDEPENDENT dimensions (specificity, structure, engagement, originality, evidence): use the SAME bar regardless of reading level. "Names a specific person" is the same for a 1st grader and a 5th grader; gifted scholars at any age can engage with content specifically.

CRITERIA SHAPE:
- 3-5 items. Fewer is fine if the deliverable is small.
- Each is { label, description }.
- Label: 1-4 words, plain. E.g. "Specificity", "Mechanics", "Beginning, middle, end".
- Description: a single sentence stating concretely what counts as "full" for THIS scholar. Include the failure mode if it makes the bar clearer.

DIMENSIONAL > PROCEDURAL:
- Make criteria about WHAT'S TRUE OF THE WORK (specificity, structure, mechanics), not about WHAT THE SCHOLAR DID (drafted, revised, brainstormed). Procedural lives in the process pipeline, not the rubric.

Don't be sycophantic. Don't pad. Don't restate the deliverable prompt.

You MUST call the report_criteria tool.`;

const CRITERIA_GEN_TOOL = {
  name: "report_criteria",
  description:
    "Report 3-5 rubric criteria calibrated for this scholar's reading level.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      criteria: {
        type: "array" as const,
        minItems: 1,
        items: {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            label: {
              type: "string" as const,
              description: "1-4 words. Plain English.",
            },
            description: {
              type: "string" as const,
              description:
                "One sentence stating concretely what counts as 'full' for this scholar at this level.",
            },
          },
          required: ["label", "description"] as const,
        },
      },
    },
    required: ["criteria"],
  },
};

interface GeneratedCriterionInput {
  label: string;
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/**
 * Defend the external tool boundary even though strict mode validates the
 * schema upstream: the SDK still exposes toolBlock.input as unknown.
 */
export function parseCriteriaGenToolInput(
  input: unknown,
): GeneratedCriterionInput[] {
  if (!isRecord(input) || !hasOnlyKeys(input, ["criteria"])) {
    throw new Error("report_criteria input must contain only criteria");
  }
  if (!Array.isArray(input.criteria)) {
    throw new Error("report_criteria criteria must be an array");
  }

  const criteria = input.criteria;
  if (criteria.length < 3 || criteria.length > 5) {
    throw new Error("report_criteria criteria must contain 3-5 items");
  }

  return criteria.map((criterion, index) => {
    if (!isRecord(criterion)) {
      throw new Error(`report_criteria criterion ${index + 1} must be an object`);
    }
    if (!hasOnlyKeys(criterion, ["label", "description"])) {
      throw new Error(
        `report_criteria criterion ${index + 1} must contain only label and description`,
      );
    }
    if (typeof criterion.label !== "string" || !criterion.label.trim()) {
      throw new Error(
        `report_criteria criterion ${index + 1} label must be a non-empty string`,
      );
    }
    if (
      typeof criterion.description !== "string" ||
      !criterion.description.trim()
    ) {
      throw new Error(
        `report_criteria criterion ${index + 1} description must be a non-empty string`,
      );
    }
    return { label: criterion.label, description: criterion.description };
  });
}

interface CriteriaGenContext {
  scholarId: Id<"users"> | null;
  activityTitle: string;
  activityDescription: string | null;
  deliverablePrompt: string;
  teacherNotes: string | null;
  readingLevel: string | null;
  unitTitle: string | null;
  lessonTitle: string | null;
  // Per-scholar angle when activity.hasScholarAngles is on.
  angleTitle: string | null;
  angleDescription: string | null;
  institutionProfile: InstitutionPromptProfile;
}

export const internalGetCriteriaGenContext = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<CriteriaGenContext | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    if (!session.activityId) return null;
    const activity = await ctx.db.get(session.activityId);
    if (!activity?.deliverable) return null;
    if (activity.deliverable.mode !== "auto") return null;

    let readingLevel: string | null = null;
    if (session.isTestDrive && session.testDriveSyntheticReadingLevel) {
      readingLevel = session.testDriveSyntheticReadingLevel;
    } else if (session.testDriveAsScholarId) {
      const s = await ctx.db.get(session.testDriveAsScholarId);
      readingLevel = s?.readingLevel ?? null;
    } else {
      const s = await ctx.db.get(session.userId);
      readingLevel = s?.readingLevel ?? null;
    }
    if (session.readingLevelOverride) readingLevel = session.readingLevelOverride;

    let unitTitle: string | null = null;
    let lessonTitle: string | null = null;
    if (activity.lessonId) {
      const lesson = await ctx.db.get(activity.lessonId);
      if (lesson) {
        lessonTitle = lesson.title;
        const unit = await ctx.db.get(lesson.unitId);
        if (unit) unitTitle = unit.title;
      }
    }

    // Per-scholar angle (the jigsaw move).
    let angleTitle: string | null = null;
    let angleDescription: string | null = null;
    if (activity.hasScholarAngles) {
      const scholarId =
        session.testDriveAsScholarId ?? session.userId;
      const angle = await ctx.db
        .query("scholarActivityAngles")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activity._id),
        )
        .first();
      if (angle) {
        angleTitle = angle.title;
        angleDescription = angle.description;
      }
    }

    return {
      scholarId: session.isTestDrive
        ? session.testDriveAsScholarId ?? null
        : session.userId,
      activityTitle: activity.title,
      activityDescription: activity.description ?? null,
      deliverablePrompt: activity.deliverable.prompt,
      teacherNotes: activity.deliverable.notes ?? null,
      readingLevel,
      unitTitle,
      lessonTitle,
      angleTitle,
      angleDescription,
      institutionProfile: await institutionPromptProfileForScholar(
        ctx,
        session.testDriveAsScholarId ?? session.userId,
      ),
    };
  },
});

export const persistGeneratedCriteria = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    criteria: v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        description: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      deliverableCriteria: args.criteria,
      deliverableCriteriaStatus: "ready" as const,
      deliverableCriteriaError: undefined,
    });
    await ensureFlairArtForSession(ctx, args.sessionId, args.criteria);
  },
});

export const recordCriteriaError = internalMutation({
  args: { sessionId: v.id("sessions"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      deliverableCriteriaStatus: "error" as const,
      deliverableCriteriaError: args.error.slice(0, 500),
    });
  },
});

export const generateCriteriaForSession = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<void> => {
    const bundle = await ctx.runQuery(
      internal.deliverables.internalGetCriteriaGenContext,
      { sessionId: args.sessionId },
    );
    if (!bundle) return;
    const institutionId = bundle.scholarId
      ? await ctx.runQuery(internal.usage.resolveInstitution, {
          userId: bundle.scholarId,
          principal: "scholar",
        })
      : null;

    const angleBlock = bundle.angleTitle
      ? [
          `Scholar's chosen angle for this activity: ${bundle.angleTitle}${bundle.angleDescription ? ` — ${bundle.angleDescription}` : ""}`,
          "SPECIALIZE the criteria to that angle — a scholar whose angle is 'Wings' should be judged on wing-specific specifics, not on engines-specific specifics.",
        ]
      : [];

    const userMessage = [
      bundle.unitTitle ? `Unit: ${bundle.unitTitle}` : null,
      bundle.lessonTitle ? `Lesson: ${bundle.lessonTitle}` : null,
      ...angleBlock,
      `Activity: ${bundle.activityTitle}${bundle.activityDescription ? ` — ${bundle.activityDescription}` : ""}`,
      `Deliverable prompt (what the scholar produces): ${bundle.deliverablePrompt}`,
      `Teacher's notes about quality bar / intent: ${bundle.teacherNotes ?? "(none — infer from the deliverable prompt and unit context)"}`,
      `Scholar's reading level: ${bundle.readingLevel ?? "(not set — pick a sensible default for elementary)"}`,
      "",
      "Produce 3-5 dimensional criteria calibrated for this scholar. Call report_criteria.",
    ]
      .filter((s) => s !== null)
      .join("\n");

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 1024,
        system: buildCriteriaGenSystemPrompt(bundle.institutionProfile),
        tools: [CRITERIA_GEN_TOOL],
        tool_choice: { type: "tool", name: "report_criteria" },
        messages: [{ role: "user", content: userMessage }],
      });
      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        throw new Error("AI did not call report_criteria");
      }
      await recordAnthropicUsage(ctx, {
        source: "criteria-gen",
        role: ROLES.TEACHER,
        model: MODELS.SONNET,
        usage: response.usage,
        institutionId,
      });
      const criteria = parseCriteriaGenToolInput(toolBlock.input);
      const normalized = normalizeDeliverable({
        kind: "text",
        prompt: "x",
        mode: "manual",
        criteria: criteria.map((c) => ({
          id: "",
          label: c.label,
          description: c.description,
        })),
      });
      if (!normalized) throw new Error("normalizer returned undefined");
      await ctx.runMutation(internal.deliverables.persistGeneratedCriteria, {
        sessionId: args.sessionId,
        criteria: normalized.criteria.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[generateCriteriaForSession] failed:", msg);
      await ctx.runMutation(internal.deliverables.recordCriteriaError, {
        sessionId: args.sessionId,
        error: msg,
      });
    }
  },
});

export const regenerateCriteria = teacherMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    // Session-owner gate (handles test-drive sessions) — mirrors teacherSetCheck
    // / processState.teacherMoveStep so a cross-institution teacher can't mutate
    // another scholar's session + burn an AI call once enforcement is on.
    const ownerScholarId = session.isTestDrive
      ? session.testDriveAsScholarId
      : session.userId;
    if (ownerScholarId) {
      await requireActiveScholarAccess(ctx, ctx.user, ownerScholarId);
    }
    await ctx.db.patch(args.sessionId, {
      deliverableCriteriaStatus: "pending" as const,
      deliverableCriteriaError: undefined,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.deliverables.generateCriteriaForSession,
      { sessionId: args.sessionId },
    );
  },
});
