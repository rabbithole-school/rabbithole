// Trusted enrollment import primitives. Source-specific parsing, institution
// selection policy, and any decision to verify an address live downstream.
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getInstitutionBySlug } from "./institutions";
import { ensureMembership } from "./memberships";
import { normalizeEmail, isValidEmail } from "./lib/email";
import { ROLES, isPlatformAdminRole } from "./lib/roles";

const guardianValidator = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});

const scholarValidator = v.object({
  externalKey: v.string(),
  name: v.optional(v.string()),
  dateOfBirth: v.optional(v.string()),
  gradeLevel: v.optional(v.string()),
  guardians: v.array(guardianValidator),
});

const staffRoleValidator = v.union(
  v.literal(ROLES.STAFF),
  v.literal(ROLES.TEACHER),
  v.literal(ROLES.SCHOOL_ADMIN),
  v.literal(ROLES.PLATFORM_ADMIN),
);

function normalizedKey(key: string) {
  const normalized = key.trim();
  if (!normalized) throw new Error("Each enrollment record needs a stable external key");
  return normalized;
}

/**
 * Imports enrollment records supplied by a trusted operator. It never parses a
 * roster, embeds records, or confirms email ownership. Dry runs perform the
 * same resolution without writes and return counts only, so caller logs cannot
 * expose family data.
 */
export const importEnrollment = internalMutation({
  args: {
    institutionSlug: v.string(),
    dryRun: v.optional(v.boolean()),
    scholars: v.array(scholarValidator),
  },
  handler: async (ctx, args) => {
    const institution = await getInstitutionBySlug(ctx, args.institutionSlug.trim());
    if (!institution) throw new Error("Unknown institution");
    const dryRun = args.dryRun ?? false;
    let scholarsCreated = 0;
    let scholarsUpdated = 0;
    let guardiansCreated = 0;
    let guardiansReused = 0;
    let guardianshipsCreated = 0;
    const guardiansByEmail = new Map<string, Id<"users"> | null>();

    for (const record of args.scholars) {
      const externalKey = normalizedKey(record.externalKey);
      const scholar = await ctx.db
        .query("users")
        .withIndex("by_institution_enrollment_external_key", (q) =>
          q.eq("institutionId", institution._id).eq("enrollmentExternalKey", externalKey),
        )
        .unique();
      let scholarId: Id<"users"> | null = scholar?._id ?? null;
      if (scholar) {
        scholarsUpdated++;
        if (!dryRun) {
          await ctx.db.patch(scholar._id, {
            ...(record.name?.trim() ? { name: record.name.trim() } : {}),
            ...(record.dateOfBirth ? { dateOfBirth: record.dateOfBirth } : {}),
            ...(record.gradeLevel ? { gradeLevel: record.gradeLevel } : {}),
          });
          await ensureMembership(ctx, {
            userId: scholar._id,
            role: ROLES.SCHOLAR,
            institutionId: institution._id,
          });
        }
      } else {
        scholarsCreated++;
        if (!dryRun) {
          scholarId = await ctx.db.insert("users", {
            role: ROLES.SCHOLAR,
            institutionId: institution._id,
            enrollmentExternalKey: externalKey,
            ...(record.name?.trim() ? { name: record.name.trim() } : {}),
            ...(record.dateOfBirth ? { dateOfBirth: record.dateOfBirth } : {}),
            ...(record.gradeLevel ? { gradeLevel: record.gradeLevel } : {}),
            profileSetupComplete: true,
          });
          await ensureMembership(ctx, {
            userId: scholarId,
            role: ROLES.SCHOLAR,
            institutionId: institution._id,
          });
        }
      }

      for (const guardian of record.guardians) {
        const email = normalizeEmail(guardian.email);
        if (!isValidEmail(email)) throw new Error("Enrollment contains an invalid guardian email");
        let guardianId = guardiansByEmail.get(email);
        if (guardianId === undefined) {
          const existing = await ctx.db
            .query("users")
            .withIndex("by_email", (q) => q.eq("email", email))
            .unique();
          if (existing) {
            guardiansReused++;
            guardianId = existing._id;
            if (!dryRun) {
              await ensureMembership(ctx, { userId: existing._id, role: ROLES.PARENT });
            }
          } else {
            guardiansCreated++;
            guardianId = null;
            if (!dryRun) {
              guardianId = await ctx.db.insert("users", {
                email,
                role: ROLES.PARENT,
                ...(guardian.name?.trim() ? { name: guardian.name.trim() } : {}),
              });
              await ensureMembership(ctx, { userId: guardianId, role: ROLES.PARENT });
            }
          }
          guardiansByEmail.set(email, guardianId);
        }
        if (!dryRun && scholarId && guardianId) {
          const existingLink = await ctx.db
            .query("guardianships")
            .withIndex("by_pair", (q) =>
              q.eq("parentUserId", guardianId).eq("scholarUserId", scholarId),
            )
            .unique();
          if (!existingLink) {
            await ctx.db.insert("guardianships", {
              parentUserId: guardianId,
              scholarUserId: scholarId,
              createdBy: guardianId,
            });
            guardianshipsCreated++;
          }
        }
      }
    }
    return {
      dryRun,
      recordsProcessed: args.scholars.length,
      scholarsCreated,
      scholarsUpdated,
      guardiansCreated,
      guardiansReused,
      guardianshipsCreated,
    };
  },
});

/** Separate staff-account primitive; enrollment imports never create staff. */
export const ensureStaffAccount = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    role: v.optional(staffRoleValidator),
    institutionSlug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!isValidEmail(email)) throw new Error("Invalid staff email");
    const role = args.role ?? ROLES.STAFF;
    const institution = args.institutionSlug
      ? await getInstitutionBySlug(ctx, args.institutionSlug.trim())
      : null;
    if (args.institutionSlug && !institution) throw new Error("Unknown institution");
    if (!isPlatformAdminRole(role) && !institution) {
      throw new Error("Institution-scoped staff need an institution");
    }
    const existing = await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).unique();
    const userId = existing?._id ?? await ctx.db.insert("users", {
      email,
      role,
      ...(args.name?.trim() ? { name: args.name.trim() } : {}),
    });
    await ensureMembership(ctx, {
      userId,
      role,
      ...(institution ? { institutionId: institution._id } : {}),
    });
    return { created: !existing, role };
  },
});
