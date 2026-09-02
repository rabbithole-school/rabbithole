// The GAME observer — game digests enter the learning record as PORTRAIT
// evidence.
//
// A completed game writes a server-derived digest (lib/games/digest.ts),
// rebuilt deterministically from an append-only event log. That digest is our
// strongest evidence of what a scholar DID — stronger than a kid-typed tutor
// transcript, which already feeds the session observer. This module closes the
// integrity inversion: after a game completes, `convex/games.ts` schedules this
// pass, which reads the stored digest and records 0..n `masteryObservations`
// anchored on the game session (the FOURTH session-less anchor, after
// metaChatId and portfolioItemId).
//
// What this module MUST NOT do — the SR legs stay absolute (D-3):
//   • It writes NO `practiceAttempts` and NO `practiceMastery`. Green fluency is
//     minted only by the practice engine's later bare reps — green = decaying,
//     re-probed SR state, and a game round is not that probe. This module
//     imports no such helper.
//   • It never inflates. The digest shows what happened in ONE round; the
//     observer describes what the scholar DID, never "mastered X". masteryLevel
//     is a modest reading, confidence is low, and zero observations is a
//     first-class outcome for a short/abandoned round (mirroring the
//     portfolio-scan observer's "a name-only page is zero observations").
//
// Failures log and give up quietly: the round outcome must never depend on this
// pass, so every error path returns without throwing (same posture as the other
// post-hoc observer passes).

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { getGame } from "../lib/games/catalog";
import { renderDigestForModel } from "../lib/games/promptContext";
import type { GameSessionDigest } from "../lib/games/digest";
import {
  matchObservationToKnowledgeNode,
} from "./lib/knowledgeNodeResolver";
import { autoConsolidateDuplicates } from "./masteryObservations";

/** attemptContext stamped on every row this module writes. */
export const GAME_ATTEMPT_CONTEXT = "game_session";

/**
 * Floor below which a round is too short to be worth a model call. Counted over
 * the SUBSTANTIVE evidence in the digest (predictions, revisions, the scholar's
 * own words, choices, rule outcomes, strategy guesses) — not the raw event
 * count, which is padded by phase/outcome/host bookkeeping. Five substantive
 * events is a round with a shape to read; fewer is a tap-and-quit.
 */
const MIN_GAME_EVIDENCE_EVENTS = 5;

/**
 * At most this many game-observer passes per scholar per rolling 24h. The
 * observer is ~22% of AI spend, and a game round is cheap to start over and
 * over — an uncapped pass would let a kid grinding the same game burn the
 * budget. Counted by DISTINCT gameSessionIds already recorded in the last day
 * (see the query below): a zero-observation round writes nothing and so does
 * not consume the cap, which is fine — those are short rounds the floor above
 * already screens.
 */
const GAME_OBSERVER_DAILY_CAP = 3;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Never mint more than this many observations from one round. */
const MAX_GAME_OBSERVATIONS = 3;

/**
 * conceptLabel/domain are injected verbatim into the tutor's mastery section, so
 * a runaway string would eat live context. Real labels are a few words.
 */
const MAX_LABEL_CHARS = 120;
const capLabel = (s: string): string => s.trim().slice(0, MAX_LABEL_CHARS).trim();

/** Evidence types the record accepts from a game round. */
const ALLOWED_EVIDENCE_TYPES = new Set([
  "direct_demonstration",
  "indirect_inference",
  "misconception_signal",
  "interest_signal",
]);

type GameObservation = {
  conceptLabel: string;
  domain: string;
  nodeKey?: string;
  masteryLevel: number;
  confidenceScore: number;
  evidenceType: string;
  evidenceSummary: string;
  transcriptExcerpt: string;
};

const gameObservationValidator = v.object({
  conceptLabel: v.string(),
  domain: v.string(),
  nodeKey: v.optional(v.string()),
  masteryLevel: v.number(),
  confidenceScore: v.number(),
  evidenceType: v.string(),
  evidenceSummary: v.string(),
  transcriptExcerpt: v.string(),
});

/** A resolved candidate node offered to the model — never invented by it. */
type CandidateNode = { nodeKey: string; label: string; domain: string };

/** Count the substantive, scholar-thinking evidence in a digest. */
function countGameEvidence(digest: GameSessionDigest): number {
  return (
    digest.predictions.length +
    digest.revisions.length +
    digest.scholarExplanations.length +
    digest.choices.length +
    digest.localRuleResults.length +
    digest.strategyInferences.length
  );
}

/**
 * Distinct game sessions this scholar has already had OBSERVED in the rolling
 * 24h window, excluding the one in flight. Shared by the query gate and the
 * mutation's write-time re-check so the two agree on what "the cap" counts.
 */
async function countObservedGameSessionsToday(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
  excludeGameSessionId: Id<"gameSessions">,
): Promise<number> {
  const cutoff = Date.now() - DAILY_WINDOW_MS;
  const recent = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_observedAt", (q) =>
      q.eq("scholarId", scholarId).gte("observedAt", cutoff),
    )
    .collect();
  const sessions = new Set<string>();
  for (const row of recent) {
    if (row.gameSessionId && row.gameSessionId !== excludeGameSessionId) {
      sessions.add(row.gameSessionId);
    }
  }
  return sessions.size;
}

/**
 * Fully validate one model-supplied observation before it reaches the write
 * mutation. Convex arg-validation is all-or-nothing per call, so ONE malformed
 * sibling would otherwise reject the whole batch and drop every valid row —
 * we screen each item here in the action and drop bad ones individually.
 * Returns a clean `GameObservation` or null.
 */
function coerceObservation(value: unknown): GameObservation | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const strs = ["conceptLabel", "domain", "evidenceType", "evidenceSummary", "transcriptExcerpt"];
  for (const key of strs) {
    if (typeof o[key] !== "string") return null;
  }
  if (typeof o.masteryLevel !== "number" || !Number.isFinite(o.masteryLevel)) return null;
  if (typeof o.confidenceScore !== "number" || !Number.isFinite(o.confidenceScore)) return null;
  if (o.nodeKey !== undefined && typeof o.nodeKey !== "string") return null;
  const clean: GameObservation = {
    conceptLabel: o.conceptLabel as string,
    domain: o.domain as string,
    masteryLevel: o.masteryLevel as number,
    confidenceScore: o.confidenceScore as number,
    evidenceType: o.evidenceType as string,
    evidenceSummary: o.evidenceSummary as string,
    transcriptExcerpt: o.transcriptExcerpt as string,
  };
  if (typeof o.nodeKey === "string" && o.nodeKey.trim()) clean.nodeKey = o.nodeKey;
  return clean;
}

const GAME_OBSERVER_SYSTEM_PROMPT = `You are a classroom observer reading the server's digest of ONE completed learning game a scholar just played. The digest is a faithful, deterministic record of what happened in the round — predictions the scholar committed to before seeing a result, revisions to their thinking, choices they made, and their own typed words. It carries no score and no grade, and neither do you.

Your only job is to record what THIS ROUND demonstrates about the scholar's understanding, for their long-term learning record. You MUST call the report_game_observations tool.

Ground rules:
- Evidence, never conclusions. Say what the scholar DID ("weighed a number against its factors", "revised a guess after seeing the signal"). Never say "mastered" or "understands X" — one round of a game is weak evidence, so masteryLevel stays modest and confidenceScore stays low.
- Zero observations is the honest answer for a short, aimless, or abandoned round. Prefer fewer, higher-signal observations; return an empty array rather than inventing signal.
- nodeKey is OPTIONAL. Set it ONLY when a concept maps confidently onto one of the candidate nodes listed for you, copying that node's exact nodeKey. Never invent a nodeKey. When in doubt, leave it unset — a node-less observation is still recorded.`;

const GAME_OBSERVER_TOOL = {
  name: "report_game_observations",
  description:
    "Record 0-3 mastery observations distilled from a completed game round. Prefer fewer; return an empty array when the round shows nothing assessable.",
  input_schema: {
    type: "object" as const,
    required: ["observations"],
    properties: {
      observations: {
        type: "array" as const,
        description: "0-3 observations. Empty when the round carries no academic signal.",
        items: {
          type: "object" as const,
          required: [
            "conceptLabel",
            "domain",
            "masteryLevel",
            "confidenceScore",
            "evidenceType",
            "evidenceSummary",
            "transcriptExcerpt",
          ],
          properties: {
            conceptLabel: { type: "string" as const },
            domain: { type: "string" as const },
            nodeKey: {
              type: "string" as const,
              description:
                "Copy the exact nodeKey of a listed candidate node, only when confident. Omit otherwise.",
            },
            masteryLevel: {
              type: "number" as const,
              description: "0-5 Bloom depth. Modest — one game round is weak evidence.",
            },
            confidenceScore: { type: "number" as const, description: "0-1. Low for a single round." },
            evidenceType: {
              type: "string" as const,
              enum: [
                "direct_demonstration",
                "indirect_inference",
                "misconception_signal",
                "interest_signal",
              ],
            },
            evidenceSummary: { type: "string" as const },
            transcriptExcerpt: {
              type: "string" as const,
              description: "A short quote from the digest lines that grounds this observation.",
            },
          },
        },
      },
    },
  },
};

type GameObserveContext =
  | { kind: "skip"; reason: string }
  | {
      kind: "assess";
      scholarId: Id<"users">;
      gameId: string;
      title: string;
      blurb: string;
      digestText: string;
      candidates: CandidateNode[];
    };

/**
 * Gate + context for one game session, all the server-side checks in one read:
 * completed?, digest present?, not already observed (dedupe), long enough,
 * under the per-scholar daily cap. Returns the model-ready context only when
 * every gate passes; otherwise a skip with a reason for the log.
 */
export const getGameObserveContext = internalQuery({
  args: { gameSessionId: v.id("gameSessions") },
  handler: async (ctx, args): Promise<GameObserveContext> => {
    const session = await ctx.db.get(args.gameSessionId);
    if (!session) return { kind: "skip", reason: "session missing" };
    if (session.status !== "completed") {
      return { kind: "skip", reason: `status ${session.status}` };
    }

    // Dedupe: a re-schedule or retry must never double-write the portrait.
    const already = await ctx.db
      .query("masteryObservations")
      .withIndex("by_gameSession", (q) => q.eq("gameSessionId", args.gameSessionId))
      .first();
    if (already) return { kind: "skip", reason: "already observed" };

    const digestRow = await ctx.db
      .query("gameSessionDigests")
      .withIndex("by_session", (q) => q.eq("sessionId", args.gameSessionId))
      .first();
    if (!digestRow) return { kind: "skip", reason: "no digest" };

    let digest: GameSessionDigest;
    try {
      digest = JSON.parse(digestRow.digestJson) as GameSessionDigest;
    } catch {
      return { kind: "skip", reason: "unparseable digest" };
    }
    if (countGameEvidence(digest) < MIN_GAME_EVIDENCE_EVENTS) {
      return { kind: "skip", reason: "too short" };
    }

    // Per-scholar daily cap, by distinct game sessions already observed today.
    if (
      (await countObservedGameSessionsToday(ctx, session.scholarId, args.gameSessionId)) >=
      GAME_OBSERVER_DAILY_CAP
    ) {
      return { kind: "skip", reason: "daily cap reached" };
    }

    const game = getGame(session.gameId);
    if (!game) return { kind: "skip", reason: "unknown game" };

    // Candidate nodes: resolve the catalog evidence plan's `concept` labels to
    // real knowledgeNodes and offer THOSE to the model. The model may pick a
    // nodeKey from this list; it may never invent one. Node resolution punts on
    // ambiguity by design, so the list is precise-or-empty.
    const nodes = await ctx.db.query("knowledgeNodes").collect();
    const candidates = new Map<string, CandidateNode>();
    for (const entry of Object.values(game.evidencePlan)) {
      const concept = entry.concept?.trim();
      if (!concept) continue;
      const nodeKey = matchObservationToKnowledgeNode(nodes, { conceptLabel: concept });
      if (!nodeKey || candidates.has(nodeKey)) continue;
      const node = nodes.find((n) => n.nodeKey === nodeKey);
      if (node) candidates.set(nodeKey, { nodeKey, label: node.label, domain: node.domain });
    }

    return {
      kind: "assess",
      scholarId: session.scholarId,
      gameId: session.gameId,
      title: game.title,
      blurb: game.blurb,
      digestText: renderDigestForModel(digest),
      candidates: [...candidates.values()],
    };
  },
});

/**
 * Persist the observer's read of one game round. Idempotent: re-checks the
 * dedupe guard so a racing re-run writes nothing. A model-supplied nodeKey is
 * kept ONLY when it is one of the candidate nodeKeys this session offered the
 * model AND still exists in knowledgeNodes — so the model cannot attach a valid
 * but unrelated node; anything else drops to undefined (a node-less portrait
 * row). Writes only `masteryObservations`; no SR row is reachable here.
 */
export const applyGameObservations = internalMutation({
  args: {
    gameSessionId: v.id("gameSessions"),
    observations: v.array(gameObservationValidator),
    // The exact candidate nodeKeys offered to the model for THIS session. A
    // model nodeKey is honored only if it is in this set (fix #3). Defaulted to
    // empty by callers that offered none.
    candidateNodeKeys: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ written: number }> => {
    const session = await ctx.db.get(args.gameSessionId);
    if (!session) return { written: 0 };

    const already = await ctx.db
      .query("masteryObservations")
      .withIndex("by_gameSession", (q) => q.eq("gameSessionId", args.gameSessionId))
      .first();
    if (already) return { written: 0 };

    // Write-time daily-cap re-check. The query gate ran in a SEPARATE
    // transaction, so two passes for the same scholar could both pass it and
    // both write. Mutations serialize, so re-checking here makes the WRITE cap
    // exact. (The small residual race is only in MODEL SPEND — two passes may
    // each make their model call before either writes; that is acceptable, and
    // the per-session dedupe above still prevents any double-write.)
    if (
      (await countObservedGameSessionsToday(ctx, session.scholarId, args.gameSessionId)) >=
      GAME_OBSERVER_DAILY_CAP
    ) {
      return { written: 0 };
    }

    const candidateSet = new Set(args.candidateNodeKeys);

    let written = 0;
    for (const obs of args.observations.slice(0, MAX_GAME_OBSERVATIONS)) {
      const conceptLabel = capLabel(obs.conceptLabel);
      if (!conceptLabel) continue;

      // Honor a model nodeKey only when it was one WE offered for this session
      // and still exists. Never invent one, never accept an off-list node.
      let nodeKey: string | undefined = undefined;
      if (obs.nodeKey && candidateSet.has(obs.nodeKey)) {
        const node = await ctx.db
          .query("knowledgeNodes")
          .withIndex("by_nodeKey", (q) => q.eq("nodeKey", obs.nodeKey!))
          .first();
        if (node) nodeKey = node.nodeKey;
      }

      const evidenceType = ALLOWED_EVIDENCE_TYPES.has(obs.evidenceType)
        ? obs.evidenceType
        : "indirect_inference";
      const domain = capLabel(obs.domain) || "General";

      const newId = await ctx.db.insert("masteryObservations", {
        scholarId: session.scholarId,
        conceptLabel,
        domain,
        nodeKey,
        observedAt: Date.now(),
        // The digest IS the evidence — no session, a game-session anchor.
        gameSessionId: args.gameSessionId,
        transcriptExcerpt: obs.transcriptExcerpt.slice(0, 800),
        masteryLevel: Math.max(0, Math.min(5, obs.masteryLevel)),
        confidenceScore: Math.max(0, Math.min(1, obs.confidenceScore)),
        evidenceSummary: obs.evidenceSummary.slice(0, 500),
        evidenceType,
        attemptContext: GAME_ATTEMPT_CONTEXT,
        // A scholar opened and played the game; the round is theirs.
        studentInitiated: true,
        isSuperseded: false,
      });
      written++;

      // Reuse the shared near-duplicate supersession backstop (a prod-incident
      // structural floor). We insert directly rather than through
      // masteryObservations.record — our nodeKey comes from a candidate-enforced
      // verify, not record's label resolution — so we must call this ourselves,
      // exactly as record does after its own insert.
      await autoConsolidateDuplicates(ctx, {
        scholarId: session.scholarId,
        domain,
        newId,
        conceptLabel,
        evidenceType,
      });
    }
    return { written };
  },
});

/**
 * Read one completed game session's digest and record what it demonstrates.
 * Scheduled from games.requestCompletion, never user-facing. All gates live in
 * getGameObserveContext; this action is the model call + write. It never throws
 * — a game's outcome must not depend on the observer.
 */
export const observeGameSession = internalAction({
  args: { gameSessionId: v.id("gameSessions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; skipped?: boolean; reason?: string; written?: number }> => {
    const bundle = await ctx.runQuery(internal.gameObserver.getGameObserveContext, {
      gameSessionId: args.gameSessionId,
    });
    if (bundle.kind === "skip") {
      console.log(`[gameObserver] ${args.gameSessionId}: skipped — ${bundle.reason}`);
      return { ok: true, skipped: true, reason: bundle.reason };
    }

    const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
      userId: bundle.scholarId,
      principal: "scholar",
    });

    try {
      const candidateLines = bundle.candidates.length
        ? bundle.candidates
            .map((c) => `- nodeKey "${c.nodeKey}" — ${c.label} (${c.domain})`)
            .join("\n")
        : "(no confident candidate nodes — leave nodeKey unset on every observation)";

      const userText = [
        `Game: ${bundle.title} — ${bundle.blurb}`,
        "",
        "What the digest shows the scholar did this round:",
        bundle.digestText,
        "",
        "Candidate nodes you MAY map an observation onto (copy the exact nodeKey, only when confident):",
        candidateLines,
        "",
        "Record only what this one round demonstrates. Return an empty observations array if it shows nothing assessable.",
      ].join("\n");

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const observerModel = process.env.OBSERVER_MODEL || MODELS.SONNET;
      const response = await anthropic.messages.create({
        model: observerModel,
        max_tokens: 1536,
        system: GAME_OBSERVER_SYSTEM_PROMPT,
        tools: [GAME_OBSERVER_TOOL],
        tool_choice: { type: "tool", name: "report_game_observations" },
        messages: [{ role: "user", content: userText }],
      });
      await recordAnthropicUsage(ctx, {
        source: "game-observe",
        role: ROLES.SCHOLAR,
        model: observerModel,
        usage: response.usage,
        institutionId,
      });

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        console.error(`[gameObserver] ${args.gameSessionId}: no tool_use block`);
        return { ok: false };
      }
      const raw = toolBlock.input as { observations?: unknown };
      // Validate each item fully and drop bad ones individually — one malformed
      // sibling must not fail the whole write mutation (fix #4).
      const observations: GameObservation[] = Array.isArray(raw.observations)
        ? raw.observations.flatMap((o) => {
            const clean = coerceObservation(o);
            return clean ? [clean] : [];
          })
        : [];

      const { written } = await ctx.runMutation(
        internal.gameObserver.applyGameObservations,
        {
          gameSessionId: args.gameSessionId,
          observations,
          candidateNodeKeys: bundle.candidates.map((c) => c.nodeKey),
        },
      );
      console.log(
        `[gameObserver] ${args.gameSessionId}: ${observations.length} observation(s) → ${written} row(s)`,
      );
      return { ok: true, written };
    } catch (err) {
      // A game's outcome never depends on the observer — log and give up.
      console.error(`[gameObserver] failed for ${args.gameSessionId}:`, err);
      return { ok: false };
    }
  },
});
