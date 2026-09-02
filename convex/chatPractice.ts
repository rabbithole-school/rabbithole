/**
 * Problems-in-chat (⑮ / roadmap §8 Pattern 3) — the Convex wiring.
 *
 * `serveChatPracticeItem` is the internal mutation the tutor's
 * serve_practice_problem tool calls from the /project-stream handler. It:
 *   1. resolves the tutor's free-text `skill` to a concrete servable skillKey,
 *      preferring the scholar's own frontier / due / fluent skills (so the item
 *      fits where they are), falling back to the whole servable domain;
 *   2. resolves a template, verified word item, or curated manipulative
 *      server-side (never the answer/verifier);
 *   3. finalizes the current assistant bubble, inserts a `role: "tool"` message
 *      carrying the item in its `chatPractice` field (so the client renders the
 *      inline widget), and opens a fresh assistant placeholder for the tutor's
 *      follow-up — the same split dance the other tutor tools use.
 *
 * Grading reuses `practiceSkills.submitAnswer` unchanged (called directly from
 * the widget): the answer is re-derived from the opaque itemId and recorded
 * through the normal spaced-repetition path, so a chat item COUNTS toward
 * mastery, and the correct answer is only ever echoed back on a CORRECT
 * submission (the anti-offloading rule preserved from ⑫).
 *
 * Pure logic lives in convex/lib/practice/chatPractice.ts (shared with the
 * eval harness). This file is the thin auth/persistence layer.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  CHAT_PRACTICE_NO_ITEM_REASON,
  CHAT_PRACTICE_NO_MATCH_REASON,
  CHAT_PRACTICE_WITHHOLD_REASON,
  hasChatPracticeItem,
  hasExplicitPracticeWithholdSignal,
  resolveChatPracticeSkill,
  serveChatItem,
  storyThreadChatPayload,
  type ChatPracticeCandidate,
  type ChatPracticeServe,
} from "./lib/practice/chatPractice";
import { eligibleStoryApplication } from "./lib/practice/applicationEligibility";
import { isDue, isFluent } from "./lib/practice/scheduler";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "./seed/wholeNumberArithmeticGraph";
import { parseManipulativeSpec } from "../lib/manipulative/grade";
import {
  isRetiredManipulativeSpecId,
  MANIPULATIVE_VERIFIER_KIND,
} from "../lib/manipulative/practiceContract";

/** A small, dependency-free seed derived from the item context. Date.now() is
 *  deterministic-safe in a Convex mutation; hashing the skillKey in de-correlates
 *  two items served in the same millisecond for different skills. */
function itemSeed(skillKey: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < skillKey.length; i++) {
    h ^= skillKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Date.now() ^ h) >>> 0;
}

/**
 * Build the scholar's candidate skills for resolution, in priority order:
 * frontier (currently working on) → due (revisiting) → fluent → any other
 * mastered node — all filtered to skills with any servable item. Falls back to
 * the whole servable domain when the scholar has no mastery rows yet, so the tutor can
 * still serve a sensible item on a fresh account.
 */
async function loadCandidates(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  targetSkillKeys?: string[],
): Promise<ChatPracticeCandidate[]> {
  const allowedSkillKeys = targetSkillKeys
    ? new Set(targetSkillKeys)
    : null;
  const nodes = (await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .collect()).filter(
    (node) => !allowedSkillKeys || allowedSkillKeys.has(node.nodeKey),
  );
  const labelByKey = new Map(nodes.map((n) => [n.nodeKey, n.label]));
  const stored = await ctx.db
    .query("practiceItems")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .collect();
  const storedByKey = new Map<string, typeof stored>();
  for (const item of stored) {
    if (item.verifierKind === MANIPULATIVE_VERIFIER_KIND) {
      const spec = parseManipulativeSpec(item.manipulativeSpec);
      if (spec && isRetiredManipulativeSpecId(spec.id)) continue;
    }
    const rows = storedByKey.get(item.skillKey) ?? [];
    rows.push(item);
    storedByKey.set(item.skillKey, rows);
  }

  const mastery = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar_domain", (q) =>
      q.eq("scholarId", scholarId).eq("domain", domain),
    )
    .collect();

  const now = Date.now();
  const masteryByKey = new Map(mastery.map((row) => [row.skillKey, row]));
  const seen = new Set<string>();
  const ordered: ChatPracticeCandidate[] = [];
  const push = (key: string) => {
    if (seen.has(key)) return;
    const label = labelByKey.get(key);
    if (!label) return;
    const candidate: ChatPracticeCandidate = {
      skillKey: key,
      label,
      domain,
      isFluent: !!masteryByKey.get(key) && isFluent(masteryByKey.get(key)!),
      storedItems: storedByKey.get(key) ?? [],
    };
    if (!hasChatPracticeItem(candidate)) return;
    seen.add(key);
    ordered.push(candidate);
  };

  for (const m of mastery) if (m.frontier) push(m.skillKey);
  for (const m of mastery)
    if (
      isDue(
        { repetition: m.repetition, halfLifeDays: m.halfLifeDays, lastPracticedAt: m.lastPracticedAt },
        now,
      )
    )
      push(m.skillKey);
  for (const m of mastery) if (isFluent(m)) push(m.skillKey);
  for (const m of mastery) push(m.skillKey);

  // Fallback: no usable mastery-scoped candidates → offer the whole servable
  // domain so resolution still works on a fresh scholar.
  if (ordered.length === 0) {
    for (const n of nodes) push(n.nodeKey);
  }
  return ordered;
}

async function persistChatPracticeMessage(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    currentMessageId: Id<"messages">;
    contentSoFar: string;
  },
  served: ChatPracticeServe,
  label: string,
): Promise<Id<"messages">> {
  const currentMsg = await ctx.db.get(args.currentMessageId);
  const dims = {
    personaId: currentMsg?.personaId,
    unitId: currentMsg?.unitId,
    perspectiveId: currentMsg?.perspectiveId,
    processId: currentMsg?.processId,
    promptVersion: currentMsg?.promptVersion,
  };
  if (!args.contentSoFar.trim()) {
    await ctx.db.delete(args.currentMessageId);
  } else {
    await ctx.db.patch(args.currentMessageId, {
      content: args.contentSoFar,
      streamId: undefined,
    });
  }

  await ctx.db.insert("messages", {
    sessionId: args.sessionId,
    role: "tool",
    content: "",
    toolAction: `Practice: ${label}`,
    ...dims,
    flagged: false,
    chatPractice: served,
  });

  return await ctx.db.insert("messages", {
    sessionId: args.sessionId,
    role: "assistant",
    content: "",
    ...dims,
    flagged: false,
    lastStreamActivityAt: Date.now(),
  });
}

export const serveChatPracticeItem = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    currentMessageId: v.id("messages"),
    contentSoFar: v.string(),
    skill: v.string(),
    domain: v.optional(v.string()),
    // When called from a problem-set activity, this is the activity's authored
    // allowlist. An empty or stale list deliberately serves nothing.
    targetSkillKeys: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;

    // Activity-scoped quests are allowed to serve only when the scholar is
    // ready to practice. Ordinary inline practice keeps its existing behavior.
    if (args.targetSkillKeys !== undefined) {
      const latestScholarMessage = (
        await ctx.db
          .query("messages")
          .withIndex("by_session_role", (q) =>
            q.eq("sessionId", args.sessionId).eq("role", "user"),
          )
          .order("desc")
          .first()
      )?.content ?? "";
      if (hasExplicitPracticeWithholdSignal(latestScholarMessage)) {
        return { ok: false as const, reason: CHAT_PRACTICE_WITHHOLD_REASON };
      }
    }

    const candidates = await loadCandidates(
      ctx,
      args.scholarId,
      domain,
      args.targetSkillKeys,
    );
    const skillKey = resolveChatPracticeSkill(args.skill, candidates);
    if (!skillKey) {
      return {
        ok: false as const,
        reason: CHAT_PRACTICE_NO_MATCH_REASON,
      };
    }

    const candidate = candidates.find((c) => c.skillKey === skillKey);
    const served = candidate
      ? serveChatItem(candidate, itemSeed(skillKey), args.skill)
      : null;
    if (!served) {
      return { ok: false as const, reason: CHAT_PRACTICE_NO_ITEM_REASON };
    }

    const label = candidate?.label ?? skillKey;
    const servedStem =
      served.kind === "typed"
        ? served.stem
        : candidate?.storedItems.find(
            (item) => `gen#${item._id}` === served.itemId,
          )?.stem ?? label;

    const newMessageId = await persistChatPracticeMessage(
      ctx,
      args,
      served,
      label,
    );

    return {
      ok: true as const,
      newMessageId,
      skillLabel: label,
      stem: servedStem,
    };
  },
});

/**
 * Serve only the application attached to this session's canonical story edge.
 * Unlike ordinary chat practice, no caller-supplied scholar, skill, or item can
 * influence selection.
 */
export const serveStoryThreadApplicationItem = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    currentMessageId: v.id("messages"),
    contentSoFar: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session?.seedId) {
      return { ok: false as const, reason: "This is not a story-thread session." };
    }
    const seed = await ctx.db.get(session.seedId);
    if (
      !seed ||
      seed.scholarId !== session.userId ||
      seed.origin !== "story" ||
      !seed.storyFromKey ||
      !seed.storyToKey
    ) {
      return { ok: false as const, reason: "This is not a story-thread session." };
    }

    const eligible = await eligibleStoryApplication(
      ctx,
      session.userId,
      seed.storyFromKey,
      seed.storyToKey,
    );
    if (!eligible || eligible.items.length === 0) {
      return {
        ok: false as const,
        reason: "This story's application problem is not available.",
      };
    }

    const item =
      eligible.items[
        itemSeed(`${seed.storyFromKey}:${seed.storyToKey}`) %
          eligible.items.length
      ];
    const served = storyThreadChatPayload(item);
    if (!served) {
      return {
        ok: false as const,
        reason: "This story's application problem cannot be shown in chat.",
      };
    }

    const newMessageId = await persistChatPracticeMessage(
      ctx,
      args,
      served,
      item.skillLabel,
    );
    return {
      ok: true as const,
      newMessageId,
      skillLabel: item.skillLabel,
      stem: item.prompt.stem,
    };
  },
});
