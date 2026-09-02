/**
 * Stretch DIALOGUE backend — the ctx-bound half of the rubric'd-chat stretch
 * vessel (pure prompts/judge/verdict logic in lib/practice/dialogueStretch.ts;
 * the HTTP surface in http.ts → /practice-dialogue).
 *
 * Internal functions reached only through the endpoint:
 *   • `dialogueContext` — resolve a "gen#<id>" dialogue item server-side.
 *     Returns the stem/technique for the tutor prompt AND the rubric for the
 *     judge — which is exactly why it must stay internal: rubricCriteria never
 *     crosses the client wire (same discipline as answerCanonical).
 *   • transcript start/read/append — maintain the server-held turn log that is
 *     the only evidence the judge may consume;
 *   • `recordDialogueOutcome` — persist a judged dialogue: always one
 *     practiceAttempts row (lane "stretch", correct = passed); on a PASS, one
 *     depth observation (evidenceType "stretch_dialogue" — model-judged, so
 *     stamped at lower confidence than the verifier-graded stretch_success and
 *     kept distinct in the record). Never touches practiceMastery: a dialogue
 *     demonstrates DEPTH, not retrieval fluency, and a non-pass costs nothing —
 *     the same no-penalty rule as every stretch miss.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  dialogueEvidenceExcerpt,
  DIALOGUE_OPENER,
  DIALOGUE_PROMPT_VERSION,
  DIALOGUE_JUDGE_CONFIDENCE,
  STRETCH_DIALOGUE_EVIDENCE_TYPE,
} from "./lib/practice/dialogueStretch";
import { STRETCH_DEFAULT_BLOOM, STRETCH_EVIDENCE_TYPES } from "./practiceSkills";

/** Resolve a served "gen#<id>" itemId to its dialogue row, or null when the id
 *  isn't a stored DIALOGUE stretch item (the endpoint 400s on null). */
export const dialogueContext = internalQuery({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    if (!args.itemId.startsWith("gen#")) return null;
    const row = await ctx.db.get(args.itemId.slice(4) as Doc<"practiceItems">["_id"]);
    if (!row || row.tier !== "stretch" || row.answerType !== "dialogue") return null;
    const rubricCriteria = row.rubricCriteria ?? [];
    if (rubricCriteria.length === 0) return null; // ungradeable — never serve-able as a dialogue
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", row.skillKey))
      .first();
    return {
      skillKey: row.skillKey,
      skillLabel: node?.label ?? row.skillKey,
      domain: row.domain,
      stem: row.stem,
      technique: row.technique,
      bloomLevel: row.bloomLevel,
      rubricCriteria,
    };
  },
});

const dialogueMessageValidator = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
});

type DialogueMessage = {
  role: "user" | "assistant";
  content: string;
};

export const startDialogueTranscript = internalMutation({
  args: {
    dedupKey: v.string(),
    itemId: v.string(),
    skillKey: v.string(),
    stem: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const collision = await ctx.db
      .query("tutorTranscripts")
      .withIndex("by_dedupKey", (q) => q.eq("dedupKey", args.dedupKey))
      .first();
    if (collision) throw new Error("Dialogue session key collision");
    await ctx.db.insert("tutorTranscripts", {
      surface: "stretchDialogue",
      anchor: {
        kind: "stretchDialogue",
        itemId: args.itemId,
        skillKey: args.skillKey,
        stem: args.stem,
      },
      dedupKey: args.dedupKey,
      promptVersion: DIALOGUE_PROMPT_VERSION,
      transcript: [{ role: "assistant", content: DIALOGUE_OPENER }],
      turns: 1,
      createdAt: Date.now(),
    });
  },
});

export const dialogueTranscript = internalQuery({
  args: { dedupKey: v.string(), itemId: v.string() },
  handler: async (ctx, args): Promise<{ transcript: DialogueMessage[] } | null> => {
    const row = await ctx.db
      .query("tutorTranscripts")
      .withIndex("by_dedupKey", (q) => q.eq("dedupKey", args.dedupKey))
      .first();
    if (
      !row ||
      row.surface !== "stretchDialogue" ||
      row.anchor.kind !== "stretchDialogue" ||
      row.anchor.itemId !== args.itemId ||
      row.completedAt !== undefined
    ) {
      return null;
    }
    return { transcript: row.transcript };
  },
});

export const appendDialogueTurn = internalMutation({
  args: {
    dedupKey: v.string(),
    itemId: v.string(),
    turn: dialogueMessageValidator,
  },
  handler: async (ctx, args): Promise<{ transcript: DialogueMessage[] }> => {
    const row = await ctx.db
      .query("tutorTranscripts")
      .withIndex("by_dedupKey", (q) => q.eq("dedupKey", args.dedupKey))
      .first();
    if (
      !row ||
      row.surface !== "stretchDialogue" ||
      row.anchor.kind !== "stretchDialogue" ||
      row.anchor.itemId !== args.itemId ||
      row.completedAt !== undefined
    ) {
      throw new Error("Dialogue session is not active");
    }

    const last = row.transcript[row.transcript.length - 1];
    if (args.turn.role === "user") {
      if (last?.role === "user" && last.content === args.turn.content) {
        return { transcript: row.transcript };
      }
      if (last?.role !== "assistant") {
        throw new Error("Dialogue is waiting for the tutor");
      }
    } else if (last?.role !== "user") {
      throw new Error("Dialogue is waiting for the scholar");
    }

    const transcript = [...row.transcript, args.turn];
    await ctx.db.patch(row._id, {
      transcript,
      turns: transcript.filter((message) => message.role === "assistant").length,
    });
    return { transcript };
  },
});

export const completeDialogueTranscript = internalMutation({
  args: { dedupKey: v.string(), itemId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query("tutorTranscripts")
      .withIndex("by_dedupKey", (q) => q.eq("dedupKey", args.dedupKey))
      .first();
    if (
      !row ||
      row.surface !== "stretchDialogue" ||
      row.anchor.kind !== "stretchDialogue" ||
      row.anchor.itemId !== args.itemId ||
      row.completedAt !== undefined
    ) {
      throw new Error("Dialogue session is not active");
    }
    await ctx.db.patch(row._id, { completedAt: Date.now() });
  },
});

export const recordDialogueOutcome = internalMutation({
  args: {
    dedupKey: v.string(),
    scholarId: v.id("users"),
    itemId: v.string(),
    skillKey: v.string(),
    skillLabel: v.string(),
    domain: v.string(),
    bloomLevel: v.optional(v.number()),
    technique: v.optional(v.string()),
    passed: v.boolean(),
    metCount: v.number(),
    total: v.number(),
    note: v.string(),
    bestQuote: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const transcriptRow = await ctx.db
      .query("tutorTranscripts")
      .withIndex("by_dedupKey", (q) => q.eq("dedupKey", args.dedupKey))
      .first();
    if (
      !transcriptRow ||
      transcriptRow.surface !== "stretchDialogue" ||
      transcriptRow.anchor.kind !== "stretchDialogue" ||
      transcriptRow.anchor.itemId !== args.itemId ||
      transcriptRow.completedAt !== undefined
    ) {
      throw new Error("Dialogue session is not active");
    }
    const excerpt = dialogueEvidenceExcerpt(args.bestQuote, transcriptRow.transcript);
    if (!excerpt) throw new Error("Dialogue has no scholar evidence");
    await ctx.db.patch(transcriptRow._id, { completedAt: now });

    const masteryRow = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", args.scholarId).eq("skillKey", args.skillKey),
      )
      .first();
    // Deliberately no `stemSnapshot`/`expectedAnswer` here: a stretch dialogue
    // is a rubric-judged Socratic conversation, not a graded item+answer pair
    // — there's no discrete stem to snapshot. The teacher-only "recent misses"
    // read model naturally omits any row with nothing renderable, so this
    // needs no special-casing on the read side either.
    await ctx.db.insert("practiceAttempts", {
      scholarId: args.scholarId,
      nodeKey: args.skillKey,
      itemId: args.itemId,
      correct: args.passed,
      domain: args.domain,
      ...(masteryRow?.strand ? { strand: masteryRow.strand } : {}),
      lane: "stretch",
      breakerEligible: false,
      repetitionBefore: masteryRow?.repetition ?? 0,
      source: masteryRow?.source ?? "practice",
      createdAt: now,
    });
    if (!args.passed) return { recorded: true, observationWritten: false };

    // One current stretch depth claim per node at ≥ this level is enough,
    // across BOTH stretch evidence kinds (verifier-graded + model-judged).
    const level = args.bloomLevel ?? STRETCH_DEFAULT_BLOOM;
    const current = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_node", (q) =>
        q.eq("scholarId", args.scholarId).eq("nodeKey", args.skillKey),
      )
      .filter((q) => q.eq(q.field("isSuperseded"), false))
      .collect();
    const already = current.some(
      (o) => STRETCH_EVIDENCE_TYPES.has(o.evidenceType) && o.masteryLevel >= level,
    );
    if (already) return { recorded: true, observationWritten: false };

    await ctx.db.insert("masteryObservations", {
      scholarId: args.scholarId,
      conceptLabel: args.skillLabel,
      domain: args.domain,
      nodeKey: args.skillKey,
      observedAt: now,
      // The scholar's own best line IS the evidence — fall back to the task.
      transcriptExcerpt: excerpt,
      masteryLevel: level,
      confidenceScore: DIALOGUE_JUDGE_CONFIDENCE,
      evidenceSummary: `Articulated the idea behind a stretch (insight) dialogue challenge${
        args.technique ? ` — technique: ${args.technique.replace(/_/g, " ")}` : ""
      } (rubric: ${args.metCount}/${args.total} criteria, model-judged). ${args.note}`.slice(
        0,
        900,
      ),
      evidenceType: STRETCH_DIALOGUE_EVIDENCE_TYPE,
      attemptContext: "practice",
      studentInitiated: true,
      isSuperseded: false,
    });
    return { recorded: true, observationWritten: true };
  },
});
