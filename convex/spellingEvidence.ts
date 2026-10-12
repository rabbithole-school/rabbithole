// Teacher-facing spelling evidence (TRA-505): the dated text a scholar TYPED
// themselves, for a teacher preparing a family conversation about possible
// orthographic (surface) dyslexia. The backing read for the staff aide's
// `get_scholar_spelling_evidence` tool (lib/spellingEvidenceTools.ts).
//
// Evidence for a human to weigh, never a diagnosis. Nothing here reaches the
// tutor, the observer, a scholar, or a parent: the query is internal-only and
// re-authorizes the caller as scholar-admin staff (teacher / school admin /
// platform admin) with access to THIS scholar's institution.
//
// What counts as the child's own spelling:
//   - role "user" messages in the scholar's own, real sessions (not test
//     drives or offline sessions, which a teacher may have authored);
//   - inputModality "typed". "spoken" is speech-to-text output (fully spelled
//     by the engine, so it measures the transcriber) and "app" is a button the
//     embedded app pressed. A MISSING modality (older native clients) is
//     included but labelled "unknown" so the reader can discount it.
// Teacher remote mode is not recorded on a message, so a teacher typing into a
// scholar's session cannot be told apart here; that residue is stated in the
// tool description rather than guessed at.

import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireActiveScholarAccess } from "./lib/access";
import { isScholarAdminRole } from "./lib/roles";
import { isTypedScholarText } from "./lib/inputModality";

export const SPELLING_DEFAULT_DAYS = 90;
export const SPELLING_MAX_DAYS = 365;
export const SPELLING_DEFAULT_LIMIT = 200;
export const SPELLING_MAX_LIMIT = 400;
const MAX_SESSIONS_SCANNED = 400;
const MAX_TEXT_CHARS = 1200;
// Hard bound on user rows read per session (kept OR excluded), so a scholar who
// mostly dictates cannot make one session unbounded. Hitting it sets `capped`.
const MAX_ROWS_SCANNED_PER_SESSION = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SpellingSample = {
  date: string; // YYYY-MM-DD (UTC)
  sessionTitle: string;
  // "typed" = stamped typed; "unknown" = no modality recorded (legacy client).
  modality: "typed" | "unknown";
  text: string;
};

export type SpellingEvidence = {
  window: { days: number; since: string; until: string };
  counts: {
    typed: number;
    unknownModality: number;
    excludedSpoken: number;
    excludedApp: number;
    // True when more qualifying messages existed than `limit`; the oldest
    // were dropped, so the samples may start later than `window.since`.
    capped: boolean;
  };
  samples: SpellingSample[]; // oldest first, so change over time reads in order
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.floor(n), lo), hi);

export async function readTypedSpellingSamples(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  opts: { days?: number; limit?: number; now: number },
): Promise<SpellingEvidence> {
  const days = clamp(opts.days ?? SPELLING_DEFAULT_DAYS, 1, SPELLING_MAX_DAYS);
  const limit = clamp(
    opts.limit ?? SPELLING_DEFAULT_LIMIT,
    1,
    SPELLING_MAX_LIMIT,
  );
  const since = opts.now - days * DAY_MS;

  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .order("desc")
    .take(MAX_SESSIONS_SCANNED);

  type Row = SpellingSample & { at: number };
  const rows: Row[] = [];
  let excludedSpoken = 0;
  let excludedApp = 0;
  let scanCapped = false;

  for (const session of sessions) {
    if (session.isTestDrive || session.isOffline) continue;
    if ((session.lastMessageAt ?? session._creationTime) < since) continue;
    // Only KEPT rows count toward the per-session budget: excluded spoken/app
    // rows are skipped, so a mostly-dictating scholar's typed turns are not
    // crowded out. Stream newest-first and stop early.
    let keptHere = 0;
    let scanned = 0;
    const messages = ctx.db
      .query("messages")
      .withIndex("by_session_role", (q) =>
        q.eq("sessionId", session._id).eq("role", "user"),
      )
      .order("desc");
    for await (const m of messages) {
      if (m._creationTime < since) break; // desc: everything after is older
      if (++scanned > MAX_ROWS_SCANNED_PER_SESSION) {
        scanCapped = true;
        break;
      }
      if (m.notebookEntry) continue; // engine-authored, not scholar prose
      if (!isTypedScholarText(m)) {
        if (m.inputModality === "spoken") excludedSpoken++;
        else excludedApp++;
        continue;
      }
      const text = m.content.trim();
      if (!text) continue;
      rows.push({
        at: m._creationTime,
        date: new Date(m._creationTime).toISOString().slice(0, 10),
        sessionTitle: session.title,
        modality: m.inputModality === "typed" ? "typed" : "unknown",
        text:
          text.length > MAX_TEXT_CHARS
            ? `${text.slice(0, MAX_TEXT_CHARS)}…`
            : text,
      });
      if (++keptHere > limit) break; // one over the cap proves `capped`
    }
  }

  rows.sort((a, b) => b.at - a.at); // newest first so the cap keeps the recent
  const capped = scanCapped || rows.length > limit;
  const kept = rows.slice(0, limit).reverse(); // then oldest first
  return {
    window: {
      days,
      since: new Date(since).toISOString().slice(0, 10),
      until: new Date(opts.now).toISOString().slice(0, 10),
    },
    counts: {
      typed: kept.filter((r) => r.modality === "typed").length,
      unknownModality: kept.filter((r) => r.modality === "unknown").length,
      excludedSpoken,
      excludedApp,
      capped,
    },
    samples: kept.map(({ at: _at, ...sample }) => sample),
  };
}

/**
 * Internal-only: the caller must be scholar-admin staff with access to this
 * scholar's institution. The aide tool resolves the name through the lens-
 * scoped chokepoint first; this is the independent boundary (a role wrapper
 * alone would be a cross-tenant leak).
 */
export const getTypedSamplesForAide = internalQuery({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isScholarAdminRole(caller.role)) {
      throw new Error(
        "Forbidden: spelling evidence requires teacher or admin access",
      );
    }
    await requireActiveScholarAccess(ctx, caller, args.scholarId);
    // t11-ok: internal query called once per aide tool call from an action; never subscribed
    const now = Date.now();
    return readTypedSpellingSamples(ctx, args.scholarId, {
      days: args.days,
      limit: args.limit,
      now,
    });
  },
});
