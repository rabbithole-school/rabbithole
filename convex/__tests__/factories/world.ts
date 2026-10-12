// A typed test-world factory for Convex tests: `makeWorld` seeds a small,
// deterministic multi-school world (institutions + staff + scholars +
// parents) in one call, replacing hand-rolled `ctx.db.insert("users", {...})`
// blocks repeated across hundreds of test files. It wraps — never forks —
// `institutionTestHelpers.ts`; extend that file's exports additively if a new
// primitive is needed, and add a builder or option here instead of a new
// parallel seeding helper.
//
// Design goals (see rabbithole-testing.md "Use the factory"):
//   - Every insert is schema-valid and deterministic: fixed fictional names
//     drawn from the same cast as `convex/seed/devPersonas.ts`, never real
//     people (see CLAUDE.md "Never put a real scholar in a durable
//     artifact").
//   - A two-school world is the trivial default, so a cross-tenant leak test
//     never has to hand-build the second institution.
//   - Pure inserts only (no `vi.mock`, no fake timers, no `globalThis`/
//     `process.env` mutation) — this file must stay outside vitest.config.ts's
//     ISOLATION_HAZARD regex, or every consumer test gets force-isolated out
//     of the shared convex-test worker pool.
//
// `as.*` accessors return a `t.withIdentity(...)`-bound test client, exactly
// like the copy-pasted `withUser` helper in every existing test file — so
// migrating a file onto the factory is usually: delete the local `withUser` +
// seeding block, call `makeWorld`, and call `world.as.staffOf(school)` /
// `world.as.scholar(scholar)` instead.

import type { TestConvex } from "convex-test";
import schema from "../../schema";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  seedTestInstitution,
  grantInstitutionMembership,
  seedOperationsStaff,
} from "../institutionTestHelpers";

type TestCtx = TestConvex<typeof schema>;
type Identity = ReturnType<TestCtx["withIdentity"]>;

export type StaffRole = "teacher" | "school_admin" | "staff";

export type UserOverrides = Partial<
  Omit<Doc<"users">, "_id" | "_creationTime" | "role" | "institutionId">
>;
export type SessionOverrides = Partial<
  Omit<Doc<"sessions">, "_id" | "_creationTime" | "userId">
>;
export type UnitOverrides = Partial<
  Omit<Doc<"units">, "_id" | "_creationTime" | "teacherId">
>;
export type LessonOverrides = Partial<
  Omit<Doc<"lessons">, "_id" | "_creationTime" | "unitId">
>;
export type ActivityOverrides = Partial<
  Omit<Doc<"activities">, "_id" | "_creationTime" | "lessonId">
>;

export interface WorldScholar {
  id: Id<"users">;
  username: string;
  name: string;
  institutionId: Id<"institutions">;
}

export interface WorldStaff {
  id: Id<"users">;
  username: string;
  name: string;
  role: StaffRole;
  institutionId: Id<"institutions">;
}

export interface WorldParent {
  id: Id<"users">;
  username: string;
  name: string;
  children: WorldScholar[];
}

export interface WorldSchool {
  id: Id<"institutions">;
  slug: string;
  name: string;
  isPrimary: boolean;
  teacher: WorldStaff;
  admin: WorldStaff;
  ops: WorldStaff;
  scholars: WorldScholar[];
  parents: WorldParent[];
}

export interface WorldPlatformAdmin {
  id: Id<"users">;
  username: string;
  name: string;
}

export interface World {
  schools: WorldSchool[];
  platformAdmin: WorldPlatformAdmin | undefined;
  as: {
    /** `t.withIdentity(...)` bound to a school's teacher/school_admin/ops-staff. */
    staffOf(school: WorldSchool, role?: StaffRole): Promise<Identity>;
    scholar(scholar: WorldScholar): Promise<Identity>;
    parent(parent: WorldParent): Promise<Identity>;
    platformAdmin(): Promise<Identity>;
  };
}

export interface MakeWorldOptions {
  /** Number of institutions to seed. Default 2 (the trivial cross-tenant case). */
  schools?: number;
  /** Scholars per school. Default 2. */
  scholarsPerSchool?: number;
  /** Parents per school, each guardian of one of that school's scholars. Default 1. */
  parentsPerSchool?: number;
  /** Seed a global platform_admin (no institution). Default true. */
  includePlatformAdmin?: boolean;
}

// ── Fictional cast (stable, deterministic; never a real person) ──────────
// Drawn from / in the style of `convex/seed/devPersonas.ts`'s Moli School
// cast. A module-level counter makes every seeded username unique across
// multiple `makeWorld`/builder calls within one test file, without callers
// ever having to think about collisions.

const SCHOOLS = [
  { name: "Moli School", slug: "moli" },
  { name: "Kona Tutoring", slug: "kona" },
  { name: "Ohana Learning Co-op", slug: "ohana" },
] as const;

const STAFF_CAST = [
  { teacher: "Lehua Torres", admin: "Hoku Makani", ops: "Sloane Kahale" },
  { teacher: "Noe Alana", admin: "Mahina Reyes", ops: "Iolana Cruz" },
  { teacher: "Keahi Kalani", admin: "Nalani Pak", ops: "Malia Freitas" },
] as const;

const SCHOLAR_CAST = [
  ["Kai Kahale", "Lani Kahale", "Oliver Stone", "Emma Wong"],
  ["Malia Reyes", "Keoni Alana", "Nalu Chun", "Sofia Cruz"],
  ["Noa Pak", "Leilani Freitas", "Kekoa Kalani", "Ava Santos"],
] as const;

const PARENT_CAST = ["Avery Stone", "Devin Alana", "Robin Pak"] as const;

let worldSuffix = 0;
function nextSuffix(): number {
  worldSuffix += 1;
  return worldSuffix;
}

function usernameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return `${slug}-${nextSuffix()}`;
}

async function identityFor(t: TestCtx, userId: Id<"users">): Promise<Identity> {
  const authSessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

/** Seed one scholar in `school`. Overrides win over every default. */
export async function makeScholar(
  t: TestCtx,
  school: WorldSchool | Id<"institutions">,
  overrides: UserOverrides = {},
): Promise<WorldScholar> {
  const institutionId = typeof school === "string" ? school : school.id;
  const name = overrides.name ?? "Fixture Scholar";
  const username = overrides.username ?? usernameFor(name);
  const id = await t.run((ctx) =>
    ctx.db.insert("users", {
      role: "scholar",
      institutionId,
      ...overrides,
      name,
      username,
    }),
  );
  return { id, username, name, institutionId };
}

/** Seed one staff member with an institution membership. */
export async function makeStaff(
  t: TestCtx,
  school: WorldSchool | Id<"institutions">,
  role: StaffRole,
  overrides: UserOverrides = {},
): Promise<WorldStaff> {
  const institutionId = typeof school === "string" ? school : school.id;
  const name = overrides.name ?? `Fixture ${role}`;
  const username = overrides.username ?? usernameFor(name);
  if (role === "staff") {
    const id = await seedOperationsStaff(t, {
      institutionId,
      name,
      username,
    });
    return { id, username, name, role, institutionId };
  }
  const id = await t.run((ctx) =>
    ctx.db.insert("users", {
      role,
      ...overrides,
      name,
      username,
    }),
  );
  await grantInstitutionMembership(t, id, institutionId, role);
  return { id, username, name, role, institutionId };
}

/** Seed one parent guardianship-linked to `children`. */
export async function makeParent(
  t: TestCtx,
  children: WorldScholar[],
  overrides: UserOverrides = {},
): Promise<WorldParent> {
  const name = overrides.name ?? "Fixture Parent";
  const username = overrides.username ?? usernameFor(name);
  const id = await t.run((ctx) =>
    ctx.db.insert("users", {
      role: "parent",
      ...overrides,
      name,
      username,
    }),
  );
  await t.run(async (ctx) => {
    for (const child of children) {
      await ctx.db.insert("guardianships", {
        parentUserId: id,
        scholarUserId: child.id,
        createdBy: id,
      });
    }
  });
  return { id, username, name, children };
}

/** Seed a global platform_admin (no institution). */
export async function makePlatformAdmin(
  t: TestCtx,
  overrides: UserOverrides = {},
): Promise<WorldPlatformAdmin> {
  const name = overrides.name ?? "Fixture Platform Admin";
  const username = overrides.username ?? usernameFor(name);
  const id = await t.run((ctx) =>
    ctx.db.insert("users", {
      role: "platform_admin",
      ...overrides,
      name,
      username,
    }),
  );
  return { id, username, name };
}

/** Seed one scholar session. Defaults to a plain, unarchived conversation. */
export async function makeSession(
  t: TestCtx,
  scholar: WorldScholar | Id<"users">,
  overrides: SessionOverrides = {},
): Promise<Id<"sessions">> {
  const userId = typeof scholar === "string" ? scholar : scholar.id;
  return await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "Fixture Session",
      isArchived: false,
      ...overrides,
    }),
  );
}

/** Seed one unit owned by `teacher`, in `school`'s curriculum. */
export async function makeUnit(
  t: TestCtx,
  teacher: WorldStaff | Id<"users">,
  school: WorldSchool | Id<"institutions">,
  overrides: UnitOverrides = {},
): Promise<Id<"units">> {
  const teacherId = typeof teacher === "string" ? teacher : teacher.id;
  const institutionId = typeof school === "string" ? school : school.id;
  return await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Fixture Unit",
      isActive: true,
      ...overrides,
    }),
  );
}

/** Seed one lesson under `unitId`. */
export async function makeLesson(
  t: TestCtx,
  unitId: Id<"units">,
  overrides: LessonOverrides = {},
): Promise<Id<"lessons">> {
  return await t.run((ctx) =>
    ctx.db.insert("lessons", {
      unitId,
      title: "Fixture Lesson",
      order: 0,
      ...overrides,
    }),
  );
}

/** Seed one online activity under `lessonId`. */
export async function makeActivity(
  t: TestCtx,
  lessonId: Id<"lessons">,
  overrides: ActivityOverrides = {},
): Promise<Id<"activities">> {
  return await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId,
      title: "Fixture Activity",
      kind: "online",
      order: 0,
      ...overrides,
    }),
  );
}

async function makeSchool(
  t: TestCtx,
  index: number,
  scholarsPerSchool: number,
  parentsPerSchool: number,
): Promise<WorldSchool> {
  const schoolDef = SCHOOLS[index % SCHOOLS.length];
  const slug = `${schoolDef.slug}-${nextSuffix()}`;
  const institutionId = await seedTestInstitution(t, {
    name: schoolDef.name,
    slug,
    isPrimary: index === 0,
  });

  const cast = STAFF_CAST[index % STAFF_CAST.length];
  const teacher = await makeStaff(t, institutionId, "teacher", {
    name: cast.teacher,
  });
  const admin = await makeStaff(t, institutionId, "school_admin", {
    name: cast.admin,
  });
  const ops = await makeStaff(t, institutionId, "staff", { name: cast.ops });

  const scholarNames = SCHOLAR_CAST[index % SCHOLAR_CAST.length];
  const scholars: WorldScholar[] = [];
  for (let i = 0; i < scholarsPerSchool; i++) {
    const name = scholarNames[i % scholarNames.length];
    scholars.push(await makeScholar(t, institutionId, { name }));
  }

  const parents: WorldParent[] = [];
  for (let i = 0; i < parentsPerSchool; i++) {
    const name = PARENT_CAST[(index + i) % PARENT_CAST.length];
    const child = scholars[i % Math.max(scholars.length, 1)];
    parents.push(await makeParent(t, child ? [child] : [], { name }));
  }

  return {
    id: institutionId,
    slug,
    name: schoolDef.name,
    isPrimary: index === 0,
    teacher,
    admin,
    ops,
    scholars,
    parents,
  };
}

/**
 * Seed a small, typed, deterministic test world: N institutions
 * (`schools`, default 2 — a two-school world is the trivial default so
 * cross-tenant leak tests never hand-build a second institution), each with
 * a teacher, school_admin, and operations-staff member (all with real
 * institution memberships), plus scholars and parent guardianships.
 *
 * Every insert uses fixed fictional names from the same cast as
 * `convex/seed/devPersonas.ts` — never a real person — made unique per call
 * with a module-level counter suffix on the username.
 */
export async function makeWorld(
  t: TestCtx,
  opts: MakeWorldOptions = {},
): Promise<World> {
  const schoolCount = opts.schools ?? 2;
  const scholarsPerSchool = opts.scholarsPerSchool ?? 2;
  const parentsPerSchool = opts.parentsPerSchool ?? 1;
  const includePlatformAdmin = opts.includePlatformAdmin ?? true;

  const schools: WorldSchool[] = [];
  for (let i = 0; i < schoolCount; i++) {
    schools.push(await makeSchool(t, i, scholarsPerSchool, parentsPerSchool));
  }

  const platformAdmin = includePlatformAdmin
    ? await makePlatformAdmin(t)
    : undefined;

  return {
    schools,
    platformAdmin,
    as: {
      staffOf: (school, role = "teacher") =>
        identityFor(
          t,
          role === "school_admin"
            ? school.admin.id
            : role === "staff"
              ? school.ops.id
              : school.teacher.id,
        ),
      scholar: (scholar) => identityFor(t, scholar.id),
      parent: (parent) => identityFor(t, parent.id),
      platformAdmin: async () => {
        if (!platformAdmin) {
          throw new Error(
            "makeWorld({ includePlatformAdmin: false }) — no platform admin to authenticate as",
          );
        }
        return identityFor(t, platformAdmin.id);
      },
    },
  };
}
