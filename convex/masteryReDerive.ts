"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildObserverSystemPrompt } from "./prompts";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import {
  OBSERVER_TOOL,
  buildObserverTranscript,
  buildObserverUserMessage,
  parseObserverResponse,
} from "./lib/observerShared";
import { conceptLabelsNearDuplicate, AUTO_MERGE_THRESHOLD } from "./lib/conceptLabels";

// ─── One-time mastery RE-DERIVATION ──────────────────────────────────
//
// Rebuild a scholar's mastery record FROM SCRATCH with the current (post-#288,
// better-calibrated) observer, to retire the inflated/accumulated records the
// old observer left. See evals/observer/FINDINGS-rigor.md + TODO.html (#observer-mastery-dedup).
//
// Why not re-call observer.analyzeSession: that ALSO writes seeds, sessionSignals,
// crossDomainConnections, granuleEvidence, the analyses/pulse row, reading-level
// suggestions, runs standardsMapper, AND fires Slack welfare/parasocial alerts —
// re-running it would duplicate all of that and re-fire old alerts. This path
// re-runs the SAME observer model call but writes ONLY the mastery record.
//
// Fidelity model: each session is scored as an INDEPENDENT fresh pass (no prior
// observations fed in) — the findings showed a fresh single run is well-calibrated
// (~2.6–3.3 avg), and the inflation came from accumulation. Cross-session
// near-duplicates are then collapsed by the deterministic write-path dedup net in
// masteryObservations.record (kept newest), which we also SIMULATE here for the
// dry-run "after" preview. Sessions are processed oldest→newest so the newest
// session's row wins each dedup cluster, and each row is stamped with its
// session's time (observedAt) to preserve growth-story chronology.
//
// OPERATOR SEQUENCE (per scholar):
//   1. dry-run preview (default):  masteryReDerive:run '{"username":"nuni"}'
//   2. review before/after + human-data-at-risk counts
//   3. snapshot:                   npx convex export --prod
//   4. purge (real):               masteryObservations:purgeScholar '{"scholarId":"…","dryRun":false}'
//   5. rebuild (real):             masteryReDerive:run '{"scholarId":"…","dryRun":false,"mapStandards":true}'
// The real rebuild REFUSES to write onto a non-empty record (step 4 is mandatory
// by construction) unless allowNonEmpty:true.

type ProposedObs = {
  conceptLabel: string;
  domain: string;
  masteryLevel: number;
  evidenceType: string;
};

type ReDeriveStats = {
  conceptObservations: number;
  misconceptions: number;
  meanBloom: number;
  pctAnalyzePlus: number;
  distribution: { b1: number; b2: number; b3: number; b4: number; b5: number };
};

// Explicit return type: keeps TypeScript from deeply INFERRING this action's
// (large) result shape into the generated `api`/`internal` type — without it the
// inference budget blows and `api` silently degrades to `any`, cascading
// implicit-any errors across unrelated files. (A known Convex scaling gotcha.)
type ReDeriveReport = {
  dryRun: boolean;
  scholarId: Id<"users">;
  scholarName: string | null;
  model: string;
  sessionsAnalyzable: number;
  sessionsProcessed: number;
  rawProposedObservations: number;
  before: ReDeriveStats;
  after: ReDeriveStats;
  perSession: Array<{
    sessionId: string;
    title: string;
    messages: number;
    observations: number;
    error?: string;
  }>;
  note: string;
};

function summarize(obs: ProposedObs[]): ReDeriveStats {
  const concepts = obs.filter((o) => o.evidenceType !== "misconception_signal");
  const n = concepts.length;
  const mean = n ? concepts.reduce((s, o) => s + o.masteryLevel, 0) / n : 0;
  const analyzePlus = n
    ? concepts.filter((o) => o.masteryLevel >= 4).length / n
    : 0;
  const dist = [0, 0, 0, 0, 0]; // Bloom 1..5
  for (const o of concepts) {
    const b = Math.round(o.masteryLevel);
    if (b >= 1 && b <= 5) dist[b - 1]++;
  }
  return {
    conceptObservations: n,
    misconceptions: obs.length - n,
    meanBloom: Number(mean.toFixed(2)),
    pctAnalyzePlus: Math.round(analyzePlus * 100),
    distribution: { b1: dist[0], b2: dist[1], b3: dist[2], b4: dist[3], b5: dist[4] },
  };
}

// Deterministic simulation of the write-path dedup net (masteryObservations
// autoConsolidateDuplicates): per domain, keep newest among lexical near-dups.
function simulateNet(proposed: ProposedObs[]): ProposedObs[] {
  const kept: ProposedObs[] = [];
  for (const o of proposed) {
    if (o.evidenceType === "misconception_signal") {
      kept.push(o); // misconceptions are exempt from the net
      continue;
    }
    const dupIdx = kept.findIndex(
      (k) =>
        k.evidenceType !== "misconception_signal" &&
        k.domain === o.domain &&
        conceptLabelsNearDuplicate(k.conceptLabel, o.conceptLabel, AUTO_MERGE_THRESHOLD),
    );
    if (dupIdx >= 0) kept[dupIdx] = o; // newest wins
    else kept.push(o);
  }
  return kept;
}

export const run = internalAction({
  args: {
    scholarId: v.optional(v.id("users")),
    username: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    // Cap / window the sessions processed (testing or chunking a very active
    // scholar across invocations).
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    // Re-map the new observations to curriculum standards at the end (one extra
    // Haiku pass). Off by default for dry-runs.
    mapStandards: v.optional(v.boolean()),
    // Escape hatch: allow a real rebuild even if the record isn't empty (normally
    // purgeScholar must run first).
    allowNonEmpty: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ReDeriveReport> => {
    const dryRun = args.dryRun ?? true;

    // ── Resolve scholar ──
    let scholarId = args.scholarId ?? null;
    let scholarName: string | null = null;
    if (!scholarId && args.username) {
      const u = await ctx.runQuery(internal.users.getByUsernameInternal, {
        username: args.username,
      });
      scholarId = (u?._id as Id<"users">) ?? null;
      scholarName = u?.name ?? args.username;
    }
    if (!scholarId) {
      throw new Error("masteryReDerive: provide scholarId or a resolvable username");
    }
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: scholarId, principal: "scholar" },
    );
    if (!scholarName) {
      const u = await ctx.runQuery(internal.users.getByIdInternal, {
        id: scholarId,
      });
      scholarName = u?.name ?? u?.username ?? null;
    }

    // ── BEFORE snapshot (current, non-superseded record) ──
    const before = await ctx.runQuery(
      internal.masteryObservations.currentByScholar,
      { scholarId },
    );
    const beforeStats = summarize(
      before.map((o) => ({
        conceptLabel: o.conceptLabel,
        domain: o.domain,
        masteryLevel: o.masteryLevel,
        evidenceType: o.evidenceType,
      })),
    );

    // Guard: a REAL rebuild must run against an empty record (purgeScholar first).
    if (!dryRun && before.length > 0 && !args.allowNonEmpty) {
      throw new Error(
        `masteryReDerive: scholar still has ${before.length} current observations. ` +
          `Run masteryObservations:purgeScholar '{"scholarId":"${scholarId}","dryRun":false}' first, ` +
          `or pass allowNonEmpty:true.`,
      );
    }

    // ── Sessions to replay ──
    let sessions = await ctx.runQuery(
      internal.sessions.analyzableSessionsForScholar,
      { scholarId },
    );
    const totalAnalyzable = sessions.length;
    const offset = args.offset ?? 0;
    if (offset > 0) sessions = sessions.slice(offset);
    if (args.limit !== undefined) sessions = sessions.slice(0, args.limit);

    const observerModel = process.env.OBSERVER_MODEL || MODELS.SONNET;
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();

    const proposed: ProposedObs[] = [];
    const newObservationIds: Id<"masteryObservations">[] = [];
    const perSession: Array<{
      sessionId: string;
      title: string;
      messages: number;
      observations: number;
      error?: string;
    }> = [];

    for (const s of sessions) {
      const context = await ctx.runQuery(
        internal.sessionHelpers.getSessionContext,
        { sessionId: s.sessionId },
      );
      if (!context || context.isTestDrive || context.chatHistory.length < 3) {
        perSession.push({
          sessionId: s.sessionId,
          title: s.title,
          messages: s.messageCount,
          observations: 0,
          error: !context
            ? "no context"
            : context.isTestDrive
              ? "test drive"
              : "too few messages",
        });
        continue;
      }

      const transcript = buildObserverTranscript(context.chatHistory);
      // Independent fresh pass: no prior observations / seeds / signals.
      const userMessage = buildObserverUserMessage(transcript, [], [], [], context);

      const observations: typeof proposed = [];
      try {
        const response = await anthropic.messages.create({
          model: observerModel,
          max_tokens: 4096,
          system: buildObserverSystemPrompt(context.institutionProfile),
          tools: [OBSERVER_TOOL],
          tool_choice: { type: "tool", name: "record_observations" },
          messages: [{ role: "user", content: userMessage }],
        });
        await recordAnthropicUsage(ctx, {
          source: "mastery-rederive",
          role: ROLES.SCHOLAR,
          model: observerModel,
          usage: response.usage,
          sessionId: s.sessionId as Id<"sessions">,
          institutionId,
        });
        const result = parseObserverResponse(response.content);
        const obs = result?.observations ?? [];

        for (const o of obs) {
          const row: ProposedObs = {
            conceptLabel: o.conceptLabel,
            domain: o.domain,
            masteryLevel: o.masteryLevel,
            evidenceType: o.evidenceType || "direct_demonstration",
          };
          proposed.push(row);
          observations.push(row);

          if (!dryRun) {
            const obsId = await ctx.runMutation(
              internal.masteryObservations.record,
              {
                scholarId,
                conceptLabel: o.conceptLabel,
                domain: o.domain,
                sessionId: s.sessionId,
                transcriptExcerpt: o.transcriptExcerpt || "",
                masteryLevel: o.masteryLevel,
                confidenceScore: o.confidenceScore,
                evidenceSummary: o.evidenceSummary,
                evidenceType: o.evidenceType || "direct_demonstration",
                attemptContext: o.attemptContext || "conversation",
                studentInitiated: o.studentInitiated ?? false,
                standardNotations: o.standardNotations ?? undefined,
                // Clean rebuild — no carried-over supersede pointers; the
                // write-path dedup net handles cross-session duplicates.
                supersedesObservationId: undefined,
                fluencyLevel:
                  o.fluencyLevel && o.fluencyLevel >= 1 && o.fluencyLevel <= 3
                    ? o.fluencyLevel
                    : undefined,
                // Stamp WHEN the learning happened, not the re-run time.
                observedAt: s.observedAt,
              },
            );
            newObservationIds.push(obsId);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perSession.push({
          sessionId: s.sessionId,
          title: s.title,
          messages: s.messageCount,
          observations: 0,
          error: `observer call failed: ${message}`,
        });
        continue;
      }

      perSession.push({
        sessionId: s.sessionId,
        title: s.title,
        messages: s.messageCount,
        observations: observations.length,
      });
    }

    // Optional standards mapping on the freshly-written rows.
    if (!dryRun && args.mapStandards && newObservationIds.length > 0) {
      try {
        await ctx.runAction(internal.standardsMapper.mapToStandards, {
          scholarId,
          observationIds: newObservationIds,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[masteryReDerive] standards mapping failed (non-fatal): ${message}`);
      }
    }

    // AFTER: real run reads the true current record; dry-run simulates the net.
    let afterStats;
    if (dryRun) {
      afterStats = summarize(simulateNet(proposed));
    } else {
      const after = await ctx.runQuery(
        internal.masteryObservations.currentByScholar,
        { scholarId },
      );
      afterStats = summarize(
        after.map((o) => ({
          conceptLabel: o.conceptLabel,
          domain: o.domain,
          masteryLevel: o.masteryLevel,
          evidenceType: o.evidenceType,
        })),
      );
    }

    return {
      dryRun,
      scholarId,
      scholarName: scholarName ?? null,
      model: observerModel,
      sessionsAnalyzable: totalAnalyzable,
      sessionsProcessed: sessions.length,
      rawProposedObservations: proposed.length,
      before: beforeStats,
      after: afterStats,
      perSession,
      note: dryRun
        ? "DRY RUN — nothing written. 'after' simulates the write-path dedup net; the real record may be marginally smaller. Run purgeScholar then this with dryRun:false to apply."
        : "Applied. 'after' is the live current record.",
    };
  },
});
