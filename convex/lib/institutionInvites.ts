// Institution invite-code helpers (pure + ctx-reading), kept out of the Convex
// functions file so the auth callback (convex/auth.ts) and the signup entry
// point (convex/users.ts) can share the redeemability + gating logic without
// importing a functions module. The functions live in convex/institutionInvites.ts.
//
// See the `institutionInvites` table comment in convex/schema.ts.

import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type InstitutionInvite = Doc<"institutionInvites">;

/**
 * Is an invite still redeemable RIGHT NOW? Single source of truth for
 * validity: not revoked, not past its expiry, and under its use cap.
 */
export function isInviteRedeemable(
  invite: InstitutionInvite,
  now: number,
): boolean {
  if (invite.revokedAt !== undefined) return false;
  if (invite.expiresAt !== undefined && invite.expiresAt <= now) return false;
  if (invite.maxUses !== undefined && invite.usedCount >= invite.maxUses) {
    return false;
  }
  return true;
}

/**
 * A human-readable reason an invite can't be redeemed, or null if it can.
 * Used to give the /join page (and the redeem path) a specific message.
 */
export function inviteRejectionReason(
  invite: InstitutionInvite,
  now: number,
): string | null {
  if (invite.revokedAt !== undefined) return "This invite link has been revoked.";
  if (invite.expiresAt !== undefined && invite.expiresAt <= now) {
    return "This invite link has expired.";
  }
  if (invite.maxUses !== undefined && invite.usedCount >= invite.maxUses) {
    return "This invite link has already been used up.";
  }
  return null;
}

/** Generate an unguessable, URL-safe invite code (144 bits of entropy). */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return isoBase64URL.fromBuffer(bytes);
}

/** Look an invite up by its exact code (codes are unguessable + unique). */
export async function findInviteByCode(
  ctx: QueryCtx | MutationCtx,
  code: string,
): Promise<InstitutionInvite | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  return await ctx.db
    .query("institutionInvites")
    .withIndex("by_code", (q) => q.eq("code", trimmed))
    .unique();
}

/** The relative path a redeemer opens for an invite. */
export function invitePath(code: string): string {
  return `/join?code=${encodeURIComponent(code)}`;
}

/**
 * The absolute base URL for an invite link. Uses `process.env.SITE_URL` with
 * the same required semantics as every other deep-link builder in this repo
 * (parentMessageSend, channels, driveAccess, …): SITE_URL is the source of
 * truth for the public origin, with the prod host as the safe fallback so a
 * dev/test deployment that hasn't set it still produces a usable link.
 *
 * NOTE: a sibling branch centralizes this in `convex/lib/deploymentConfig.ts`;
 * this reads SITE_URL directly on purpose so the two can be reconciled at
 * integration time without a cross-branch dependency here.
 */
export function inviteLinkBase(): string {
  return (process.env.SITE_URL ?? "https://rabbithole.school").replace(
    /\/+$/,
    "",
  );
}

/** The full, shareable invite URL (SITE_URL-based). */
export function inviteUrl(code: string): string {
  return inviteLinkBase() + invitePath(code);
}

/** Coarse lifecycle status for a listing UI. */
export type InviteStatus = "active" | "revoked" | "expired" | "exhausted";

export function inviteStatus(
  invite: InstitutionInvite,
  now: number,
): InviteStatus {
  if (invite.revokedAt !== undefined) return "revoked";
  if (invite.expiresAt !== undefined && invite.expiresAt <= now) return "expired";
  if (invite.maxUses !== undefined && invite.usedCount >= invite.maxUses) {
    return "exhausted";
  }
  return "active";
}
