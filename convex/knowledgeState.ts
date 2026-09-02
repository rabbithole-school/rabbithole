/**
 * Teacher-facing composed read model over practice state, observer evidence,
 * teacher corrections, and recurring practice misconceptions.
 */

import { v } from "convex/values";
import { teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import {
  isDue,
  isFluent,
  isProvisional,
  proficiencyFromReps,
  retention as retainedProbability,
} from "./lib/practice/scheduler";
import { openErrorPatterns } from "./lib/practice/errorFlags";
import { normalizeLabel } from "./lib/nodeDepthHelpers";
import { strandHeadlineFor } from "../shared/practiceDomainLabels";

export const forScholarNode = teacherQuery({
  args: {
    scholarId: v.id("users"),
    nodeKey: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const now = Date.now();

    const [practiceRow, observationRows] = await Promise.all([
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", args.scholarId).eq("skillKey", args.nodeKey),
        )
        .unique(),
      ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar_node", (q) =>
          q.eq("scholarId", args.scholarId).eq("nodeKey", args.nodeKey),
        )
        .collect(),
    ]);

    const currentObservations = observationRows
      .filter((observation) => !observation.isSuperseded)
      .sort((a, b) => b.observedAt - a.observedAt);
    const latest = currentObservations[0];
    const latestFluency = currentObservations.find(
      (observation) => observation.fluencyLevel !== undefined,
    );

    let teacherOverride = null;
    if (currentObservations.length > 0) {
      const currentIds = new Set(currentObservations.map((observation) => observation._id));
      const overrides = await ctx.db
        .query("teacherMasteryOverrides")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .collect();
      teacherOverride =
        overrides
          .filter((override) => currentIds.has(override.observationId))
          .sort((a, b) => b._creationTime - a._creationTime)[0] ?? null;
    }

    return {
      practice: practiceRow
        ? {
            band: proficiencyFromReps(practiceRow.repetition),
            repetition: practiceRow.repetition,
            halfLifeDays: practiceRow.halfLifeDays,
            retention: retainedProbability(practiceRow, now),
            due: isDue(practiceRow, now),
            source: practiceRow.source,
            becameFluentAt: practiceRow.becameFluentAt ?? null,
          }
        : null,
      observer: latest
        ? {
            masteryLevel: latest.masteryLevel,
            confidenceScore: latest.confidenceScore,
            evidenceCount: currentObservations.length,
            fluencyLevel: latestFluency?.fluencyLevel ?? null,
            latestAt: latest.observedAt,
          }
        : null,
      teacherOverride,
    };
  },
});

export const subjectRollup = teacherQuery({
  args: {
    scholarId: v.id("users"),
    domain: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const now = Date.now();

    const [nodes, masteryRows, errorEvents, allObservations] = await Promise.all([
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", args.domain))
        .collect(),
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", args.scholarId).eq("domain", args.domain),
        )
        .collect(),
      ctx.db
        .query("practiceErrorEvents")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", args.scholarId).eq("domain", args.domain),
        )
        .collect(),
      ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .collect(),
    ]);

    const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
    const masteryByKey = new Map(masteryRows.map((row) => [row.skillKey, row]));
    const nodesByStrand = new Map<string, typeof nodes>();
    for (const node of nodes) {
      const strand = node.strand ?? "";
      const bucket = nodesByStrand.get(strand);
      if (bucket) bucket.push(node);
      else nodesByStrand.set(strand, [node]);
    }

    const strands = [...nodesByStrand.entries()]
      .map(([strand, strandNodes]) => {
        strandNodes.sort(
          (a, b) =>
            (a.order ?? Number.MAX_SAFE_INTEGER) -
              (b.order ?? Number.MAX_SAFE_INTEGER) ||
            a.label.localeCompare(b.label),
        );
        const rows = strandNodes
          .map((node) => masteryByKey.get(node.nodeKey))
          .filter((row) => row !== undefined);
        const frontier = strandNodes.find(
          (node) => masteryByKey.get(node.nodeKey)?.frontier === true,
        );

        return {
          strand,
          strandHeadline: strandHeadlineFor(args.domain, strand),
          frontierSkill: frontier
            ? { key: frontier.nodeKey, label: frontier.label }
            : null,
          fluentCount: rows.filter((row) => isFluent(row, { now })).length,
          totalCount: strandNodes.length,
          dueCount: rows.filter((row) => isDue(row, now)).length,
          confirmingCount: rows.filter((row) => isProvisional(row)).length,
          firstOrder: strandNodes[0]?.order ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .sort(
        (a, b) =>
          a.firstOrder - b.firstOrder || a.strand.localeCompare(b.strand),
      )
      .map((summary) => ({
        strand: summary.strand,
        strandHeadline: summary.strandHeadline,
        frontierSkill: summary.frontierSkill,
        fluentCount: summary.fluentCount,
        totalCount: summary.totalCount,
        dueCount: summary.dueCount,
        confirmingCount: summary.confirmingCount,
      }));

    const eventsByNode = new Map<string, typeof errorEvents>();
    for (const event of errorEvents) {
      const bucket = eventsByNode.get(event.nodeKey);
      if (bucket) bucket.push(event);
      else eventsByNode.set(event.nodeKey, [event]);
    }
    const openMisconceptions = [...eventsByNode.entries()]
      .flatMap(([nodeKey, events]) =>
        openErrorPatterns(events, now).map((open) => ({
          nodeKey,
          skillLabel: nodeByKey.get(nodeKey)?.label ?? nodeKey,
          pattern: open.pattern,
          phrasing: open.phrasing,
          count14d: open.count,
          lastAt: open.lastAt,
        })),
      )
      .sort((a, b) => b.lastAt - a.lastAt);

    const domainNodeKeys = new Set(nodes.map((node) => node.nodeKey));
    const normalizedDomain = normalizeLabel(args.domain);
    const highlightByIdentity = new Map<
      string,
      (typeof allObservations)[number]
    >();
    for (const observation of allObservations
      .filter(
        (row) =>
          !row.isSuperseded &&
          (row.nodeKey
            ? domainNodeKeys.has(row.nodeKey)
            : normalizeLabel(row.domain) === normalizedDomain),
      )
      .sort((a, b) => b.observedAt - a.observedAt)) {
      const identity =
        observation.nodeKey ?? normalizeLabel(observation.conceptLabel);
      if (!highlightByIdentity.has(identity)) {
        highlightByIdentity.set(identity, observation);
      }
    }
    const observerHighlights = [...highlightByIdentity.values()].map(
      (observation) => ({
        conceptLabel: observation.conceptLabel,
        ...(observation.nodeKey ? { nodeKey: observation.nodeKey } : {}),
        masteryLevel: observation.masteryLevel,
        latestAt: observation.observedAt,
      }),
    );

    return {
      strands,
      openMisconceptions,
      observerHighlights,
    };
  },
});
