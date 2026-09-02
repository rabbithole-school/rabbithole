import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id, type Doc } from "./_generated/dataModel";
import { authedAction, authedQuery, teacherMutation } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { deriveGrowthStories } from "./lib/growthStories";
import {
  recapLinesFromGrowthStories,
  recapLinesFromSessionObservations,
  tinySessionRecap,
} from "./lib/sessionRecap";
import { expectedBloomForStandard, fourStop, type BloomStop } from "./lib/bloomRigor";
import { conceptLabelsNearDuplicate, AUTO_MERGE_THRESHOLD } from "./lib/conceptLabels";
import { requireActiveScholarAccess } from "./lib/access";
import { normalizeLabel } from "./lib/nodeDepthHelpers";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "./seed/wholeNumberArithmeticGraph";
import { pcmDimensionValidator } from "./lib/pcm";
import {
  loadKnowledgeNodes,
  matchObservationToDeclaredTargets,
  matchObservationToKnowledgeNode,
  resolveObservationNodeKey,
} from "./lib/knowledgeNodeResolver";

// Write-path dedup BACKSTOP for the observer's mastery record. Supersession is
// otherwise 100% model-directed, and at scale the model under-consolidates —
// near-duplicate labels pile up (a real prod session reached 77 current
// observations). After a new observation is written, auto-supersede any current
// same-scholar, same-domain observation whose label is a lexical near-duplicate
// the model didn't already collapse, keeping the new (freshest, now better-
// calibrated) row. The prompt's consolidation rules remain the primary, semantic
// mechanism; this only guarantees a structural floor. Misconceptions are exempt
// (their own open/addressed lifecycle). See evals/observer/FINDINGS-rigor.md.
//
// Mode via OBSERVER_DEDUP_MODE env (default "enforce"): "enforce" supersedes,
// "shadow" only logs what it WOULD do, "off" disables. Flippable in the Convex
// dashboard with no redeploy.
//
// Exported so post-hoc writers that insert masteryObservations WITHOUT going
// through `record` (e.g. convex/gameObserver.ts, whose nodeKey comes from a
// candidate-enforced verify rather than label resolution) can still reuse this
// structural floor after their own inserts. Keep it a plain helper, not a
// Convex function — it runs inside the caller's mutation transaction.
export async function autoConsolidateDuplicates(
  ctx: MutationCtx,
  args: { scholarId: Id<"users">; domain: string; newId: Id<"masteryObservations">; conceptLabel: string; evidenceType: string },
): Promise<void> {
  const mode = process.env.OBSERVER_DEDUP_MODE ?? "enforce";
  if (mode === "off") return;
  // Misconceptions carry their own lifecycle — never auto-merge them.
  if (args.evidenceType === "misconception_signal") return;

  const sameBand = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_domain", (q) => q.eq("scholarId", args.scholarId).eq("domain", args.domain))
    .collect();

  for (const old of sameBand) {
    if (old._id === args.newId) continue;
    if (old.isSuperseded) continue;
    if (old.evidenceType === "misconception_signal") continue;
    if (!conceptLabelsNearDuplicate(old.conceptLabel, args.conceptLabel, AUTO_MERGE_THRESHOLD)) continue;
    if (mode === "shadow") {
      console.log(`[dedup:shadow] would supersede "${old.conceptLabel}" (${old.masteryLevel}) ← "${args.conceptLabel}"`);
      continue;
    }
    await ctx.db.patch(old._id, { isSuperseded: true, autoSuperseded: true });
    console.log(`[dedup] auto-superseded near-duplicate "${old.conceptLabel}" (${old.masteryLevel}) ← "${args.conceptLabel}"`);
  }
}

/**
 * Record a mastery observation (called by the observer action).
 * Handles supersession: if supersedesObservationId is provided,
 * marks the old observation as superseded.
 */
export const record = internalMutation({
  args: {
    scholarId: v.id("users"),
    conceptLabel: v.string(),
    domain: v.string(),
    // Optional, matching the schema field: session-LESS evidence is real (a
    // Workshop reflection anchors on a metaChat; a scanned work sample that
    // never materialized anchors on portfolioItemId below). Every ordinary
    // observer/deliverable writer still passes a real session id.
    sessionId: v.optional(v.id("sessions")),
    // Anchor for evidence read straight off a scanned work sample with no
    // session (convex/portfolioAssess.ts). Never set together with sessionId.
    portfolioItemId: v.optional(v.id("portfolioItems")),
    transcriptExcerpt: v.string(),
    masteryLevel: v.number(),
    confidenceScore: v.number(),
    evidenceSummary: v.string(),
    evidenceType: v.string(),
    attemptContext: v.string(),
    studentInitiated: v.boolean(),
    standardNotations: v.optional(v.array(v.string())),
    supersedesObservationId: v.optional(v.string()),
    // Optional automaticity reading — set ONLY when the exchange genuinely
    // showed speed/ease. Stamped source "tutor-observed" + timestamped.
    fluencyLevel: v.optional(v.number()),
    // When re-deriving mastery from historical sessions (masteryReDerive), stamp
    // the observation with WHEN the learning happened (the session's time), not
    // the re-run time — otherwise every rebuilt row collapses to a single
    // timestamp and growth-story chronology is destroyed. Defaults to now().
    observedAt: v.optional(v.number()),
    // Optional PCM dimension tag (assessment-and-goals §4), set by the observer
    // only where clear-cut.
    pcmDimension: v.optional(pcmDimensionValidator),
  },
  handler: async (ctx, args) => {
    let nodeKey = await resolveObservationNodeKey(ctx, {
      conceptLabel: args.conceptLabel,
      domain: args.domain,
    });
    // Second chance: when the whole-graph match punts (ambiguity/no match),
    // retry against the session activity's DECLARED target nodes
    // (probeSkillKeys / problemSet.targetSkillKeys) — a shortlist where the
    // same precision-first tiers can be decisive. Designed-target attribution,
    // rung 1 of review/beast-academy-lessons.html §8.
    // A session-less observation (reflection / scanned work sample) has no
    // activity to shortlist against, so this second chance simply doesn't apply.
    if (!nodeKey && args.sessionId) {
      const session = await ctx.db.get(args.sessionId);
      const activity = session?.activityId ? await ctx.db.get(session.activityId) : null;
      const targetKeys = [
        ...(activity?.probeSkillKeys ?? []),
        ...(activity?.problemSet?.targetSkillKeys ?? []),
      ];
      if (targetKeys.length > 0) {
        nodeKey = matchObservationToDeclaredTargets(
          await loadKnowledgeNodes(ctx),
          targetKeys,
          { conceptLabel: args.conceptLabel, domain: args.domain },
        );
      }
    }

    // Resolve standard notations to IDs (if standards table is populated)
    let standardIds: Id<"standards">[] | undefined = undefined;
    if (args.standardNotations && args.standardNotations.length > 0) {
      const resolved = [];
      for (const notation of args.standardNotations) {
        let std = await ctx.db
          .query("standards")
          .withIndex("by_notation", (q) => q.eq("notation", notation))
          .first();
        if (!std) {
          std = await ctx.db
            .query("standards")
            .withIndex("by_asnId", (q) => q.eq("asnId", notation))
            .first();
        }
        if (std) resolved.push(std._id);
      }
      if (resolved.length > 0) standardIds = resolved;
    }

    // Handle observer-directed supersession
    if (args.supersedesObservationId) {
      try {
        const obsId = args.supersedesObservationId as Id<"masteryObservations">;
        const existing = await ctx.db.get(obsId);
        if (existing && !existing.isSuperseded) {
          await ctx.db.patch(obsId, { isSuperseded: true });
        }
      } catch {
        // Invalid ID — observer hallucinated. No-op.
      }
    }

    const newId = await ctx.db.insert("masteryObservations", {
      scholarId: args.scholarId,
      conceptLabel: args.conceptLabel,
      domain: args.domain,
      nodeKey,
      observedAt: args.observedAt ?? Date.now(),
      sessionId: args.sessionId,
      portfolioItemId: args.portfolioItemId,
      transcriptExcerpt: args.transcriptExcerpt,
      masteryLevel: args.masteryLevel,
      confidenceScore: args.confidenceScore,
      evidenceSummary: args.evidenceSummary,
      evidenceType: args.evidenceType,
      attemptContext: args.attemptContext,
      studentInitiated: args.studentInitiated,
      standardIds,
      supersedesId: args.supersedesObservationId
        ? (args.supersedesObservationId as Id<"masteryObservations">)
        : undefined,
      isSuperseded: false,
      pcmDimension: args.pcmDimension,
      // Automaticity, only when the observer actually saw speed/ease (most
      // observations omit it — a normal chat is a weak fluency sensor).
      ...(args.fluencyLevel
        ? {
            fluencyLevel: args.fluencyLevel,
            fluencySource: "tutor-observed",
            fluencyObservedAt: Date.now(),
          }
        : {}),
    });

    // Backstop: collapse any near-duplicate the model didn't supersede itself.
    await autoConsolidateDuplicates(ctx, {
      scholarId: args.scholarId,
      domain: args.domain,
      newId,
      conceptLabel: args.conceptLabel,
      evidenceType: args.evidenceType,
    });

    return newId;
  },
});

/**
 * Get current (non-superseded) observations for a scholar.
 * Used by the observer to make supersession decisions.
 */
export const currentByScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false)
      )
      .collect();
  },
});

/**
 * Teacher view: current observations for a scholar, grouped by domain.
 */
/**
 * Flat list of current (non-superseded) mastery observations for a
 * scholar, sorted most recent first. Used by the unit progress
 * dashboard's scholar drawer.
 */
export const listForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const obs = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();
    const sorted = obs.sort((a, b) => b.observedAt - a.observedAt);
    // Attach each observation's four-stop position vs its standard's own bar,
    // so the feed's mastery marker can colour by met/beyond (null = unmapped).
    const stdCache = new Map<string, string | null>();
    return await Promise.all(
      sorted.map(async (o) => {
        const sid = o.standardIds?.[0];
        let stop: BloomStop | null = null;
        if (sid) {
          const k = sid as unknown as string;
          let desc = stdCache.get(k);
          if (desc === undefined) {
            const std = await ctx.db.get(sid);
            desc = std?.description ?? null;
            stdCache.set(k, desc);
          }
          if (desc) stop = fourStop(o.masteryLevel, expectedBloomForStandard(desc));
        }
        return { ...o, stop };
      }),
    );
  },
});

/**
 * The full per-concept evidence record reached BY OBSERVATION ID — so a feed
 * row (or a deep link, ?obs=<id>) can open the exact same record the Mastery
 * tab / Tree node show. Resolves the observation, then returns every current+
 * superseded observation sharing its conceptLabel (newest first) + the override.
 */
export const inspectByObservation = authedQuery({
  args: { observationId: v.id("masteryObservations") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.observationId);
    if (!target) return null;
    const isTeacher = requireTeacherOrSelf(ctx.user, target.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, target.scholarId);

    const allForScholar = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", target.scholarId))
      .collect();
    const forConcept = allForScholar
      .filter((o) => o.conceptLabel === target.conceptLabel)
      .sort((a, b) => b.observedAt - a.observedAt);

    const current = forConcept.find((o) => !o.isSuperseded);
    let teacherOverride = null;
    if (current) {
      teacherOverride = await ctx.db
        .query("teacherMasteryOverrides")
        .withIndex("by_observation", (q) => q.eq("observationId", current._id))
        .first();
    }
    return { observations: forConcept, teacherOverride, conceptLabel: target.conceptLabel };
  },
});

export const byScholarDomain = authedQuery({
  args: { scholarId: v.id("users"), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false)
      )
      .collect();

    const filtered = args.domain
      ? observations.filter((o) => o.domain === args.domain)
      : observations;

    const byDomain: Record<string, typeof filtered> = {};
    for (const obs of filtered) {
      if (!byDomain[obs.domain]) byDomain[obs.domain] = [];
      byDomain[obs.domain].push(obs);
    }

    return byDomain;
  },
});

/**
 * Inspect a concept's full observation history (all versions).
 */
export const inspectConcept = authedQuery({
  args: {
    scholarId: v.id("users"),
    conceptLabel: v.string(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const allForScholar = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const forConcept = allForScholar
      .filter((o) => o.conceptLabel === args.conceptLabel)
      .sort((a, b) => b.observedAt - a.observedAt);

    // Get teacher override if any
    const current = forConcept.find((o) => !o.isSuperseded);
    let teacherOverride = null;
    if (current) {
      teacherOverride = await ctx.db
        .query("teacherMasteryOverrides")
        .withIndex("by_observation", (q) =>
          q.eq("observationId", current._id)
        )
        .first();
    }

    return { observations: forConcept, teacherOverride };
  },
});

// The same per-concept evidence record, but keyed by a STANDARD instead of a
// concept label — so the Knowledge Tree (whose nodes ARE standards) can open
// the exact evidence the Mastery tab shows, reached from the map. Returns the
// observations whose standardIds include this standard, newest first, plus the
// current override (same shape as inspectConcept).
export const inspectStandard = authedQuery({
  args: {
    scholarId: v.id("users"),
    standardId: v.id("standards"),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const allForScholar = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const forStandard = allForScholar
      .filter((o) => (o.standardIds ?? []).some((sid) => sid === args.standardId))
      .sort((a, b) => b.observedAt - a.observedAt);

    const current = forStandard.find((o) => !o.isSuperseded);
    let teacherOverride = null;
    if (current) {
      teacherOverride = await ctx.db
        .query("teacherMasteryOverrides")
        .withIndex("by_observation", (q) => q.eq("observationId", current._id))
        .first();
    }

    return { observations: forStandard, teacherOverride };
  },
});

/**
 * Open (un-addressed) misconception observations that resolve onto a given map
 * node — for the node drawer. TEACHER-ONLY detail (misconceptions are redacted
 * from the scholar's own view, mirroring nodeReadingsForScholar's flag). Matches
 * an observation to the node the same way nodeReadingsForScholar does:
 * normalizeLabel(conceptLabel) === node.normalizedLabel || === node.nodeKey.
 */
export const openMisconceptionsForNode = authedQuery({
  args: { scholarId: v.id("users"), nodeKey: v.string() },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    // Misconception DETAIL is teacher-only — a scholar viewing their own map
    // never sees it (same redaction as the map flag).
    if (!isTeacher) return { misconceptions: [] };
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.nodeKey))
      .first();
    const targets = new Set<string>([normalizeLabel(args.nodeKey)]);
    if (node?.normalizedLabel) targets.add(node.normalizedLabel);
    if (node?.nodeKey) targets.add(node.nodeKey);

    const rows = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const misconceptions = rows
      .filter(
        (o) =>
          !o.isSuperseded &&
          o.evidenceType === "misconception_signal" &&
          o.misconceptionStatus !== "addressed" &&
          targets.has(normalizeLabel(o.conceptLabel)),
      )
      .sort((a, b) => b.observedAt - a.observedAt)
      .map((o) => ({
        _id: o._id,
        conceptLabel: o.conceptLabel,
        evidenceSummary: o.evidenceSummary,
        transcriptExcerpt: o.transcriptExcerpt,
        misconceptionNote: o.misconceptionNote ?? null,
        observedAt: o.observedAt,
        confidenceScore: o.confidenceScore,
      }));

    return { misconceptions };
  },
});

/**
 * Current observations that have linked standards, for a scholar.
 * Used by StandardsTab for efficient initial load.
 */
export const withStandardsByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false)
      )
      .collect();

    return observations.filter(
      (o) => o.standardIds && o.standardIds.length > 0
    );
  },
});

/**
 * Get all current observations that have no standardIds linked (for backfill).
 */
export const unmappedObservations = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("masteryObservations").collect();
    return all.filter(
      (o) => !o.isSuperseded && (!o.standardIds || o.standardIds.length === 0)
    );
  },
});

/**
 * Get all current (non-superseded) observations regardless of standardIds (for re-backfill).
 */
export const allCurrentObservations = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("masteryObservations").collect();
    return all.filter((o) => !o.isSuperseded);
  },
});

/**
 * Clear standardIds on an observation (for re-backfill).
 */
export const clearStandardIds = internalMutation({
  args: { observationId: v.id("masteryObservations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.observationId, { standardIds: undefined });
  },
});

/**
 * Get a single observation by ID (used by standards mapper).
 */
export const getById = internalQuery({
  args: { observationId: v.id("masteryObservations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.observationId);
  },
});

/**
 * Patch standardIds onto an existing observation (used by standards mapper).
 */
export const patchStandardIds = internalMutation({
  args: {
    observationId: v.id("masteryObservations"),
    standardIds: v.array(v.id("standards")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.observationId, {
      standardIds: args.standardIds,
    });
  },
});

/**
 * The teacher's fluency (automaticity) reading on a node's evidence — the
 * highest-trust source for "knows it but slow / fluent / automatic" where we
 * have no instrument. 1 = effortful, 2 = fluent, 3 = automatic; null clears it.
 * Stamps fluencySource "teacher" + a timestamp so it can age out (automaticity
 * decays without practice).
 */
export const setFluency = teacherMutation({
  args: {
    observationId: v.id("masteryObservations"),
    fluencyLevel: v.union(v.literal(1), v.literal(2), v.literal(3), v.null()),
  },
  handler: async (ctx, args) => {
    const obs = await ctx.db.get(args.observationId);
    if (!obs) throw new Error("Observation not found");
    await requireActiveScholarAccess(ctx, ctx.user, obs.scholarId);
    if (args.fluencyLevel === null) {
      await ctx.db.patch(args.observationId, {
        fluencyLevel: undefined,
        fluencySource: undefined,
        fluencyObservedAt: undefined,
      });
    } else {
      await ctx.db.patch(args.observationId, {
        fluencyLevel: args.fluencyLevel,
        fluencySource: "teacher",
        fluencyObservedAt: Date.now(),
      });
    }
  },
});

/**
 * Mark a misconception "addressed" or "open" (re-open). Non-misconception rows
 * don't have a resolution lifecycle. Setting "addressed" stamps who/when and an
 * optional note ("re-taught with the bowling-ball demo"); "open" clears the
 * stamps (reopen). Note: if the observer later re-observes the same
 * misconception, supersession inserts a fresh (open) row, so a kid who keeps
 * the wrong idea will resurface regardless of this flag.
 */
export const setMisconceptionStatus = teacherMutation({
  args: {
    observationId: v.id("masteryObservations"),
    status: v.union(v.literal("open"), v.literal("addressed")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const obs = await ctx.db.get(args.observationId);
    if (!obs) throw new Error("Observation not found");
    await requireActiveScholarAccess(ctx, ctx.user, obs.scholarId);
    if (obs.evidenceType !== "misconception_signal") {
      throw new Error(
        "Resolution lifecycle only applies to misconception observations",
      );
    }
    if (args.status === "addressed") {
      await ctx.db.patch(args.observationId, {
        misconceptionStatus: "addressed",
        misconceptionAddressedAt: Date.now(),
        misconceptionAddressedBy: ctx.user._id,
        misconceptionNote: args.note,
      });
    } else {
      await ctx.db.patch(args.observationId, {
        misconceptionStatus: "open",
        misconceptionAddressedAt: undefined,
        misconceptionAddressedBy: undefined,
        misconceptionNote: args.note,
      });
    }
  },
});

/**
 * Wave 3 §9 (misconception → targeted practice): a teacher-authored
 * misconception, created directly (no observer/transcript involved) — e.g.
 * from a live lesson, a worksheet, or a hallway conversation. Opens the SAME
 * lifecycle as an observer-written one (`setMisconceptionStatus` addresses
 * it later), and shows up everywhere current misconceptions do
 * (`listForScholar`, `MasteryTab`).
 *
 * `masteryObservations.sessionId` is a required FK, but a teacher's flag isn't
 * tied to any one transcript — reads are keyed by scholarId, so which session
 * anchors the row doesn't matter. Anchor to the scholar's most recent session
 * (mirrors `acceleration.devSeedAcceleration`'s "anchor session" pattern);
 * throws if the scholar has none yet (there's nothing to anchor to).
 *
 * Rated ~Remember(1.0) with high confidence, per the observer's own
 * misconception convention (prompts.ts: "Rate it ~Remember(1.0) with HIGH
 * confidence when the student stated it clearly") — a teacher directly
 * asserting a misconception is at least that confident.
 */
export const flagMisconception = teacherMutation({
  args: {
    scholarId: v.id("users"),
    conceptLabel: v.string(),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const conceptLabel = args.conceptLabel.trim();
    if (!conceptLabel) throw new Error("conceptLabel is required");
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const nodeKey = await resolveObservationNodeKey(ctx, { conceptLabel, domain });

    const anchorSession =
      (await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
        .order("desc")
        .first()) ??
      (await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
        .first());
    if (!anchorSession) {
      throw new Error("Scholar has no session yet to anchor this observation to");
    }

    return await ctx.db.insert("masteryObservations", {
      scholarId: args.scholarId,
      conceptLabel,
      domain,
      nodeKey,
      observedAt: Date.now(),
      sessionId: anchorSession._id,
      transcriptExcerpt: "",
      masteryLevel: 1,
      confidenceScore: 1,
      evidenceSummary: "Flagged directly by a teacher (no transcript excerpt).",
      evidenceType: "misconception_signal",
      attemptContext: "teacher-flagged",
      studentInitiated: false,
      isSuperseded: false,
      misconceptionStatus: "open",
    });
  },
});

const OBSERVATION_NODE_KEY_BACKFILL_BATCH_SIZE = 25;

/**
 * Gated maintenance operation for existing observer evidence. Each invocation
 * handles one cursor page and schedules the next; already-joined rows are
 * skipped, and unresolved concepts remain undefined for a safe rerun later.
 */
export const backfillObservationNodeKeys = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scanned: number;
    updated: number;
    isDone: boolean;
    continueCursor: string;
  }> => {
    const page = await ctx.db.query("masteryObservations").paginate({
      cursor: args.cursor ?? null,
      numItems: OBSERVATION_NODE_KEY_BACKFILL_BATCH_SIZE,
    });
    const unresolved = page.page.filter((observation) => !observation.nodeKey);
    const nodes = unresolved.length > 0 ? await loadKnowledgeNodes(ctx) : [];
    let updated = 0;

    for (const observation of unresolved) {
      const nodeKey = matchObservationToKnowledgeNode(nodes, observation);
      if (!nodeKey) continue;
      await ctx.db.patch(observation._id, { nodeKey });
      updated += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.masteryObservations.backfillObservationNodeKeys,
        { cursor: page.continueCursor },
      );
    }

    return {
      scanned: page.page.length,
      updated,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Growth stories for the learner's "My Learning" view. Derivation happens
 * server-side (lib/growthStories.ts) so mastery levels never reach the
 * scholar's client — the kid sees movement + their own transcript moment,
 * never a number (review/learner-parent-pedagogy.md).
 */
export const growthForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    return deriveGrowthStories(rows);
  },
});

/**
 * Scholar-facing recap for either activity completion or an explicit
 * conversational-session wrap-up. Reuses the same growth-story derivation as
 * /me, then keeps only stories whose latest observation landed in this session;
 * activity completion state is deliberately irrelevant. Returns kid-facing
 * lines — never levels, scores, or engagement.
 */
export const recapForSession = authedQuery({
  args: {
    sessionId: v.id("sessions"),
    // T2/T3 belong only to the scholar-owned explicit Wrap up action. Passive
    // activity completion keeps its existing premium growth-story-only posture.
    allowFallback: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    const isTeacher = requireTeacherOrSelf(ctx.user, session.userId);
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }
    const rows = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", session.userId))
      .collect();
    const latestObservedInSession = new Set(
      rows
        .filter(
          (row) =>
            row.sessionId === args.sessionId &&
            row.evidenceType !== "misconception_signal",
        )
        .map((row) => `${row.conceptLabel}\u0000${row.observedAt}`),
    );
    const sessionStories = deriveGrowthStories(rows).filter((story) =>
      latestObservedInSession.has(`${story.conceptLabel}\u0000${story.latestAt}`),
    );
    const growthLines = recapLinesFromGrowthStories(sessionStories);
    if (growthLines.length > 0) return growthLines;
    if (!args.allowFallback) return [];

    const currentSessionObservations = rows.filter(
      (row) =>
        row.sessionId === args.sessionId &&
        !row.isSuperseded &&
        row.evidenceType !== "misconception_signal",
    );
    const mirrorLines = recapLinesFromSessionObservations(
      currentSessionObservations,
    );
    return mirrorLines.length > 0 ? mirrorLines : tinySessionRecap();
  },
});

const RECAP_REFRESH_WINDOW_MS = 10 * 60 * 1000;

export const claimRecapRefresh = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (
      session.recapRequestedAt &&
      session.recapRequestedAt > Date.now() - RECAP_REFRESH_WINDOW_MS
    ) {
      return false;
    }

    // Reserve this refresh window before the action starts its model call.
    await ctx.db.patch(args.sessionId, { recapRequestedAt: Date.now() });
    return true;
  },
});

/**
 * Refresh the observer-backed recap for the current scholar's own session.
 * The session-row claim makes refreshes atomic and bounded across clients;
 * this deliberately does not change activity completion state.
 */
export const requestRecap = authedAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<boolean> => {
    const caller = await ctx.runQuery(api.users.currentUser, {});
    if (!caller) throw new Error("Not authenticated");

    const ownership = await ctx.runQuery(
      internal.sessionHelpers.getSessionOwnership,
      { sessionId: args.sessionId },
    );
    if (!ownership) throw new Error("Session not found");
    if (caller.role !== "scholar" || ownership.userId !== caller._id) {
      throw new Error("Forbidden");
    }

    const existing = await ctx.runQuery(
      api.masteryObservations.recapForSession,
      { sessionId: args.sessionId },
    );
    if (existing.some((line) => line.tier === "growth")) return true;

    const claimed = await ctx.runMutation(
      internal.masteryObservations.claimRecapRefresh,
      { sessionId: args.sessionId },
    );
    if (!claimed) return true;

    try {
      await ctx.runAction(internal.observer.analyzeSession, {
        sessionId: args.sessionId,
      });
    } catch (error) {
      // The ending belongs to the scholar. A model/provider failure may reduce
      // the recap to its current-observation or tiny-close fallback, never veto it.
      console.error("[requestRecap] observer refresh failed", error);
    }
    return true;
  },
});

/**
 * Get all observations for a project (for inline display in teacher view).
 */
export const bySession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    const isTeacher = requireTeacherOrSelf(ctx.user, session.userId);
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }
    return await ctx.db
      .query("masteryObservations")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
  },
});

/**
 * The referential cleanup a HARD-DELETE of mastery observations owes: a
 * teacher's override may target one, and a granuleEvidence row may cite one as
 * the misconception it addressed. Collected (not applied) so callers can report
 * "human data at risk" before destroying anything — purgeScholar's dry run.
 *
 * granuleEvidence has no by-field index for the pointer, so it's reached the
 * only way available: through the owning scholars' sessions.
 */
export async function collectObservationRefs(
  ctx: MutationCtx,
  rows: Doc<"masteryObservations">[],
): Promise<{
  overrideIds: Id<"teacherMasteryOverrides">[];
  granuleEvidenceIds: Id<"granuleEvidence">[];
}> {
  const idSet = new Set<string>(rows.map((r) => r._id));
  const overrideIds: Id<"teacherMasteryOverrides">[] = [];
  for (const r of rows) {
    const ovs = await ctx.db
      .query("teacherMasteryOverrides")
      .withIndex("by_observation", (q) => q.eq("observationId", r._id))
      .collect();
    for (const o of ovs) overrideIds.push(o._id);
  }

  const granuleEvidenceIds: Id<"granuleEvidence">[] = [];
  for (const scholarId of new Set(rows.map((r) => r.scholarId))) {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholarId))
      .collect();
    for (const s of sessions) {
      const ev = await ctx.db
        .query("granuleEvidence")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const e of ev) {
        if (
          e.misconceptionObservationId &&
          idSet.has(e.misconceptionObservationId)
        ) {
          granuleEvidenceIds.push(e._id);
        }
      }
    }
  }
  return { overrideIds, granuleEvidenceIds };
}

/**
 * Apply the cleanup above (delete the overrides, null the granule pointers).
 * Call BEFORE deleting the observations themselves.
 */
export async function purgeObservationRefs(
  ctx: MutationCtx,
  rows: Doc<"masteryObservations">[],
): Promise<{ overridesDeleted: number; granuleLinksNulled: number }> {
  const { overrideIds, granuleEvidenceIds } = await collectObservationRefs(
    ctx,
    rows,
  );
  for (const oid of overrideIds) await ctx.db.delete(oid);
  for (const gid of granuleEvidenceIds) {
    await ctx.db.patch(gid, { misconceptionObservationId: undefined });
  }
  return {
    overridesDeleted: overrideIds.length,
    granuleLinksNulled: granuleEvidenceIds.length,
  };
}

/**
 * One-time maintenance: HARD-DELETE every mastery observation for a scholar so
 * the record can be rebuilt fresh by `masteryReDerive`. Used to retire the
 * inflated/accumulated records the pre-#288 observer produced — superseding
 * (vs deleting) was rejected because growth stories (`growthForScholar`) and the
 * per-concept history views read ALL rows incl. superseded, so stale inflated
 * rows would distort both. Rollback is via a `convex export` snapshot, not these.
 *
 * Cascades cleanly (the devPurge pattern):
 *   • deletes each observation's teacherMasteryOverrides (a teacher's manual
 *     correction — surfaced in the dry-run count so a human can decide), and
 *   • nulls any granuleEvidence.misconceptionObservationId pointing at a deleted
 *     row (no by-field index → found by walking the scholar's sessions).
 *
 * DRY-RUN BY DEFAULT — reports what it WOULD destroy and changes nothing. The
 * counts of teacherOverrides + addressedMisconceptions are the "human data at
 * risk" gate: review them before running for real.
 */
export const purgeScholar = internalMutation({
  args: { scholarId: v.id("users"), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;

    const rows = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const misconceptions = rows.filter(
      (r) => r.evidenceType === "misconception_signal",
    );
    const addressedMisconceptions = misconceptions.filter(
      (r) => r.misconceptionStatus === "addressed",
    ).length;

    // What the delete would orphan: teacher overrides + granuleEvidence
    // misconception pointers (shared with portfolioAssess's scan teardown).
    const { overrideIds, granuleEvidenceIds: granuleToNull } =
      await collectObservationRefs(ctx, rows);

    if (!dryRun) {
      await purgeObservationRefs(ctx, rows);
      for (const r of rows) await ctx.db.delete(r._id);
    }

    return {
      dryRun,
      deletedObservations: rows.length,
      misconceptions: misconceptions.length,
      addressedMisconceptions,
      teacherOverridesDeleted: overrideIds.length,
      granuleEvidenceLinksNulled: granuleToNull.length,
    };
  },
});
