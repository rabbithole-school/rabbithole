/**
 * Evidence and growth for the scholar profile's "Talk, read and write" card
 * (TRA-515). Teacher-only. One read model for the evidence that has no other
 * home, and for the growth chart:
 *
 *   • TALK — the observer's per-session judgment of the scholar's language
 *     (`analyses.talkLevel`), newest first. Plotted without numbers until it
 *     is calibrated (T6; TRA-521).
 *   • READ — the scored your-turn read-alouds (`readAloudAttempts`).
 *   • WRITE — spoken vs typed scholar turns, and the weekly Flesch–Kincaid
 *     grade of the typed ones (the old "Scholar writing over time" line).
 *   • MARKERS — every ratified level change (`readingLevelHistory`, all three
 *     dimensions) with who made it.
 *
 * Deliberately NOT here, because they already have a read model the card
 * reuses: the tutor's reply grade (`messages.getRecentTutorReadabilityByScholar`),
 * vocabulary wins and scanned writing samples (`messages.getScholarReadingTrend`),
 * and the writing estimate (`scholars.getProfile`).
 *
 * Every weekly series buckets on ONE grid — Honolulu calendar weeks
 * (`honoluluWeekStart`) — so a week is the same school week in every lane.
 *
 * Bounded read. Worst case per call: MAX_SESSIONS sessions + one analysis each
 * + MAX_SCHOLAR_TURNS_PER_SESSION user turns each + MAX_ATTEMPTS read-alouds +
 * MAX_HISTORY level changes (+ one user doc per distinct teacher who changed a
 * level) = 60 + 60 + 2,400 + 600 + 200 ≈ 3,320 documents. When a cap bites,
 * the window is shortened to the span actually read (`truncated`), so a busy
 * scholar's unread early weeks are never drawn as empty weeks.
 *
 * The clock is an argument (T11): the client passes a minute-rounded `now`
 * through `useSmoothedQuery`, so the windows move without the query reading
 * the wall clock.
 */
import { v } from "convex/values";
import { teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { isTypedScholarText } from "./lib/inputModality";
import { WEEK_MS, honoluluWeekStart } from "./lib/levelEvidence";
import {
  DEFAULT_MIN_WORDS_PER_MESSAGE,
  isSyntheticStartMessage,
} from "../lib/readingTrend";
import { readabilityStats } from "../lib/readability";
import type { Id } from "./_generated/dataModel";

/** The growth chart's span: this school week and the 12 before it. */
export const GROWTH_WEEKS = 13;
const READ_TALLY_MS = 7 * 24 * 60 * 60 * 1000;
const SPOKEN_SHARE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 60;
/** Newest user turns read per session: plenty for a weekly spoken/typed share. */
const MAX_SCHOLAR_TURNS_PER_SESSION = 40;
const MAX_ATTEMPTS = 600;
const MAX_HISTORY = 200;

export const forScholar = teacherQuery({
  args: { scholarId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const now = args.now;
    const fullWindowStart = honoluluWeekStart(now) - (GROWTH_WEEKS - 1) * WEEK_MS;
    // The earliest instant every capped read is complete from.
    let completeFrom = fullWindowStart;

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_last_message", (q) =>
        q.eq("userId", args.scholarId).gte("lastMessageAt", fullWindowStart),
      )
      .order("desc")
      .take(MAX_SESSIONS);
    if (sessions.length === MAX_SESSIONS) {
      // Older sessions were not read; everything they hold is before this.
      completeFrom = Math.max(completeFrom, sessions[sessions.length - 1].lastMessageAt ?? 0);
    }

    const talk: { at: number; level: string }[] = [];
    const turns: { at: number; spoken: boolean; typedGrade: number | null }[] = [];
    for (const session of sessions) {
      if (session.isTestDrive) continue;

      // The session's talk judgment: its newest observer run (one read). The
      // observer re-reads the latest 30 messages each run, so the newest run
      // has the most scholar words behind it.
      const latest = await ctx.db
        .query("analyses")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .first();
      if (latest?.talkLevel) {
        // Plotted when the judgment was made.
        talk.push({ at: latest._creationTime, level: latest.talkLevel });
      }

      const rows = await ctx.db
        .query("messages")
        .withIndex("by_session_role", (q) =>
          q.eq("sessionId", session._id).eq("role", "user"),
        )
        .order("desc")
        .take(MAX_SCHOLAR_TURNS_PER_SESSION);
      if (rows.length === MAX_SCHOLAR_TURNS_PER_SESSION) {
        completeFrom = Math.max(completeFrom, rows[rows.length - 1]._creationTime);
      }
      for (const m of rows) {
        // Generated images are role "tool" rows, so this index never returns
        // them. App buttons and a staff member typing for the scholar are not
        // the scholar's words.
        if (m.inputModality === "app" || m.byStaff) continue;
        if (!m.content.trim() || isSyntheticStartMessage(m.content)) continue;
        const spoken = !isTypedScholarText(m);
        let typedGrade: number | null = null;
        if (!spoken) {
          // Same rule as the Flesch–Kincaid trend (lib/readingTrend.ts).
          const stats = readabilityStats(m.content);
          if (stats.wordCount >= DEFAULT_MIN_WORDS_PER_MESSAGE) {
            typedGrade = stats.fleschKincaidGrade;
          }
        }
        turns.push({ at: m._creationTime, spoken, typedGrade });
      }
    }

    const attempts = await ctx.db
      .query("readAloudAttempts")
      .withIndex("by_scholar", (q) =>
        q.eq("scholarId", args.scholarId).gte("_creationTime", fullWindowStart),
      )
      .order("desc")
      .take(MAX_ATTEMPTS);
    if (attempts.length === MAX_ATTEMPTS) {
      completeFrom = Math.max(completeFrom, attempts[attempts.length - 1]._creationTime);
    }

    // Shorten the window to whole weeks that were read in full.
    const truncated = completeFrom > fullWindowStart;
    const windowStart = truncated
      ? honoluluWeekStart(completeFrom) +
        (honoluluWeekStart(completeFrom) < completeFrom ? WEEK_MS : 0)
      : fullWindowStart;
    const inWindow = (at: number) => at >= windowStart;

    const writeWeeks = new Map<
      number,
      { spoken: number; typed: number; typedGradeTotal: number; typedGraded: number }
    >();
    let spokenRecent = 0;
    let typedRecent = 0;
    for (const t of turns) {
      if (!inWindow(t.at)) continue;
      const week = honoluluWeekStart(t.at);
      const bucket =
        writeWeeks.get(week) ?? { spoken: 0, typed: 0, typedGradeTotal: 0, typedGraded: 0 };
      if (t.spoken) bucket.spoken += 1;
      else bucket.typed += 1;
      if (t.typedGrade !== null) {
        bucket.typedGradeTotal += t.typedGrade;
        bucket.typedGraded += 1;
      }
      writeWeeks.set(week, bucket);
      if (t.at >= now - SPOKEN_SHARE_MS) {
        if (t.spoken) spokenRecent += 1;
        else typedRecent += 1;
      }
    }

    const readRows = attempts.map((a) => ({
      at: a._creationTime,
      words: a.words,
      matched: a.matched,
      attempted: a.attempted,
      missedUnits: a.missedUnits,
    }));
    const readWeeks = new Map<number, { words: number; matched: number; lines: number }>();
    for (const r of readRows) {
      if (!r.attempted || !inWindow(r.at)) continue;
      const week = honoluluWeekStart(r.at);
      const bucket = readWeeks.get(week) ?? { words: 0, matched: 0, lines: 0 };
      bucket.words += r.words;
      bucket.matched += r.matched;
      bucket.lines += 1;
      readWeeks.set(week, bucket);
    }

    const historyRows = await ctx.db
      .query("readingLevelHistory")
      .withIndex("by_scholar", (q) =>
        q.eq("scholarId", args.scholarId).gte("_creationTime", windowStart),
      )
      .order("desc")
      .take(MAX_HISTORY);
    const names = new Map<Id<"users">, string | null>();
    const markers = [];
    for (const row of historyRows) {
      let by: string | null = null;
      if (row.changedBy) {
        if (!names.has(row.changedBy)) {
          const who = await ctx.db.get(row.changedBy);
          names.set(row.changedBy, who?.name ?? null);
        }
        by = names.get(row.changedBy) ?? null;
      }
      markers.push({
        dimension: row.dimension ?? ("talk" as const),
        level: row.level,
        at: row._creationTime,
        by,
      });
    }

    const byWeek = <T>(m: Map<number, T>) =>
      [...m.entries()].sort((a, b) => a[0] - b[0]).map(([start, value]) => ({ start, ...value }));

    return {
      windowStart,
      now,
      /** A cap bit, so `windowStart` is later than the usual 13 weeks. */
      truncated,
      talk: {
        /** Judged sessions in the window, newest first. */
        sessions: talk.filter((s) => inWindow(s.at)).sort((a, b) => b.at - a.at),
      },
      read: {
        /** Attempts in the last 7 days, for the Read row's tally. */
        recent: readRows.filter((r) => r.at >= now - READ_TALLY_MS),
        weeks: byWeek(readWeeks),
      },
      write: {
        spokenRecent,
        typedRecent,
        weeks: byWeek(writeWeeks).map((w) => ({
          start: w.start,
          spoken: w.spoken,
          typed: w.typed,
          typedGrade:
            w.typedGraded > 0
              ? Math.round((w.typedGradeTotal / w.typedGraded) * 10) / 10
              : null,
        })),
      },
      /** Level changes in the window, oldest first. */
      markers: markers.reverse(),
    };
  },
});
