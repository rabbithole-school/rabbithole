import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { teacherMutation, teacherQuery } from "./lib/customFunctions";
import {
  requireActiveScholarAccess,
  requireScholarsAccessible,
} from "./lib/access";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { currentReportingPeriod } from "./reportingPeriods";
import { rosterPulseForScholarIds } from "./scholars";
import type { ScholarPulse } from "./lib/rosterPulse";
import {
  roundsAnchorFor,
  roundsWeekKey,
  roundsWeekLabel,
  roundsWeekWindow,
  type RoundsAnchor,
  type RoundsCadenceKind,
} from "../lib/roundsCadence";
import { DEFAULT_TIMEZONE } from "../shared/institutionDay";

/**
 * Rounds — the weekly staff pass over the roster.
 *
 * Once a week the teaching staff walk the roster one scholar at a time, look at
 * what actually happened, and WRITE A NOTE. The note is the artifact. It
 * replaced a four-option disposition picker, which recorded that a choice had
 * been made and nothing about what the adults said.
 *
 * This file persists exactly two things: which scholars were on the agenda, and
 * the note the team wrote for each. Every signal a teacher reads during Rounds
 * is rendered from its canonical table and never copied here, so there is
 * exactly one representation of a scholar's evidence in the product.
 *
 * The cadence is a school WEEK anchored to the institution's own meeting time
 * (`lib/roundsCadence.ts`), never a named weekday — one school meeting at the
 * end of a Thursday is a local habit, not a product rule.
 */

type ScopeCtx = (QueryCtx | MutationCtx) & { user: Doc<"users"> };
type ReviewMeeting = Doc<"scholarReviewMeetings">;
type ReviewEntry = Doc<"scholarReviewEntries">;

/** How far back the bounded index scans reach when linking weeks together. */
const CONTINUITY_SCAN = 24;

/**
 * Per-scholar caps on the week board's evidence reads. The week window already
 * bounds them; these stop one pathological week from making the projected board
 * unloadable for the whole room. Each is a cap on rows *inside* the week, so
 * hitting one means genuine overflow to report, never a silently truncated scan.
 */
const WEEK_OBSERVATION_SCAN = 40;
const WEEK_MASTERY_LIMIT = 12;
const WEEK_PRACTICE_SCAN = 400;

/** Longest note the room can write for one scholar in one week. */
const MAX_NOTE_LEN = 4_000;
const roundsCadenceValidator = v.union(
  v.literal("academic"),
  v.literal("sel"),
);

async function requireRoundsInstitution(
  ctx: ScopeCtx,
  requestedScope?: string,
): Promise<{ institution: Doc<"institutions">; institutionId: Id<"institutions"> }> {
  const lens = await resolveInstitutionLens(ctx, ctx.user, requestedScope);
  if (lens.scope === "all") {
    throw new Error("Choose one school before opening Rounds");
  }
  if (!lens.institution || lens.institution.disabledAt !== undefined) {
    throw new Error("Your school's Rabbithole access is paused.");
  }
  return {
    institution: lens.institution,
    institutionId: lens.institution._id,
  };
}

/**
 * Resolve the caller's institution and validate the reporting period against
 * it. Fail-closed in both directions:
 *
 *  - a period stamped with ANOTHER institution is rejected outright;
 *  - a legacy period with no `institutionId` is NOT a silent cross-tenant
 *    fallback. It is accepted only when the canonical resolver
 *    (`reportingPeriods.currentReportingPeriod` — the same helper the Whole
 *    Child page's `reportingPeriods.current` calls) hands this exact period to
 *    this caller. An arbitrary institution-less period id from the client is
 *    refused.
 *
 * Either way the institution comes from the caller's membership, never from the
 * period, so a shared global period can never make one school read another's
 * agenda.
 */
async function resolveScope(
  ctx: ScopeCtx,
  periodId: Id<"reportingPeriods">,
  requestedScope?: string,
) {
  const { institution, institutionId } = await requireRoundsInstitution(
    ctx,
    requestedScope,
  );
  const period = await ctx.db.get(periodId);
  if (!period) throw new Error("Reporting period not found");
  if (period.institutionId !== institutionId) {
    if (period.institutionId !== undefined) {
      throw new Error("Reporting period is not in your current context");
    }
    const canonical = await currentReportingPeriod(ctx, ctx.user, requestedScope);
    if (canonical?._id !== period._id) {
      throw new Error("Reporting period is not in your current context");
    }
  }
  return { institution, institutionId, period };
}

function scholarLabel(scholar: { name?: string; username?: string }): string {
  return scholar.name?.trim() || scholar.username?.trim() || "Scholar";
}

function timeZoneFor(institution: Doc<"institutions">): string {
  return institution.timeZone ?? DEFAULT_TIMEZONE;
}

function cadenceOf(meeting: ReviewMeeting): RoundsCadenceKind {
  return meeting.cadenceKind ?? "academic";
}

function anchorFor(
  institution: Doc<"institutions">,
  cadence: RoundsCadenceKind,
): RoundsAnchor | null {
  return roundsAnchorFor(institution, cadence);
}

/**
 * The scholars this teacher may put on the agenda, in roster order.
 *
 * Read through the institution+role index and then narrowed by the canonical
 * access boundary, so a roster row this caller could not open individually
 * never lands on their agenda either.
 */
async function rosterForInstitution(
  ctx: ScopeCtx,
  institutionId: Id<"institutions">,
) {
  const inInstitution = await ctx.db
    .query("users")
    .withIndex("by_institution_role", (q) =>
      q.eq("institutionId", institutionId).eq("role", "scholar"),
    )
    .collect();
  return inInstitution
    .filter((scholar) => scholar.enrollmentStanding !== "program_guest")
    .sort(
      (a, b) =>
        scholarLabel(a).localeCompare(scholarLabel(b)) ||
        String(a._id).localeCompare(String(b._id)),
    );
}

async function meetingFor(
  ctx: ScopeCtx,
  institutionId: Id<"institutions">,
  periodId: Id<"reportingPeriods">,
  cadence: RoundsCadenceKind,
  weekKey: string,
) {
  const explicit = await ctx.db
    .query("scholarReviewMeetings")
    .withIndex("by_institution_period_cadence_weekKey", (q) =>
      q
        .eq("institutionId", institutionId)
        .eq("periodId", periodId)
        .eq("cadenceKind", cadence)
        .eq("weekKey", weekKey),
    )
    .first();
  if (explicit || cadence === "sel") return explicit;

  // Widen-phase compatibility: rows written before `cadenceKind` existed are
  // academic. Keep the legacy index until the prod stamp migration has run.
  const legacy = await ctx.db
    .query("scholarReviewMeetings")
    .withIndex("by_institution_period_weekKey", (q) =>
      q
        .eq("institutionId", institutionId)
        .eq("periodId", periodId)
        .eq("weekKey", weekKey),
    )
    .collect();
  return legacy.find((meeting) => cadenceOf(meeting) === "academic") ?? null;
}

/**
 * The scholar's most recent Rounds entries in this institution, newest first.
 * Bounded: `by_scholar` is an index, and Rounds only ever needs the tail.
 */
async function recentEntriesForScholar(
  ctx: ScopeCtx,
  scholarId: Id<"users">,
  institutionId: Id<"institutions">,
  limit = CONTINUITY_SCAN,
): Promise<ReviewEntry[]> {
  return await ctx.db
    .query("scholarReviewEntries")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .order("desc")
    .filter((q) => q.eq(q.field("institutionId"), institutionId))
    .take(limit);
}

/** Load meetings by id once per request rather than once per entry. */
function meetingLoader(ctx: ScopeCtx) {
  const cache = new Map<string, ReviewMeeting | null>();
  return async (meetingId: Id<"scholarReviewMeetings">) => {
    const key = String(meetingId);
    if (!cache.has(key)) cache.set(key, await ctx.db.get(meetingId));
    return cache.get(key) ?? null;
  };
}

/** Load users by id once per request rather than once per row. */
function userLoader(ctx: ScopeCtx) {
  const cache = new Map<string, Doc<"users"> | null>();
  return async (userId: Id<"users">) => {
    const key = String(userId);
    if (!cache.has(key)) cache.set(key, await ctx.db.get(userId));
    return cache.get(key) ?? null;
  };
}

/** A note is either real words or nothing; whitespace is not a record. */
function noteOf(entry: ReviewEntry | null | undefined): string | null {
  const note = entry?.note?.trim();
  return note ? note : null;
}

/**
 * Entries for one meeting in their stable read order.
 *
 * `by_meeting_position` still supplies that order. `position` is vestigial and
 * no longer written, so for any meeting opened after that change the index
 * degrades to (meetingId, undefined, _id) — insertion order, which IS roster
 * order because `open` inserts in roster order. Rows from before the change
 * still carry a number and sort ahead of the undefined ones, which only matters
 * inside a single legacy meeting where it is that meeting's original order.
 */
async function entriesForMeeting(
  ctx: ScopeCtx,
  meetingId: Id<"scholarReviewMeetings">,
) {
  return await ctx.db
    .query("scholarReviewEntries")
    .withIndex("by_meeting_position", (q) => q.eq("meetingId", meetingId))
    .collect();
}

async function agendaForMeeting(ctx: ScopeCtx, meeting: ReviewMeeting) {
  const cadenceKind = cadenceOf(meeting);
  const entries = await entriesForMeeting(ctx, meeting._id);
  const loadMeeting = meetingLoader(ctx);
  const rows = await Promise.all(
    entries.map(async (entry) => {
      const scholar = await ctx.db.get(entry.scholarId);
      // Previous-week continuity: what the team said last time. This is the one
      // piece of stored Rounds state that earns its place — "what did we say
      // last week" is the whole point of a recurring meeting.
      const previousEntry = entry.previousEntryId
        ? await ctx.db.get(entry.previousEntryId)
        : null;
      const previousMeeting =
        previousEntry && previousEntry.institutionId === meeting.institutionId
          ? await loadMeeting(previousEntry.meetingId)
          : null;
      return {
        _id: entry._id,
        scholarId: entry.scholarId,
        scholarName: scholar ? scholarLabel(scholar) : "Scholar",
        note: noteOf(entry),
        noteVersion: entry.discussedAt ?? null,
        discussedAt: entry.discussedAt ?? null,
        previous:
          previousEntry &&
            previousMeeting &&
            cadenceOf(previousMeeting) === cadenceKind
            ? {
                weekKey: previousMeeting.weekKey,
                note: noteOf(previousEntry),
                discussedAt: previousEntry.discussedAt ?? null,
              }
            : null,
      };
    }),
  );
  return {
    configured: true,
    cadenceKind,
    weekKey: meeting.weekKey,
    weekLabel: roundsWeekLabel(meeting.weekKey),
    meeting: {
      _id: meeting._id,
      weekKey: meeting.weekKey,
      periodId: meeting.periodId,
      cadenceKind,
      createdAt: meeting.createdAt,
    },
    entries: rows,
  };
}

type AgendaEntryRow = Awaited<ReturnType<typeof agendaForMeeting>>["entries"][number];
type AgendaView = {
  configured: boolean;
  cadenceKind: RoundsCadenceKind;
  weekKey: string;
  weekLabel: string;
  meeting: Awaited<ReturnType<typeof agendaForMeeting>>["meeting"] | null;
  entries: AgendaEntryRow[];
};

/**
 * Read the persisted agenda for a school week. Passing no weekKey keeps the
 * browser and the server on the institution's clock rather than the laptop's.
 *
 * This is the light meeting-state read — does a meeting exist, is it open, what
 * did each row's note end up saying. The projected board reads `week` below.
 */
export const agenda = teacherQuery({
  args: {
    periodId: v.id("reportingPeriods"),
    weekKey: v.optional(v.string()),
    cadence: v.optional(roundsCadenceValidator),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AgendaView> => {
    const { institution, institutionId } = await resolveScope(
      ctx,
      args.periodId,
      args.scope,
    );
    const cadence = args.cadence ?? "academic";
    const anchor = anchorFor(institution, cadence);
    if (!anchor) {
      return {
        configured: false,
        cadenceKind: cadence,
        weekKey: "",
        weekLabel: "SEL rounds not configured",
        meeting: null,
        entries: [],
      };
    }
    const key =
      args.weekKey ??
      roundsWeekKey(Date.now(), timeZoneFor(institution), anchor);
    const meeting = await meetingFor(
      ctx,
      institutionId,
      args.periodId,
      cadence,
      key,
    );
    if (!meeting) {
      return {
        configured: true,
        cadenceKind: cadence,
        weekKey: key,
        weekLabel: roundsWeekLabel(key),
        meeting: null,
        entries: [],
      };
    }
    return await agendaForMeeting(ctx, meeting);
  },
});

// ── The week board ─────────────────────────────────────────────────────────

export type RoundsWeekOrder = "roster" | "age";

export type RoundsWeekObservation = {
  _id: Id<"observations">;
  type: "praise" | "concern" | "suggestion" | "intervention" | "note";
  note: string;
  /** The category-tag the staff aide filed it under, when it carries one. The
   *  SEL lens quotes the category-tagged + concern/intervention slice verbatim;
   *  the academic lens ignores it. */
  category:
    | "execFunction"
    | "socialEmotional"
    | "collaboration"
    | "passions"
    | "other"
    | null;
  weight: "minor" | "major";
  at: number;
  teacherName: string | null;
};

export type RoundsWeekMastery = {
  _id: Id<"masteryObservations">;
  conceptLabel: string;
  domain: string;
  masteryLevel: number;
  evidenceType: string;
  attemptContext: string;
  observedAt: number;
};

export type RoundsWeekPractice = {
  attempts: number;
  correct: number;
  nodes: number;
  lastAttemptAt: number | null;
};

export type RoundsWeekGuidance = {
  _id: Id<"teacherDirectives">;
  label: string;
  content: string;
  /** null == standing. */
  expiresAt: number | null;
  fromThisMeeting: boolean;
  updatedAt: number;
};

export type RoundsWeekPrevious = {
  weekKey: string;
  weekLabel: string;
  note: string | null;
  discussedAt: number | null;
};

export type RoundsWeekScholar = {
  scholarId: Id<"users">;
  scholarName: string;
  dateOfBirth: string | null;
  /** null until the week's meeting has been opened. */
  entryId: Id<"scholarReviewEntries"> | null;
  note: string | null;
  /** The optimistic-concurrency token `saveNote` expects handed back. */
  noteVersion: number | null;
  discussedAt: number | null;
  discussedByName: string | null;
  previous: RoundsWeekPrevious | null;
  observations: RoundsWeekObservation[];
  mastery: RoundsWeekMastery[];
  practice: RoundsWeekPractice;
  pulse: ScholarPulse | null;
  guidance: RoundsWeekGuidance[];
};

export type RoundsWeekView = {
  configured: boolean;
  cadenceKind: RoundsCadenceKind;
  institutionId: Id<"institutions">;
  weekKey: string;
  weekLabel: string;
  window: { startMs: number; endMs: number };
  order: RoundsWeekOrder;
  meeting: AgendaView["meeting"];
  scholars: RoundsWeekScholar[];
};

/** Age in years at `atMs` from an ISO "YYYY-MM-DD" birth date. */
function ageAt(dateOfBirth: string | undefined, atMs: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth ?? "");
  if (!match) return null;
  const born = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(born)) return null;
  return (atMs - born) / (365.2425 * 86_400_000);
}

/**
 * Everything the projected week board renders, for the whole roster, in one
 * query.
 *
 * `weekKey` is an ARGUMENT, never derived from `Date.now()` in here: a reactive
 * query that reads the clock re-runs unpredictably and could shift the week
 * under the room mid-meeting. Callers resolve "this week" once (`agenda`
 * returns the institution's current key) and then hold it.
 *
 * Teacher-gated AND institution-scoped: the auth wrapper checks role only, so
 * the roster is proven accessible to this caller before a single evidence read
 * happens. A role check alone would be a cross-tenant leak.
 */
export const week = teacherQuery({
  args: {
    periodId: v.id("reportingPeriods"),
    weekKey: v.string(),
    cadence: v.optional(roundsCadenceValidator),
    order: v.optional(v.union(v.literal("roster"), v.literal("age"))),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<RoundsWeekView> => {
    const { institution, institutionId } = await resolveScope(
      ctx,
      args.periodId,
      args.scope,
    );
    const cadence = args.cadence ?? "academic";
    const order: RoundsWeekOrder = args.order ?? "roster";
    const anchor = anchorFor(institution, cadence);
    if (!anchor) {
      return {
        configured: false,
        cadenceKind: cadence,
        institutionId,
        weekKey: args.weekKey,
        weekLabel: "SEL rounds not configured",
        window: { startMs: 0, endMs: 0 },
        order,
        meeting: null,
        scholars: [],
      };
    }
    const window = roundsWeekWindow(
      args.weekKey,
      timeZoneFor(institution),
      anchor,
    );

    const roster = await rosterForInstitution(ctx, institutionId);
    // The institution index is a tenancy filter, not an authorization one:
    // prove every roster row is genuinely readable in this caller's context.
    await requireScholarsAccessible(
      ctx,
      ctx.user,
      roster.map((scholar) => scholar._id),
    );

    const meeting = await meetingFor(
      ctx,
      institutionId,
      args.periodId,
      cadence,
      args.weekKey,
    );
    const entries = meeting ? await entriesForMeeting(ctx, meeting._id) : [];
    const entryByScholar = new Map<string, ReviewEntry>(
      entries.map((entry) => [String(entry.scholarId), entry]),
    );

    const loadMeeting = meetingLoader(ctx);
    const loadUser = userLoader(ctx);
    const pulses = await rosterPulseForScholarIds(
      ctx,
      roster.map((scholar) => scholar._id),
      window.startMs,
      window.endMs,
    );
    const pulseByScholar = new Map(pulses.map((pulse) => [pulse.scholarId, pulse]));

    const scholars: RoundsWeekScholar[] = [];
    for (const scholar of roster) {
      const entry = entryByScholar.get(String(scholar._id)) ?? null;

      const previousEntry = entry?.previousEntryId
        ? await ctx.db.get(entry.previousEntryId)
        : null;
      const previousMeeting =
        previousEntry && previousEntry.institutionId === institutionId
          ? await loadMeeting(previousEntry.meetingId)
          : null;

      // Week-bounded observations, newest first. Convex appends `_creationTime`
      // to every index, so `by_scholar` ranges on the week directly: the read is
      // exact no matter how far back the room steps.
      const observationRows = await ctx.db
        .query("observations")
        .withIndex("by_scholar", (q) =>
          q
            .eq("scholarId", scholar._id)
            .gte("_creationTime", window.startMs)
            .lt("_creationTime", window.endMs),
        )
        .order("desc")
        .take(WEEK_OBSERVATION_SCAN);
      const observations: RoundsWeekObservation[] = [];
      for (const row of observationRows) {
        const author = await loadUser(row.teacherId);
        observations.push({
          _id: row._id,
          type: row.type,
          note: row.note,
          category: row.category ?? null,
          weight: row.weight ?? "minor",
          at: row._creationTime,
          teacherName: author ? scholarLabel(author) : null,
        });
      }

      // Mastery movement inside the week, newest first.
      const masteryRows = await ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar_observedAt", (q) =>
          q
            .eq("scholarId", scholar._id)
            .gte("observedAt", window.startMs)
            .lt("observedAt", window.endMs),
        )
        .order("desc")
        .take(WEEK_MASTERY_LIMIT);
      const mastery: RoundsWeekMastery[] = masteryRows.map((row) => ({
        _id: row._id,
        conceptLabel: row.conceptLabel,
        domain: row.domain,
        masteryLevel: row.masteryLevel,
        evidenceType: row.evidenceType,
        attemptContext: row.attemptContext,
        observedAt: row.observedAt,
      }));

      // Practice rows are counted, never listed: the board wants "did they
      // practise, and how did it go", not a per-item transcript.
      const attemptRows = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) =>
          q
            .eq("scholarId", scholar._id)
            .gte("createdAt", window.startMs)
            .lt("createdAt", window.endMs),
        )
        .take(WEEK_PRACTICE_SCAN);
      const nodes = new Set<string>();
      let correct = 0;
      let lastAttemptAt: number | null = null;
      for (const row of attemptRows) {
        nodes.add(row.nodeKey);
        if (row.correct) correct += 1;
        // `createdAt` is optional on the table, but the index range above
        // already excluded rows without one.
        if (row.createdAt !== undefined) {
          lastAttemptAt = Math.max(lastAttemptAt ?? 0, row.createdAt);
        }
      }

      // Live guidance only. Inactive or already-expired guidance is not what the
      // tutor is currently being told, so the room must not read it as if it
      // were. Expiry is measured against the week being reviewed, so reopening
      // an old week shows the guidance that was live during it.
      const guidanceRows = await ctx.db
        .query("teacherDirectives")
        .withIndex("by_scholar_active", (q) =>
          q.eq("scholarId", scholar._id).eq("isActive", true),
        )
        .collect();
      const guidance: RoundsWeekGuidance[] = guidanceRows
        .filter((row) => row.expiresAt === undefined || row.expiresAt > window.startMs)
        .sort((a, b) => a._creationTime - b._creationTime)
        .map((row) => ({
          _id: row._id,
          label: row.label,
          content: row.content,
          expiresAt: row.expiresAt ?? null,
          fromThisMeeting:
            meeting !== null &&
            String(row.sourceMeetingId ?? "") === String(meeting._id),
          updatedAt: row.updatedAt,
        }));

      const discussedByUser = entry?.discussedBy
        ? await loadUser(entry.discussedBy)
        : null;

      scholars.push({
        scholarId: scholar._id,
        scholarName: scholarLabel(scholar),
        dateOfBirth: scholar.dateOfBirth ?? null,
        entryId: entry?._id ?? null,
        note: noteOf(entry),
        noteVersion: entry?.discussedAt ?? null,
        discussedAt: entry?.discussedAt ?? null,
        discussedByName: discussedByUser ? scholarLabel(discussedByUser) : null,
        previous:
          previousEntry &&
            previousMeeting &&
            cadenceOf(previousMeeting) === cadence
            ? {
                weekKey: previousMeeting.weekKey,
                weekLabel: roundsWeekLabel(previousMeeting.weekKey),
                note: noteOf(previousEntry),
                discussedAt: previousEntry.discussedAt ?? null,
              }
            : null,
        observations,
        mastery,
        practice: {
          attempts: attemptRows.length,
          correct,
          nodes: nodes.size,
          lastAttemptAt,
        },
        pulse: pulseByScholar.get(String(scholar._id)) ?? null,
        guidance,
      });
    }

    if (order === "age") {
      // Youngest first. A scholar with no recorded birth date sorts last rather
      // than pretending to be newborn.
      scholars.sort((a, b) => {
        const ageA = ageAt(a.dateOfBirth ?? undefined, window.startMs);
        const ageB = ageAt(b.dateOfBirth ?? undefined, window.startMs);
        if (ageA === null && ageB === null) {
          return a.scholarName.localeCompare(b.scholarName);
        }
        if (ageA === null) return 1;
        if (ageB === null) return -1;
        return ageA - ageB || a.scholarName.localeCompare(b.scholarName);
      });
    }

    return {
      configured: true,
      cadenceKind: cadence,
      institutionId,
      weekKey: args.weekKey,
      weekLabel: roundsWeekLabel(args.weekKey),
      window,
      order,
      meeting: meeting
        ? {
            _id: meeting._id,
            weekKey: meeting.weekKey,
            periodId: meeting.periodId,
            cadenceKind: cadenceOf(meeting),
            createdAt: meeting.createdAt,
          }
        : null,
      scholars,
    };
  },
});

/**
 * The scholar's newest earlier-week entry in this institution + cadence, so the
 * continuity chain survives a reporting-period boundary and never points
 * forward. Extracted from the old `open` so the note-write's implicit
 * materialization uses the exact same linking.
 */
async function continuityPreviousEntry(
  ctx: ScopeCtx,
  loadMeeting: ReturnType<typeof meetingLoader>,
  scholarId: Id<"users">,
  institutionId: Id<"institutions">,
  cadence: RoundsCadenceKind,
  weekKey: string,
): Promise<Id<"scholarReviewEntries"> | undefined> {
  const history = await recentEntriesForScholar(ctx, scholarId, institutionId);
  let previousEntryId: Id<"scholarReviewEntries"> | undefined;
  let previousWeek: string | undefined;
  for (const candidate of history) {
    const candidateMeeting = await loadMeeting(candidate.meetingId);
    if (
      !candidateMeeting ||
      cadenceOf(candidateMeeting) !== cadence ||
      candidateMeeting.weekKey >= weekKey
    ) {
      continue;
    }
    if (previousWeek === undefined || candidateMeeting.weekKey > previousWeek) {
      previousWeek = candidateMeeting.weekKey;
      previousEntryId = candidate._id;
    }
  }
  return previousEntryId;
}

/**
 * Find or create the one meeting per institution × period × week, materializing
 * a per-scholar entry for the whole roster on first creation (with cross-week
 * continuity links). Idempotent: an existing meeting is returned untouched.
 *
 * This is the old `open` mutation's CREATION path, now an internal helper the
 * note write calls — Rounds no longer has an open/closed state machine, so a
 * meeting simply comes into being the first time the room writes a note for a
 * week. Insertion order IS roster order, and nothing stamps a stored sort key,
 * so the board stays free to re-sort itself without a write.
 *
 * New rows still carry `status: "open"` because the schema keeps that field
 * required; it is INERT — never read, never flipped — and `closedAt`/`closedBy`
 * stay unwritten (kept only as history on any legacy row).
 */
async function ensureMeeting(
  ctx: MutationCtx & { user: Doc<"users"> },
  institutionId: Id<"institutions">,
  period: Doc<"reportingPeriods">,
  cadence: RoundsCadenceKind,
  weekKey: string,
): Promise<ReviewMeeting> {
  const existing = await meetingFor(
    ctx,
    institutionId,
    period._id,
    cadence,
    weekKey,
  );
  if (existing) return existing;

  const meetingId = await ctx.db.insert("scholarReviewMeetings", {
    institutionId,
    periodId: period._id,
    cadenceKind: cadence,
    weekKey,
    createdBy: ctx.user._id,
    status: "open",
    createdAt: Date.now(),
  });
  const roster = await rosterForInstitution(ctx, institutionId);
  const loadMeeting = meetingLoader(ctx);
  for (const scholar of roster) {
    const previousEntryId = await continuityPreviousEntry(
      ctx,
      loadMeeting,
      scholar._id,
      institutionId,
      cadence,
      weekKey,
    );
    await ctx.db.insert("scholarReviewEntries", {
      institutionId,
      meetingId,
      scholarId: scholar._id,
      previousEntryId,
    });
  }
  const meeting = await ctx.db.get(meetingId);
  if (!meeting) throw new Error("Rounds meeting disappeared");
  return meeting;
}

/**
 * What Rounds last said about one scholar — the newest entry that actually
 * carries a note, so a freshly opened (still blank) week never blanks the
 * answer on a scholar's own page.
 */
export const statusForScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    cadence: v.optional(roundsCadenceValidator),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    const institutionId = scholar?.institutionId;
    if (!institutionId) return null;
    const history = await recentEntriesForScholar(ctx, args.scholarId, institutionId);
    if (history.length === 0) return null;

    const loadMeeting = meetingLoader(ctx);
    let latest: { entry: ReviewEntry; meeting: ReviewMeeting } | null = null;
    for (const entry of history) {
      if (noteOf(entry) === null) continue;
      const meeting = await loadMeeting(entry.meetingId);
      if (
        !meeting ||
        meeting.institutionId !== institutionId ||
        cadenceOf(meeting) !== (args.cadence ?? "academic")
      ) {
        continue;
      }
      if (!latest || meeting.weekKey > latest.meeting.weekKey) {
        latest = { entry, meeting };
      }
    }
    if (!latest) return null;
    return {
      entryId: latest.entry._id,
      weekKey: latest.meeting.weekKey,
      weekLabel: roundsWeekLabel(latest.meeting.weekKey),
      periodId: latest.meeting.periodId,
      note: noteOf(latest.entry),
      discussedAt: latest.entry.discussedAt ?? null,
    };
  },
});

/**
 * Write (or rewrite) the team's note for one scholar this week.
 *
 * IDENTITY, not an entryId: the room may write the very first note of a week
 * before any meeting row exists, so the caller names the meeting by
 * (periodId, weekKey, cadence, scholarId) and the server materializes the
 * meeting + all roster entries on demand (`ensureMeeting`) before writing.
 * There is no open/close step — the note IS what brings the meeting into being.
 *
 * The note is the record that the scholar was discussed, so this is the only
 * writer of `discussedAt` — and clearing the note clears it again, keeping
 * "`discussedAt` present ⟺ a note exists" true for `convex/coherence.ts`.
 *
 * OPTIMISTIC CONCURRENCY, not an edge case: two teachers typing into the same
 * row on a Zoom call is the expected shape of this meeting. The caller hands
 * back the `noteVersion` it read (the row's `discussedAt`; `null` for a row
 * nobody has written yet). A mismatch means the note changed underneath the
 * editor, and the write is refused rather than silently overwriting the other
 * teacher's words.
 */
export const saveNote = teacherMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    weekKey: v.string(),
    cadence: v.optional(roundsCadenceValidator),
    scholarId: v.id("users"),
    note: v.string(),
    /** The `noteVersion` the editor last read. `null` == "there was no note". */
    expectedVersion: v.union(v.number(), v.null()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cadence = args.cadence ?? "academic";
    const { institution, institutionId, period } = await resolveScope(
      ctx,
      args.periodId,
      args.scope,
    );
    const anchor = anchorFor(institution, cadence);
    if (!anchor) {
      throw new Error("SEL Rounds isn't set up for this school yet.");
    }
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    // Materialize the meeting + roster entries on first write (idempotent).
    const meeting = await ensureMeeting(
      ctx,
      institutionId,
      period,
      cadence,
      args.weekKey,
    );
    const entry = await ctx.db
      .query("scholarReviewEntries")
      .withIndex("by_meeting_scholar", (q) =>
        q.eq("meetingId", meeting._id).eq("scholarId", args.scholarId),
      )
      .first();
    if (!entry) {
      // A scholar off the Rounds roster (an extended-education guest) has no
      // entry to write. Refuse rather than inventing one out of roster order.
      throw new Error("This scholar is not on the Rounds roster.");
    }

    const currentVersion = entry.discussedAt ?? null;
    if (currentVersion !== args.expectedVersion) {
      throw new Error(
        "This note changed while you were writing. Reload Rounds to see the current note before saving again.",
      );
    }
    const note = args.note.trim();
    if (note.length > MAX_NOTE_LEN) {
      throw new Error(`Keep the note under ${MAX_NOTE_LEN} characters`);
    }
    if (note.length === 0) {
      // Clearing the note un-records the discussion: there is no separate "we
      // discussed them and said nothing" state to keep.
      await ctx.db.patch(entry._id, {
        note: undefined,
        discussedAt: undefined,
        discussedBy: undefined,
      });
    } else {
      // The version token IS `discussedAt`, so it has to strictly advance or a
      // second save inside the same millisecond would leave the version
      // unchanged and let a writer holding the older read overwrite it without
      // ever seeing the stale-write refusal. Two people typing about the same
      // child at once is exactly what this meeting looks like.
      const stamp = Math.max(Date.now(), (entry.discussedAt ?? 0) + 1);
      await ctx.db.patch(entry._id, {
        note,
        discussedAt: stamp,
        discussedBy: ctx.user._id,
      });
    }
    const saved = await ctx.db.get(entry._id);
    if (!saved) throw new Error("Rounds entry disappeared");
    return {
      entryId: saved._id,
      scholarId: saved.scholarId,
      note: noteOf(saved),
      noteVersion: saved.discussedAt ?? null,
      discussedAt: saved.discussedAt ?? null,
      discussedBy: saved.discussedBy ?? null,
    };
  },
});
