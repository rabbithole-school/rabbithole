import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { raiseAlert } from "./alerts";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { siteUrl, scholarPath, scholarSlug, withBase } from "./lib/channels";
import { MODELS } from "./lib/models";
import { ROLES } from "./lib/roles";
import { PATTERN_PHRASING } from "./lib/practice/errorFlags";
import type { ErrorPattern } from "./lib/practice/errorPatterns";
import {
  isBreakerCountedAttempt,
  SPIRAL_GAP_MS,
  SPIRAL_MISS_THRESHOLD,
} from "./lib/practice/spiralBreaker";
import {
  buildNotYetTaughtAlertBody,
  buildBreakerOutcomeReply,
  buildStuckAlertBody,
  type BreakerTelemetry,
  STUCK_SITTING_SCAN_LIMIT,
  tallyPracticeSitting,
  type PracticeSitting,
  type StuckAlertMiss,
} from "./lib/practice/stuckAlertBody";
import {
  buildPracticeStuckUserMessage,
  normalizePracticeStuckDiagnosis,
  PRACTICE_STUCK_ALERT_SYSTEM,
} from "./lib/practice/stuckAlertPrompt";
import {
  fetchConversationReplies,
  escapeSlackText,
  messageWithDeliveryMetadata,
  postMessage,
  type SlackMessageMetadata,
} from "./lib/slackApi";
import { recordAnthropicUsage } from "./usage";
import { MANIPULATIVE_VERIFIER_KIND } from "../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../lib/manipulative/grade";
import { describeState as describeManipulativeState } from "../lib/manipulative/logic";

const ERROR_EVENT_JOIN_TOLERANCE_MS = 60_000;
const OUTCOME_DELIVERY_EVENT_TYPE = "rabbithole_practice_alert_outcome";
const OUTCOME_CLAIM_LEASE_MS = 15 * 60 * 1000;
const OUTCOME_RETRY_DELAY_MS = 60_000;

type StuckAlertEvidence = {
  misses: StuckAlertMiss[];
  sitting?: PracticeSitting;
  scholarName: string;
  username?: string;
  institutionId?: Id<"institutions">;
  breaker?: BreakerTelemetry;
};

const missValidator = v.object({
  nodeKey: v.string(),
  skillLabel: v.string(),
  stemSnapshot: v.optional(v.string()),
  answerText: v.optional(v.string()),
  expectedAnswer: v.optional(v.string()),
  errorPattern: v.optional(v.string()),
  elapsedMs: v.optional(v.number()),
  teachOutcome: v.optional(
    v.union(v.literal("solved"), v.literal("hint"), v.literal("stuck")),
  ),
  isDontKnow: v.boolean(),
});

const sittingValidator = v.object({
  correct: v.number(),
  total: v.number(),
  startedAt: v.number(),
  bounded: v.boolean(),
});

const evidenceValidator = v.object({
  misses: v.array(missValidator),
  sitting: v.optional(sittingValidator),
  scholarName: v.string(),
  username: v.optional(v.string()),
  institutionId: v.optional(v.id("institutions")),
  breaker: v.optional(
    v.object({
      offer: v.optional(v.union(v.literal("accepted"), v.literal("declined"))),
      recovery: v.optional(
        v.union(
          v.literal("won"),
          v.literal("missed"),
          v.literal("none"),
          v.literal("skipped"),
        ),
      ),
      lifecycle: v.optional(
        v.object({
          version: v.literal(2),
          triggeredAt: v.number(),
          repairShownAt: v.optional(v.number()),
          repairRungKind: v.optional(
            v.union(v.literal("completion"), v.literal("reveal")),
          ),
          repairUnavailableAt: v.optional(v.number()),
          repairStartedAt: v.optional(v.number()),
          repairCompletedAt: v.optional(v.number()),
          coachEscalatedAt: v.optional(v.number()),
          easyExitedAt: v.optional(v.number()),
          stoppedAt: v.optional(v.number()),
          freshResult: v.optional(
            v.object({
              correct: v.boolean(),
              assisted: v.optional(v.boolean()),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const gatherEvidence = internalQuery({
  args: {
    scholarId: v.id("users"),
    attemptIds: v.array(v.id("practiceAttempts")),
  },
  handler: async (ctx, args): Promise<StuckAlertEvidence | null> => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) {
      throw new Error(`Cannot gather stuck-alert evidence for missing scholar ${args.scholarId}`);
    }

    const streakRows: Doc<"practiceAttempts">[] = [];
    for (const attemptId of args.attemptIds) {
      const row = await ctx.db.get(attemptId);
      if (
        row?.scholarId === args.scholarId &&
        !row.correct &&
        !isBreakerCountedAttempt(row)
      ) {
        return null;
      }
      if (
        !row ||
        row.scholarId !== args.scholarId ||
        row.retry === true ||
        row.correct
      ) {
        throw new Error(
          `Pinned stuck-alert attempt ${attemptId} is unavailable or invalid`,
        );
      }
      streakRows.push(row);
    }

    const labels = new Map<string, string>();
    for (const nodeKey of new Set(streakRows.map((row) => row.nodeKey))) {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
        .unique();
      labels.set(nodeKey, node?.label ?? nodeKey);
    }

    const events: Doc<"practiceErrorEvents">[] = [];
    for (const nodeKey of new Set(streakRows.map((row) => row.nodeKey))) {
      events.push(
        ...(await ctx.db
          .query("practiceErrorEvents")
          .withIndex("by_scholar_node", (q) =>
            q.eq("scholarId", args.scholarId).eq("nodeKey", nodeKey),
          )
          .collect()),
      );
    }

    const sittingRows = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", args.scholarId))
      .filter((q) => q.neq(q.field("retry"), true))
      .order("desc")
      .take(STUCK_SITTING_SCAN_LIMIT);
    const sittingAttempts = sittingRows.map((row) => ({
      row,
      createdAt: row.createdAt ?? row._creationTime,
    }));
    const currentSittingNewestFirst: typeof sittingAttempts = [];
    let newerAt: number | undefined;
    for (const attempt of sittingAttempts) {
      if (!Number.isFinite(attempt.createdAt)) continue;
      if (
        newerAt !== undefined &&
        newerAt - attempt.createdAt > SPIRAL_GAP_MS
      ) {
        break;
      }
      currentSittingNewestFirst.push(attempt);
      newerAt = attempt.createdAt;
    }
    const manipulativeAnswers = new Map<Id<"practiceAttempts">, string>();
    for (const row of streakRows) {
      if (!row.itemId?.startsWith("gen#") || row.answerText === undefined) continue;
      const practiceItemId = ctx.db.normalizeId(
        "practiceItems",
        row.itemId.slice(4),
      );
      if (!practiceItemId) continue;
      const item = await ctx.db.get(practiceItemId);
      if (!item || item.verifierKind !== MANIPULATIVE_VERIFIER_KIND) continue;
      const spec = parseManipulativeSpec(item.manipulativeSpec);
      if (!spec) continue;
      manipulativeAnswers.set(
        row._id,
        describeManipulativeState(spec, row.answerText),
      );
    }

    const misses: StuckAlertMiss[] = streakRows.map((row) => {
      const at = row.createdAt ?? row._creationTime;
      const matchedEvent = row.itemId
        ? events
            .filter(
              (event) =>
                event.itemId === row.itemId &&
                Math.abs(event.createdAt - at) <=
                  ERROR_EVENT_JOIN_TOLERANCE_MS,
            )
            .sort(
              (a, b) =>
                Math.abs(a.createdAt - at) - Math.abs(b.createdAt - at),
            )[0]
        : undefined;
      const errorPattern = matchedEvent
        ? PATTERN_PHRASING[matchedEvent.pattern as ErrorPattern]
        : undefined;
      return {
        nodeKey: row.nodeKey,
        skillLabel: labels.get(row.nodeKey) ?? row.nodeKey,
        ...(row.stemSnapshot !== undefined
          ? { stemSnapshot: row.stemSnapshot }
          : {}),
        ...(row.answerText !== undefined
          ? {
              answerText:
                manipulativeAnswers.get(row._id) ?? row.answerText,
            }
          : {}),
        ...(row.expectedAnswer !== undefined
          ? { expectedAnswer: row.expectedAnswer }
          : {}),
        ...(errorPattern ? { errorPattern } : {}),
        ...(row.elapsedMs !== undefined ? { elapsedMs: row.elapsedMs } : {}),
        ...(row.teachOutcome ? { teachOutcome: row.teachOutcome } : {}),
        isDontKnow: row.explanationReason === "dont_know",
      };
    });

    const sitting = tallyPracticeSitting(
      sittingRows.map((row) => ({
        correct: row.correct,
        retry: row.retry,
        breakerEligible: row.breakerEligible,
        lane: row.lane,
        createdAt: row.createdAt ?? row._creationTime,
      })),
    );
    const crossingAttempt = streakRows.at(-1);
    const crossingBreaker = crossingAttempt?.breaker;
    const crossingLifecycle = crossingAttempt?.breakerLifecycle;

    return {
      misses,
      ...(sitting ? { sitting } : {}),
      scholarName: scholar.name ?? "A scholar",
      ...(scholar.username ? { username: scholar.username } : {}),
      ...(scholar.institutionId
        ? { institutionId: scholar.institutionId }
        : {}),
      ...(crossingBreaker || crossingLifecycle
        ? {
            breaker: {
              ...(crossingBreaker
                ? {
                    offer: crossingBreaker.offer,
                    recovery: crossingBreaker.recovery,
                  }
                : {}),
              ...(crossingLifecycle
                ? {
                    lifecycle: {
                      version: crossingLifecycle.version,
                      triggeredAt: crossingLifecycle.triggeredAt,
                      ...(crossingLifecycle.repairShownAt !== undefined
                        ? { repairShownAt: crossingLifecycle.repairShownAt }
                        : {}),
                      ...(crossingLifecycle.repairRungKind !== undefined
                        ? { repairRungKind: crossingLifecycle.repairRungKind }
                        : {}),
                      ...(crossingLifecycle.repairUnavailableAt !== undefined
                        ? {
                            repairUnavailableAt:
                              crossingLifecycle.repairUnavailableAt,
                          }
                        : {}),
                      ...(crossingLifecycle.repairStartedAt !== undefined
                        ? { repairStartedAt: crossingLifecycle.repairStartedAt }
                        : {}),
                      ...(crossingLifecycle.repairCompletedAt !== undefined
                        ? { repairCompletedAt: crossingLifecycle.repairCompletedAt }
                        : {}),
                      ...(crossingLifecycle.coachEscalatedAt !== undefined
                        ? { coachEscalatedAt: crossingLifecycle.coachEscalatedAt }
                        : {}),
                      ...(crossingLifecycle.easyExitedAt !== undefined
                        ? { easyExitedAt: crossingLifecycle.easyExitedAt }
                        : {}),
                      ...(crossingLifecycle.stoppedAt !== undefined
                        ? { stoppedAt: crossingLifecycle.stoppedAt }
                        : {}),
                      ...(crossingLifecycle.freshResult
                        ? {
                            freshResult: {
                              correct: crossingLifecycle.freshResult.correct,
                              ...(crossingLifecycle.freshResult.assisted !== undefined
                                ? {
                                    assisted:
                                      crossingLifecycle.freshResult.assisted,
                                  }
                                : {}),
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
    };
  },
});

export const compose = internalAction({
  args: {
    scholarId: v.id("users"),
    // Optional for the deployment window: the prior release scheduled compose
    // jobs with only attemptIds, and Convex runs queued jobs against new validators.
    triggerAttemptId: v.optional(v.id("practiceAttempts")),
    missStreak: v.number(),
    attemptIds: v.array(v.id("practiceAttempts")),
    fallbackSkillLabel: v.string(),
    allDontKnow: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const triggerAttemptId = args.triggerAttemptId ?? args.attemptIds.at(-1);
    if (!triggerAttemptId) return;
    let evidence: StuckAlertEvidence = {
      misses: [],
      scholarName: "A scholar",
    };
    try {
      const gathered = await ctx.runQuery(
        internal.practiceStuckAlert.gatherEvidence,
        {
          scholarId: args.scholarId,
          attemptIds: args.attemptIds,
        },
      );
      if (gathered === null) return;
      evidence = gathered;
    } catch (error) {
      console.error("[practiceStuckAlert] evidence gathering failed:", error);
    }

    const notYetTaught =
      evidence.misses.length > 0
        ? evidence.misses.length === SPIRAL_MISS_THRESHOLD &&
          evidence.misses.every((miss) => miss.isDontKnow)
        : args.allDontKnow;
    const raiseArgs = {
      scholarId: args.scholarId,
      triggerAttemptId,
      missStreak: args.missStreak,
      evidence,
      fallbackSkillLabel: args.fallbackSkillLabel,
      alertKind: notYetTaught
        ? ("practice_not_yet_taught" as const)
        : ("practice_stuck" as const),
    };
    let alertId: Id<"alerts"> | undefined;
    try {
      alertId = (await ctx.runMutation(
        internal.practiceStuckAlert.raise,
        raiseArgs,
      )) ?? undefined;
    } catch (error) {
      console.error(
        "[practiceStuckAlert] alert delivery failed; retrying once:",
        error,
      );
      try {
        alertId = (await ctx.runMutation(
          internal.practiceStuckAlert.raise,
          raiseArgs,
        )) ?? undefined;
      } catch (retryError) {
        console.error(
          "[practiceStuckAlert] alert delivery retry failed:",
          retryError,
        );
      }
    }
    if (!alertId) return;

    let diagnosis: string | undefined;
    if (evidence.misses.length > 0 && !notYetTaught) {
      try {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
        const response = await anthropic.messages.create({
          model: MODELS.SONNET,
          max_tokens: 200,
          system: PRACTICE_STUCK_ALERT_SYSTEM,
          messages: [
            {
              role: "user",
              content: buildPracticeStuckUserMessage(evidence),
            },
          ],
        });
        const institutionId = await ctx.runQuery(
          internal.usage.resolveInstitution,
          {
            userId: args.scholarId,
            principal: "scholar",
          },
        );
        await recordAnthropicUsage(ctx, {
          source: "practice-stuck-alert",
          role: ROLES.TEACHER,
          model: MODELS.SONNET,
          usage: response.usage,
          institutionId: institutionId ?? evidence.institutionId,
        });
        const textBlock = response.content.find(
          (block) => block.type === "text",
        );
        if (textBlock?.type === "text") {
          diagnosis = normalizePracticeStuckDiagnosis(textBlock.text);
        }
      } catch (error) {
        console.error(
          "[practiceStuckAlert] diagnosis generation failed:",
          error,
        );
      }
    }
    try {
      await ctx.runMutation(internal.practiceStuckAlert.completeDiagnosis, {
        alertId,
        ...(diagnosis ? { diagnosis } : {}),
      });
    } catch (error) {
      console.error(
        "[practiceStuckAlert] diagnosis persistence failed; retrying once:",
        error,
      );
      try {
        await ctx.runMutation(internal.practiceStuckAlert.completeDiagnosis, {
          alertId,
          ...(diagnosis ? { diagnosis } : {}),
        });
      } catch (retryError) {
        console.error(
          "[practiceStuckAlert] diagnosis persistence retry failed:",
          retryError,
        );
      }
    }
  },
});

export const raise = internalMutation({
  args: {
    scholarId: v.id("users"),
    triggerAttemptId: v.id("practiceAttempts"),
    missStreak: v.number(),
    evidence: evidenceValidator,
    fallbackSkillLabel: v.string(),
    alertKind: v.union(
      v.literal("practice_stuck"),
      v.literal("practice_not_yet_taught"),
    ),
  },
  handler: async (ctx, args): Promise<Id<"alerts"> | undefined> => {
    const [scholar, trigger] = await Promise.all([
      ctx.db.get(args.scholarId),
      ctx.db.get(args.triggerAttemptId),
    ]);
    if (
      trigger &&
      (trigger.scholarId !== args.scholarId ||
        trigger.correct ||
        !isBreakerCountedAttempt(trigger))
    ) {
      return undefined;
    }
    const scholarName =
      args.evidence.scholarName === "A scholar"
        ? scholar?.name ?? args.evidence.scholarName
        : args.evidence.scholarName;
    const username = args.evidence.username ?? scholar?.username;
    const notYetTaught = args.alertKind === "practice_not_yet_taught";
    const alertId = await raiseAlert(ctx, {
      kind: args.alertKind,
      severity: notYetTaught ? "info" : "warning",
      audience: "institution",
      source: "practice",
      title: notYetTaught
        ? `Hasn't met these yet — ${escapeSlackText(scholarName)}`
        : `Stuck in math practice — ${escapeSlackText(scholarName)}`,
      body: notYetTaught
        ? buildNotYetTaughtAlertBody({
            missStreak: args.missStreak,
            misses: args.evidence.misses,
            sitting: args.evidence.sitting,
            breaker: args.evidence.breaker,
            now: Date.now(),
          })
        : buildStuckAlertBody({
            missStreak: args.missStreak,
            misses: args.evidence.misses,
            sitting: args.evidence.sitting,
            breaker: args.evidence.breaker,
            fallbackSkillLabel: args.fallbackSkillLabel,
            now: Date.now(),
          }),
      scholarId: args.scholarId,
      practiceTriggerAttemptId: args.triggerAttemptId,
      dedupKey: `${args.alertKind}:${args.scholarId}`,
      dedupWindowMs: SPIRAL_GAP_MS,
      deepLink: withBase(
        siteUrl(),
        scholarPath(scholarSlug(username, args.scholarId)),
      ),
    });
    if (alertId) {
      await ctx.scheduler.runAfter(
        SPIRAL_GAP_MS,
        internal.practiceStuckAlert.postOutcome,
        { triggerAttemptId: args.triggerAttemptId },
      );
    }
    return alertId;
  },
});

export const completeDiagnosis = internalMutation({
  args: {
    alertId: v.id("alerts"),
    diagnosis: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (!alert || !alert.practiceTriggerAttemptId) return false;
    await ctx.db.patch(alert._id, {
      practiceDiagnosis: args.diagnosis,
      practiceDiagnosisReadyAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.practiceStuckAlert.postOutcome,
      { triggerAttemptId: alert.practiceTriggerAttemptId },
    );
    return true;
  },
});

export const claimOutcome = internalMutation({
  args: { triggerAttemptId: v.id("practiceAttempts") },
  handler: async (ctx, args) => {
    const alert = await ctx.db
      .query("alerts")
      .withIndex("by_practice_trigger", (q) =>
        q.eq("practiceTriggerAttemptId", args.triggerAttemptId),
      )
      .unique();
    const trigger = await ctx.db.get(args.triggerAttemptId);
    if (
      !alert ||
      !trigger?.breakerLifecycle ||
      !alert.slackChannelId ||
      !alert.slackMessageTs ||
      alert.practiceOutcomePostedAt !== undefined
    ) {
      return null;
    }

    const now = Date.now();
    const lifecycle = trigger.breakerLifecycle;
    const lastActivityAt = Math.max(
      lifecycle.triggeredAt,
      lifecycle.repairShownAt ?? Number.NEGATIVE_INFINITY,
      lifecycle.repairUnavailableAt ?? Number.NEGATIVE_INFINITY,
      lifecycle.repairStartedAt ?? Number.NEGATIVE_INFINITY,
      lifecycle.repairCompletedAt ?? Number.NEGATIVE_INFINITY,
      lifecycle.coachEscalatedAt ?? Number.NEGATIVE_INFINITY,
      lifecycle.easyExitedAt ?? Number.NEGATIVE_INFINITY,
      lifecycle.stoppedAt ?? Number.NEGATIVE_INFINITY,
      lifecycle.freshResult?.completedAt ?? Number.NEGATIVE_INFINITY,
    );
    const sittingEnded =
      now >= lastActivityAt + SPIRAL_GAP_MS;
    const recoveryFinished =
      trigger.breaker?.recovery !== undefined &&
      trigger.breaker.recovery !== "none";
    const v2Finished =
      trigger.breakerLifecycle.freshResult?.correct === true ||
      trigger.breakerLifecycle.stoppedAt !== undefined ||
      Boolean(trigger.breakerLifecycle.easyExitedAt && recoveryFinished);
    const v2InteractionRecorded =
      trigger.breakerLifecycle.repairShownAt !== undefined ||
      trigger.breakerLifecycle.repairUnavailableAt !== undefined ||
      trigger.breakerLifecycle.repairStartedAt !== undefined ||
      trigger.breakerLifecycle.repairCompletedAt !== undefined ||
      trigger.breakerLifecycle.coachEscalatedAt !== undefined ||
      trigger.breakerLifecycle.easyExitedAt !== undefined;
    const legacyClientFinished = !v2InteractionRecorded && recoveryFinished;
    if (!v2Finished && !legacyClientFinished && !sittingEnded) return null;
    if (
      alert.practiceOutcomeClaim &&
      alert.practiceOutcomeClaim.claimedAt >
        now - OUTCOME_CLAIM_LEASE_MS
    ) {
      return null;
    }

    const deliveryId = `practice-outcome:${alert._id}`;
    const claimId = `${deliveryId}:${now}`;
    await ctx.db.patch(alert._id, {
      practiceOutcomeClaim: { claimId, deliveryId, claimedAt: now },
    });
    return {
      alertId: alert._id,
      channelId: alert.slackChannelId,
      threadTs: alert.slackMessageTs,
      claimId,
      deliveryId,
      text: buildBreakerOutcomeReply(
        {
          ...(trigger.breaker
            ? {
                offer: trigger.breaker.offer,
                recovery: trigger.breaker.recovery,
              }
            : {}),
          lifecycle: trigger.breakerLifecycle,
        },
        alert.practiceDiagnosis,
      ),
    };
  },
});

export const releaseOutcomeClaim = internalMutation({
  args: {
    alertId: v.id("alerts"),
    claimId: v.string(),
  },
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (alert?.practiceOutcomeClaim?.claimId !== args.claimId) {
      return false;
    }
    await ctx.db.patch(alert._id, { practiceOutcomeClaim: undefined });
    return true;
  },
});

export const finalizeOutcome = internalMutation({
  args: {
    alertId: v.id("alerts"),
    claimId: v.string(),
  },
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (alert?.practiceOutcomeClaim?.claimId !== args.claimId) {
      return false;
    }
    await ctx.db.patch(alert._id, {
      practiceOutcomeClaim: undefined,
      practiceOutcomePostedAt: Date.now(),
    });
    return true;
  },
});

function outcomeMetadata(deliveryId: string): SlackMessageMetadata {
  return {
    event_type: OUTCOME_DELIVERY_EVENT_TYPE,
    event_payload: { delivery_id: deliveryId },
  };
}

export const postOutcome = internalAction({
  args: {
    triggerAttemptId: v.id("practiceAttempts"),
    retry: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const scheduleRetry = async (
      delayMs = OUTCOME_RETRY_DELAY_MS,
      force = false,
    ) => {
      const retry = args.retry ?? 0;
      if (!force && retry >= 2) return;
      try {
        await ctx.scheduler.runAfter(
          delayMs,
          internal.practiceStuckAlert.postOutcome,
          {
            triggerAttemptId: args.triggerAttemptId,
            retry: retry + 1,
          },
        );
      } catch (error) {
        console.error(
          "[practiceStuckAlert] outcome retry scheduling failed:",
          error,
        );
      }
    };
    const claimed = await (async () => {
      try {
        return await ctx.runMutation(
          internal.practiceStuckAlert.claimOutcome,
          { triggerAttemptId: args.triggerAttemptId },
        );
      } catch (error) {
        console.error(
          "[practiceStuckAlert] outcome claim failed:",
          error,
        );
        await scheduleRetry();
        return null;
      }
    })();
    if (!claimed) return;

    const finish = () =>
      ctx.runMutation(internal.practiceStuckAlert.finalizeOutcome, {
        alertId: claimed.alertId,
        claimId: claimed.claimId,
      });
    const releaseAndRetry = async (delayMs = OUTCOME_RETRY_DELAY_MS) => {
      let released = false;
      let releaseFailed = false;
      try {
        released = await ctx.runMutation(
          internal.practiceStuckAlert.releaseOutcomeClaim,
          {
            alertId: claimed.alertId,
            claimId: claimed.claimId,
          },
        );
      } catch (error) {
        releaseFailed = true;
        console.error(
          "[practiceStuckAlert] outcome claim release failed:",
          error,
        );
      }
      if (!released && !releaseFailed) return;
      const retryDelay = releaseFailed
        ? Math.max(delayMs, OUTCOME_CLAIM_LEASE_MS + OUTCOME_RETRY_DELAY_MS)
        : delayMs;
      await scheduleRetry(retryDelay, releaseFailed);
    };

    try {
      const replies = await fetchConversationReplies(
        token,
        claimed.channelId,
        claimed.threadTs,
      );
      if (!replies.ok) {
        await releaseAndRetry(replies.retryAfterMs);
        return;
      }
      if (
        messageWithDeliveryMetadata(
          replies.messages,
          OUTCOME_DELIVERY_EVENT_TYPE,
          claimed.deliveryId,
        )
      ) {
        await finish();
        return;
      }

      const posted = await postMessage(token, {
        channel: claimed.channelId,
        threadTs: claimed.threadTs,
        text: claimed.text,
        markdown: true,
        metadata: outcomeMetadata(claimed.deliveryId),
      });
      if (posted.ok) {
        await finish();
        return;
      }
      if (posted.ambiguous) {
        const reconciled = await fetchConversationReplies(
          token,
          claimed.channelId,
          claimed.threadTs,
        );
        if (
          reconciled.ok &&
          messageWithDeliveryMetadata(
            reconciled.messages,
            OUTCOME_DELIVERY_EVENT_TYPE,
            claimed.deliveryId,
          )
        ) {
          await finish();
          return;
        }
      }
      await releaseAndRetry(posted.retryAfterMs);
    } catch (error) {
      console.error(
        "[practiceStuckAlert] unexpected outcome delivery failure:",
        error,
      );
      await releaseAndRetry();
    }
  },
});
