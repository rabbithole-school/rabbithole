/**
 * The `simpleMdmDeviceSnapshots` row: what SimpleMDM last told us about one
 * managed serial, dated. Written by convex/simplemdm.ts after every real
 * SimpleMDM read or write; cleared here when a claim's identity changes so a
 * stale "in sync" can never describe a claim that no longer exists.
 *
 * Every lookup is keyed by (institution, serial). A serial alone is not a
 * tenant boundary: hardware moves between schools, and the row it left behind
 * belongs to the school that wrote it.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeSerial } from "./simpleMdmClient";

export type SimpleMdmSnapshotPatch = Partial<
  Omit<
    Doc<"simpleMdmDeviceSnapshots">,
    "_id" | "_creationTime" | "institutionId" | "serial" | "updatedAt"
  >
>;

export async function snapshotForInstitutionSerial(
  ctx: QueryCtx | MutationCtx,
  institutionId: Id<"institutions">,
  serial: string,
): Promise<Doc<"simpleMdmDeviceSnapshots"> | null> {
  return await ctx.db
    .query("simpleMdmDeviceSnapshots")
    .withIndex("by_institution_serial", (q) =>
      q.eq("institutionId", institutionId).eq("serial", normalizeSerial(serial)),
    )
    .unique();
}

export async function upsertSimpleMdmSnapshot(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  serial: string,
  patch: SimpleMdmSnapshotPatch,
): Promise<void> {
  const now = Date.now();
  const existing = await snapshotForInstitutionSerial(ctx, institutionId, serial);
  if (existing) {
    await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
    return;
  }
  // No defaults for the inventory fields: a row created by a push outcome
  // alone says nothing about whether SimpleMDM knows the serial.
  await ctx.db.insert("simpleMdmDeviceSnapshots", {
    institutionId,
    serial: normalizeSerial(serial),
    ...patch,
    updatedAt: now,
  });
}

/**
 * The claim this serial's verify status described no longer exists (minted,
 * rotated, unassigned, revoked). Drop the verdict; keep the device inventory
 * and the cached SimpleMDM id, which are about the hardware, not the claim.
 */
export async function forgetClaimVerification(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  serial: string,
): Promise<void> {
  const existing = await snapshotForInstitutionSerial(ctx, institutionId, serial);
  if (!existing || existing.claimVerifyStatus === undefined) return;
  await ctx.db.patch(existing._id, {
    claimVerifyStatus: undefined,
    claimVerifiedAt: undefined,
    updatedAt: Date.now(),
  });
}
