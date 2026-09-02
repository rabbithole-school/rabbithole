import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { institutionIdForUnitAuthor } from "./unitAccess";

/**
 * Independent-Study (IS) unit shape — the ONE place a thin, scholar-authored
 * quest unit is minted.
 *
 * A quest's identity is (scholar, unit), and the unification's invariant is
 * "no IS session PERSISTS without a unitId." Three call sites mint the exact
 * same thin unit and MUST never diverge:
 *   1. units.createQuest — the Custom Quest ("Start a Quest").
 *   2. sessions.create — the free-form auto-mint that enforces the invariant.
 *   3. migrations.backfillUnitlessISSessions — the one-shot backfill for
 *      pre-existing unit-less IS sessions.
 * Factoring the insert here is what keeps them identical. A "thin" unit is
 * PURE IDENTITY: one insert, no lessons/activities, no LLM, no bake. See
 * review/quest-lifecycle-unification.html §3 (Identity) and §5 (Power audit).
 */

/**
 * The placeholder title a brand-new anchorless session gets before it is
 * renamed (by its unit anchor or the auto-titler). Treated as "no meaningful
 * title yet" when naming the thin IS unit, so a free-form quest reads as
 * "My Quest" rather than "New Project".
 */
export const NEW_SESSION_TITLE = "New Project";

/** Default title for a free-form quest / thin IS unit that has no title. */
export const DEFAULT_QUEST_TITLE = "My Quest";

/**
 * Resolve the thin IS unit's title from a session title, treating the
 * placeholder default as empty (→ "My Quest").
 */
export function questTitleFromSessionTitle(sessionTitle?: string): string {
  const trimmed = sessionTitle?.trim();
  return trimmed && trimmed !== NEW_SESSION_TITLE ? trimmed : DEFAULT_QUEST_TITLE;
}

/**
 * Custom Quests preserve the scholar's verbatim question in `unit.title`.
 * Once the one-shot bake creates its lesson, that lesson's polished title is
 * the stable name shown on Home. Inspired/catalog units keep their unit title.
 */
export async function homeTitleForIndependentStudyUnit(
  ctx: Pick<QueryCtx, "db">,
  unit: Doc<"units">,
): Promise<string> {
  if (unit.authorRole !== "author") return unit.title;

  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
    .collect();
  const firstLesson = lessons.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  return firstLesson?.title.trim() || unit.title;
}

/**
 * Mint a THIN scholar-authored Independent-Study unit (pure identity — no
 * lessons, no activities, no LLM, no bake) and return its id.
 *
 * The unit is scholar-owned (teacherId === authorScholarId === scholarId),
 * active, authored from scratch (`authorRole: "author"`), and carries a
 * completion badge — byte-for-byte the shape units.createQuest has
 * always produced. Callers resolve their OWN title fallback and pass the final
 * (non-empty) title.
 */
export async function mintIndependentStudyUnit(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    title: string;
    description?: string;
    badgeIcon?: string;
  },
): Promise<Id<"units">> {
  const { scholarId, title } = args;
  const description = args.description?.trim() || undefined;
  const institutionId = await institutionIdForUnitAuthor(ctx, scholarId, {
    asScholar: true,
  });
  return await ctx.db.insert("units", {
    teacherId: scholarId, // the scholar IS the unit's author/teacher
    institutionId,
    title,
    emoji: "⚡",
    description,
    // The scholar authored this in their own voice, so it reads fine as
    // their own card's blurb too.
    scholarDescription: description,
    isActive: true,
    authorScholarId: scholarId,
    // Built from scratch → truly authored (vs. a teacher-offered "inspired").
    authorRole: "author",
    badgeOnCompletion: {
      title: `${title} — completed`,
      description: `Earned by completing every activity in "${title}".`,
      icon: args.badgeIcon ?? "🏆",
    },
  });
}
