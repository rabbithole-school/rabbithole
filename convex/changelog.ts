// The Workshop (internal code name: `meta`) — the "What's new" changelog that
// closes the circle. See review/scholar-meta-prep-time-plan.html §§5, 8.
//
// Release notes are written when something SHIPS, whatever its provenance —
// one kid's idea, five kids', or none. Attribution is an EDITORIAL act that
// lives on the changelog entry (`creditedScholarIds`), never on an idea: an
// idea's life ends at a human reply, and credit is a separate decision the
// staff author makes (or reads off a private proposals-repo `Credits:` line).
//
// Two consumers:
//  - `listRecent` — the class-visible "What's new" feed (any signed-in user),
//    each entry carrying a server-resolved `creditLine` ("Built from an idea by
//    Kai N. 🌟"; named credit is fine — §11.5, ownership pride wins).
//  - the credit MOMENT — each credited scholar hears it once, personally, at
//    their next Prep Time. `undeliveredCreditsForScholar` feeds the reflection
//    prompt; `markCreditDelivered` stamps it at prompt-build time (the same
//    at-most-once idea as scholarSuggestions.responseSeenAt).

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { shortScholarName, isScholarWithinAideLens } from "./scholarSuggestions";

// Soft cap on the class-visible feed — newest wins, older entries scroll off.
const RECENT_LIMIT = 20;

/**
 * The credit line shown under a changelog entry, resolved server-side.
 * `null` when nobody is credited; otherwise a warm, named line — a first name
 * + last initial each ("Kai N."), joined naturally (Oxford comma for 3+):
 *   1 → "Built from an idea by Kai N. 🌟"
 *   2 → "Built from an idea by Kai N. and Lani K. 🌟"
 *   3 → "Built from an idea by Kai N., Lani K., and Sam T. 🌟"
 * Named credit is intentional (§11.5 — ownership pride). Exported for tests.
 */
export function creditLine(shortNames: string[]): string | null {
  const names = shortNames.filter((n) => n && n.trim() !== "");
  if (names.length === 0) return null;
  let joined: string;
  if (names.length === 1) {
    joined = names[0];
  } else if (names.length === 2) {
    joined = `${names[0]} and ${names[1]}`;
  } else {
    joined = `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  }
  return `Built from an idea by ${joined} 🌟`;
}

/**
 * The class-visible "What's new" feed — newest first, capped. Any signed-in
 * user may read it (a changelog entry is about Rabbithole itself, never a
 * scholar's private record). Each entry carries its resolved `creditLine`.
 *
 * GLOBAL ACROSS INSTITUTIONS, AND THAT IS INTENTIONAL (Andy, 2026-08-19).
 * `changelogEntries` deliberately carries no `institutionId`: a "What's new"
 * note is about the PRODUCT, which every school runs the same build of, so one
 * shared feed is the honest model. Consequence to know before you "fix" it: the
 * `creditLine` names credited scholars (first name + last initial, "Kai N.")
 * across school boundaries, so a reader at one institution can see that a child
 * at another inspired a feature. That was weighed and accepted — the exposure is
 * a first name + initial attached to a positive credit, with no school, record,
 * or contact attached.
 *
 * This is NOT the un-lensed hole that `scholarSuggestions` had. The WRITE side
 * IS tenant-scoped: `createEntry` below refuses to credit a username outside the
 * caller's institution lens, indistinguishably from an unknown one, so no staff
 * member can mint a credit naming another school's scholar.
 *
 * Revisit if a second school starts crediting its own scholars and those names
 * carrying across schools stops reading as a nice thing — then stamp
 * `institutionId` on the table and lens this query, rather than quietly dropping
 * credit names (the names are the point of the feature).
 */
export const listRecent = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("changelogEntries")
      .withIndex("by_createdAt")
      .order("desc")
      .take(RECENT_LIMIT);
    return await Promise.all(
      rows.map(async (row) => {
        const shortNames = await Promise.all(
          row.creditedScholarIds.map(async (id) => {
            const scholar = await ctx.db.get(id);
            return shortScholarName(scholar?.name);
          }),
        );
        return {
          _id: row._id,
          title: row.title,
          kidBody: row.kidBody,
          createdAt: row.createdAt,
          creditLine: creditLine(shortNames),
        };
      }),
    );
  },
});

/**
 * Write a "What's new" entry. Called by the `create_whats_new_entry` aide tool
 * (author = the caller). Validates non-empty title/kidBody and resolves each
 * credited username to a real user id — an unknown username throws a friendly
 * error (the tool relays it) rather than silently dropping the credit. Credit
 * is editorial and 0..n: `creditedScholarUsernames` may be empty/omitted.
 */
export const createEntry = internalMutation({
  args: {
    title: v.string(),
    kidBody: v.string(),
    creditedScholarUsernames: v.optional(v.array(v.string())),
    createdByUserId: v.id("users"),
    // Institution lens threaded from the aide tool layer (this fn has no
    // ctx.user). Arrays over the wire — Convex validators can't take a Set.
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) throw new Error("A changelog entry needs a title.");
    const kidBody = args.kidBody.trim();
    if (!kidBody) {
      throw new Error("A changelog entry needs a kid-readable body.");
    }

    const allowed = args.allowedScholarIds
      ? new Set(args.allowedScholarIds)
      : undefined;

    // Resolve credited usernames → ids (exact username, the same lookup the
    // idea queue uses). Dedupe, and collect any that don't resolve so the tool
    // can tell the staff member exactly which name to fix — never guess credit.
    const creditedScholarIds: Id<"users">[] = [];
    const seen = new Set<string>();
    const unknown: string[] = [];
    for (const raw of args.creditedScholarUsernames ?? []) {
      const username = raw.trim();
      if (!username) continue;
      const key = username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const scholar = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .unique();
      // Fail CLOSED on the institution boundary: a scholar the caller can't see
      // is treated EXACTLY like an unknown username — same "couldn't find"
      // message below — so a teacher at one school can neither write a
      // cross-tenant credit row NOR probe for another school's scholar (the
      // refusal must never reveal that the other tenant's scholar exists).
      if (
        !scholar ||
        !isScholarWithinAideLens(scholar._id, allowed, args.scholarLensResolved)
      ) {
        unknown.push(username);
        continue;
      }
      creditedScholarIds.push(scholar._id);
    }
    if (unknown.length > 0) {
      throw new Error(
        `Couldn't find ${unknown.length === 1 ? "a scholar" : "scholars"} with username ${unknown
          .map((u) => `"${u}"`)
          .join(", ")}. Double-check the username(s) — I won't guess who to credit.`,
      );
    }

    const now = Date.now();
    const entryId = await ctx.db.insert("changelogEntries", {
      title,
      kidBody,
      creditedScholarIds,
      creditDelivered: [],
      createdByUserId: args.createdByUserId,
      createdAt: now,
    });
    return { entryId, creditedCount: creditedScholarIds.length };
  },
});

/**
 * Changelog entries crediting this scholar whose credit moment hasn't fired
 * yet. Shared by the reflection-prompt context builder (metaChat.getContext)
 * and the internal query below. `entryIds` are the rows to stamp once the
 * moment is woven in (via `markCreditDelivered`). `changelogEntries` has no
 * by-credited-scholar index (array field), so this scans the small table and
 * filters — mirrors groupsForScholar.
 */
export async function undeliveredCreditsFor(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<{ credits: Array<{ title: string }>; entryIds: Id<"changelogEntries">[] }> {
  const rows = await ctx.db.query("changelogEntries").collect();
  const credits: Array<{ title: string }> = [];
  const entryIds: Id<"changelogEntries">[] = [];
  for (const row of rows) {
    const isCredited = row.creditedScholarIds.some((id) => id === scholarId);
    if (!isCredited) continue;
    const alreadyDelivered = row.creditDelivered.some(
      (d) => d.scholarId === scholarId,
    );
    if (alreadyDelivered) continue;
    credits.push({ title: row.title });
    entryIds.push(row._id);
  }
  return { credits, entryIds };
}

/**
 * Query wrapper over `undeliveredCreditsFor` — feeds the reflection prompt's
 * `{creditsSection}` (the credit moment). See that helper for the scan.
 */
export const undeliveredCreditsForScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => undeliveredCreditsFor(ctx, args.scholarId),
});

/**
 * Stamp `creditDelivered` for one scholar across the given entries — at-most-
 * once per (entry, scholar). Called at PROMPT-BUILD time (the moment the credit
 * is woven into a chat, it is delivered — same semantics as responseSeenAt).
 * Idempotent: a re-run for an already-stamped entry is a no-op.
 */
export const markCreditDelivered = internalMutation({
  args: {
    entryIds: v.array(v.id("changelogEntries")),
    scholarId: v.id("users"),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    for (const entryId of args.entryIds) {
      const entry = await ctx.db.get(entryId);
      if (!entry) continue;
      // Only stamp a scholar who is actually credited and not yet delivered.
      const isCredited = entry.creditedScholarIds.some(
        (id) => id === args.scholarId,
      );
      if (!isCredited) continue;
      if (entry.creditDelivered.some((d) => d.scholarId === args.scholarId)) {
        continue;
      }
      await ctx.db.patch(entryId, {
        creditDelivered: [
          ...entry.creditDelivered,
          { scholarId: args.scholarId, at: args.at },
        ],
      });
    }
  },
});
