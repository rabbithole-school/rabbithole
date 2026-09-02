// The Workshop (internal code name: `meta`) — scholar suggestions about
// Rabbithole itself, and the staff response loop that closes the circuit.
// See review/scholar-meta-prep-time-plan.html §§5, 6, 8, 9.
//
// An idea has NO staff-set state (the `heard`/`answered` enum was retired
// 2026-08-25 — see schema.ts). Two independent facts describe one:
//   * **a human replied** — `staffResponse !== undefined`. That is what the
//     kid's card reads and what the staff queue means by "owes a reply".
//   * **the scholar archived it** — `archivedAt`. The scholar's own act; staff
//     have no way to set it. "Open" everywhere means NOT ARCHIVED.
// Replying therefore does not close anything: it is a comment, never a
// verdict, and the five-open cap is a prioritization lesson pointed at the
// kid, so the kid — not a staffer — decides when a slot frees. No pipeline, no
// tracking to shipped code; release-note credit is its own editorial act on
// `changelogEntries`, not here.
//
// Phase 1 (this file): the manual composer (`createMine`), the scholar's own
// board (`listMine`), the staff queue (`listOpenForStaff` +
// `listForStaffInternal` for the aide tool), and the human reply (`respond`,
// the aide tool's backing mutation). The reflection chat that auto-distills
// ideas is Phase 2.

import { v } from "convex/values";
import { authedQuery, authedMutation, teacherQuery, teacherMutation } from "./lib/customFunctions";
import {
  internalAction,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isTeacherRole } from "./lib/roles";
import {
  resolveInstitutionLens,
  scholarInLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import { firstLineToTitle } from "./lib/textToTitle";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import {
  escapeSlackText,
  fetchConversationHistory,
  messageWithDeliveryMetadata,
  postMessage,
  type SlackMessageMetadata,
} from "./lib/slackApi";

/**
 * Fail-CLOSED institution-lens check for the Workshop aide-tool paths — the
 * internal fns that run with NO `ctx.user`, so the caller's scholar lens is
 * threaded in as args (`allowedScholarIds` + `scholarLensResolved`). Mirrors the
 * semantics of `assertTargetsWithinLens` in convex/customApps.ts: an absent id
 * set is legitimate ONLY when the caller actually resolved a lens and found
 * itself unrestricted (a platform admin's "all" lens). A caller that never
 * resolved one at all sees / touches NOTHING — that silence must never read as
 * "no restrictions apply". Exported so `changelog.createEntry` enforces the
 * identical rule on credited usernames.
 */
export function isScholarWithinAideLens(
  scholarId: Id<"users">,
  allowedScholarIds: Set<Id<"users">> | undefined,
  scholarLensResolved: boolean | undefined,
): boolean {
  if (!allowedScholarIds) return scholarLensResolved === true;
  return allowedScholarIds.has(scholarId);
}

// Soft cap on OPEN (heard) ideas per scholar — a prioritization lesson, not a
// hard wall (§9 "rate/volume sanity"). The friendly error names the number so
// the UI can show it verbatim.
const MAX_OPEN_SUGGESTIONS = 5;
/** Slack message metadata `event_type` on a Workshop-idea notification. The
 * inbound reply path keys on it to tell OUR root apart from any other message
 * a human might start a thread under. */
export const WORKSHOP_IDEA_EVENT_TYPE = "rabbithole_workshop_idea";
const WORKSHOP_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

/** The `delivery_id` this file stamps on the Slack root message. It is the ONLY
 * durable Slack-thread → idea binding we have (the visible text carries just a
 * shortened name + title), so both the outbound dedupe and the inbound reply
 * path derive from this one shape. */
export function workshopDeliveryId(suggestionId: Id<"scholarSuggestions">): string {
  return `workshop-idea:${suggestionId}`;
}

/** Inverse of `workshopDeliveryId`, for the inbound Slack thread reply. Returns
 * the id string, or null when the metadata isn't ours.
 *
 * The shape check is not redundant with the mutation's `normalizeId`: the
 * @mention path names this id inside a MODEL PROMPT (slackBot.ts), so anything
 * carrying whitespace or newlines could add lines to that prompt. Only this bot
 * writes the metadata today, which is exactly why the guard belongs here rather
 * than in a comment about how it can't happen. */
export function suggestionIdFromDeliveryId(deliveryId: unknown): string | null {
  if (typeof deliveryId !== "string") return null;
  const prefix = "workshop-idea:";
  if (!deliveryId.startsWith(prefix)) return null;
  const raw = deliveryId.slice(prefix.length).trim();
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;
}

/** Shared with the meta-observer so its at-cap skip matches the composer's. */
export const MAX_OPEN_SUGGESTIONS_EXPORT = MAX_OPEN_SUGGESTIONS;

/** "Kai Nakamura" → "Kai N." for the digest line — a first name + last
 * initial, the same register the Slack sketch uses (§6). Falls back to the
 * whole name when there's no surname, or a generic label when unknown. */
export function shortScholarName(fullName: string | undefined | null): string {
  const name = (fullName ?? "").trim();
  if (!name) return "A scholar";
  const parts = name.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${parts[0]} ${lastInitial}.`;
}

// Slack rejects chat.postMessage text past ~40k chars and renders anything
// over a few thousand poorly. The RECORD keeps the kid's words verbatim —
// only the Slack rendering is clipped, with an explicit marker. Clip before
// escaping so an escape entity can't be cut mid-way.
const MAX_SLACK_IDEA_CHARS = 3500;

export function workshopIdeaSlackText(
  scholarName: string | undefined | null,
  scholarWords: string,
): string {
  const trimmed = scholarWords.trim();
  const clipped = trimmed.length > MAX_SLACK_IDEA_CHARS
    ? `${trimmed.slice(0, MAX_SLACK_IDEA_CHARS)}…\n(truncated — the full idea is in Rabbithole)`
    : trimmed;
  const quotedIdea = escapeSlackText(clipped).replace(/\r?\n/g, "\n> ");
  return `💡 *${escapeSlackText(shortScholarName(scholarName))}* filed a Workshop idea:\n> ${quotedIdea}`;
}

/**
 * Workshop ideas use the primary school's configured inbox, never a class
 * group's EOD thread. The action revalidates eligibility before delivery.
 */
export async function fanOutWorkshopIdea(
  ctx: MutationCtx,
  args: { suggestionId: Id<"scholarSuggestions"> },
): Promise<void> {
  try {
    await ctx.scheduler.runAfter(0, internal.scholarSuggestions.postWorkshopIdea, {
      suggestionId: args.suggestionId,
    });
  } catch (err) {
    console.error("Workshop idea Slack fan-out failed (ignored):", err);
  }
}

/** Delivery-time facts for a first-party Workshop idea notification. */
export const workshopDeliveryContext = internalQuery({
  args: { suggestionId: v.id("scholarSuggestions") },
  handler: async (ctx, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) return null;
    const institutionId = await scholarInstitutionId(ctx, suggestion.scholarId);
    if (!institutionId) return null;
    const institution = await ctx.db.get(institutionId);
    if (!institution?.isPrimary || institution.disabledAt !== undefined) return null;
    const scholar = await ctx.db.get(suggestion.scholarId);
    return {
      text: workshopIdeaSlackText(scholar?.name, suggestion.scholarWords),
      deliveryId: workshopDeliveryId(suggestion._id),
      createdAt: suggestion.createdAt,
    };
  },
});

export const postWorkshopIdea = internalAction({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const channelId = process.env.SLACK_WORKSHOP_CHANNEL_ID?.trim();
    const token = process.env.SLACK_BOT_TOKEN;
    if (!channelId || !token) return;
    const context = await ctx.runQuery(
      internal.scholarSuggestions.workshopDeliveryContext,
      { suggestionId: args.suggestionId },
    );
    if (!context) return;

    const scheduleRetry = async (retryAfterMs?: number) => {
      const attempt = args.attempt ?? 0;
      const baseDelay = WORKSHOP_RETRY_DELAYS_MS[attempt];
      if (baseDelay === undefined) return;
      await ctx.scheduler.runAfter(
        Math.max(baseDelay, retryAfterMs ?? 0),
        internal.scholarSuggestions.postWorkshopIdea,
        { suggestionId: args.suggestionId, attempt: attempt + 1 },
      );
    };

    const history = await fetchConversationHistory(token, channelId, {
      oldest: String(Math.max(0, Math.floor(context.createdAt / 1000) - 60)),
    });
    if (!history.ok) {
      await scheduleRetry(history.retryAfterMs);
      return;
    }
    if (
      messageWithDeliveryMetadata(
        history.messages,
        WORKSHOP_IDEA_EVENT_TYPE,
        context.deliveryId,
      )
    ) {
      return;
    }

    const metadata: SlackMessageMetadata = {
      event_type: WORKSHOP_IDEA_EVENT_TYPE,
      event_payload: { delivery_id: context.deliveryId },
    };
    const posted = await postMessage(token, {
      channel: channelId,
      text: context.text,
      metadata,
      markdown: true,
    });
    if (!posted.ok) await scheduleRetry(posted.retryAfterMs);
  },
});

/** A staff-facing suggestion row joined with its scholar's display name +
 * username (the queue + the aide tool both need to name the child). */
async function joinScholar(ctx: QueryCtx, row: Doc<"scholarSuggestions">) {
  const scholar = await ctx.db.get(row.scholarId);
  return {
    _id: row._id,
    scholarId: row.scholarId,
    scholarName: scholar?.name ?? "Unknown scholar",
    scholarUsername: scholar?.username ?? null,
    title: row.title,
    scholarWords: row.scholarWords,
    // Additive when a thinking-partner conversation reshaped the idea and the
    // scholar agreed to the new framing — staff see the kid's original words
    // (scholarWords) AND this refined framing. Absent for as-sent ideas.
    refined: row.refined,
    distilled: row.distilled,
    archivedAt: row.archivedAt,
    answered: !!row.staffResponse,
    staffResponse: row.staffResponse,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Extended Education (program-guest) scholars' rows carry a tag so the
    // aide tool edge can apply the enrolled-only default (see
    // lib/scholarParticipationTooling.ts); enrolled rows stay byte-identical.
    ...extendedEducationTag({ enrollmentStanding: scholar?.enrollmentStanding }),
  };
}

/**
 * File an idea about the Workshop, for MYSELF. `scholarId` is ALWAYS the
 * caller — never an argument — so no one can file on another kid's behalf.
 * Title is the first line/sentence of the text; scholarWords keeps the full
 * verbatim text (in-app only). New ideas start `heard`.
 */
export const createMine = authedMutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) {
      throw new Error("Add a few words about your idea first.");
    }

    const scholarId = ctx.user._id;

    // Soft cap: too many open ideas is a prioritization moment, not a bug.
    const open = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .filter((q) => q.eq(q.field("archivedAt"), undefined))
      .collect();
    if (open.length >= MAX_OPEN_SUGGESTIONS) {
      throw new Error(
        `You've already got ${MAX_OPEN_SUGGESTIONS} ideas open in the Workshop — that's the most at once. Let's see what happens with those first. Which one matters most to you?`,
      );
    }

    const now = Date.now();
    const title = firstLineToTitle(text);
    const suggestionId = await ctx.db.insert("scholarSuggestions", {
      scholarId,
      title,
      scholarWords: text,
      createdAt: now,
      updatedAt: now,
    });

    await fanOutWorkshopIdea(ctx, {
      suggestionId,
    });

    return { suggestionId, title };
  },
});

/**
 * The result the `send_idea_to_teacher` tool relays to the model (Workshop
 * idea-conversations, WORKSHOP_IDEA_CONVOS_ENABLED). A discriminated union so
 * the tool can speak naturally about what happened:
 *  - `captured`: the idea was sent (a row exists).
 *  - `at_cap`:   the scholar already has the max open ideas — nothing was sent;
 *                the tool relays a "help them prioritize" nudge (§9 cap parity
 *                with the composer's message).
 *  - `empty`:    no scholar words to send (defensive; the model must supply the
 *                kid's own phrasing).
 */
export type CaptureFromChatResult =
  | { status: "captured"; suggestionId: Id<"scholarSuggestions">; title: string }
  | { status: "at_cap"; cap: number }
  | { status: "empty" };

/**
 * Capture an idea a scholar chose to send from a Workshop reflection chat, via
 * the `send_idea_to_teacher` tool. The parallel of `createMine` for the tool
 * path: `scholarId` is the chat's owner (resolved by the caller from the
 * authenticated identity — NEVER a model-supplied value), so no one can file on
 * another kid's behalf.
 *
 * Records the kid's OWN words verbatim (`scholarWords`) and, when a thinking-
 * partner conversation reshaped the idea and the scholar agreed to it, the
 * `refined` framing too — staff see BOTH (QB guardrail #3, "the kid's words
 * survive"). At the open-ideas cap it captures NOTHING and returns `at_cap` so
 * the tool can help the scholar prioritize instead of erroring (guardrail #2 /
 * §9), never a hard wall that would block sending.
 */
export const captureFromChat = internalMutation({
  args: {
    scholarId: v.id("users"),
    title: v.string(),
    scholarWords: v.string(),
    refined: v.optional(v.string()),
    sourceChatId: v.optional(v.id("metaChats")),
  },
  handler: async (ctx, args): Promise<CaptureFromChatResult> => {
    const scholarWords = args.scholarWords.trim();
    // The kid's own words are the whole point — never file an empty idea.
    if (!scholarWords) return { status: "empty" };

    const scholarId = args.scholarId;

    // Soft cap, same number as the composer — the thinking partner helps the
    // scholar prioritize rather than piling on. Nothing is written at the cap.
    const open = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .filter((q) => q.eq(q.field("archivedAt"), undefined))
      .collect();
    if (open.length >= MAX_OPEN_SUGGESTIONS) {
      return { status: "at_cap", cap: MAX_OPEN_SUGGESTIONS };
    }

    const title = args.title.trim() || firstLineToTitle(scholarWords);
    // Only persist `refined` when it's a real, distinct framing — a blank or a
    // verbatim echo of the kid's own words isn't a refinement, so drop it.
    const refinedTrimmed = args.refined?.trim();
    const refined =
      refinedTrimmed && refinedTrimmed !== scholarWords ? refinedTrimmed : undefined;

    const now = Date.now();
    const suggestionId = await ctx.db.insert("scholarSuggestions", {
      scholarId,
      title,
      scholarWords,
      ...(refined ? { refined } : {}),
      sourceChatId: args.sourceChatId,
      createdAt: now,
      updatedAt: now,
    });

    await fanOutWorkshopIdea(ctx, {
      suggestionId,
    });

    return { status: "captured", suggestionId, title };
  },
});

/**
 * The caller's own suggestions, newest first — full rows (their own words +
 * any staff response), each with the responding staff member's display name
 * resolved for the "From <staff name>" block on their card. Safe: it's the
 * scholar's own record.
 */
export const listMine = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .order("desc")
      .collect();
    return await Promise.all(
      rows.map(async (row) => {
        const responder = row.staffResponse
          ? await ctx.db.get(row.staffResponse.authorId)
          : null;
        return { ...row, responderName: responder?.name ?? null };
      }),
    );
  },
});

/**
 * Ideas that still OWE A REPLY — not archived by the scholar, and no human has
 * written back yet — oldest first, joined with each scholar's name + username.
 * Backs the teacher-dashboard queue (the aide tool reads through the internal
 * sibling below, since it runs in an action with a mapped principal, not a
 * Convex-auth identity).
 */
export const listOpenForStaff = teacherQuery({
  args: {},
  handler: async (ctx) => {
    // Indexed on the un-archived rows only — an archived idea is off the
    // plate, and a global scan would grow without bound as the table does.
    let rows = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
      .collect();
    rows = rows.filter((r) => !r.staffResponse);
    rows.sort((a, b) => a.createdAt - b.createdAt);
    // Institution boundary (CLAUDE.md § Multi-tenancy): a role check alone is a
    // cross-tenant leak, so a teacher only sees ideas from scholars in their
    // context. Use the SAME lens the aide path uses (institutionLens) — NOT the
    // access.ts helpers — so the dashboard and the aide cannot diverge: the aide
    // lens deliberately includes UNASSIGNED scholars (institutionId undefined)
    // under the primary institution during the pre-backfill window, and those
    // scholars' ideas must not silently vanish from the queue that owes them a
    // reply. Build the allowed set once, then filter BEFORE joining any scholar
    // name/username PII.
    const lens = await resolveInstitutionLens(ctx, ctx.user, "");
    const allowed = await scholarIdsInLens(ctx, lens, {
      includeProgramGuests: true,
    });
    const visible = rows.filter((r) => allowed.has(r.scholarId));
    return await Promise.all(visible.map((row) => joinScholar(ctx, row)));
  },
});

/**
 * Staff-queue read for the aide tool (`list_scholar_suggestions`), gated at
 * the tool-assembly layer (teacher+). Optional filters: `filter` and a
 * scholar `username` (exact). Oldest first — the longest-waiting idea leads.
 *
 * `filter` replaced the retired `status` enum: "needs_reply" (nobody has
 * written back and the scholar hasn't archived it), "answered" (a human
 * replied), "archived" (the scholar archived it). Archived ideas are EXCLUDED
 * from the other two — they are off the kid's plate.
 */
export const listForStaffInternal = internalQuery({
  args: {
    filter: v.optional(
      v.union(
        v.literal("needs_reply"),
        v.literal("answered"),
        v.literal("archived"),
      ),
    ),
    scholarUsername: v.optional(v.string()),
    // Institution lens threaded from the aide tool layer (this fn has no
    // ctx.user). Arrays over the wire — Convex validators can't take a Set.
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const allowed = args.allowedScholarIds
      ? new Set(args.allowedScholarIds)
      : undefined;
    // Fail CLOSED: a caller that never resolved a lens sees nothing.
    const inLens = (scholarId: Id<"users">) =>
      isScholarWithinAideLens(scholarId, allowed, args.scholarLensResolved);

    let scholarId: Id<"users"> | undefined;
    const username = args.scholarUsername?.trim();
    if (username) {
      const scholar = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .unique();
      // A named-but-unknown scholar yields no rows (the tool says so) rather
      // than silently listing everyone's ideas. An out-of-lens scholar is
      // refused the SAME way — same empty shape as "unknown scholar" — so the
      // tool copy still reads correctly and we never confirm that another
      // tenant's scholar exists.
      if (!scholar || !inLens(scholar._id)) return [];
      scholarId = scholar._id;
    }

    let rows: Doc<"scholarSuggestions">[];
    if (scholarId) {
      const id = scholarId;
      rows = await ctx.db
        .query("scholarSuggestions")
        .withIndex("by_scholar", (q) => q.eq("scholarId", id))
        .collect();
    } else if (args.filter === "answered" || args.filter === "needs_reply") {
      // Both live filters are "not archived" — read that through the index
      // rather than scanning every idea the school has ever filed.
      rows = await ctx.db
        .query("scholarSuggestions")
        .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
        .collect();
    } else {
      rows = await ctx.db.query("scholarSuggestions").collect();
    }
    if (args.filter === "archived") {
      rows = rows.filter((r) => !!r.archivedAt);
    } else if (args.filter === "answered") {
      rows = rows.filter((r) => !r.archivedAt && !!r.staffResponse);
    } else if (args.filter === "needs_reply") {
      rows = rows.filter((r) => !r.archivedAt && !r.staffResponse);
    }

    // Scope to the lens BEFORE joinScholar — never resolve a child's name +
    // username for an out-of-lens row.
    rows = rows.filter((r) => inLens(r.scholarId));

    rows.sort((a, b) => a.createdAt - b.createdAt);
    return await Promise.all(rows.map((row) => joinScholar(ctx, row)));
  },
});

/**
 * Shared core for storing a human reply on an idea — used by both the aide
 * tool's `respond` (internal, bot-mapped author) and the dashboard's
 * `respondAsStaff` (teacherMutation, the signed-in teacher). `authorId` must
 * be teacher+ (checked here as defense-in-depth).
 *
 * A reply CHANGES NO STATE. It is a comment; whether the idea is still on the
 * scholar's plate is theirs to say (`archivedAt`). This is why there is no
 * `close` here any more.
 */
async function respondCore(
  ctx: MutationCtx,
  args: {
    suggestionId: Id<"scholarSuggestions">;
    authorId: Id<"users">;
    body: string;
    // Institution boundary. The dashboard path (respondAsStaff) has a real
    // authenticated staffer → the SAME institution lens the aide uses
    // (resolveInstitutionLens + scholarInLens), so unassigned scholars under
    // the primary institution stay answerable; the aide path threads its
    // resolved lens in and is fail-closed the same way as listForStaffInternal.
    lens:
      | { via: "userAccess" }
      | {
          via: "aideLens";
          allowedScholarIds: Set<Id<"users">> | undefined;
          scholarLensResolved: boolean | undefined;
        };
  },
) {
  const author = await ctx.db.get(args.authorId);
  if (!author || !isTeacherRole(author.role)) {
    throw new Error("Forbidden: teacher or admin role required");
  }
  const body = args.body.trim();
  if (!body) throw new Error("A reply needs a message.");

  const suggestion = await ctx.db.get(args.suggestionId);
  if (!suggestion) throw new Error("Suggestion not found");

  // Institution boundary (CLAUDE.md § Multi-tenancy): a staffer may only reply
  // to an idea from a scholar in their context — the role gate above is not
  // enough. Enforced BEFORE any write, so an out-of-lens idea is left untouched.
  // The dashboard path resolves the SAME lens the aide uses (institutionLens,
  // not access.ts) so unassigned scholars under the primary institution stay
  // answerable; the aide path uses its threaded, fail-closed set.
  let withinLens: boolean;
  if (args.lens.via === "userAccess") {
    const lens = await resolveInstitutionLens(ctx, author, "");
    const scholar = await ctx.db.get(suggestion.scholarId);
    withinLens = !!scholar && scholarInLens(lens, scholar);
  } else {
    withinLens = isScholarWithinAideLens(
      suggestion.scholarId,
      args.lens.allowedScholarIds,
      args.lens.scholarLensResolved,
    );
  }
  if (!withinLens) {
    // Deliberately the IDENTICAL error as a nonexistent id above — an
    // out-of-lens suggestion must be indistinguishable from "no such
    // suggestion" so staff can't use this as an existence oracle to learn that
    // another school's suggestion exists (same principle as the username branch
    // in listForStaffInternal and the credit branch in changelog.createEntry).
    // Do NOT "improve" this into a specific "outside your institution" message.
    throw new Error("Suggestion not found");
  }

  // Human edits to an already-replied idea overwrite the reply — fine, but
  // worth a log line so an accidental overwrite is traceable. (The Slack
  // thread path appends rather than replacing; this covers the aide/dashboard.)
  if (suggestion.staffResponse) {
    console.log(
      `scholarSuggestions.respond: overwriting the reply on already-answered ${args.suggestionId}`,
    );
  }

  await ctx.db.patch(args.suggestionId, {
    staffResponse: { authorId: args.authorId, body, at: Date.now() },
    updatedAt: Date.now(),
  });

  const scholar = await ctx.db.get(suggestion.scholarId);
  const scholarFirstName =
    scholar?.name?.trim().split(/\s+/)[0] ?? "the scholar";
  return { title: suggestion.title, scholarFirstName };
}

/**
 * Store a human reply on an idea (the aide tool `respond_to_suggestion`'s
 * backing mutation). `authorId` is the CALLER (per-message principal),
 * resolved by the tool. The scholar lens is threaded from the tool layer so
 * this fails closed on a caller that never resolved one.
 */
export const respond = internalMutation({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    authorId: v.id("users"),
    body: v.string(),
    // Arrays over the wire — Convex validators can't take a Set.
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) =>
    respondCore(ctx, {
      suggestionId: args.suggestionId,
      authorId: args.authorId,
      body: args.body,
      lens: {
        via: "aideLens",
        allowedScholarIds: args.allowedScholarIds
          ? new Set(args.allowedScholarIds)
          : undefined,
        scholarLensResolved: args.scholarLensResolved,
      },
    }),
});

/**
 * The teacher-dashboard queue's reply action — the signed-in teacher IS the
 * author. Thin `teacherMutation` wrapper over the same core as the aide tool
 * (per-request principal from the auth identity, not an arg). Its lens comes
 * from the real
 * authenticated user (resolveInstitutionLens), so it needs no id-set plumbing.
 */
export const respondAsStaff = teacherMutation({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    body: v.string(),
  },
  handler: async (ctx, args) =>
    respondCore(ctx, {
      suggestionId: args.suggestionId,
      authorId: ctx.user._id,
      body: args.body,
      lens: { via: "userAccess" },
    }),
});

/**
 * The result of routing a plain Slack thread reply onto its Workshop idea, so
 * the Slack layer can ACK legibly instead of repeating the silent drop this
 * path exists to fix (see convex/slackBot.ts → handleWorkshopIdeaThreadReply).
 */
export type WorkshopSlackReplyResult =
  | { status: "recorded"; appended: boolean; title: string; scholarFirstName: string }
  | { status: "empty" }
  | { status: "forbidden" }
  | { status: "not_found" };

/**
 * Record a staff member's PLAIN Slack thread reply as the response on the idea
 * its thread root announced.
 *
 * Why this exists: `postWorkshopIdea` is a one-way post with no `slackThreads`
 * row, so a plain reply used to fall through every branch of the Slack message
 * handler and return silently — the child never heard back and the staffer got
 * no signal that nothing had happened (observed on prod 2026-08-25: both
 * Workshop ideas filed to date had a staff reply in Slack and neither reached
 * the scholar).
 *
 * Semantics, decided deliberately:
 *  - **Never changes the idea's state**, because no reply does any more: the
 *    `heard`/`answered` enum is retired and only the scholar can put an idea
 *    away (`archivedAt`). The scholar hears back either way — delivery keys off
 *    `staffResponse`.
 *  - **A second reply APPENDS.** `respondCore` overwrites wholesale, which
 *    would silently destroy an earlier reply the child may already have been
 *    shown. A thread is a conversation; keeping both turns reads correctly to
 *    a kid ("I'll take a look." → "fixed it!").
 *  - **Every staff reply in the thread reaches the child.** That IS the
 *    feature; it also means the thread is not a staff-room. The ✅ ack on the
 *    Slack side makes that visible on every message.
 *
 * `suggestionId` arrives as a raw string parsed out of Slack metadata, so it is
 * normalized against the real table rather than trusted as an id.
 */
export const respondFromSlackThread = internalMutation({
  args: {
    suggestionId: v.string(),
    authorId: v.id("users"),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<WorkshopSlackReplyResult> => {
    const body = args.body.trim();
    if (!body) return { status: "empty" };

    // Pre-checked here (rather than left to respondCore's throw) so the Slack
    // layer can tell a staffer WHY nothing was recorded.
    const author = await ctx.db.get(args.authorId);
    if (!author || !isTeacherRole(author.role)) return { status: "forbidden" };

    const suggestionId = ctx.db.normalizeId(
      "scholarSuggestions",
      args.suggestionId,
    );
    if (!suggestionId) return { status: "not_found" };
    const existing = await ctx.db.get(suggestionId);
    if (!existing) return { status: "not_found" };

    // EXACT match only. A suffix test (`prior.endsWith(body)`) looks like a
    // safe dedupe and is data loss: a follow-up that happens to be a trailing
    // substring of the accumulated reply ("you soon." after "…get back to you
    // soon.") would replace the whole conversation with the fragment. Slack
    // retries are already deduped by event id upstream (slackBot.claimEvent),
    // so there is no repeat this needs to catch anyway.
    const prior = existing.staffResponse?.body.trim();
    const appended = !!prior && prior !== body;
    const composed = appended ? `${prior}\n\n${body}` : body;

    try {
      const result = await respondCore(ctx, {
        suggestionId,
        authorId: args.authorId,
        body: composed,
        lens: { via: "userAccess" },
      });
      return {
        status: "recorded",
        appended,
        title: result.title,
        scholarFirstName: result.scholarFirstName,
      };
    } catch (err) {
      // The expected throw here is respondCore's institution-lens refusal,
      // which is deliberately indistinguishable from "no such suggestion" (see
      // the comment there) — keep the RESPONSE that way. But the assumption
      // that nothing else can throw is unenforced, so log: a real bug degrading
      // into a friendly "couldn't match that" is precisely the silent failure
      // this whole path exists to eliminate.
      console.error(
        `scholarSuggestions.respondFromSlackThread: refused ${suggestionId}:`,
        err,
      );
      return { status: "not_found" };
    }
  },
});

/**
 * Put one of MY OWN ideas away, or bring it back.
 *
 * This is the lever the five-open cap was always pointing at. The cap's message
 * asks the kid "which one matters most to you?" — but until now a STAFFER
 * closing an idea is what freed a slot, so the friction landed on the child and
 * the control sat with an adult. `scholarId` is ALWAYS the caller, never an
 * argument, and there is deliberately no staff-facing equivalent: an adult can
 * reply to an idea, and that is all.
 *
 * Reversible on purpose. Putting something away should never feel like losing
 * it, and a kid who archives to make room may want it back next week.
 */
export const setArchivedMine = authedMutation({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    // Same shape as every other "my own row" guard: a suggestion belonging to
    // someone else is indistinguishable from one that doesn't exist.
    if (!suggestion || suggestion.scholarId !== ctx.user._id) {
      throw new Error("Idea not found");
    }
    const alreadyArchived = !!suggestion.archivedAt;
    if (alreadyArchived === args.archived) {
      return { archived: alreadyArchived, title: suggestion.title };
    }

    // Bringing an idea back can push the scholar over the five-open cap — say
    // so plainly rather than silently exceeding it, and name the number the way
    // the composer does.
    if (!args.archived) {
      const open = await ctx.db
        .query("scholarSuggestions")
        .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
        .filter((q) => q.eq(q.field("archivedAt"), undefined))
        .collect();
      if (open.length >= MAX_OPEN_SUGGESTIONS) {
        throw new Error(
          `You've already got ${MAX_OPEN_SUGGESTIONS} ideas out — that's the most at once. Archive one first to make room for this one.`,
        );
      }
    }

    await ctx.db.patch(args.suggestionId, {
      archivedAt: args.archived ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
    return { archived: args.archived, title: suggestion.title };
  },
});
