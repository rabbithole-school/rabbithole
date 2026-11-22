import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The only capability this lookup needs. Exported so a ctx-narrow caller — the
 * device-revocation/projection helpers carry `Pick<MutationCtx, "db" |
 * "scheduler">` — can be typed honestly instead of casting a context it does
 * not actually have to a full `QueryCtx`.
 */
export type InstitutionLookupCtx = Pick<QueryCtx | MutationCtx, "db">;

/**
 * Resolve the one institution marked primary, or null before defaults exist.
 *
 * Kept in a leaf module so low-level access and device-revocation helpers do
 * not need to import the full institutions function module. The institution
 * table is intentionally tiny, so a full scan is appropriate.
 */
// Declared narrowest-FIRST so a db-only context resolves here. The full-ctx
// overloads stay, and `QueryCtx` stays LAST on purpose: `Parameters<typeof
// primaryInstitutionId>[0]` resolves to the final overload, and
// convex/receptionAttendance.ts uses exactly that to type a helper which then
// needs more of the context than `db`.
export function primaryInstitutionId(
  ctx: InstitutionLookupCtx,
): Promise<Id<"institutions"> | null>;
export function primaryInstitutionId(
  ctx: MutationCtx,
): Promise<Id<"institutions"> | null>;
export function primaryInstitutionId(
  ctx: QueryCtx,
): Promise<Id<"institutions"> | null>;
export async function primaryInstitutionId(
  ctx: InstitutionLookupCtx,
): Promise<Id<"institutions"> | null> {
  const all = await ctx.db.query("institutions").collect();
  return all.find((institution) => institution.isPrimary)?._id ?? null;
}

/** The live primary institution, or null (none yet, or suspended). */
export async function livePrimaryInstitution(
  ctx: InstitutionLookupCtx,
): Promise<Doc<"institutions"> | null> {
  const primary = (await ctx.db.query("institutions").collect()).find(
    (institution) => institution.isPrimary,
  );
  return primary && primary.disabledAt === undefined ? primary : null;
}
