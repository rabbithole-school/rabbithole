/**
 * Scholar-facing daily map-movement receipt — a deterministic read over the
 * practice engine's durable transition stamps. ZERO model calls: it reads only
 * practiceMastery fluency/frontier events and nodeReveals, resolves their
 * knowledgeNode labels, and hands the plain rows to the pure helper in
 * lib/dailyRecap.ts.
 *
 * Redaction (this is a SCHOLAR read): it touches ONLY practiceMastery (and only
 * its non-sensitive fields — skillKey, source, and the transition stamps) plus
 * nodeReveals and knowledgeNodes labels. It never reads or returns
 * practiceErrorEvents, practiceTuneups, activity completions, misconception
 * fields, mastery levels, or the FIRe implicit-credit fields
 * (lastImplicitAt/implicitCount). See
 * .claude/rules/rabbithole-prompt-design.md + FAUX_RESEARCH §5.
 *
 * Gated exactly like practiceSkills.treeForScholar: requireTeacherOrSelf, plus
 * requireActiveScholarAccess for the teacher path (institution scoping).
 */
import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { buildDailyRecap, type DailyRecap } from "./lib/dailyRecap";
import { isFluent } from "./lib/practice/scheduler";
import {
  dayKeyForTimezone,
  dayStartForTimezone,
} from "../shared/institutionDay";
import { timeZoneForScholar } from "./lib/institutionTime";

const EMPTY_RECAP: DailyRecap = {
  practiced: [],
  practicedCount: 0,
  yoursNow: [],
  newOnMap: [],
  revealed: [],
  finished: [],
  hasAny: false,
};

export const forScholar = authedQuery({
  args: {
    scholarId: v.id("users"),
    // Legacy clients send device-local midnight. Kept optional for compatibility;
    // the server now derives the authoritative institution-local boundary.
    dayStart: v.optional(v.number()),
    // Subscription cache-buster changed by current clients at local midnight.
    dayKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DailyRecap> => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const now = Date.now();
    const timeZone = await timeZoneForScholar(ctx, args.scholarId);
    const currentDayKey = dayKeyForTimezone(now, timeZone);
    if (args.dayKey !== undefined && args.dayKey !== currentDayKey) {
      return EMPTY_RECAP;
    }
    const dayStart = dayStartForTimezone(now, timeZone);

    const [masteryRows, revealedRows] = await Promise.all([
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .collect(),
      ctx.db
        .query("nodeReveals")
        .withIndex("by_scholar_revealedAt", (q) =>
          q.eq("scholarId", args.scholarId).gte("revealedAt", dayStart),
        )
        .collect()
        // Every access crossing latches reveals (never un-reveal), but only
        // practice-earned ones are receipt-worthy — a valve-jump's inferred
        // credit opens the horizon without claiming "you did this today".
        .then((rows) => rows.filter((row) => row.source === "practice")),
    ]);

    // Only durable Knowledge Tree movement earns a receipt. Attempts and
    // activity completions belong to practice/session surfaces; they do not
    // create a Home celebration on their own.
    const candidateKeys = new Set<string>();
    for (const r of masteryRows) {
      if ((r.becameFluentAt ?? 0) >= dayStart && r.source === "practice") {
        candidateKeys.add(r.skillKey);
      }
      if ((r.frontierAdvancedAt ?? 0) >= dayStart) candidateKeys.add(r.skillKey);
    }
    for (const row of revealedRows) candidateKeys.add(row.nodeKey);

    // Short-circuit before label lookups when the map did not change today.
    if (candidateKeys.size === 0) {
      return EMPTY_RECAP;
    }

    // Resolve labels only for the skills that moved today — one point lookup per
    // candidate nodeKey (not the whole graph), fired in parallel.
    const candidateKeyList = [...candidateKeys];
    const candidateNodes = await Promise.all(
      candidateKeyList.map((key) =>
        ctx.db
          .query("knowledgeNodes")
          .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
          .first(),
      ),
    );
    const labelByKey = new Map<string, string>();
    candidateKeyList.forEach((key, i) => {
      const node = candidateNodes[i];
      if (node) labelByKey.set(key, node.label);
    });

    return buildDailyRecap({
      // Only the rows that moved today, and only the non-sensitive fields the
      // pure helper needs — never FIRe fields. `fluentNow` is the composite
      // GREEN claim (retention leg included) computed here where the full DB row
      // is available; the pure helper stays context-free.
      masteryRows: masteryRows
        .filter((r) => candidateKeys.has(r.skillKey))
        .map((r) => ({
          skillKey: r.skillKey,
          source: r.source,
          fluentNow: isFluent(r, { now }),
          becameFluentAt: r.becameFluentAt,
          frontierAdvancedAt: r.frontierAdvancedAt,
        })),
      revealedRows: revealedRows.map((row) => ({
        nodeKey: row.nodeKey,
        revealedAt: row.revealedAt,
      })),
      labelByKey,
      // Compatibility input: the released response still carries empty
      // practiced/finished fields for older native clients.
      completions: [],
      dayStart,
    });
  },
});
