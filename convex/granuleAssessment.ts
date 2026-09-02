// Offline-artifact granule assessment — the non-conversation half of the
// baseline/exit-ticket recipe.
//
// The observer (convex/observer.ts) attributes a *conversation* to the
// unit's EQ/EU granules. But a baseline/exit-ticket activity can be
// OFFLINE — the scholar's thinking arrives as a written deliverable (a
// typed response, or a scanned/uploaded worksheet whose text is OCR'd
// into the linked portfolio item). This module assesses THAT text against
// the same granules, writing the same phase-stamped `granuleEvidence`
// rows, so an offline baseline/exit ticket feeds the Understanding grid +
// before/after exactly like a tutored one.
//
// Trigger: scheduled from a deliverable write (scholar `deliverables.submit`
// or teacher portfolio materialization) when the activity carries a recipe.
// Idempotent per offline project: a re-submit re-OCR clears this project's
// prior artifact-sourced evidence before re-writing.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { unitGranules } from "./lib/granules";
import type { Doc, Id } from "./_generated/dataModel";
import { SCHOLAR_PRONOUN_GUIDANCE } from "./lib/scholarPronouns";

// The model echoes granule keys back; same demonstrated/probed bar as the
// observer's §8 (convex/prompts.ts) so online + offline evidence is calibrated
// the same way.
export const ARTIFACT_GRANULE_SYSTEM_PROMPT = `You assess a scholar's written work against a unit's essential questions (EQs) and enduring understandings (EUs) — its "granules". You are looking at ONE artifact (a written response or a scanned worksheet), not a conversation.

${SCHOLAR_PRONOUN_GUIDANCE}

For each granule the artifact actually engages, emit one attribution. Omit granules the artifact never touches — absence is itself the signal (it tells the teacher this work didn't reach that question).

- outcome "demonstrated": the work SHOWED the understanding — the scholar explained it in their own words, applied it to a concrete example, or reasoned with it. If the prompt/worksheet handed them the idea and they merely restated it, that is NOT demonstrated.
- outcome "probed": the work genuinely engaged the granule (wrestled with it, attempted it, reasoned around it) but didn't demonstrate the understanding — including when it shows a misconception.
- A passing mention is not "probed." The bar is real engagement: would a teacher reading this say "they worked on that question"?
- granuleKey must be copied EXACTLY from the provided list. Never invent keys; never attribute to a granule that isn't listed.
- transcriptExcerpt: a short verbatim snippet of the SCHOLAR's own words from the artifact that is the evidence. Never quote the prompt.
- bloomLevel: the highest Bloom's level the work reached for this granule (remember/understand/apply/analyze/evaluate/create). Scaffolding data, never a kid-facing grade.

This is assessment, not grading. There is no pass/fail and no minimum — report honestly what the work shows, even if that is little.`;

const ARTIFACT_GRANULE_TOOL = {
  name: "report_granule_assessment",
  description:
    "Report which of the unit's EQ/EU granules this artifact engaged, and how.",
  input_schema: {
    type: "object" as const,
    required: ["attributions"],
    properties: {
      attributions: {
        type: "array" as const,
        description:
          "One entry per granule the artifact engaged. Omit untouched granules.",
        items: {
          type: "object" as const,
          required: ["granuleKey", "outcome", "evidenceSummary", "transcriptExcerpt"],
          properties: {
            granuleKey: {
              type: "string" as const,
              description: "Key from the Unit Granules list — exact string",
            },
            outcome: {
              type: "string" as const,
              enum: ["demonstrated", "probed"],
            },
            evidenceSummary: { type: "string" as const },
            transcriptExcerpt: {
              type: "string" as const,
              description: "Verbatim snippet of the scholar's own words",
            },
            bloomLevel: {
              type: "string" as const,
              enum: ["remember", "understand", "apply", "analyze", "evaluate", "create"],
            },
          },
        },
      },
    },
  },
};

type ArtifactAttribution = {
  granuleKey: string;
  outcome: "demonstrated" | "probed";
  evidenceSummary: string;
  transcriptExcerpt: string;
  bloomLevel?: string;
};

/**
 * Resolve a deliverable's unit: prefer the (offline) session's unitId, else
 * the activity's lesson → unit. `activities.lessonId` is optional, so this
 * keeps the id strongly typed as `Id<"units"> | null`.
 */
async function resolveUnitId(
  ctx: { db: { get: (id: Id<"sessions"> | Id<"lessons">) => Promise<Doc<"sessions"> | Doc<"lessons"> | null> } },
  session: Doc<"sessions"> | null,
  activity: Doc<"activities">,
): Promise<Id<"units"> | null> {
  if (session?.unitId) return session.unitId;
  if (activity.lessonId) {
    const lesson = (await ctx.db.get(activity.lessonId)) as Doc<"lessons"> | null;
    if (lesson?.unitId) return lesson.unitId;
  }
  return null;
}

/**
 * Gather everything the assessor needs, or return null when the deliverable
 * isn't assessable for granules: no recipe on the activity, no granules on the
 * unit, or no usable artifact text yet (e.g. OCR hasn't landed). Returning null
 * makes the action a clean no-op rather than an error.
 */
export const getArtifactAssessContext = internalQuery({
  args: { deliverableId: v.id("deliverables") },
  handler: async (ctx, { deliverableId }) => {
    const d = await ctx.db.get(deliverableId);
    if (!d) return null;
    const activity = await ctx.db.get(d.activityId);
    if (!activity?.recipe) return null; // only baseline/exitTicket activities
    // OFFLINE only. Online recipe activities get their granule evidence from
    // the conversation observer (convex/observer.ts) writing to this same
    // session; running the artifact assessor there would let its
    // idempotent-replace wipe that richer conversation evidence.
    if (activity.kind !== "offline") return null;

    const session = await ctx.db.get(d.sessionId as Id<"sessions">);
    const resolvedUnitId = await resolveUnitId(ctx, session, activity);
    if (!resolvedUnitId) return null;
    const unit = await ctx.db.get(resolvedUnitId);
    if (!unit) return null;
    const granules = unitGranules(unit);
    if (granules.length === 0) return null;

    // Assessable text: the typed deliverable, else the scanned portfolio
    // item's caption + OCR text (same fallback as deliverables.applyCheckResult).
    let text = (d.textContent ?? "").trim();
    if (!text && d.portfolioItemId) {
      const item = await ctx.db.get(d.portfolioItemId);
      text = [item?.aiCaption, item?.extractedText]
        .filter((s): s is string => !!s && s.trim().length > 0)
        .join("\n\n")
        .trim();
    }
    if (!text) return null; // nothing to assess yet

    const scholar = await ctx.db.get(d.scholarId);
    return {
      scholarId: d.scholarId,
      sessionId: d.sessionId,
      assignmentId: d.assignmentId ?? null,
      unitId: resolvedUnitId,
      recipe: activity.recipe,
      activityTitle: activity.title,
      readingLevel: scholar?.readingLevel ?? null,
      granules: granules.map((g) => ({ key: g.key, kind: g.kind, text: g.text })),
      assessableText: text.slice(0, 6000),
    };
  },
});

/**
 * Assess one offline deliverable's text against the unit granules and write
 * phase-stamped evidence. Scheduled (not user-facing); a clean no-op when the
 * deliverable isn't assessable.
 */
export const assessArtifact = internalAction({
  args: { deliverableId: v.id("deliverables") },
  handler: async (ctx, { deliverableId }) => {
    const bundle = await ctx.runQuery(
      internal.granuleAssessment.getArtifactAssessContext,
      { deliverableId },
    );
    if (!bundle) return;
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: bundle.scholarId, principal: "scholar" },
    );

    const granuleList = bundle.granules
      .map((g) => `- [${g.key}] (${g.kind.toUpperCase()}) ${g.text}`)
      .join("\n");
    const readingLine = bundle.readingLevel
      ? `Scholar reading level: ${bundle.readingLevel}. Judge understanding, not spelling/handwriting — calibrate expectations to this level.`
      : null;
    const userMessage = [
      `Activity: ${bundle.activityTitle} (${bundle.recipe === "baseline" ? "BASELINE — start of unit; expect partial, pre-teaching thinking" : "EXIT TICKET — end of unit; look for grown understanding"})`,
      readingLine,
      `Unit Granules (attribute the artifact to these — keys are exact):`,
      granuleList,
      "",
      "── The scholar's written work ──",
      bundle.assessableText,
    ]
      .filter((s): s is string => s !== null)
      .join("\n");

    let attributions: ArtifactAttribution[] = [];
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 2048,
        system: ARTIFACT_GRANULE_SYSTEM_PROMPT,
        tools: [ARTIFACT_GRANULE_TOOL],
        tool_choice: { type: "tool", name: "report_granule_assessment" },
        messages: [{ role: "user", content: userMessage }],
      });
      await recordAnthropicUsage(ctx, {
        source: "granule-assess",
        role: ROLES.SCHOLAR,
        model: MODELS.SONNET,
        usage: response.usage,
        institutionId,
      });
      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (toolBlock && toolBlock.type === "tool_use") {
        const raw = toolBlock.input as { attributions?: ArtifactAttribution[] };
        attributions = Array.isArray(raw.attributions) ? raw.attributions : [];
      }
    } catch (err) {
      console.error("[granuleAssessment] Anthropic call failed:", err);
      return; // leave prior evidence intact on a transient failure
    }

    await ctx.runMutation(internal.granuleAssessment.applyArtifactAssessment, {
      deliverableId,
      attributions,
    });
  },
});

/**
 * Persist the assessor's attributions as `granuleEvidence`. Idempotent per
 * offline project: clears this project's prior artifact-sourced evidence
 * first, so a re-submit/re-OCR replaces rather than piles up. (An offline
 * project is scoped to one (scholar, activity, assignment), so by_project is
 * the right blast radius — it never touches conversation-sourced rows from a
 * different session.)
 */
export const applyArtifactAssessment = internalMutation({
  args: {
    deliverableId: v.id("deliverables"),
    attributions: v.array(
      v.object({
        granuleKey: v.string(),
        outcome: v.union(v.literal("demonstrated"), v.literal("probed")),
        evidenceSummary: v.string(),
        transcriptExcerpt: v.string(),
        bloomLevel: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { deliverableId, attributions }) => {
    const d = await ctx.db.get(deliverableId);
    if (!d) return;
    const activity = await ctx.db.get(d.activityId);
    if (!activity?.recipe) return;
    // OFFLINE only — the by_project replace below is safe only for offline
    // projects (one artifact, no conversation evidence). Never run it against
    // an online session, which accumulates the observer's granule rows.
    if (activity.kind !== "offline") return;
    const session = await ctx.db.get(d.sessionId as Id<"sessions">);
    const unitId = await resolveUnitId(ctx, session, activity);
    if (!unitId) return;
    const unit = await ctx.db.get(unitId);
    if (!unit) return;
    const validKeys = new Set(unitGranules(unit).map((g) => g.key));
    const phase = activity.recipe === "baseline" ? ("baseline" as const) : ("exit" as const);

    // Idempotent replace: drop this offline project's prior artifact rows
    // (offline project = one artifact, so by_project is the right scope).
    const prior = await ctx.db
      .query("granuleEvidence")
      .withIndex("by_session", (q) => q.eq("sessionId", d.sessionId))
      .collect();
    for (const e of prior) await ctx.db.delete(e._id);

    let written = 0;
    for (const attr of attributions) {
      if (!validKeys.has(attr.granuleKey)) {
        console.error(
          `[granuleAssessment] ⚠️ Dropping attribution with unknown granuleKey "${attr.granuleKey}"`,
        );
        continue;
      }
      await ctx.runMutation(internal.granuleEvidence.record, {
        scholarId: d.scholarId,
        unitId,
        granuleKey: attr.granuleKey,
        assignmentId: d.assignmentId ?? undefined,
        sessionId: d.sessionId as Id<"sessions">,
        outcome: attr.outcome,
        transcriptExcerpt: attr.transcriptExcerpt || "",
        evidenceSummary: attr.evidenceSummary || "",
        bloomLevel: attr.bloomLevel ?? undefined,
        phase,
      });
      written++;
    }
    console.log(
      `[granuleAssessment] ${written} artifact attributions written (phase: ${phase})`,
    );
  },
});

/**
 * Schedule an assessment if this deliverable's activity carries a recipe.
 * Shared by the scholar-submit and teacher-portfolio trigger sites. Gates on
 * the recipe here so ordinary (non-recipe) deliverables don't spawn no-op jobs.
 */
export async function maybeScheduleArtifactAssessment(
  ctx: MutationCtx,
  deliverableId: Id<"deliverables">,
): Promise<void> {
  const d = await ctx.db.get(deliverableId);
  if (!d) return;
  const activity = await ctx.db.get(d.activityId);
  if (!activity?.recipe) return; // only baseline/exitTicket activities
  // OFFLINE only — online recipe activities are assessed by the conversation
  // observer; see getArtifactAssessContext / applyArtifactAssessment.
  if (activity.kind !== "offline") return;
  await ctx.scheduler.runAfter(0, internal.granuleAssessment.assessArtifact, {
    deliverableId,
  });
}
