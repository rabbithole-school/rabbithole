// Dev/seed institutions — a fictional stand-in for the real school.
//
// Production seeds the configured primary school via institutions.ensureDefaults
// (run from the backfill migration). For DEV we don't want the real brand all
// over throwaway worktrees, so the seed creates "Moli School" (a fictional
// primary school — moli = the Laysan albatross) as the primary institution, plus
// the shared "Guests" bucket, and drops most seeded scholars into Moli with a
// couple of "outside testers" in Guests so the roster's hide-guests default is
// immediately testable. "Kona Tutoring" is the second school used by the
// multi-institution teacher fixture in seed/devPersonas.ts.
//
// Reused by: convex/seedRichCohort.ts (so the rich cohort + its tests populate
// institutions) and scripts/db-seed.sh (the CLI step that assigns every seeded
// scholar on a fresh worktree). Idempotent on every path.

import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { ROLES } from "../lib/roles";

// Shared "Guests" slug — matches institutions.GUEST_SLUG so the same UI logic
// (hide-by-default) works in dev and prod. "moli" is the dev-only primary.
export const DEV_PRIMARY_SLUG = "moli";
export const DEV_GUEST_SLUG = "guests";
export const DEV_KONA_TUTORING_SLUG = "kona-tutoring";
export const DEV_ALBATROSS_SLUG = "albatross-society";

// Seeded scholars that should land in Guests (outside testers), by username.
// Everyone else goes to Moli School — so the roster default still shows "most"
// of the cohort and the Guests bucket is non-empty for testing the filter.
const GUEST_SCHOLAR_USERNAMES = new Set<string>([
  "guest", // the base seed's default guest scholar
  "makoa_texeira", // rich-cohort tester
  "anela_cruz", // rich-cohort tester
]);
const KONA_TUTORING_SCHOLAR_USERNAMES = new Set<string>([
  "noe_tutoring",
  "emi_tutoring",
]);

/**
 * The dev primary school's two Rounds cadences.
 *
 * Set explicitly so dev exercises a CONFIGURED anchor rather than the Monday
 * 00:00 fallback — the fallback is the back-compat path for schools that never
 * configured one, and shipping without ever running the configured path would
 * have left it unverified. The weekday lives here, in dev seed data, and not
 * in product code: nothing in Rounds names a weekday.
 *
 * It deliberately does NOT track whatever day the real school currently meets.
 * Keeping dev on a different weekday is what makes the claim above observable:
 * if anything ever hardcoded the school's day, dev would disagree with it.
 */
const DEV_ROUNDS_CADENCES = [
  { kind: "academic" as const, weekday: 3, minutes: 15 * 60 },
  { kind: "sel" as const, weekday: 5, minutes: 15 * 60 },
];

/**
 * Idempotently create the dev institutions (Moli School primary + Guests +
 * Kona Tutoring), keyed by slug.
 */
export async function ensureDevInstitutions(ctx: MutationCtx): Promise<{
  moli: Id<"institutions">;
  guests: Id<"institutions">;
  konaTutoring: Id<"institutions">;
  albatross: Id<"institutions">;
}> {
  const ensure = async (
    slug: string,
    fields: {
      name: string;
      kind: "school" | "guest" | "community";
      isPrimary?: boolean;
      emoji?: string;
      roundsCadences?: typeof DEV_ROUNDS_CADENCES;
    },
  ): Promise<Id<"institutions">> => {
    const existing = await ctx.db
      .query("institutions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!existing) {
      return await ctx.db.insert("institutions", { slug, ...fields });
    }
    // Re-seeding an already-provisioned worktree must still pick up an anchor
    // added after that row was written, or every existing dev deployment keeps
    // silently running the Monday fallback.
    if (
      fields.roundsCadences !== undefined &&
      existing.roundsCadences === undefined
    ) {
      await ctx.db.patch(existing._id, {
        roundsCadences: fields.roundsCadences,
      });
    }
    return existing._id;
  };

  const moli = await ensure(DEV_PRIMARY_SLUG, {
    name: "Moli School",
    kind: "school",
    isPrimary: true,
    emoji: "🌺",
    roundsCadences: DEV_ROUNDS_CADENCES,
  });
  const guests = await ensure(DEV_GUEST_SLUG, {
    name: "Guests",
    kind: "guest",
    emoji: "🧪",
  });
  const konaTutoring = await ensure(DEV_KONA_TUTORING_SLUG, {
    name: "Kona Tutoring",
    kind: "school",
    emoji: "📚",
  });
  const albatross = await ensure(DEV_ALBATROSS_SLUG, {
    name: "Albatross Society",
    kind: "community",
    emoji: "🌊",
  });
  return { moli, guests, konaTutoring, albatross };
}

/**
 * Ensure the dev institutions exist, then assign EVERY scholar in the db to one
 * of them (Guests / Kona Tutoring for the known fixture usernames, Moli
 * School for everyone else).
 * Idempotent — re-running just re-applies the same assignment. Returns counts.
 */
export async function assignDevInstitutions(ctx: MutationCtx): Promise<{
  moli: Id<"institutions">;
  guests: Id<"institutions">;
  konaTutoring: Id<"institutions">;
  assignedMoli: number;
  assignedGuests: number;
  assignedKonaTutoring: number;
}> {
  const { moli, guests, konaTutoring } = await ensureDevInstitutions(ctx);
  const scholars = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
    .collect();

  let assignedMoli = 0;
  let assignedGuests = 0;
  let assignedKonaTutoring = 0;
  for (const s of scholars) {
    const target =
      s.username && GUEST_SCHOLAR_USERNAMES.has(s.username)
        ? guests
        : s.username && KONA_TUTORING_SCHOLAR_USERNAMES.has(s.username)
          ? konaTutoring
          : moli;
    if (s.institutionId !== target) await ctx.db.patch(s._id, { institutionId: target });
    if (target === guests) assignedGuests++;
    else if (target === konaTutoring) assignedKonaTutoring++;
    else assignedMoli++;
  }
  return {
    moli,
    guests,
    konaTutoring,
    assignedMoli,
    assignedGuests,
    assignedKonaTutoring,
  };
}

/**
 * CLI entry: seed + assign the dev institutions over whatever scholars exist.
 * Run by scripts/db-seed.sh and re-runnable by hand:
 *
 *   CONVEX_ALLOW_ANONYMOUS=false npx convex run seed/institutions:seedDevInstitutions
 */
export const seedDevInstitutions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await assignDevInstitutions(ctx);
    console.log(
      `Dev institutions: Moli School (${result.assignedMoli}) + Guests (${result.assignedGuests}) + Kona Tutoring (${result.assignedKonaTutoring}).`,
    );
    return result;
  },
});
