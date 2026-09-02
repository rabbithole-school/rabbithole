/**
 * INSTITUTION SUSPENSION — temporary DISABLE / ENABLE (the reversible sibling
 * of the cascade-delete in convex/institutionDeletion.ts).
 *
 * Framed for billing: a school that stops paying gets SUSPENDED, not deleted.
 * The two operations share posture but are deliberately distinct:
 *
 *   • DELETE (institutionDeletion.ts) — destroys the institution and everything
 *     scoped to it, irreversibly. Type-to-confirm, batched, audited.
 *   • DISABLE (this file) — sets institutions.disabledAt (the timestamp IS the
 *     flag; no boolean to drift). NOTHING is destroyed; every member's data is
 *     preserved untouched. Re-enabling clears the marker and FULLY restores
 *     access. One confirm to pause, one click to resume.
 *
 * What "disabled" MEANS is enforced at the auth chokepoint, not here: a member
 * of a suspended institution is refused at `requireUser`
 * (convex/lib/access.ts → assertInstitutionActive) with a legible paused
 * message, while a user who also belongs to a still-active institution keeps
 * working there, and platform admins are never blocked (so they can inspect and
 * re-enable). This file is only the gated lifecycle control.
 *
 * Authorization: PLATFORM-ADMIN ONLY (the billing operator). Unlike delete
 * (which a school_admin may run on their own school), suspension is a
 * platform-wide billing action a school's own leader must not self-serve.
 *
 * THE PRIMARY INSTITUTION CAN NEVER BE SUSPENDED — a hard server refusal (on
 * in production that is the home school; pausing it would take it offline),
 * exactly like delete. Both operations are AUDITED into the global `auditLog`.
 */
import { v } from "convex/values";
import { platformAdminMutation } from "./lib/customFunctions";

/**
 * Temporarily disable (suspend) a non-primary institution. Idempotent: a
 * second call on an already-suspended school is a no-op that reports the
 * existing marker. Reversible — nothing is destroyed.
 */
export const disableInstitution = platformAdminMutation({
  args: {
    institutionId: v.id("institutions"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) throw new Error("Institution not found");

    // PRIMARY IS NEVER SUSPENDABLE — hard refusal, server-side (same posture as
    // delete). Pausing the primary would take the whole school offline.
    if (institution.isPrimary) {
      throw new Error("The primary institution cannot be disabled.");
    }

    // Idempotent: already suspended → report the existing marker, don't restamp.
    if (institution.disabledAt !== undefined) {
      return {
        institutionId: institution._id,
        alreadyDisabled: true,
        disabledAt: institution.disabledAt,
      };
    }

    const now = Date.now();
    const reason = args.reason?.trim() || undefined;
    await ctx.db.patch(institution._id, {
      disabledAt: now,
      disabledBy: ctx.user._id,
      disabledReason: reason,
    });

    // Mirror into the global admin audit trail (delete's convention).
    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "institution.disable",
      at: now,
      detail: `Suspended institution "${institution.name}" (${institution.slug})${
        reason ? ` — ${reason}` : ""
      }`,
    });

    return { institutionId: institution._id, alreadyDisabled: false, disabledAt: now };
  },
});

/**
 * Re-enable (resume) a suspended institution — clears the suspension marker and
 * FULLY restores access; no data was ever changed. Idempotent: enabling an
 * already-active school is a no-op.
 */
export const enableInstitution = platformAdminMutation({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) throw new Error("Institution not found");

    if (institution.disabledAt === undefined) {
      return { institutionId: institution._id, alreadyEnabled: true };
    }

    // Patching an optional field to `undefined` UNSETS it in Convex — so the
    // timestamp source-of-truth is cleared (active), along with its metadata.
    await ctx.db.patch(institution._id, {
      disabledAt: undefined,
      disabledBy: undefined,
      disabledReason: undefined,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "institution.enable",
      at: Date.now(),
      detail: `Resumed institution "${institution.name}" (${institution.slug})`,
    });

    return { institutionId: institution._id, alreadyEnabled: false };
  },
});
