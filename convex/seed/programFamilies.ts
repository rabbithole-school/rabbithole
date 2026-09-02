// Production-only, runtime-fed onboarding for an Extended Education cohort.
//
// This module intentionally contains no family roster data. An operator supplies
// the cohort JSON at invocation time, reviews the PII-free dry-run summary, then
// re-runs with `dryRun: false`. It creates no credentials, sends no email, and
// does not call the general enrolled-scholar onboarding flow.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { ensureMembership } from "../memberships";
import { normalizeEmail, isValidEmail } from "../lib/email";
import { ENROLLMENT_STANDINGS } from "../lib/enrollmentStanding";
import { ROLES, isStaffRole } from "../lib/roles";

const familyValidator = v.object({
  scholar: v.object({
    name: v.string(),
    dateOfBirth: v.string(),
    grade: v.string(),
    externalSchoolName: v.optional(v.string()),
  }),
  guardian: v.object({
    name: v.string(),
    email: v.string(),
    phone: v.string(),
  }),
});

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function scholarKey(name: string, dateOfBirth: string): string {
  return `${normalizedText(name)}|${dateOfBirth.trim()}`;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Onboard a runtime-provided Extended Education cohort into a program group.
 *
 * `dryRun` defaults to true and never writes, including institutions. Returned
 * summaries intentionally identify only input indexes, never family data.
 */
export const seedProgramFamilies = internalMutation({
  args: {
    programGroupName: v.string(),
    instructionalKind: v.string(),
    ownerStaffEmail: v.optional(v.string()),
    ownerStaffName: v.optional(v.string()),
    families: v.array(familyValidator),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const groupName = args.programGroupName.trim();
    const instructionalKind = args.instructionalKind.trim();
    if (!groupName) throw new Error("Program group name is required.");
    if (!instructionalKind) throw new Error("Instructional kind is required.");

    const primary = (await ctx.db.query("institutions").collect()).find(
      (institution) => institution.isPrimary === true,
    );
    if (!primary) throw new Error("A primary institution is required.");

    const ownerEmail = args.ownerStaffEmail
      ? normalizeEmail(args.ownerStaffEmail)
      : "";
    const ownerName = optionalText(args.ownerStaffName);
    if ((ownerEmail ? 1 : 0) + (ownerName ? 1 : 0) !== 1) {
      throw new Error("Provide exactly one owner staff email or name.");
    }
    const ownerNameMatches = ownerName
      ? (await ctx.db.query("users").collect()).filter(
          (user) =>
            isStaffRole(user.role) &&
            normalizedText(user.name ?? "") === normalizedText(ownerName),
        )
      : [];
    const owner = ownerEmail
      ? isValidEmail(ownerEmail)
        ? await ctx.db
            .query("users")
            .withIndex("by_email", (q) => q.eq("email", ownerEmail))
            .unique()
        : null
      : ownerNameMatches.length === 1
        ? ownerNameMatches[0]
        : null;
    if (!owner || !isStaffRole(owner.role)) {
      throw new Error("Owner must be an existing staff account.");
    }
    const ownerMemberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", owner._id))
      .collect();
    if (
      !ownerMemberships.some(
        (membership) =>
          membership.institutionId === primary._id && isStaffRole(membership.role),
      )
    ) {
      throw new Error("Owner must have a staff membership at the primary institution.");
    }

    const matchingGroups = (
      await ctx.db
        .query("scholarGroups")
        .withIndex("by_institution", (q) => q.eq("institutionId", primary._id))
        .collect()
    ).filter((group) => normalizedText(group.name) === normalizedText(groupName));
    if (matchingGroups.length > 1) {
      throw new Error("More than one group has this program group name.");
    }
    const existingGroup = matchingGroups[0];

    // Reuse only primary-institution guests. Retain external keys so a matching
    // input cannot silently move a guest across institution boundaries.
    const scholarsByKey = new Map<
      string,
      { id: Id<"users"> | null }
    >();
    const crossInstitutionScholarKeys = new Set<string>();
    for (const scholar of await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect()) {
      // A row without both pieces cannot match this mutation's required
      // name+DOB key, so it must not create a false collision with another
      // incomplete legacy scholar.
      if (!scholar.name?.trim() || !scholar.dateOfBirth?.trim()) continue;
      const key = scholarKey(scholar.name, scholar.dateOfBirth);
      if (scholar.institutionId !== primary._id) {
        crossInstitutionScholarKeys.add(key);
        continue;
      }
      if (scholarsByKey.has(key)) {
        throw new Error("Multiple existing scholars share a normalized name and date of birth.");
      }
      scholarsByKey.set(key, { id: scholar._id });
    }

    const guardiansByEmail = new Map<string, Id<"users"> | null>();
    const linkedPairs = new Set<string>();
    const groupMemberKeys = new Set(
      existingGroup?.scholarIds.map((id) => String(id)) ?? [],
    );
    const programScholarIds: Id<"users">[] = [];
    const warnings: string[] = [];
    let scholarsCreated = 0;
    let scholarsUpdated = 0;
    let parentsCreated = 0;
    let parentsReused = 0;
    let guardianshipsCreated = 0;
    let groupMembersAdded = 0;

    for (const [familyIndex, family] of args.families.entries()) {
      const name = family.scholar.name.trim();
      const dateOfBirth = family.scholar.dateOfBirth.trim();
      const grade = family.scholar.grade.trim();
      if (!name || !dateOfBirth || !grade) {
        throw new Error(`Family at index ${familyIndex} has incomplete scholar data.`);
      }

      const key = scholarKey(name, dateOfBirth);
      if (crossInstitutionScholarKeys.has(key)) {
        throw new Error(
          `Family at index ${familyIndex} collides with a scholar at another institution.`,
        );
      }
      let scholar = scholarsByKey.get(key);
      let scholarId = scholar?.id ?? null;
      if (scholar) {
        if (scholar.id) {
          const existing = await ctx.db.get(scholar.id);
          if (
            !existing ||
            existing.enrollmentStanding !== ENROLLMENT_STANDINGS.PROGRAM_GUEST
          ) {
            throw new Error(
              `Family at index ${familyIndex} collides with an enrolled scholar.`,
            );
          }
        }
        scholarsUpdated++;
        if (!dryRun && scholarId) {
          await ctx.db.patch(scholarId, {
            institutionId: primary._id,
            enrollmentStanding: ENROLLMENT_STANDINGS.PROGRAM_GUEST,
            gradeLevel: grade,
            ...(optionalText(family.scholar.externalSchoolName)
              ? { externalSchoolName: optionalText(family.scholar.externalSchoolName) }
              : {}),
          });
          await ensureMembership(ctx, {
            userId: scholarId,
            role: ROLES.SCHOLAR,
            institutionId: primary._id,
          });
        }
      } else {
        scholarsCreated++;
        if (!dryRun) {
          scholarId = await ctx.db.insert("users", {
            name,
            role: ROLES.SCHOLAR,
            institutionId: primary._id,
            enrollmentStanding: ENROLLMENT_STANDINGS.PROGRAM_GUEST,
            dateOfBirth,
            gradeLevel: grade,
            externalSchoolName: optionalText(family.scholar.externalSchoolName),
            profileSetupComplete: true,
          });
          await ensureMembership(ctx, {
            userId: scholarId,
            role: ROLES.SCHOLAR,
            institutionId: primary._id,
          });
        }
        scholar = { id: scholarId };
        scholarsByKey.set(key, scholar);
      }

      const groupMemberKey = scholarId ? String(scholarId) : `new:${key}`;
      if (!groupMemberKeys.has(groupMemberKey)) {
        groupMemberKeys.add(groupMemberKey);
        groupMembersAdded++;
      }
      if (scholarId && !programScholarIds.includes(scholarId)) {
        programScholarIds.push(scholarId);
      }

      const guardianEmail = normalizeEmail(family.guardian.email);
      if (!family.guardian.name.trim() || !family.guardian.phone.trim()) {
        throw new Error(`Family at index ${familyIndex} has incomplete guardian data.`);
      }
      if (!isValidEmail(guardianEmail)) {
        throw new Error(`Family at index ${familyIndex} has an invalid guardian email.`);
      }
      let guardianId = guardiansByEmail.get(guardianEmail);
      if (!guardiansByEmail.has(guardianEmail)) {
        const existingGuardian = await ctx.db
          .query("users")
          .withIndex("by_email", (q) => q.eq("email", guardianEmail))
          .unique();
        if (existingGuardian) {
          if (
            existingGuardian.role !== ROLES.PARENT &&
            !isStaffRole(existingGuardian.role)
          ) {
            throw new Error(
              `Family at index ${familyIndex} has a guardian email assigned to an incompatible account.`,
            );
          }
          parentsReused++;
          guardianId = existingGuardian._id;
          if (!dryRun) {
            const patch = {
              ...(existingGuardian.name || !family.guardian.name.trim()
                ? {}
                : { name: family.guardian.name.trim() }),
              ...(existingGuardian.phone || !family.guardian.phone.trim()
                ? {}
                : { phone: family.guardian.phone.trim() }),
            };
            if (Object.keys(patch).length) {
              await ctx.db.patch(existingGuardian._id, patch);
            }
            await ensureMembership(ctx, {
              userId: existingGuardian._id,
              role: ROLES.PARENT,
            });
          }
        } else {
          parentsCreated++;
          if (!dryRun) {
            guardianId = await ctx.db.insert("users", {
              name: family.guardian.name.trim() || undefined,
              email: guardianEmail,
              phone: family.guardian.phone.trim() || undefined,
              role: ROLES.PARENT,
              emailVerificationTime: Date.now(),
            });
            await ensureMembership(ctx, {
              userId: guardianId,
              role: ROLES.PARENT,
            });
          }
        }
        guardiansByEmail.set(guardianEmail, guardianId ?? null);
      }

      const pairKey = `${guardianEmail}|${key}`;
      if (linkedPairs.has(pairKey)) {
        warnings.push(`Family at index ${familyIndex} repeats an earlier guardianship.`);
        continue;
      }
      if (guardianId && scholarId) {
        const existingGuardianship = await ctx.db
          .query("guardianships")
          .withIndex("by_pair", (q) =>
            q.eq("parentUserId", guardianId).eq("scholarUserId", scholarId),
          )
          .unique();
        if (existingGuardianship) {
          linkedPairs.add(pairKey);
          continue;
        }
      }
      linkedPairs.add(pairKey);
      guardianshipsCreated++;
      if (!dryRun && guardianId && scholarId) {
        await ctx.db.insert("guardianships", {
          parentUserId: guardianId,
          scholarUserId: scholarId,
          createdBy: guardianId,
        });
      }
    }

    const groupPatch = {
      institutionId: primary._id,
      name: groupName,
      type: instructionalKind,
      participation: "includes_program_guests" as const,
      ownerId: owner._id,
    };
    if (!dryRun) {
      const scholarIds = [
        ...(existingGroup?.scholarIds ?? []),
        ...programScholarIds
          .filter((id) => !(existingGroup?.scholarIds ?? []).includes(id)),
      ];
      if (existingGroup) {
        await ctx.db.patch(existingGroup._id, { ...groupPatch, scholarIds });
      } else {
        await ctx.db.insert("scholarGroups", {
          teacherId: owner._id,
          scholarIds,
          ...groupPatch,
        });
      }
    }

    return {
      dryRun,
      familiesProcessed: args.families.length,
      groupCreated: !existingGroup,
      groupUpdated: !!existingGroup,
      groupMembersAdded,
      scholarsCreated,
      scholarsUpdated,
      parentsCreated,
      parentsReused,
      guardianshipsCreated,
      warnings,
    };
  },
});
