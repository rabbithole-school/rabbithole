// concepts.litScholars (the Galaxy page's per-scholar Sky picker) lists the
// scholars the picker can open, and reads only their current observations and
// the sky nodes (TRA-652).
//
// Candidates are the scholars enrolled at the caller's live schools, kept only
// when `canUserAccessScholar` (the gate `skyFieldForScholar` applies) admits
// them. Each candidate's current observations are read through
// `by_scholar_current`, and sky nodes through `by_source`, rather than the whole
// `masteryObservations` and `knowledgeNodes` tables.
//
// convex-test's `transactionLimits.documentsRead` throws once a function reads
// more documents than the limit. It counts rows a query returns after any
// `.filter`, so the read-bound case below catches a whole-table `.collect()`,
// not a `.filter` over an unindexed scan.
//
// Fictional names only.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  grantInstitutionMembership,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { makeScholar, makeWorld } from "./factories/world";

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const READ_LIMIT = 80;

type T = ReturnType<typeof convexTest>;

async function seedSkyNode(t: T, label: string, placed = true) {
  await t.run((ctx) =>
    ctx.db.insert("knowledgeNodes", {
      nodeKey: label.toLowerCase().replace(/\s+/g, "_"),
      label,
      normalizedLabel: label.toLowerCase(),
      domain: "science",
      source: "mastery",
      ...(placed ? { skyX: 10, skyY: 20 } : {}),
    }),
  );
}

async function seedObservation(
  t: T,
  scholarId: Id<"users">,
  conceptLabel: string,
  opts: { superseded?: boolean; misconception?: boolean } = {},
) {
  await t.run((ctx) =>
    ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel,
      domain: "science",
      observedAt: Date.now(),
      transcriptExcerpt: "…",
      masteryLevel: 3,
      confidenceScore: 0.8,
      evidenceSummary: "Explained it in their own words.",
      evidenceType: opts.misconception ? "misconception_signal" : "explanation",
      attemptContext: "project",
      studentInitiated: false,
      isSuperseded: opts.superseded ?? false,
    }),
  );
}

async function twoSchools(t: T) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 2,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  await seedSkyNode(t, "Tide pools");
  await seedSkyNode(t, "Wave energy");
  await seedSkyNode(t, "Unplaced idea", false);
  return world;
}

const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name).sort();

describe("concepts.litScholars", () => {
  test("lists the caller's school's lit scholars, counting placed concepts", async () => {
    const t = convexTest(schema, modules);
    const world = await twoSchools(t);
    const [home, away] = world.schools;
    const [hoku, kai] = home.scholars;
    await seedObservation(t, hoku.id, "Tide pools");
    await seedObservation(t, hoku.id, "Wave  Energy"); // normalizes to the node
    await seedObservation(t, hoku.id, "Unplaced idea"); // not on the sky
    await seedObservation(t, hoku.id, "Tide pools", { superseded: true });
    await seedObservation(t, kai.id, "Wave energy", { misconception: true });
    await seedObservation(t, away.scholars[0].id, "Tide pools");

    const asTeacher = await world.as.staffOf(home);
    const rows = await asTeacher.query(api.concepts.litScholars, {});

    expect(rows).toEqual([{ id: hoku.id, name: hoku.name, litCount: 2 }]);
  });

  test("includes Extended Education scholars, whom the picker can open", async () => {
    const t = convexTest(schema, modules);
    const world = await twoSchools(t);
    const home = world.schools[0];
    const guest = await makeScholar(t, home, {
      name: "Nalu Guest",
      enrollmentStanding: "program_guest",
    });
    await seedObservation(t, guest.id, "Tide pools");

    const asTeacher = await world.as.staffOf(home);
    const rows = await asTeacher.query(api.concepts.litScholars, {});
    expect(names(rows)).toEqual(["Nalu Guest"]);
    // …and opening that scholar's sky is allowed, so the listing matches.
    await expect(
      asTeacher.query(api.concepts.skyFieldForScholar, { scholarId: guest.id }),
    ).resolves.toBeDefined();
  });

  test("a teacher at two schools sees both schools' lit scholars", async () => {
    const t = convexTest(schema, modules);
    const world = await twoSchools(t);
    const [home, away] = world.schools;
    await grantInstitutionMembership(t, home.teacher.id, away.id, "teacher");
    await seedObservation(t, home.scholars[0].id, "Tide pools");
    await seedObservation(t, away.scholars[0].id, "Wave energy");

    const asTeacher = await world.as.staffOf(home);
    const rows = await asTeacher.query(api.concepts.litScholars, {});
    expect(names(rows)).toEqual(
      [home.scholars[0].name, away.scholars[0].name].sort(),
    );
  });

  test("leaves out a scholar enrolled elsewhere who has no institution on their user row", async () => {
    const t = convexTest(schema, modules);
    const world = await twoSchools(t);
    const [home, away] = world.schools;
    const elsewhere = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        name: "Ola Elsewhere",
        username: "ola-elsewhere",
        role: "scholar",
      });
      await ctx.db.insert("memberships", {
        userId: id,
        institutionId: away.id,
        role: "scholar",
      });
      return id;
    });
    await seedObservation(t, elsewhere, "Tide pools");
    await seedObservation(t, home.scholars[0].id, "Tide pools");

    const asTeacher = await world.as.staffOf(home);
    const rows = await asTeacher.query(api.concepts.litScholars, {});
    expect(names(rows)).toEqual([home.scholars[0].name]);
  });

  test("includes the caller's own lit record", async () => {
    const t = convexTest(schema, modules);
    const world = await twoSchools(t);
    const home = world.schools[0];
    await seedObservation(t, home.teacher.id, "Tide pools");

    const asTeacher = await world.as.staffOf(home);
    const rows = await asTeacher.query(api.concepts.litScholars, {});
    expect(rows.map((r) => r.id)).toEqual([home.teacher.id]);
  });

  test("a platform admin sees learners at a suspended school and with no school", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: true,
    });
    await seedSkyNode(t, "Tide pools");
    const [home, away] = world.schools;
    await t.run((ctx) => ctx.db.patch(away.id, { disabledAt: Date.now() }));
    const noSchool = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Pua Unplaced",
        username: "pua-unplaced",
        role: "scholar",
      }),
    );
    for (const id of [home.scholars[0].id, away.scholars[0].id, noSchool]) {
      await seedObservation(t, id, "Tide pools");
    }

    const asAdmin = await world.as.platformAdmin();
    const rows = await asAdmin.query(api.concepts.litScholars, {});
    expect(names(rows)).toEqual(
      [home.scholars[0].name, away.scholars[0].name, "Pua Unplaced"].sort(),
    );
  });

  test("lifelong learners are listed for staff of their school only", async () => {
    const t = convexTest(schema, modules);
    const world = await twoSchools(t);
    const home = world.schools[0];
    const albatross = await seedTestInstitution(t, {
      slug: "albatross-society",
      name: "Albatross Society",
    });
    const albatrossTeacher = await seedStaffWithMembership(t, {
      institutionId: albatross,
      name: "Iwa Mentor",
    });
    const learner = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Manu Lifelong",
        username: "manu-lifelong",
        role: "lifelong_learner",
      }),
    );
    await seedObservation(t, learner, "Wave energy");

    const asAlbatross = await withUser(t, albatrossTeacher);
    expect(names(await asAlbatross.query(api.concepts.litScholars, {}))).toEqual([
      "Manu Lifelong",
    ]);
    const asHome = await world.as.staffOf(home);
    expect(await asHome.query(api.concepts.litScholars, {})).toEqual([]);
  });

  test("learner memberships whose school was deleted are still listed for those who can open them", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 0,
      parentsPerSchool: 0,
      includePlatformAdmin: true,
    });
    await seedSkyNode(t, "Tide pools");
    const albatross = await seedTestInstitution(t, {
      slug: "albatross-society",
      name: "Albatross Society",
    });
    const albatrossTeacher = await seedStaffWithMembership(t, {
      institutionId: albatross,
      name: "Iwa Mentor",
    });
    const gone = await seedTestInstitution(t, {
      slug: "closed-school",
      name: "Closed School",
    });
    const { scholarMember, lifelongMember } = await t.run(async (ctx) => {
      await ctx.db.delete(gone);
      const scholarMember = await ctx.db.insert("users", {
        name: "Ahi Orphan",
        username: "ahi-orphan",
        role: "parent",
      });
      await ctx.db.insert("memberships", {
        userId: scholarMember,
        institutionId: gone,
        role: "scholar",
      });
      const lifelongMember = await ctx.db.insert("users", {
        name: "Lani Orphan",
        username: "lani-orphan",
        role: "parent",
      });
      await ctx.db.insert("memberships", {
        userId: lifelongMember,
        institutionId: gone,
        role: "lifelong_learner",
      });
      return { scholarMember, lifelongMember };
    });
    await seedObservation(t, scholarMember, "Tide pools");
    await seedObservation(t, lifelongMember, "Tide pools");

    const asAdmin = await world.as.platformAdmin();
    expect(names(await asAdmin.query(api.concepts.litScholars, {}))).toEqual([
      "Ahi Orphan",
      "Lani Orphan",
    ]);
    const asAlbatross = await withUser(t, albatrossTeacher);
    expect(names(await asAlbatross.query(api.concepts.litScholars, {}))).toEqual([
      "Lani Orphan",
    ]);
  });

  test("reads no superseded observations and no non-sky nodes", async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: READ_LIMIT },
    });
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const scholar = school.scholars[0];
    await seedSkyNode(t, "Tide pools");
    await seedObservation(t, scholar.id, "Tide pools");
    await t.run(async (ctx) => {
      for (let i = 0; i < READ_LIMIT; i++) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: `practice_skill_${i}`,
          label: `Practice skill ${i}`,
          domain: "math",
          source: "practice",
        });
      }
    });
    for (let i = 0; i < READ_LIMIT; i++) {
      await seedObservation(t, scholar.id, "Tide pools", { superseded: true });
    }

    const asTeacher = await world.as.staffOf(school);
    const rows = await asTeacher.query(api.concepts.litScholars, {});

    expect(rows).toEqual([{ id: scholar.id, name: scholar.name, litCount: 1 }]);
  });
});
