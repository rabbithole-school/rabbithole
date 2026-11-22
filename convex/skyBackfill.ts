/**
 * The one backfill that lays out each existing kid's first Sky (TRA-699,
 * Quests rebuild PR 8b). Run by hand by the controller only: after a rehearsal
 * on a copy, a production snapshot and a dry run, confirming the deployment
 * slug, and followed by a read-back. Nothing here runs on its own: no cron, no
 * deploy hook, no trigger.
 *
 * In scope: scholar accounts that could open their sky, i.e. whose school
 * resolves (lib/scholarEnrollment.ts, the school 8a reads a sky for), exists,
 * and is not suspended for them (lib/access.ts, the check every signed-in read
 * makes). Program guests who can sign in are in. Everyone else is counted as
 * skipped, by reason, and never read further.
 *
 *   1. `dryRun` (an action that only calls read-only queries, one per
 *      scholar): what the run would do, in totals and per school, plus every
 *      label the tidy would change or hide, as before → after pairs. The
 *      labels are kids' words: they are returned to the caller's terminal
 *      only, never logged.
 *   2. `run` (an action, one page of scholars per call, inside a time
 *      budget): 8a's per-kid refresh for every scholar in scope. The refresh
 *      is idempotent: it adds missing sources, embeds rows with no vector and
 *      places unplaced ones, and never moves a placed star, so a sky left part
 *      done by an earlier failure picks up where it stopped. It writes only
 *      `skyStars` and `skyStarEmbeddings` (and, if a kid's refresh fails, the
 *      retry 8a schedules for that kid).
 *   3. `readBack` (a query): stars per school (total, placed, unplaced,
 *      hidden, bright, without an embedding) and, given a scholar id, that
 *      kid's sky exactly as `skyStars.forSelf` returns it.
 *
 * What earns a star is 8a's rule (lib/skySources.ts), unchanged, and so is
 * the per-kid cap (lib/skyRefresh.ts `planStarAdditions`).
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { evaluateInstitutionSuspension } from "./lib/access";
import { EMBED_NETWORK_MESSAGE, EMBED_TIMEOUT_MESSAGE } from "./lib/embeddings";
import { ROLES } from "./lib/roles";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import { tidySkyLabel } from "./lib/skyLabel";
import {
  isWaitingStar,
  planStarAdditions,
  skyStarRows,
  starSourceIsTheirs,
} from "./lib/skyRefresh";
import { collectStarSourceDetails, questStarSource, skySchoolId } from "./lib/skySources";
import { refreshScholarSky, skyForScholar, type SkyStar } from "./skyStars";

/** Scholars listed per page. Listing is light (an account, its school);
 *  each scholar's sources are then read in a query of its own. */
const DEFAULT_PAGE_SIZE = 25;
/** Scholars refreshed per `run` call: each refresh may call the embedding
 *  service, and the call also stops at RUN_TIME_BUDGET_MS. */
const DEFAULT_RUN_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 50;
/** `run` starts no new kid after this long, and returns where to resume, so
 *  a slow provider can't run it into the action's 10-minute limit and lose
 *  the cursor or the report. */
export const RUN_TIME_BUDGET_MS = 5 * 60_000;

const pageArgs = {
  cursor: v.optional(v.union(v.string(), v.null())),
  pageSize: v.optional(v.number()),
};

function pageSizeOf(requested: number | undefined, fallback: number): number {
  const size = Math.floor(requested ?? fallback);
  return Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
}

// ─── Who is in scope ─────────────────────────────────────────────────

type SkipReason = "noSchool" | "schoolMissing" | "schoolSuspended";
type SkipCounts = Record<SkipReason, number>;

function emptySkips(): SkipCounts {
  return { noSchool: 0, schoolMissing: 0, schoolSuspended: 0 };
}

/** Could this scholar open their sky? Null when they could, else why not. */
async function skipReasonFor(ctx: QueryCtx, scholar: Doc<"users">): Promise<SkipReason | null> {
  const schoolId = await scholarInstitutionId(ctx, scholar._id);
  if (!schoolId) return "noSchool";
  const school = await ctx.db.get(schoolId);
  if (!school) return "schoolMissing";
  if (school.disabledAt !== undefined) return "schoolSuspended";
  if ((await evaluateInstitutionSuspension(ctx, scholar)).blocked) return "schoolSuspended";
  return null;
}

/** A scholar account in index order (`by_role`: creation time, then id), in
 *  scope or with why not. */
type ScholarEntry = { scholarId: Id<"users">; creationTime: number; skip: SkipReason | null };

/** One page of scholar accounts, each in scope or with why not. Reads only. */
export const scholarsPage = internalQuery({
  args: pageArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{ scholars: ScholarEntry[]; isDone: boolean; continueCursor: string }> => {
    const page = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .paginate({ cursor: args.cursor ?? null, numItems: pageSizeOf(args.pageSize, DEFAULT_PAGE_SIZE) });
    const scholars: ScholarEntry[] = [];
    for (const scholar of page.page) {
      scholars.push({
        scholarId: scholar._id,
        creationTime: scholar._creationTime,
        skip: await skipReasonFor(ctx, scholar),
      });
    }
    return { scholars, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

// ─── 1. The dry run ──────────────────────────────────────────────────

type KindCounts = { wonder: number; legacySeed: number; quest: number };

/** What the run would do, for a set of in-scope scholars. */
type DryRunTotals = {
  /** In scope with a star source or a star. */
  scholars: number;
  sources: KindCounts;
  /** Nothing to add, embed or place. */
  kidsComplete: number;
  kidsNeedingWork: number;
  starsToAdd: number;
  /** Sources the per-kid cap leaves out (the run adds none of them). */
  starsCapped: number;
  /** Unhidden rows, new or existing, with no embedding yet. */
  starsToEmbed: number;
  /** Unhidden rows, new or existing, not yet placed. */
  starsToPlace: number;
  brightQuests: number;
  labelsChanged: number;
  labelsHidden: number;
};

type LabelChange = { before: string; after: string; hidden: boolean };

function emptyTotals(): DryRunTotals {
  return {
    scholars: 0,
    sources: { wonder: 0, legacySeed: 0, quest: 0 },
    kidsComplete: 0,
    kidsNeedingWork: 0,
    starsToAdd: 0,
    starsCapped: 0,
    starsToEmbed: 0,
    starsToPlace: 0,
    brightQuests: 0,
    labelsChanged: 0,
    labelsHidden: 0,
  };
}

function addTotals(into: DryRunTotals, from: DryRunTotals): void {
  into.scholars += from.scholars;
  into.sources.wonder += from.sources.wonder;
  into.sources.legacySeed += from.sources.legacySeed;
  into.sources.quest += from.sources.quest;
  into.kidsComplete += from.kidsComplete;
  into.kidsNeedingWork += from.kidsNeedingWork;
  into.starsToAdd += from.starsToAdd;
  into.starsCapped += from.starsCapped;
  into.starsToEmbed += from.starsToEmbed;
  into.starsToPlace += from.starsToPlace;
  into.brightQuests += from.brightQuests;
  into.labelsChanged += from.labelsChanged;
  into.labelsHidden += from.labelsHidden;
}

type ScholarDryRun = {
  institutionId: Id<"institutions"> | null;
  totals: DryRunTotals;
  labelChanges: LabelChange[];
};

/**
 * One scholar's part of the dry run (in a query of its own, so a heavy kid
 * never shares a transaction's read limits with another), or null when they
 * have neither a star source nor a star. What the run's refresh would do: add
 * the sources `planStarAdditions` admits, and embed and place every unhidden
 * row still missing a vector or a position whose source still exists and is
 * theirs (the refresh's own write checks), whether or not that source still
 * earns a star. Reads only.
 */
export const dryRunScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }): Promise<ScholarDryRun | null> => {
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return null;
    const details = await collectStarSourceDetails(ctx, scholarId);
    const rows = await skyStarRows(ctx, scholarId);
    if (details.length === 0 && rows.length === 0) return null;
    const totals = emptyTotals();
    totals.scholars = 1;
    for (const detail of details) totals.sources[detail.kind]++;

    const plan = planStarAdditions(
      rows,
      details.map((detail) => ({ ...detail.ref, detail })),
    );
    totals.starsCapped = plan.capped;
    const labelChanges: LabelChange[] = [];
    for (const { detail } of plan.add) {
      totals.starsToAdd++;
      if (detail.bright) totals.brightQuests++;
      const before = detail.ref.text;
      const { label, hidden } = tidySkyLabel(before);
      if (hidden) {
        totals.labelsHidden++;
      } else {
        totals.starsToEmbed++;
        totals.starsToPlace++;
        if (label !== before) totals.labelsChanged++;
      }
      if (hidden || label !== before) labelChanges.push({ before, after: label, hidden });
    }
    for (const row of rows) {
      if (row.hidden) continue;
      const unplaced = isWaitingStar(row);
      const embedded = await ctx.db
        .query("skyStarEmbeddings")
        .withIndex("by_star", (q) => q.eq("starId", row._id))
        .first();
      if (!unplaced && embedded) continue;
      // The refresh writes a vector or a position only for a row whose
      // source still exists and is theirs.
      if (!(await starSourceIsTheirs(ctx, scholarId, row))) continue;
      if (!embedded) totals.starsToEmbed++;
      if (unplaced) totals.starsToPlace++;
    }
    const needsWork = totals.starsToAdd + totals.starsToEmbed + totals.starsToPlace > 0;
    totals.kidsNeedingWork = needsWork ? 1 : 0;
    totals.kidsComplete = needsWork ? 0 : 1;
    return {
      institutionId: (await skySchoolId(ctx, scholarId)) ?? null,
      totals,
      labelChanges,
    };
  },
});

type PerInstitution = { institutionId: Id<"institutions"> | null } & DryRunTotals;

/**
 * The whole dry run: every page of scholars, each in-scope scholar read by
 * its own `dryRunScholar` query, added up. Calls queries only, so it writes
 * nothing. `labelChanges` holds kids' words for the controller's eyes: keep
 * it in the terminal (no commit, no log, no ticket).
 */
export const dryRun = internalAction({
  args: { pageSize: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    totals: DryRunTotals;
    perInstitution: PerInstitution[];
    skipped: SkipCounts;
    scholarsRead: number;
    pages: number;
    labelChanges: LabelChange[];
  }> => {
    const totals = emptyTotals();
    const skipped = emptySkips();
    const byInstitution = new Map<string, PerInstitution>();
    const labelChanges: LabelChange[] = [];
    let cursor: string | null = null;
    let scholarsRead = 0;
    let pages = 0;
    for (;;) {
      const page: { scholars: ScholarEntry[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.skyBackfill.scholarsPage, { cursor, pageSize: args.pageSize });
      pages++;
      scholarsRead += page.scholars.length;
      for (const { scholarId, skip } of page.scholars) {
        if (skip) {
          skipped[skip]++;
          continue;
        }
        const kid: ScholarDryRun | null = await ctx.runQuery(internal.skyBackfill.dryRunScholar, {
          scholarId,
        });
        if (!kid) continue;
        addTotals(totals, kid.totals);
        const key = kid.institutionId ?? "none";
        let school = byInstitution.get(key);
        if (!school) {
          school = { institutionId: kid.institutionId, ...emptyTotals() };
          byInstitution.set(key, school);
        }
        addTotals(school, kid.totals);
        labelChanges.push(...kid.labelChanges);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return {
      totals,
      perInstitution: [...byInstitution.values()],
      skipped,
      scholarsRead,
      pages,
      labelChanges,
    };
  },
});

// ─── 2. The run ──────────────────────────────────────────────────────

/** An error as the run reports it: never a kid's words. The embedding
 *  helper's failures name only a status or a fixed reason; a missing key
 *  names the setting; anything else reports its name. */
function errorWithoutContent(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^OpenAI embeddings request failed with status \d+$/.test(message)) return message;
  if (message === EMBED_TIMEOUT_MESSAGE || message === EMBED_NETWORK_MESSAGE) return message;
  if (message === "OPENAI_API_KEY not set on this deployment") return message;
  return error instanceof Error ? error.name : typeof error;
}

type RunTotals = {
  scholarsRead: number;
  kidsProcessed: number;
  /** Processed, and the refresh found nothing to add, embed or place. */
  kidsAlreadyComplete: number;
  skipped: SkipCounts;
  added: number;
  embedded: number;
  placed: number;
  firstLayouts: number;
  errors: { scholarId: Id<"users">; error: string }[];
};

/** Where a call stopped inside a page: the last scholar it handled, by the
 *  index's own order (creation time, then id), so a resume neither skips nor
 *  repeats anyone when accounts join or leave the list in between. */
const startAfterValidator = v.object({ creationTime: v.number(), scholarId: v.id("users") });
type StartAfter = { creationTime: number; scholarId: Id<"users"> };
type RunArgs = { cursor: string | null; startAfter: StartAfter | null; pageSize: number };

/** Is `entry` at or before `mark` in the index's order? */
function atOrBefore(entry: ScholarEntry, mark: StartAfter): boolean {
  if (entry.creationTime !== mark.creationTime) return entry.creationTime < mark.creationTime;
  return entry.scholarId <= mark.scholarId;
}

/**
 * Refresh one page of scholars: 8a's per-kid refresh for every one in scope,
 * one at a time, on the page that starts at `cursor`, after `startAfter` when
 * a call stopped inside this page. No new kid is started after
 * RUN_TIME_BUDGET_MS. Returns the page's totals and `nextArgs`, the exact
 * arguments for the next call (null once `isDone`): the next page, or the
 * rest of this one when the budget ran out. A kid whose refresh fails is
 * listed in `errors` by id and the run goes on; 8a has already scheduled that
 * kid's retry, and calling again retries it too.
 */
export const run = internalAction({
  args: { ...pageArgs, startAfter: v.optional(v.union(startAfterValidator, v.null())) },
  handler: async (
    ctx,
    args,
  ): Promise<RunTotals & { isDone: boolean; nextArgs: RunArgs | null }> => {
    const started = Date.now();
    const pageSize = pageSizeOf(args.pageSize, DEFAULT_RUN_PAGE_SIZE);
    const cursor = args.cursor ?? null;
    const page: { scholars: ScholarEntry[]; isDone: boolean; continueCursor: string } =
      await ctx.runQuery(internal.skyBackfill.scholarsPage, { cursor, pageSize });
    const totals: RunTotals = {
      scholarsRead: 0,
      kidsProcessed: 0,
      kidsAlreadyComplete: 0,
      skipped: emptySkips(),
      added: 0,
      embedded: 0,
      placed: 0,
      firstLayouts: 0,
      errors: [],
    };
    let last: StartAfter | null = args.startAfter ?? null;
    for (const entry of page.scholars) {
      if (args.startAfter && atOrBefore(entry, args.startAfter)) continue;
      if (Date.now() - started >= RUN_TIME_BUDGET_MS) {
        return { ...totals, isDone: false, nextArgs: { cursor, startAfter: last, pageSize } };
      }
      const { scholarId, skip } = entry;
      last = { creationTime: entry.creationTime, scholarId };
      totals.scholarsRead++;
      if (skip) {
        totals.skipped[skip]++;
        continue;
      }
      try {
        const result = await refreshScholarSky(ctx, scholarId);
        totals.kidsProcessed++;
        totals.added += result.added;
        totals.embedded += result.embedded;
        totals.placed += result.placed;
        if (result.layout === "first") totals.firstLayouts++;
        if (result.added === 0 && result.embedded === 0 && result.placed === 0) {
          totals.kidsAlreadyComplete++;
        }
      } catch (error) {
        totals.errors.push({ scholarId, error: errorWithoutContent(error) });
      }
    }
    return page.isDone
      ? { ...totals, isDone: true, nextArgs: null }
      : {
          ...totals,
          isDone: false,
          nextArgs: { cursor: page.continueCursor, startAfter: null, pageSize },
        };
  },
});

// ─── 3. The read-back ────────────────────────────────────────────────

type StarCounts = {
  total: number;
  placed: number;
  unplaced: number;
  hidden: number;
  bright: number;
  withoutEmbedding: number;
};

/**
 * Afterwards: for one page of scholar accounts in scope (the run's scope),
 * their stars per school (total, placed, unplaced (waiting to be placed),
 * hidden, bright, and unhidden stars with no embedding); the stars of
 * accounts out of scope, which the run never touches, counted apart by
 * reason; and, given `scholarId`, that kid's sky exactly as
 * `skyStars.forSelf` returns it, to spot-check without signing in as them.
 * Reads only.
 */
export const readBack = internalQuery({
  args: { ...pageArgs, scholarId: v.optional(v.id("users")) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    perInstitution: ({ institutionId: Id<"institutions"> | null; scholars: number } & StarCounts)[];
    outOfScope: Record<SkipReason, { scholars: number; stars: number }>;
    scholarsRead: number;
    isDone: boolean;
    continueCursor: string;
    sky: SkyStar[] | null;
  }> => {
    const page = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .paginate({ cursor: args.cursor ?? null, numItems: pageSizeOf(args.pageSize, DEFAULT_PAGE_SIZE) });
    const byInstitution = new Map<
      string,
      { institutionId: Id<"institutions"> | null; scholars: number } & StarCounts
    >();
    const outOfScope = {
      noSchool: { scholars: 0, stars: 0 },
      schoolMissing: { scholars: 0, stars: 0 },
      schoolSuspended: { scholars: 0, stars: 0 },
    };
    for (const scholar of page.page) {
      const rows = await skyStarRows(ctx, scholar._id);
      if (rows.length === 0) continue;
      const skip = await skipReasonFor(ctx, scholar);
      if (skip) {
        outOfScope[skip].scholars++;
        outOfScope[skip].stars += rows.length;
        continue;
      }
      const schoolId = await skySchoolId(ctx, scholar._id);
      const key = schoolId ?? "none";
      let school = byInstitution.get(key);
      if (!school) {
        school = {
          institutionId: schoolId ?? null,
          scholars: 0,
          total: 0,
          placed: 0,
          unplaced: 0,
          hidden: 0,
          bright: 0,
          withoutEmbedding: 0,
        };
        byInstitution.set(key, school);
      }
      school.scholars++;
      for (const row of rows) {
        school.total++;
        if (row.hidden) school.hidden++;
        if (row.x !== undefined) school.placed++;
        if (isWaitingStar(row)) school.unplaced++;
        if (row.unitId) {
          const unit = await ctx.db.get(row.unitId);
          const source = unit && (await questStarSource(ctx, scholar._id, schoolId, unit));
          if (source && source.shownAt !== null) school.bright++;
        }
        if (!row.hidden) {
          const embedded = await ctx.db
            .query("skyStarEmbeddings")
            .withIndex("by_star", (q) => q.eq("starId", row._id))
            .first();
          if (!embedded) school.withoutEmbedding++;
        }
      }
    }
    let sky: SkyStar[] | null = null;
    if (args.scholarId) {
      const scholar = await ctx.db.get(args.scholarId);
      sky = scholar && scholar.role === ROLES.SCHOLAR ? await skyForScholar(ctx, scholar) : [];
    }
    return {
      perInstitution: [...byInstitution.values()],
      outOfScope,
      scholarsRead: page.page.length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      sky,
    };
  },
});
