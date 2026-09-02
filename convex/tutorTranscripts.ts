/**
 * Shared durable capture for short-form tutor conversations that are judged
 * retrospectively but do not belong to a full learning session.
 *
 * `/story-open` is the first writer. Its growing conversation is UPSERTED after
 * each assistant reply through `recordTutorTranscript`, keyed by a
 * server-derived `dedupKey`, so an abandoned conversation is still available up
 * to its last completed turn. The `handoff` surface and anchor are reserved for
 * a separate follow-up migration of `handoffTranscripts`; stretchDialogue uses
 * the same table for its server-grounded grading log. Future short-form tutor
 * surfaces should extend this shared surface + anchor union rather than add
 * sibling tables.
 *
 * REDACTION: rows store NO scholarId by design. A caller may use scholar identity
 * at its authorization boundary, but the mutation receives only the anonymous
 * dedup hash, surface-specific curriculum/problem anchor, prompt version, and
 * transcript. The source user id is never persisted.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const tutorSurfaceValidator = v.union(v.literal("storyOpen"), v.literal("handoff"), v.literal("stretchDialogue"));

const tutorAnchorValidator = v.union(
  v.object({
    kind: v.literal("storyOpen"),
    fromKey: v.string(),
    toKey: v.string(),
    hook: v.string(),
  }),
  v.object({
    // Reserved for the follow-up migration of handoffTranscripts.
    kind: v.literal("handoff"),
    itemId: v.string(),
    skillKey: v.string(),
    stem: v.string(),
    wrongAnswers: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("stretchDialogue"),
    itemId: v.string(),
    skillKey: v.string(),
    stem: v.string(),
  }),
);

const transcriptValidator = v.array(
  v.object({
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  }),
);

/**
 * Upsert one short-form tutor transcript by its server-derived dedup key.
 * `createdAt` stays stable while the transcript and assistant-turn count grow,
 * preserving the judge's original creation-time window.
 */
export const recordTutorTranscript = internalMutation({
  args: {
    surface: tutorSurfaceValidator,
    anchor: tutorAnchorValidator,
    dedupKey: v.string(),
    promptVersion: v.string(),
    transcript: transcriptValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tutorTranscriptId: string; inserted: boolean }> => {
    if (args.surface !== args.anchor.kind) {
      throw new Error("Tutor transcript surface must match its anchor");
    }

    const turns = args.transcript.filter((message) => message.role === "assistant").length;
    const existing = await ctx.db
      .query("tutorTranscripts")
      .withIndex("by_dedupKey", (query) => query.eq("dedupKey", args.dedupKey))
      .first();

    if (existing) {
      if (existing.surface !== args.surface) {
        throw new Error("Tutor transcript dedup key already belongs to another surface");
      }
      await ctx.db.patch(existing._id, {
        surface: args.surface,
        anchor: args.anchor,
        promptVersion: args.promptVersion,
        transcript: args.transcript,
        turns,
      });
      return { tutorTranscriptId: existing._id, inserted: false };
    }

    const tutorTranscriptId = await ctx.db.insert("tutorTranscripts", {
      surface: args.surface,
      anchor: args.anchor,
      dedupKey: args.dedupKey,
      promptVersion: args.promptVersion,
      transcript: args.transcript,
      turns,
      createdAt: Date.now(),
    });
    return { tutorTranscriptId, inserted: true };
  },
});
