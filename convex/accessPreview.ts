// Verification / debug tool for the institution access boundary
// (convex/lib/access.ts). Given a user (by id or username), report — for EACH
// of their membership contexts — which scholars that context can access, which
// context resolveActiveMembership picks as the DEFAULT. Lets an admin diagnose
// what a user (e.g. a teacher) can see in each context without impersonating.
//
// internalQuery: callable via `npx convex run accessPreview:previewAccessibleScholars`
// (no end-user identity needed) but never exposed to the client. Read-only.
//
// This module also hosts `auditEnforcementReadiness` (below) — the integrity
// audit used before rollout and retained to detect data that enforcement would
// deny.

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  accessibleScholarIds,
  resolveActiveMembership,
} from "./lib/access";
import { ROLES, type Role } from "./lib/roles";

export const previewAccessibleScholars = internalQuery({
  // Pass exactly one of { userId } or { username }.
  args: {
    userId: v.optional(v.id("users")),
    username: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let user: Doc<"users"> | null = null;
    if (args.userId) {
      user = await ctx.db.get(args.userId);
    } else if (args.username) {
      user = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", args.username))
        .unique();
    } else {
      throw new Error("Pass either userId or username");
    }
    if (!user) throw new Error("User not found");

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user!._id))
      .collect();

    // resolveActiveMembership returns one of the membership rows (a full doc at
    // runtime, though its declared type only Picks a few fields) — cast to read
    // its _id so we can flag the default context.
    const active = await resolveActiveMembership(ctx, user);
    const defaultMembershipId: Id<"memberships"> | null = active
      ? (active as unknown as Doc<"memberships">)._id
      : null;

    const contexts = [];
    for (const m of memberships) {
      const inst = m.institutionId ? await ctx.db.get(m.institutionId) : null;
      const ids = await accessibleScholarIds(ctx, m);
      const scholars: {
        id: Id<"users">;
        name: string | null;
        username: string | null;
      }[] = [];
      for (const id of ids) {
        const s = await ctx.db.get(id);
        if (s)
          scholars.push({
            id,
            name: s.name ?? null,
            username: s.username ?? null,
          });
      }
      scholars.sort((a, b) =>
        (a.username ?? "").localeCompare(b.username ?? ""),
      );
      contexts.push({
        membershipId: m._id,
        role: m.role,
        institutionId: m.institutionId ?? null,
        institution: inst ? { name: inst.name, slug: inst.slug } : null,
        isDefault: m._id === defaultMembershipId,
        scholarCount: scholars.length,
        scholars,
      });
    }

    return {
      user: {
        id: user._id,
        name: user.name ?? null,
        username: user.username ?? null,
        role: user.role ?? null,
      },
      defaultMembershipId,
      contexts,
    };
  },
});

// ── Enforcement readiness audit ───────────────────────────────────────
//
// The backfill check originally run on PROD before rollout. The boundary
// (convex/lib/access.ts) is unconditional, so a data gap produces a denial:
//
//   • A scholar with no `institutionId` drops out of the `by_institution`
//     roster, so a teacher/operations staff/school_admin at that scholar's school
//     can no longer read their data (only a platform_admin still can).
//   • A teacher/operations staff/school_admin with no institution-scoped membership
//     resolves to an empty accessible-set (accessibleScholarIds fail-closes
//     when `membership.institutionId` is absent), so they'd see NOBODY.
//   • A staffer with zero memberships at all is denied even earlier —
//     requireActiveScholarAccess throws "no active membership/context".
//
// This query reports exactly those gaps (ids + usernames), so an operator can
// confirm the enforced data remains complete.
// Read-only; internalQuery (run via `npx convex run
// accessPreview:auditEnforcementReadiness`), never exposed to the client.
//
// curriculum_designer is included among "staffers" per the migration spec,
// but note it gets ∅ scholar access BY DESIGN (it's not a scholar-data role),
// so a missing institution membership for a designer is harmless. Each row's
// `role` distinguishes a load-bearing gap (teacher/school_admin) from
// a benign one (curriculum_designer).
const INSTITUTION_SCOPED_STAFF_ROLES: readonly Role[] = [
  ROLES.TEACHER,
  ROLES.STAFF,
  ROLES.SCHOOL_ADMIN,
  ROLES.CURRICULUM_DESIGNER,
];

export const auditEnforcementReadiness = internalQuery({
  args: {},
  handler: async (ctx) => {
    // 1. Scholars (role === "scholar") missing an institution.
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    const scholarsMissingInstitution = scholars
      .filter((s) => !s.institutionId)
      .map((s) => ({
        id: s._id,
        username: s.username ?? null,
        name: s.name ?? null,
      }))
      .sort((a, b) => (a.username ?? "").localeCompare(b.username ?? ""));

    // 2. Institution-scoped staffers with no institution-scoped membership.
    //    Candidate staffers = union of { users.role is a staff role } and
    //    { has a membership whose role is a staff role } — the same superset
    //    the boundary can act on (it keys off the ACTIVE MEMBERSHIP's role,
    //    which may differ from the legacy users.role).
    const memberships = await ctx.db.query("memberships").collect();
    const membershipsByUser = new Map<Id<"users">, Doc<"memberships">[]>();
    for (const m of memberships) {
      const list = membershipsByUser.get(m.userId) ?? [];
      list.push(m);
      membershipsByUser.set(m.userId, list);
    }

    const staffCandidates = new Map<Id<"users">, Doc<"users">>();
    for (const role of INSTITUTION_SCOPED_STAFF_ROLES) {
      const byRole = await ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", role))
        .collect();
      for (const u of byRole) staffCandidates.set(u._id, u);
    }
    for (const m of memberships) {
      if (
        INSTITUTION_SCOPED_STAFF_ROLES.includes(m.role as Role) &&
        !staffCandidates.has(m.userId)
      ) {
        const u = await ctx.db.get(m.userId);
        if (u) staffCandidates.set(m.userId, u);
      }
    }

    const staffersWithoutInstitutionMembership: {
      id: Id<"users">;
      username: string | null;
      name: string | null;
      role: string | null;
      membershipCount: number;
    }[] = [];
    for (const [uid, u] of staffCandidates) {
      const mems = membershipsByUser.get(uid) ?? [];
      const hasInstitutionMembership = mems.some((m) => !!m.institutionId);
      if (!hasInstitutionMembership) {
        staffersWithoutInstitutionMembership.push({
          id: uid,
          username: u.username ?? null,
          name: u.name ?? null,
          role: u.role ?? null,
          membershipCount: mems.length,
        });
      }
    }
    staffersWithoutInstitutionMembership.sort((a, b) =>
      (a.username ?? "").localeCompare(b.username ?? ""),
    );

    // "Load-bearing" gaps: the staffers a flip would WRONGLY deny scholar
    // access (curriculum_designer excluded — it never had scholar access).
    const blockingStaffers = staffersWithoutInstitutionMembership.filter(
      (s) => s.role !== ROLES.CURRICULUM_DESIGNER,
    );

    return {
      totalScholars: scholars.length,
      scholarsMissingInstitution,
      scholarsMissingInstitutionCount: scholarsMissingInstitution.length,
      staffCandidateCount: staffCandidates.size,
      staffersWithoutInstitutionMembership,
      staffersWithoutInstitutionMembershipCount:
        staffersWithoutInstitutionMembership.length,
      // TRUE when no scholar is orphaned AND no institution-scoped staffer
      // (teacher/operations staff/school_admin) lacks an institution membership —
      // i.e. the flip won't wrongly deny a real user. A benign
      // curriculum_designer gap does NOT block readiness.
      ready:
        scholarsMissingInstitution.length === 0 && blockingStaffers.length === 0,
    };
  },
});
