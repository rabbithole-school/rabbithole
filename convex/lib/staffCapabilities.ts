import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { includesProgramGuests } from "../../shared/scholarGroupRouting";
import { isStaffRole } from "./roles";
import { isEnrolledScholar } from "./enrollmentStanding";

export const STAFF_CAPABILITIES = [
  "curriculum:edit",
  // Run the units you can edit (assign, push/schedule your own assignments,
  // read their progress, synthetic Preflight). Ownership is the boundary, not
  // a roster: it confers NO institution lens and NO scholar-record access —
  // see staffCapabilityInstitutionIds and lib/curriculumRun.ts.
  "curriculum:run",
  "school:operations",
  "health:manage",
  "program:publish",
  "captures:review",
  // Mentor threads with ENROLLED scholars (scholarMessages.ts) — the whole
  // institution when unscoped, else one group. Deliberately NOT a lens-granting
  // capability: see staffCapabilityInstitutionIds.
  "scholars:mentor",
  // Admissions CRM tiers (institution-wide only; a user holds at most one).
  // Like the mentor grant, neither confers an institution lens: see
  // staffCapabilityInstitutionIds.
  "admissions:full",
  "admissions:scheduling",
] as const;

export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

export const ADMISSIONS_CAPABILITIES = [
  "admissions:full",
  "admissions:scheduling",
] as const satisfies readonly StaffCapability[];

/** An admissions tier as staff editors see it. `"none"` holds no grant. */
export type AdmissionsTierSetting = "none" | "scheduling" | "full";

export function admissionsCapabilityForTier(
  tier: AdmissionsTierSetting,
): StaffCapability | null {
  switch (tier) {
    case "full":
      return "admissions:full";
    case "scheduling":
      return "admissions:scheduling";
    case "none":
      return null;
    default:
      return assertNever(tier);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

type CapabilityCtx = QueryCtx | MutationCtx;

function isActive(grant: Doc<"staffCapabilityGrants">) {
  return grant.revokedAt === undefined;
}

function hasValidScope(
  capability: StaffCapability,
  scholarGroupId: Id<"scholarGroups"> | undefined,
) {
  return (
    ((capability === "curriculum:edit" ||
      capability === "curriculum:run" ||
      capability === "school:operations" ||
      capability === "health:manage" ||
      capability === "admissions:full" ||
      capability === "admissions:scheduling") &&
      scholarGroupId === undefined) ||
    ((capability === "program:publish" || capability === "captures:review") &&
      scholarGroupId !== undefined) ||
    // Institution-wide (a mentor for every enrolled scholar) or one group.
    capability === "scholars:mentor"
  );
}

async function hasActiveInstitution(
  ctx: CapabilityCtx,
  institutionId: Id<"institutions">,
) {
  const institution = await ctx.db.get(institutionId);
  return !!institution && institution.disabledAt === undefined;
}

/**
 * Narrow grants are never a substitute for staff standing at a school. This
 * intentionally does not treat a user's coarse role as standing: the
 * institution-scoped membership is the tenant boundary. `users.role` is only
 * a denormalized default; a user may intentionally hold several staff roles.
 */
export async function hasActiveStaffMembershipAtInstitution(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  if (!(await hasActiveInstitution(ctx, institutionId))) return false;
  const user = await ctx.db.get(userId);
  if (!user) return false;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return memberships.some(
    (membership) =>
      membership.institutionId === institutionId &&
      isStaffRole(membership.role),
  );
}

async function activeGrantsFor(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  capability: StaffCapability,
) {
  return (
    await ctx.db
      .query("staffCapabilityGrants")
      .withIndex("by_grantee_capability", (q) =>
        q.eq("granteeUserId", userId).eq("capability", capability),
      )
      .collect()
  ).filter(isActive);
}

/**
 * Check an institution-wide capability grant. Coarse admin overrides belong in
 * the domain wrapper, never here: callers that use this raw primitive get a
 * narrow grant or a denial.
 */
export async function hasActiveInstitutionCapability(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  capability: StaffCapability,
): Promise<boolean> {
  if (
    capability !== "curriculum:edit" &&
    capability !== "curriculum:run" &&
    capability !== "school:operations" &&
    capability !== "health:manage" &&
    capability !== "admissions:full" &&
    capability !== "admissions:scheduling"
  ) {
    return false;
  }
  if (!(await hasActiveStaffMembershipAtInstitution(ctx, userId, institutionId))) {
    return false;
  }
  return (await activeGrantsFor(ctx, userId, capability)).some(
    (grant) =>
      grant.institutionId === institutionId && grant.scholarGroupId === undefined,
  );
}

/**
 * Check a capability scoped to one live group. The group's institution must
 * match the grantee's active staff membership; legacy/unscoped groups deny.
 */
export async function hasActiveGroupCapability(
  ctx: CapabilityCtx,
  args: {
    userId: Id<"users">;
    institutionId: Id<"institutions">;
    scholarGroupId: Id<"scholarGroups">;
    capability: StaffCapability;
  },
): Promise<boolean> {
  if (
    args.capability !== "program:publish" &&
    args.capability !== "captures:review"
  ) {
    return false;
  }
  const group = await ctx.db.get(args.scholarGroupId);
  if (!group?.institutionId || !includesProgramGuests(group)) return false;
  if (
    "institutionId" in args &&
    group.institutionId !== args.institutionId
  ) {
    return false;
  }
  if (
    !(await hasActiveStaffMembershipAtInstitution(
      ctx,
      args.userId,
      group.institutionId,
    ))
  ) {
    return false;
  }
  return (await activeGrantsFor(ctx, args.userId, args.capability)).some(
    (grant) =>
      grant.institutionId === group.institutionId &&
      grant.scholarGroupId === args.scholarGroupId,
  );
}

/** All live group ids for which a staffer holds this capability at one school. */
export async function authorizedGroupIds(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  capability: StaffCapability,
): Promise<Set<Id<"scholarGroups">>> {
  if (
    capability !== "program:publish" &&
    capability !== "captures:review"
  ) {
    return new Set();
  }
  if (!(await hasActiveStaffMembershipAtInstitution(ctx, userId, institutionId))) {
    return new Set();
  }
  const ids = new Set<Id<"scholarGroups">>();
  for (const grant of await activeGrantsFor(ctx, userId, capability)) {
    if (grant.institutionId !== institutionId || !grant.scholarGroupId) continue;
    const group = await ctx.db.get(grant.scholarGroupId);
    if (
      group?.institutionId === institutionId &&
      includesProgramGuests(group)
    ) {
      ids.add(group._id);
    }
  }
  return ids;
}

/** All active institutions in which this staffer holds an institution-wide grant. */
export async function authorizedInstitutionIds(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  capability: StaffCapability,
): Promise<Set<Id<"institutions">>> {
  if (
    capability !== "curriculum:edit" &&
    capability !== "curriculum:run" &&
    capability !== "school:operations" &&
    capability !== "health:manage" &&
    capability !== "admissions:full" &&
    capability !== "admissions:scheduling"
  ) {
    return new Set();
  }
  const ids = new Set<Id<"institutions">>();
  for (const grant of await activeGrantsFor(ctx, userId, capability)) {
    if (grant.scholarGroupId !== undefined) continue;
    if (
      await hasActiveStaffMembershipAtInstitution(
        ctx,
        userId,
        grant.institutionId,
      )
    ) {
      ids.add(grant.institutionId);
    }
  }
  return ids;
}

export type SchoolOperationsPrincipal = Doc<"users"> & {
  schoolOperationsInstitutionIds: Set<Id<"institutions">> | "all";
};

/**
 * Resolve every institution where this user may perform school operations.
 * Teacher/school_admin memberships qualify by role; base `staff` needs the
 * explicit `school:operations` capability grant at the institution.
 */
export async function schoolOperationsInstitutionIds(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<Set<Id<"institutions">> | "all"> {
  if (user.role === "platform_admin") return "all";

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const ids = new Set<Id<"institutions">>();
  for (const membership of memberships) {
    if (!membership.institutionId) continue;
    if (
      !(await hasActiveStaffMembershipAtInstitution(
        ctx,
        user._id,
        membership.institutionId,
      ))
    ) {
      continue;
    }
    if (
      membership.role === "teacher" ||
      membership.role === "school_admin"
    ) {
      ids.add(membership.institutionId);
      continue;
    }
    if (
      membership.role === "staff" &&
      (await hasActiveInstitutionCapability(
        ctx,
        user._id,
        membership.institutionId,
        "school:operations",
      ))
    ) {
      ids.add(membership.institutionId);
    }
  }
  return ids;
}

/**
 * The school-operations institutions a caller may act on — the set form, with
 * SUSPENDED schools already removed and **no `"all"` branch for a caller to
 * forget**. `null` means the caller has no school-operations standing at all,
 * which callers distinguish from an empty set (403 vs. an empty result).
 *
 * WHY THIS EXISTS — the two gates above are not interchangeable, and the
 * difference is invisible at the call site:
 *
 *   - `hasSchoolOperationsAccessAtInstitution` loads the institution and fails
 *     closed on `disabledAt`.
 *   - `schoolOperationsInstitutionIds` short-circuits to `"all"` for a
 *     platform admin BEFORE any institution is loaded. A caller written as
 *     `ids === "all" || ids.has(x)` therefore never applies the liveness
 *     check, and a suspended school stays reachable through that gate while
 *     the boolean gate refuses the very same action.
 *
 * That asymmetry shipped a real defect twice (the agent device transports,
 * PR #3919; the pairing-code lookup, TRA-359). Prefer THIS helper for any new
 * school-operations gate. A caller that legitimately wants the raw `"all"` —
 * because it then intersects with `resolveInstitutionLens`, which does its own
 * `disabledAt` filtering — can keep using `schoolOperationsInstitutionIds`,
 * but should say so in a comment.
 */
export async function liveSchoolOperationsInstitutionIds(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<Set<Id<"institutions">> | null> {
  const granted = await schoolOperationsInstitutionIds(ctx, user);
  if (granted !== "all" && granted.size === 0) return null;
  const liveIds = new Set(
    (await ctx.db.query("institutions").collect())
      .filter((institution) => institution.disabledAt === undefined)
      .map((institution) => institution._id),
  );
  // The grant path already rejects a disabled institution
  // (hasActiveStaffMembershipAtInstitution -> hasActiveInstitution); the
  // intersection is what makes that true of the admin path too.
  return granted === "all"
    ? liveIds
    : new Set([...granted].filter((id) => liveIds.has(id)));
}

export async function hasSchoolOperationsAccessAtInstitution(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt) return false;
  const ids = await schoolOperationsInstitutionIds(ctx, user);
  return ids === "all" || ids.has(institutionId);
}

export async function hasAnySchoolOperationsAccess(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<boolean> {
  const ids = await schoolOperationsInstitutionIds(ctx, user);
  return ids === "all" || ids.size > 0;
}

/**
 * Resolve the institutions where the caller may read and manage health data.
 * Health records are intentionally independent from generic school operations:
 * a role included here is a clinical/emergency-data authority, while base staff
 * must hold the explicit health:manage capability at the target institution.
 */
export async function healthInstitutionIds(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<Set<Id<"institutions">> | "all"> {
  if (user.role === "platform_admin") return "all";

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const ids = new Set<Id<"institutions">>();
  for (const membership of memberships) {
    if (!membership.institutionId) continue;
    if (
      !(await hasActiveStaffMembershipAtInstitution(
        ctx,
        user._id,
        membership.institutionId,
      ))
    ) {
      continue;
    }
    if (
      membership.role === "teacher" ||
      membership.role === "school_admin"
    ) {
      ids.add(membership.institutionId);
      continue;
    }
    if (
      membership.role === "staff" &&
      (await hasActiveInstitutionCapability(
        ctx,
        user._id,
        membership.institutionId,
        "health:manage",
      ))
    ) {
      ids.add(membership.institutionId);
    }
  }
  return ids;
}

export async function hasHealthAccessAtInstitution(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt) return false;
  const ids = await healthInstitutionIds(ctx, user);
  return ids === "all" || ids.has(institutionId);
}

/** All schools where this staff member has at least one active explicit grant. */
export async function staffCapabilityInstitutionIds(
  ctx: CapabilityCtx,
  userId: Id<"users">,
): Promise<Set<Id<"institutions">>> {
  const ids = new Set<Id<"institutions">>();
  for (const capability of STAFF_CAPABILITIES) {
    // A mentor grant opens mentor threads and nothing else. Counting it here
    // would hand a mentor-only staffer an institution lens, and with it every
    // staff surface that scopes by lens (rosters, dossiers) — the redaction
    // boundary the grant exists to keep.
    if (capability === "scholars:mentor") continue;
    // Same for the admissions tiers: an admissions-only staffer must not get
    // a roster lens (scholars, dossiers, parents) from an admissions grant.
    if (capability === "admissions:full" || capability === "admissions:scheduling") {
      continue;
    }
    // curriculum:run is ownership-scoped ("run the units you make"): it must
    // never be the thing that gives a staffer a school lens. Its holder's
    // lens, if any, comes from curriculum:edit, which it always rides beside.
    if (capability === "curriculum:run") continue;
    for (const grant of await activeGrantsFor(ctx, userId, capability)) {
      if (
        await hasActiveStaffMembershipAtInstitution(
          ctx,
          userId,
          grant.institutionId,
        )
      ) {
        ids.add(grant.institutionId);
      }
    }
  }
  return ids;
}

/**
 * Seed and admin-write primitive. A revoked row is restored in place, so each
 * capability/scope has one canonical row and repeated enables remain idempotent.
 */
export async function ensureActiveStaffCapabilityGrant(
  ctx: MutationCtx,
  args: {
    granteeUserId: Id<"users">;
    institutionId: Id<"institutions">;
    capability: StaffCapability;
    scholarGroupId?: Id<"scholarGroups">;
    grantedBy: Id<"users">;
  },
): Promise<void> {
  if (!hasValidScope(args.capability, args.scholarGroupId)) {
    throw new Error("Invalid capability scope");
  }
  if (
    !(await hasActiveStaffMembershipAtInstitution(
      ctx,
      args.granteeUserId,
      args.institutionId,
    ))
  ) {
    throw new Error("Capability recipient must be active staff at this institution");
  }
  if (args.scholarGroupId) {
    const group = await ctx.db.get(args.scholarGroupId);
    if (
      group?.institutionId !== args.institutionId ||
      // A mentor may be scoped to any group of enrolled scholars; the program
      // capabilities only ever apply to program groups.
      (args.capability !== "scholars:mentor" && !includesProgramGuests(group))
    ) {
      throw new Error(
        "Capability group must be a program group in this institution",
      );
    }
  }
  const matching = (
    await ctx.db
      .query("staffCapabilityGrants")
      .withIndex("by_grantee_capability", (q) =>
        q
          .eq("granteeUserId", args.granteeUserId)
          .eq("capability", args.capability),
      )
      .collect()
  ).filter(
    (grant) =>
      grant.institutionId === args.institutionId &&
      grant.scholarGroupId === args.scholarGroupId,
  );
  if (matching.some(isActive)) return;
  const revoked = matching.find((grant) => !isActive(grant));
  if (revoked) {
    await ctx.db.patch(revoked._id, {
      grantedBy: args.grantedBy,
      grantedAt: Date.now(),
      revokedBy: undefined,
      revokedAt: undefined,
    });
    return;
  }
  await ctx.db.insert("staffCapabilityGrants", {
    ...args,
    grantedAt: Date.now(),
  });
}

/**
 * Does this staffer's `scholars:mentor` grant cover this scholar RIGHT NOW?
 * Checked on every mentor read and write, so revoking the grant (or the
 * staffer's membership, or suspending the school) ends access immediately.
 *
 *   - the scholar is ENROLLED (a program guest is never covered) and belongs
 *     to a live institution;
 *   - the staffer holds active staff membership there;
 *   - an active grant at that institution is either institution-wide or
 *     scoped to a group (of that institution) the scholar is in.
 */
export async function mentorCoversScholar(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id">,
  scholar: Doc<"users"> | null,
): Promise<boolean> {
  if (!scholar || scholar.role !== "scholar" || !scholar.institutionId) {
    return false;
  }
  if (!isEnrolledScholar(scholar)) return false;
  const institutionId = scholar.institutionId;
  if (
    !(await hasActiveStaffMembershipAtInstitution(ctx, user._id, institutionId))
  ) {
    return false;
  }
  for (const grant of await activeGrantsFor(ctx, user._id, "scholars:mentor")) {
    if (grant.institutionId !== institutionId) continue;
    if (grant.scholarGroupId === undefined) return true;
    const group = await ctx.db.get(grant.scholarGroupId);
    if (
      group?.institutionId === institutionId &&
      group.scholarIds.includes(scholar._id)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Live institutions where this staffer holds any active mentor grant (the
 * candidate set for listing mentor threads; per-scholar coverage still goes
 * through `mentorCoversScholar`).
 */
export async function mentorInstitutionIds(
  ctx: CapabilityCtx,
  userId: Id<"users">,
): Promise<Set<Id<"institutions">>> {
  const ids = new Set<Id<"institutions">>();
  for (const grant of await activeGrantsFor(ctx, userId, "scholars:mentor")) {
    if (
      await hasActiveStaffMembershipAtInstitution(
        ctx,
        userId,
        grant.institutionId,
      )
    ) {
      ids.add(grant.institutionId);
    }
  }
  return ids;
}

/**
 * The admissions tier this user holds at one LIVE institution, re-checked on
 * every call so a revoked grant, a removed membership or a suspended school
 * ends access immediately:
 *
 *   platform_admin (users.role)                 → full (no grant needed)
 *   active staff membership + admissions:full   → full
 *   active staff membership + admissions:sched. → scheduling
 *   anything else (school_admin included)       → none
 *
 * Institution-neutral. Which institution admissions runs at is the caller's
 * business (the first-party CRM pins it to the primary school).
 */
export async function admissionsTierAtInstitution(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  institutionId: Id<"institutions">,
): Promise<AdmissionsTierSetting> {
  if (!(await hasActiveInstitution(ctx, institutionId))) return "none";
  if (user.role === "platform_admin") return "full";
  if (
    await hasActiveInstitutionCapability(
      ctx,
      user._id,
      institutionId,
      "admissions:full",
    )
  ) {
    return "full";
  }
  if (
    await hasActiveInstitutionCapability(
      ctx,
      user._id,
      institutionId,
      "admissions:scheduling",
    )
  ) {
    return "scheduling";
  }
  return "none";
}
