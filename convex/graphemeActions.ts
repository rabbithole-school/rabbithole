"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import {
  GRAPHEME_SYSTEM_PROMPT,
  GRAPHEME_TOOL,
  buildAnnotationUserMessage,
  findCandidates,
  parseGraphemeToolResponse,
  annotateFromToolResult,
  normalizeTeams,
  type GraphemeSpan,
} from "./lib/graphemeAnnotate";

/**
 * Reading-ramp grapheme annotator (see `review/young-learners-plan.html` §10 and
 * the contract in `convex/lib/graphemeAnnotate.ts`).
 *
 * ONE Haiku call annotates a piece of tutor text with the grapheme-team spans a
 * given scholar is currently training. English grapheme→phoneme mapping is
 * context-dependent ("ch" = /tʃ/ chair vs /k/ school; "sh" in *mishap* is a
 * syllable boundary), so this is a cheap-model judgment pass, not a rule engine.
 *
 * Presentation-layer ONLY: it sees nothing but the tutor's own outbound text and
 * the team inventory — no scholar data, nothing enters the governed memory model.
 * It never alters the text: offsets are computed locally in
 * `graphemeAnnotate.ts` from the source string; the model only picks which
 * pre-enumerated candidate occurrences are true.
 *
 * NOT wired to the session stream yet (deliberately deferred — the session UI is
 * being rewritten in PR #400). This is the annotator + its eval, nothing else.
 *
 * Internal for now (no caller). Marked internalAction so we don't expose an
 * unused public API surface; flip to a public `action` when the render layer wires it up.
 */
export const annotate = internalAction({
  args: {
    text: v.string(),
    // The scholar's live grapheme-team inventory, e.g. ["sh","th","ea"].
    teams: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ spans: GraphemeSpan[] }> => {
    const teams = normalizeTeams(args.teams);

    // Empty inventory → nothing to annotate; do NOT spend a model call.
    if (teams.length === 0) return { spans: [] };

    // Enumerate every literal occurrence of an inventory team. If none of the
    // trained teams' letters appear in the text, there is nothing to judge —
    // short-circuit before the model call too.
    const candidates = findCandidates(args.text, teams);
    if (candidates.length === 0) return { spans: [] };

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();

    try {
      const response = await anthropic.messages.create({
        model: MODELS.HAIKU,
        // Small: the model returns only a short id list.
        max_tokens: 1024,
        // Deterministic-ish: this is a classification, not generation.
        temperature: 0,
        system: [
          {
            type: "text",
            text: GRAPHEME_SYSTEM_PROMPT,
            // The system block + tool schema are identical every call; cache the
            // static prefix so only the per-message text/candidates are re-billed.
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [GRAPHEME_TOOL],
        tool_choice: { type: "tool", name: GRAPHEME_TOOL.name },
        messages: [
          {
            role: "user",
            content: buildAnnotationUserMessage(args.text, candidates),
          },
        ],
      });

      await recordAnthropicUsage(ctx, {
        source: "grapheme",
        role: ROLES.SCHOLAR,
        model: MODELS.HAIKU,
        usage: response.usage,
      });
      const trueIds = parseGraphemeToolResponse(response.content);
      if (trueIds === null) {
        // No tool block — annotate nothing rather than guessing.
        return { spans: [] };
      }

      // Offsets are computed locally + hard-validated (letters must match the
      // team, overlaps dropped) — the text is never altered.
      const spans = annotateFromToolResult(args.text, candidates, trueIds);
      return { spans };
    } catch (err: unknown) {
      // The ramp is a nice-to-have overlay; a failed annotation must never break
      // the tutor turn. Degrade to no coloring.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GraphemeAnnotate] FAILED (non-fatal): ${message}`);
      return { spans: [] };
    }
  },
});

/**
 * Longest tutor turn we'll annotate. A normal K turn is a sentence or two; a
 * multi-KB blob is a runaway/pathological message not worth a Haiku call, and
 * candidate enumeration over it would be wasteful. Skip + log past this.
 */
const MAX_ANNOTATE_CHARS = 2000;

/**
 * Post-stream annotate-and-store — the production entry point wired from
 * `sessionHelpers.finalizeStream` (scheduled fire-and-forget alongside the
 * observer, but ALSO on test drives — spans are message-local presentation
 * data, not a scholar record). Given a finalized assistant message and the
 * scholar's active (non-graduated) teams, it:
 *   1. re-reads the message and SKIPS if it's gone, already annotated
 *      (idempotency — a stored `graphemeSpans`, even `[]`, is the guard), empty,
 *      or absurdly long;
 *   2. calls the existing `annotate` pass (which owns candidate enumeration,
 *      the Haiku call, and hard span validation) with ONLY those active teams;
 *   3. writes the validated spans back via `storeGraphemeSpans` (itself
 *      idempotent, closing the race window). Empty spans is a valid result and
 *      is stored, so the guard holds on any re-run.
 * Fully self-contained: any failure logs and drops — it never affects the turn.
 */
export const annotateAndStore = internalAction({
  args: {
    messageId: v.id("messages"),
    // The scholar's active (non-graduated) teams — the ONLY teams to color.
    teams: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const snapshot = await ctx.runQuery(
        internal.sessionHelpers.getMessageForGraphemeAnnotation,
        { messageId: args.messageId },
      );
      // Message was deleted between finalize and this run → nothing to do.
      if (!snapshot) return;
      // Idempotency: a prior run already wrote spans (possibly []). Don't re-spend.
      if (snapshot.alreadyAnnotated) {
        console.log(
          `[GraphemeAnnotate] skip — message ${args.messageId} already annotated`,
        );
        return;
      }
      const text = snapshot.content;
      if (!text.trim()) return; // nothing to annotate
      if (text.length > MAX_ANNOTATE_CHARS) {
        console.log(
          `[GraphemeAnnotate] skip — message ${args.messageId} too long (${text.length} chars)`,
        );
        return;
      }

      // Reuse the existing annotator end-to-end: it short-circuits an empty
      // team list, enumerates candidates, runs Haiku, and hard-validates the
      // spans (letters must match the team, overlaps dropped) — one shared path.
      const { spans } = await ctx.runAction(internal.graphemeActions.annotate, {
        text,
        teams: args.teams,
      });

      // Store even [] — it's a valid "nothing to color" result AND arms the
      // idempotency guard so this message is never re-annotated.
      await ctx.runMutation(internal.sessionHelpers.storeGraphemeSpans, {
        messageId: args.messageId,
        spans,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[GraphemeAnnotate] annotateAndStore FAILED (non-fatal): ${message}`,
      );
    }
  },
});
