/**
 * Durable capture of practice "Talk it through" handoff transcripts so they can
 * be judged retrospectively by the weekly Quality Pulse — the agreed safety net
 * for "is the handoff tutor giving answers away too readily?" now that the
 * runtime answer-leak backstop is gone (fade is enforced in ONE place, the
 * practice grading engine; the handoff chat writes no mastery). See the
 * handoffTranscripts + qualityPulseSamples table comments in convex/schema.ts
 * and the module header in convex/lib/practice/handoff.ts.
 *
 * `recordHandoffTranscript` is the write half: the `/practice-handoff` route
 * (convex/http.ts) calls it after each assistant reply with the full running
 * transcript, keyed by a server-derived `dedupKey` (handoffDedupKey), so the
 * growing chat is UPSERTED into ONE row across turns — no client change, no
 * duplicate rows. It stores NO scholar identity (privacy: the route binds no
 * scholarId; only the hash is stored, never the userId).
 *
 * v1 limitation (by design): a handoff that is abandoned partway is still
 * captured up to its last completed turn precisely BECAUSE we upsert on every
 * turn rather than only on a terminal one — so even a fully-abandoned chat has a
 * row to judge.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const transcriptValidator = v.array(
  v.object({
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  }),
);

/**
 * Upsert a handoff transcript keyed by its server-derived `dedupKey`. On the
 * first turn it inserts (stamping `createdAt`); on later turns it patches the
 * SAME row with the grown transcript + turn count, leaving `createdAt` stable so
 * the judge sampler's creation-time window still sees the whole chat under one
 * timestamp. `turns` is the number of assistant messages captured so far.
 */
export const recordHandoffTranscript = internalMutation({
  args: {
    dedupKey: v.string(),
    itemId: v.string(),
    skillKey: v.string(),
    stem: v.string(),
    wrongAnswers: v.array(v.string()),
    promptVersion: v.string(),
    transcript: transcriptValidator,
  },
  handler: async (ctx, args): Promise<{ handoffId: string; inserted: boolean }> => {
    const turns = args.transcript.filter((m) => m.role === "assistant").length;

    const existing = await ctx.db
      .query("handoffTranscripts")
      .withIndex("by_dedupKey", (q) => q.eq("dedupKey", args.dedupKey))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        // Refresh the derived fields (stem/skillKey/wrongAnswers/promptVersion
        // can only be identical for the same key, but patch keeps them in sync
        // if the prompt version was bumped mid-flight) and the grown transcript.
        itemId: args.itemId,
        skillKey: args.skillKey,
        stem: args.stem,
        wrongAnswers: args.wrongAnswers,
        promptVersion: args.promptVersion,
        transcript: args.transcript,
        turns,
      });
      return { handoffId: existing._id, inserted: false };
    }

    const handoffId = await ctx.db.insert("handoffTranscripts", {
      dedupKey: args.dedupKey,
      itemId: args.itemId,
      skillKey: args.skillKey,
      stem: args.stem,
      wrongAnswers: args.wrongAnswers,
      promptVersion: args.promptVersion,
      transcript: args.transcript,
      turns,
      createdAt: Date.now(),
    });
    return { handoffId, inserted: true };
  },
});
