// The reader matrix: every multi-tenant access helper, asked the same questions
// about every small world, checked against ONE reference predicate.
//
// Why this file: in one week five fixes landed for "two access helpers
// disagree" (90f1b8c, bc4c676, 53e1d14, 1988fe1, a98016f). Each was found by
// hand, one helper pair at a time. The access logic is relational, not
// concurrent, so the right tool is an enumerated matrix: generate every small
// world, run every helper, and compare each answer with `expectedStanding`, a
// single predicate written from the DOCTRINE (the helper header comments,
// CLAUDE.md "Multi-tenancy", .claude/rules/rabbithole-multi-tenancy.md), not
// from the code.
//
// A world is: two institutions (primary P, other O; O optionally suspended),
// one scholar at each, and one actor with a `users.role`, a home
// `users.institutionId`, a subset of memberships, and optional capability
// grants. See `enumerateWorlds` for the pruning, each rule cited.
//
// Known disagreements are pinned as `it.fails` with the minimal world that
// shows them. When one is fixed, its `it.fails` starts failing — flip it to
// `it` and delete the KNOWN entry. Anything NOT in KNOWN fails the
// "no unexplained disagreements" test with the minimal world attached.

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import schema from "../schema";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  accessibleScholarIds,
  assertCuratableInstitution,
  canAccessScholar,
  canReadScholarAsTeacher,
  canUserAccessScholar,
  curatableInstitutionIds,
  evaluateInstitutionSuspension,
  filterToAccessibleScholars,
  isBlockedBySuspension,
  requireActiveScholarAccess,
  requireScholarsAccessible,
  resolveActiveMembership,
} from "../lib/access";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
  scholarInLens,
} from "../lib/institutionLens";
import {
  hasSchoolOperationsAccessAtInstitution,
  liveSchoolOperationsInstitutionIds,
  schoolOperationsInstitutionIds,
} from "../lib/staffCapabilities";
import type { StaffCapability } from "../lib/staffCapabilities";
import { ROLES, type Role } from "../lib/roles";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── World model ──────────────────────────────────────────────────────────

type Inst = "P" | "O";
const INSTS: readonly Inst[] = ["P", "O"];

type MembershipKey =
  | "teacher@P"
  | "teacher@O"
  | "school_admin@P"
  | "school_admin@O"
  | "staff@P"
  | "staff@O"
  | "curriculum_designer@P"
  | "curriculum_designer@O"
  | "lifelong_learner@-"
  | "curriculum_designer@-"
  | "platform_admin@-";

const MEMBERSHIP_KEYS: readonly MembershipKey[] = [
  "teacher@P",
  "teacher@O",
  "school_admin@P",
  "school_admin@O",
  "staff@P",
  "staff@O",
  // A scoped designer is legal (roles.ts SCHOOL_STANDING_ROLES) and counts
  // as staff standing in hasActiveStaffMembershipAtInstitution and the lens.
  "curriculum_designer@P",
  "curriculum_designer@O",
  "lifelong_learner@-",
  "curriculum_designer@-",
  "platform_admin@-",
];

function parseMembership(key: MembershipKey): { role: Role; inst: Inst | null } {
  const [role, inst] = key.split("@");
  return { role: role as Role, inst: inst === "-" ? null : (inst as Inst) };
}

const ACTOR_ROLES: readonly Role[] = [
  ROLES.TEACHER,
  ROLES.SCHOOL_ADMIN,
  ROLES.STAFF,
  ROLES.PLATFORM_ADMIN,
  ROLES.CURRICULUM_DESIGNER,
  ROLES.LIFELONG_LEARNER,
  ROLES.PARENT,
  ROLES.SCHOLAR,
];

/**
 * One capability grant row per school (grants only exist where the actor
 * holds `staff@`). Every STAFF_CAPABILITIES entry is modelled at O:
 * the three institution-wide ones (school:operations — also revoked —,
 * health:manage, curriculum:edit) and one group-scoped one (program:publish
 * on a program group at O; captures:review has the same grant shape and the
 * same readers, so it adds no distinct world). P carries the institution-wide
 * three, to show a grant at one school never reaches the other.
 */
type GrantO =
  | "none"
  | "ops"
  | "opsRevoked"
  | "health"
  | "curriculum"
  | "programGroup";
type GrantP = "none" | "ops" | "health" | "curriculum";

type World = {
  suspendedO: boolean;
  role: Role;
  home: Inst | null;
  memberships: MembershipKey[];
  grantO: GrantO;
  grantP: GrantP;
};

function describeWorld(w: World): string {
  return [
    `role=${w.role}`,
    `home=${w.home ?? "none"}`,
    `memberships=[${w.memberships.join(", ")}]`,
    `grantO=${w.grantO}`,
    `grantP=${w.grantP}`,
    `suspended=${w.suspendedO ? "O" : "none"}`,
  ].join(" ");
}

/** Size used to pick the minimal world for a disagreement pattern. */
function worldSize(w: World): number {
  return (
    w.memberships.length * 4 +
    (w.grantO === "none" ? 0 : 2) +
    (w.grantP === "none" ? 0 : 2) +
    (w.home === null ? 0 : 1) +
    (w.suspendedO ? 1 : 0)
  );
}

/**
 * Pruning, each rule cited:
 *  - P is never suspended: `institutionLifecycle.ts:50` throws "The primary
 *    institution cannot be disabled." So suspension ∈ {none, O}.
 *  - A capability grant needs an active staff membership at its institution
 *    (`ensureActiveStaffCapabilityGrant`, staffCapabilities.ts:428-436). Grants
 *    are only generated where the actor holds the base `staff@` membership,
 *    the only role whose authority the grant changes.
 *  - A `platform_admin` membership is only generated unscoped:
 *    `SCHOOL_STANDING_ROLES` (roles.ts:116-123) documents a scoped one as the
 *    wrong row (TRA-349).
 *  - Membership subsets are capped at MAX_MEMBERSHIPS = 2 (67 of the 2,048
 *    subsets of 11 keys): every PAIRWISE interaction between memberships is
 *    covered, crossed with every actor role, grant and suspension state.
 *    Every disagreement pattern found so far has a minimal world of at most
 *    one membership. With 8 keys, the cap-3 and uncapped (15,360-world)
 *    products found exactly the same patterns as each other; with 11 keys,
 *    cap 3 (13,280 worlds, ~100 s) found exactly the same patterns as this
 *    cap 2 (2,720 worlds, ~16 s). Raise the cap locally when auditing a
 *    helper change.
 *  - `users.institutionId` (home) is read only by the suspension decision,
 *    so the convex-test matrix rotates it across worlds instead of
 *    multiplying by it; the pure `isBlockedBySuspension` matrix below takes
 *    the full cross product with home.
 */
const MAX_MEMBERSHIPS = 2;

function enumerateWorlds(): World[] {
  const worlds: World[] = [];
  const homes: (Inst | null)[] = ["P", "O", null];
  let rotate = 0;
  for (const suspendedO of [false, true]) {
    for (const role of ACTOR_ROLES) {
      for (let mask = 0; mask < 1 << MEMBERSHIP_KEYS.length; mask++) {
        const memberships = MEMBERSHIP_KEYS.filter((_, i) => mask & (1 << i));
        if (memberships.length > MAX_MEMBERSHIPS) continue;
        const grantOs: GrantO[] = memberships.includes("staff@O")
          ? ["none", "ops", "opsRevoked", "health", "curriculum", "programGroup"]
          : ["none"];
        const grantPs: GrantP[] = memberships.includes("staff@P")
          ? ["none", "ops", "health", "curriculum"]
          : ["none"];
        for (const grantO of grantOs) {
          for (const grantP of grantPs) {
            worlds.push({
              suspendedO,
              role,
              home: homes[rotate++ % homes.length],
              memberships,
              grantO,
              grantP,
            });
          }
        }
      }
    }
  }
  return worlds;
}

// ── Reference predicate (doctrine, not code) ─────────────────────────────

type Standing = {
  blocked: boolean;
  /** Scholars at this institution may be read by the actor (per-scholar gate). */
  scholarReadable: Record<Inst, boolean>;
  /** School-operations standing at this institution. */
  operations: Record<Inst, boolean>;
  /** May curate this institution's school-level resources. */
  curatable: Record<Inst, boolean>;
};

const GLOBAL_PRIVILEGED = new Set<Role>([
  ROLES.PLATFORM_ADMIN,
  ROLES.CURRICULUM_DESIGNER,
  ROLES.LIFELONG_LEARNER,
]);
const INSTITUTION_STAFF = new Set<Role>([
  ROLES.TEACHER,
  ROLES.SCHOOL_ADMIN,
  ROLES.STAFF,
]);

/**
 * Doctrine, restated in one place:
 *
 *  1. Suspension (access.ts header of the suspension section, roles.ts
 *     GLOBALLY_PRIVILEGED_ROLES): a global role — by users.role or by an
 *     UNSCOPED membership — is never blocked; any membership at a live school
 *     or with no school keeps the user; a live home keeps them; otherwise
 *     they are blocked iff tied to a suspended school.
 *  2. Platform operator: platform_admin is global. Doctrine says
 *     `users.role` is only a denormalized default and the membership row is
 *     the tenant boundary (staffCapabilities.ts:45-48), so an unscoped
 *     platform_admin MEMBERSHIP confers the same standing as the role.
 *  3. Staff standing at a school needs an active staff membership THERE, and
 *     the school must not be suspended ("a user who also holds a membership
 *     at a still-active institution keeps working THERE", access.ts). Base
 *     `staff` carries no authority on its own: scholar access / operations
 *     need a live `school:operations` grant (CLAUDE.md roles table).
 *  4. Global standing via a membership needs a role that is globally
 *     privileged AND staff (90f1b8c): lifelong_learner never confers staff
 *     reach.
 *  5. Curation (access.ts curation header): platform_admin / curriculum
 *     designer are global; teacher / staff / school_admin curate their
 *     staff-membership schools; an institution-scoped staffer with NO
 *     membership falls back to the primary school; a suspended school is
 *     never curatable (bc4c676's rule for school-operations, applied to the
 *     sibling scope).
 *  6. Never read another institution's scholars; never read a suspended
 *     school's scholars except as the platform operator (who "retains full
 *     access to inspect and re-enable", assertInstitutionActive).
 */
function expectedStanding(w: World): Standing {
  const ms = w.memberships.map(parseMembership);
  const suspended = (i: Inst | null) => i === "O" && w.suspendedO;

  // 1. suspension
  let blocked: boolean;
  if (!w.suspendedO) blocked = false;
  else if (GLOBAL_PRIVILEGED.has(w.role)) blocked = false;
  else if (ms.some((m) => m.inst === null && GLOBAL_PRIVILEGED.has(m.role)))
    blocked = false;
  else if (ms.some((m) => m.inst === null || !suspended(m.inst))) blocked = false;
  else if (w.home !== null && !suspended(w.home)) blocked = false;
  else
    blocked =
      (w.home !== null && suspended(w.home)) ||
      ms.some((m) => m.inst !== null && suspended(m.inst));

  // 2. platform operator: users.role alone (TRA-375). A platform_admin
  // membership held without the role is a stale row and confers nothing.
  const operator = w.role === ROLES.PLATFORM_ADMIN;

  const grantOpsAt = (i: Inst) =>
    i === "O" ? w.grantO === "ops" : w.grantP === "ops";

  const operations = {} as Record<Inst, boolean>;
  const scholarReadable = {} as Record<Inst, boolean>;
  const curatable = {} as Record<Inst, boolean>;

  // 5. global curator
  const globalCurator =
    operator ||
    w.role === ROLES.CURRICULUM_DESIGNER ||
    ms.some((m) => m.inst === null && m.role === ROLES.CURRICULUM_DESIGNER);
  const hasScopedStaffMembership = ms.some(
    (m) => m.inst !== null && INSTITUTION_STAFF.has(m.role),
  );

  for (const i of INSTS) {
    const live = !suspended(i);
    // 3. operations standing
    const opsByMembership = ms.some(
      (m) =>
        m.inst === i &&
        (m.role === ROLES.TEACHER ||
          m.role === ROLES.SCHOOL_ADMIN ||
          (m.role === ROLES.STAFF && grantOpsAt(i))),
    );
    operations[i] = !blocked && live && (operator || opsByMembership);
    // 6. scholar reads: operator may inspect a suspended school.
    scholarReadable[i] = !blocked && (operator || (live && opsByMembership));
    // 5. curation
    const staffMembershipHere = ms.some(
      (m) => m.inst === i && INSTITUTION_STAFF.has(m.role),
    );
    const primaryFallback =
      i === "P" && !hasScopedStaffMembership && INSTITUTION_STAFF.has(w.role);
    // The operator keeps a suspended school (listForStaff marks it paused
    // for them); every other curator, global or scoped, loses it (TRA-373).
    curatable[i] =
      !blocked &&
      (operator ||
        (live && (globalCurator || staffMembershipHere || primaryFallback)));
  }

  return { blocked, scholarReadable, operations, curatable };
}

// ── Observation (the helpers under test) ─────────────────────────────────

type Observed = {
  blocked: boolean;
  canUserAccessScholar: Record<Inst, boolean>;
  requireActiveScholarAccess: Record<Inst, boolean>;
  requireScholarsAccessible: Record<Inst, boolean>;
  filterToAccessibleScholars: Record<Inst, boolean>;
  canReadScholarAsTeacher: Record<Inst, boolean>;
  /** Per membership: accessibleScholarIds + canAccessScholar. */
  perMembership: {
    key: MembershipKey;
    accessible: Record<Inst, boolean>;
    canAccess: Record<Inst, boolean>;
  }[];
  activeMembership: MembershipKey | null;
  activeAccessible: Record<Inst, boolean>;
  schoolOps: Record<Inst, boolean>;
  schoolOpsIsAll: boolean;
  liveSchoolOps: Record<Inst, boolean>;
  hasSchoolOpsAt: Record<Inst, boolean>;
  curatable: Record<Inst, boolean>;
  curatableIsAll: boolean;
  assertCuratable: Record<Inst, boolean>;
  /** Plain-user lens, requested "all" (teacherQuery / authedQuery callers). */
  lensAllowed: Record<Inst, boolean>;
  lensAllScholars: Record<Inst, boolean>;
  /** Plain-user lens, each institution requested explicitly. */
  lensHonored: Record<Inst, boolean>;
  /**
   * Plain-user lens, each institution requested explicitly: does the honored
   * lens surface that school's scholar (scholarIdsInLens or scholarInLens)?
   */
  lensInstScholars: Record<Inst, boolean>;
  /** SchoolOperationsPrincipal lens "all" (scholarAdminQuery callers). */
  principalLensAllScholars: Record<Inst, boolean>;
};

async function passes(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Forbidden")) return false;
    throw e;
  }
}

async function observe(
  ctx: QueryCtx,
  ids: {
    inst: Record<Inst, Id<"institutions">>;
    scholar: Record<Inst, Id<"users">>;
    actor: Id<"users">;
    membershipIds: Map<Id<"memberships">, MembershipKey>;
  },
): Promise<Observed> {
  const actor = (await ctx.db.get(ids.actor)) as Doc<"users">;
  const has = (set: Set<Id<"users">>) => ({
    P: set.has(ids.scholar.P),
    O: set.has(ids.scholar.O),
  });
  const perInst = async (
    fn: (i: Inst) => Promise<boolean>,
  ): Promise<Record<Inst, boolean>> => ({ P: await fn("P"), O: await fn("O") });

  const blocked = (await evaluateInstitutionSuspension(ctx, actor)).blocked;

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", ids.actor))
    .collect();
  const perMembership = [];
  for (const m of memberships) {
    perMembership.push({
      key: ids.membershipIds.get(m._id)!,
      accessible: has(await accessibleScholarIds(ctx, m)),
      canAccess: await perInst((i) => canAccessScholar(ctx, m, ids.scholar[i])),
    });
  }
  const active = await resolveActiveMembership(ctx, actor);
  const activeAccessible = active
    ? has(await accessibleScholarIds(ctx, active))
    : { P: false, O: false };
  const activeKey =
    active && "_id" in active
      ? ids.membershipIds.get((active as Doc<"memberships">)._id) ?? null
      : null;

  const ops = await schoolOperationsInstitutionIds(ctx, actor);
  const liveOps = await liveSchoolOperationsInstitutionIds(ctx, actor);
  const cur = await curatableInstitutionIds(ctx, actor);

  const filtered = new Set(
    await filterToAccessibleScholars(ctx, actor, [ids.scholar.P, ids.scholar.O]),
  );

  const lensAll = await resolveInstitutionLens(ctx, actor, "all");
  const principal = {
    ...actor,
    schoolOperationsInstitutionIds: ops,
  };
  const principalLens = await resolveInstitutionLens(ctx, principal, "all");

  return {
    blocked,
    canUserAccessScholar: await perInst((i) =>
      canUserAccessScholar(ctx, actor, ids.scholar[i]),
    ),
    requireActiveScholarAccess: await perInst((i) =>
      passes(() => requireActiveScholarAccess(ctx, actor, ids.scholar[i])),
    ),
    requireScholarsAccessible: await perInst((i) =>
      passes(() => requireScholarsAccessible(ctx, actor, [ids.scholar[i]])),
    ),
    filterToAccessibleScholars: has(filtered),
    canReadScholarAsTeacher: await perInst((i) =>
      canReadScholarAsTeacher(ctx, actor, ids.scholar[i]),
    ),
    perMembership,
    activeMembership: activeKey,
    activeAccessible,
    schoolOps: {
      P: ops === "all" || ops.has(ids.inst.P),
      O: ops === "all" || ops.has(ids.inst.O),
    },
    schoolOpsIsAll: ops === "all",
    liveSchoolOps: {
      P: !!liveOps?.has(ids.inst.P),
      O: !!liveOps?.has(ids.inst.O),
    },
    hasSchoolOpsAt: await perInst((i) =>
      hasSchoolOperationsAccessAtInstitution(ctx, actor, ids.inst[i]),
    ),
    curatable: {
      P: cur === "all" || cur.has(ids.inst.P),
      O: cur === "all" || cur.has(ids.inst.O),
    },
    curatableIsAll: cur === "all",
    assertCuratable: await perInst((i) =>
      passes(() => assertCuratableInstitution(ctx, actor, ids.inst[i])),
    ),
    lensAllowed: {
      P: lensAll.allowedInstitutionIds.has(ids.inst.P),
      O: lensAll.allowedInstitutionIds.has(ids.inst.O),
    },
    lensAllScholars: has(await scholarIdsInLens(ctx, lensAll)),
    lensHonored: await perInst(async (i) => {
      const lens = await resolveInstitutionLens(ctx, actor, `${i.toLowerCase()}-school`);
      return lens.honored && lens.institution?._id === ids.inst[i];
    }),
    lensInstScholars: await perInst(async (i) => {
      const lens = await resolveInstitutionLens(ctx, actor, `${i.toLowerCase()}-school`);
      if (!lens.honored || lens.institution?._id !== ids.inst[i]) return false;
      const scholar = await ctx.db.get(ids.scholar[i]);
      return (
        (await scholarIdsInLens(ctx, lens)).has(ids.scholar[i]) ||
        (!!scholar && scholarInLens(lens, scholar))
      );
    }),
    principalLensAllScholars: has(await scholarIdsInLens(ctx, principalLens)),
  };
}

// ── Checks → disagreements ───────────────────────────────────────────────

type Disagreement = { pattern: string; detail: string };

function diff(
  pattern: string,
  label: string,
  got: Record<Inst, boolean>,
  want: Record<Inst, boolean>,
  out: Disagreement[],
  /** Only flag cells where the helper GRANTS more than the reference. */
  grantsOnly = false,
) {
  for (const i of INSTS) {
    if (got[i] === want[i]) continue;
    if (grantsOnly && !got[i]) continue;
    out.push({
      pattern,
      detail: `${label}[${i}] = ${got[i]}, reference = ${want[i]}`,
    });
  }
}

function check(w: World, o: Observed): Disagreement[] {
  const ref = expectedStanding(w);
  const out: Disagreement[] = [];
  const ms = w.memberships.map(parseMembership);
  const pamembershipOnly =
    w.role !== ROLES.PLATFORM_ADMIN && w.memberships.includes("platform_admin@-");

  // C1 — suspension.
  if (o.blocked !== ref.blocked) {
    out.push({
      pattern: "C1 blocked",
      detail: `evaluateInstitutionSuspension.blocked = ${o.blocked}, reference = ${ref.blocked}`,
    });
  }
  // Every other helper sits behind requireUser → assertInstitutionActive, so
  // a blocked actor's answers are moot (the request never reaches them).
  if (ref.blocked) return out;

  // C2 — the per-scholar gate vs. the reference. A platform_admin MEMBERSHIP
  // held by a non-platform_admin users.role is split out: see KNOWN.
  diff(
    pamembershipOnly ? "C2 per-scholar gate ignores platform_admin membership" : "C2 canUserAccessScholar",
    "canUserAccessScholar",
    o.canUserAccessScholar,
    ref.scholarReadable,
    out,
  );

  // C3 — the throwing / filtering / plural forms agree with the boolean gate.
  diff("C3 requireActiveScholarAccess≠canUserAccessScholar", "requireActiveScholarAccess", o.requireActiveScholarAccess, o.canUserAccessScholar, out);
  diff("C3 filterToAccessibleScholars≠canUserAccessScholar", "filterToAccessibleScholars", o.filterToAccessibleScholars, o.canUserAccessScholar, out);
  diff("C3 requireScholarsAccessible≠canUserAccessScholar", "requireScholarsAccessible", o.requireScholarsAccessible, o.canUserAccessScholar, out);

  // C4 — a single membership context never reaches more than the reference.
  for (const pm of o.perMembership) {
    diff(`C4 accessibleScholarIds(${parseMembership(pm.key).role} membership) over-grants`, `accessibleScholarIds(${pm.key})`, pm.accessible, ref.scholarReadable, out, true);
    diff("C4 canAccessScholar≠accessibleScholarIds", `canAccessScholar(${pm.key})`, pm.canAccess, pm.accessible, out);
  }
  diff("C4 active-membership accessibleScholarIds over-grants", `accessibleScholarIds(active=${o.activeMembership})`, o.activeAccessible, ref.scholarReadable, out, true);

  // C5 — the teacher-signal gate never reaches past the reference.
  diff(
    pamembershipOnly ? "C5 canReadScholarAsTeacher honors platform_admin membership (gate split)" : "C5 canReadScholarAsTeacher over-grants",
    "canReadScholarAsTeacher",
    o.canReadScholarAsTeacher,
    ref.scholarReadable,
    out,
    true,
  );

  // C6 — school operations. The raw set helper's documented contract is
  // "all" for a platform_admin BY ROLE (no liveness filter — that is what
  // liveSchoolOperationsInstitutionIds is for), otherwise exactly the live
  // institutions with operations standing.
  const opsPattern = pamembershipOnly
    ? "C6 school-ops ignores platform_admin membership"
    : "C6 schoolOperationsInstitutionIds";
  const expectAll = w.role === ROLES.PLATFORM_ADMIN;
  if (o.schoolOpsIsAll !== expectAll) {
    out.push({
      pattern: opsPattern,
      detail: `schoolOperationsInstitutionIds returned ${o.schoolOpsIsAll ? '"all"' : "a set"}, reference = ${expectAll ? '"all"' : "a set"}`,
    });
  } else if (!expectAll) {
    diff(opsPattern, "schoolOperationsInstitutionIds", o.schoolOps, ref.operations, out);
  }
  diff(
    pamembershipOnly ? "C6 school-ops ignores platform_admin membership" : "C6 liveSchoolOperationsInstitutionIds",
    "liveSchoolOperationsInstitutionIds",
    o.liveSchoolOps,
    ref.operations,
    out,
  );
  diff("C6 hasSchoolOperationsAccessAtInstitution≠liveSchoolOperationsInstitutionIds", "hasSchoolOperationsAccessAtInstitution", o.hasSchoolOpsAt, o.liveSchoolOps, out);

  // C7 — curation.
  const curPattern =
    o.curatableIsAll && w.suspendedO
      ? "C7 curatable \"all\" includes a suspended school"
      : "C7 curatableInstitutionIds";
  diff(curPattern, "curatableInstitutionIds", o.curatable, ref.curatable, out);
  diff("C7 assertCuratableInstitution≠curatableInstitutionIds", "assertCuratableInstitution", o.assertCuratable, o.curatable, out);

  // C8 — the lens is used as a SCHOLAR-READ scope (users.listScholars,
  // concepts.conceptDetail, scholarGroups' group gate): it must never surface
  // a scholar where the reference would not let the actor read that school's
  // scholars — through "all" or through an explicit ?inst=. Honoring ?inst=
  // itself is NOT a scholar read: the same lens scopes curriculum, program,
  // and health surfaces for a designer or grant-holding staffer (TRA-374), so
  // the explicit-lens check asks whether the honored lens yields the scholar.
  // Patterns are keyed by CAUSE (the world feature that explains the
  // over-grant); the surface goes in detail.
  const lensCause = (i: Inst): string => {
    if (i === "O" && w.suspendedO && ms.some((m) => m.inst === "O"))
      return 'lens "all" keeps a suspended membership school';
    if (ms.some((m) => m.inst === i && m.role === ROLES.CURRICULUM_DESIGNER))
      return "lens counts a scoped curriculum_designer membership as scholar-read standing";
    if (i === "O" && w.grantO === "programGroup")
      return "lens counts a group-scoped capability grant as institution-wide standing";
    const grant = i === "O" ? w.grantO : w.grantP;
    if (grant === "health" || grant === "curriculum")
      return "lens counts a non-operations capability grant as staff standing";
    return "lens over-grants (unclassified)";
  };
  const lensSurfaces: [string, Record<Inst, boolean>][] = [
    ["scholarIdsInLens(lens(all))", o.lensAllScholars],
    ["scholarIdsInLens(principalLens(all))", o.principalLensAllScholars],
    ["scholarIdsInLens/scholarInLens(lens(?inst=))", o.lensInstScholars],
  ];
  for (const [surface, got] of lensSurfaces) {
    for (const i of INSTS) {
      if (got[i] && !ref.scholarReadable[i]) {
        out.push({
          pattern: `C8 ${lensCause(i)}`,
          detail: `${surface}[${i}] = true, reference scholarReadable = false`,
        });
      }
    }
  }
  if (o.lensAllowed.O && w.suspendedO) {
    out.push({
      pattern: "C8 lens allowedInstitutionIds contains a suspended school",
      detail: "lens.allowedInstitutionIds has O while O is suspended",
    });
  }
  if (o.lensHonored.O && w.suspendedO) {
    out.push({
      pattern: "C8 lens honors an explicit suspended school",
      detail: "resolveInstitutionLens honored ?inst=O while O is suspended",
    });
  }

  // C10 — the cross-helper invariant: outside the platform operator, nothing
  // anywhere hands out a suspended school's scholar or the school itself.
  if (w.suspendedO && w.role !== ROLES.PLATFORM_ADMIN && !w.memberships.includes("platform_admin@-")) {
    const leaks: string[] = [];
    if (o.canUserAccessScholar.O) leaks.push("canUserAccessScholar");
    if (o.canReadScholarAsTeacher.O) leaks.push("canReadScholarAsTeacher");
    if (o.perMembership.some((pm) => pm.accessible.O)) leaks.push("accessibleScholarIds");
    if (o.liveSchoolOps.O || o.hasSchoolOpsAt.O) leaks.push("school-operations");
    if (o.curatable.O) leaks.push("curatableInstitutionIds");
    if (o.lensAllScholars.O) leaks.push("scholarIdsInLens(plain user)");
    if (o.principalLensAllScholars.O) leaks.push("scholarIdsInLens(principal)");
    for (const helper of leaks) {
      out.push({
        pattern: `C10 suspended school reachable by a non-operator via ${helper}`,
        detail: `${helper} answered yes for O while O is suspended`,
      });
    }
  }
  return out;
}

// ── Build + run ──────────────────────────────────────────────────────────

async function buildAndObserve(ctx: MutationCtx, w: World): Promise<Observed> {
  // Clean slate: every table these helpers read.
  for (const table of [
    "staffCapabilityGrants",
    "scholarGroups",
    "memberships",
    "guardianships",
    "users",
    "institutions",
  ] as const) {
    for (const row of await ctx.db.query(table).collect()) {
      await ctx.db.delete(row._id);
    }
  }
  const inst = {
    P: await ctx.db.insert("institutions", {
      name: "Primary School",
      slug: "p-school",
      kind: "school",
      isPrimary: true,
    }),
    O: await ctx.db.insert("institutions", {
      name: "Other School",
      slug: "o-school",
      kind: "school",
      ...(w.suspendedO ? { disabledAt: 1 } : {}),
    }),
  };
  const scholar = {
    P: await ctx.db.insert("users", {
      name: "Scholar P",
      username: "scholar-p",
      role: ROLES.SCHOLAR,
      institutionId: inst.P,
    }),
    O: await ctx.db.insert("users", {
      name: "Scholar O",
      username: "scholar-o",
      role: ROLES.SCHOLAR,
      institutionId: inst.O,
    }),
  };
  const actor = await ctx.db.insert("users", {
    name: "Actor",
    username: "actor",
    role: w.role,
    ...(w.home ? { institutionId: inst[w.home] } : {}),
  });
  const membershipIds = new Map<Id<"memberships">, MembershipKey>();
  for (const key of w.memberships) {
    const { role, inst: at } = parseMembership(key);
    const id = await ctx.db.insert("memberships", {
      userId: actor,
      role,
      ...(at ? { institutionId: inst[at] } : {}),
    });
    membershipIds.set(id, key);
  }
  const grant = async (
    at: Inst,
    capability: StaffCapability,
    opts: { revoked?: boolean; scholarGroupId?: Id<"scholarGroups"> } = {},
  ) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: actor,
      institutionId: inst[at],
      capability,
      grantedBy: actor,
      grantedAt: 1,
      ...(opts.scholarGroupId ? { scholarGroupId: opts.scholarGroupId } : {}),
      ...(opts.revoked ? { revokedBy: actor, revokedAt: 2 } : {}),
    });
  if (w.grantO === "ops") await grant("O", "school:operations");
  if (w.grantO === "opsRevoked")
    await grant("O", "school:operations", { revoked: true });
  if (w.grantO === "health") await grant("O", "health:manage");
  if (w.grantO === "curriculum") await grant("O", "curriculum:edit");
  if (w.grantO === "programGroup") {
    // A valid program-group grant (ensureActiveStaffCapabilityGrant's
    // shape): an includes_program_guests group at O holding O's scholar.
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId: actor,
      institutionId: inst.O,
      name: "Robotics",
      scholarIds: [scholar.O],
      participation: "includes_program_guests",
    });
    await grant("O", "program:publish", { scholarGroupId: groupId });
  }
  if (w.grantP === "ops") await grant("P", "school:operations");
  if (w.grantP === "health") await grant("P", "health:manage");
  if (w.grantP === "curriculum") await grant("P", "curriculum:edit");

  return await observe(ctx, { inst, scholar, actor, membershipIds });
}

type PatternReport = { count: number; minimal: World; detail: string };

const WORLDS = enumerateWorlds();
const report = new Map<string, PatternReport>();
let runtimeMs = 0;

function record(w: World, ds: Disagreement[]) {
  for (const d of ds) {
    const prev = report.get(d.pattern);
    if (!prev) {
      report.set(d.pattern, { count: 1, minimal: w, detail: d.detail });
    } else {
      prev.count++;
      if (worldSize(w) < worldSize(prev.minimal)) {
        prev.minimal = w;
        prev.detail = d.detail;
      }
    }
  }
}

/**
 * Disagreements the matrix found on current code, each with its minimal world.
 * Judgments are in the report that accompanied this file; the short form is
 * in each comment. Remove an entry (and flip its it.fails) once fixed.
 */
const KNOWN: { pattern: string; note: string }[] = [
];

describe("access reader matrix", () => {
  beforeAll(async () => {
    const started = Date.now();
    // One convex-test instance, one transaction per world (buildAndObserve
    // clears the tables first). Measured: ~11 ms/world; a fresh instance per
    // world was ~19 ms, and batching worlds into one transaction was slower
    // still (the write log grows).
    const t = convexTest(schema, modules);
    for (const w of WORLDS) {
      record(w, check(w, await t.run((ctx) => buildAndObserve(ctx, w))));
    }
    runtimeMs = Date.now() - started;
    const lines = [...report.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([p, r]) =>
          `  ${p}  (${r.count} worlds)\n    minimal: ${describeWorld(r.minimal)}\n    ${r.detail}`,
      );
    console.log(
      `access matrix: ${WORLDS.length} worlds in ${runtimeMs} ms, ${report.size} disagreement patterns\n${lines.join("\n")}`,
    );
  }, 600_000);

  it("enumerates the pruned cross product", () => {
    // 2 suspension states × 8 roles × 170 membership/grant combinations.
    expect(WORLDS.length).toBe(2720);
  });

  it("has no unexplained disagreements", () => {
    const known = new Set(KNOWN.map((k) => k.pattern));
    const unexplained = [...report.entries()]
      .filter(([p]) => !known.has(p))
      .map(([p, r]) => `${p}: ${describeWorld(r.minimal)} — ${r.detail}`);
    expect(unexplained).toEqual([]);
  });

  for (const k of KNOWN) {
    it.fails(`KNOWN: ${k.pattern}`, () => {
      expect(report.get(k.pattern)).toBeUndefined();
    });
  }
});

// The suspension decision is pure, so it gets the FULL cross product
// (including home) with no convex-test cost.
describe("isBlockedBySuspension matrix (pure, full cross product)", () => {
  it("agrees with the reference in every world", () => {
    const mismatches: string[] = [];
    let n = 0;
    for (const suspendedO of [false, true]) {
      for (const role of ACTOR_ROLES) {
        for (const home of ["P", "O", null] as (Inst | null)[]) {
          for (let mask = 0; mask < 1 << MEMBERSHIP_KEYS.length; mask++) {
            const memberships = MEMBERSHIP_KEYS.filter((_, i) => mask & (1 << i));
            const w: World = { suspendedO, role, home, memberships, grantO: "none", grantP: "none" };
            const P = "P" as unknown as Id<"institutions">;
            const O = "O" as unknown as Id<"institutions">;
            const at = (i: Inst | null) => (i === null ? undefined : i === "P" ? P : O);
            const got = isBlockedBySuspension(
              { role, institutionId: at(home) },
              memberships.map(parseMembership).map((m) => ({
                role: m.role,
                institutionId: at(m.inst),
              })),
              new Set(suspendedO ? [O] : []),
            );
            n++;
            if (got !== expectedStanding(w).blocked) mismatches.push(describeWorld(w));
          }
        }
      }
    }
    expect(n).toBe(2 * 8 * 3 * (1 << MEMBERSHIP_KEYS.length));
    expect(mismatches).toEqual([]);
  });
});
