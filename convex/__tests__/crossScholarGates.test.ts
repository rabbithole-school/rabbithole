import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the same gate —
//   const isTeacher = role === TEACHER || ADMIN;
//   if (!isTeacher && ctx.user._id !== args.scholarId) throw "Forbidden";
// is copy-pasted across ~14 query/mutation handlers in dossier, seeds,
// observations, masteryObservations, teacherDirectives, etc. It guards
// scholar-to-scholar reads of private learning data (dossier, mastery
// observations, teacher notes). A silent regression would leak one
// kid's profile to another. These tests pin the gate on three
// representative call sites — enough to catch a pattern-wide
// regression, not one per file (which would just be churn). If the
// gate ever gets extracted into a shared helper, these tests still
// stand because they hit the public API.

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin",
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

// ── dossier: the highest-stakes private profile ──────────────────────

describe("dossier privacy gate", () => {
  test("scholar can read their own dossier", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    await t.run(async (ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: scholar,
        content: "Kai loves bridges.",
      }),
    );
    const asKai = await withUser(t, scholar);
    const dossier = await asKai.query(api.dossier.getForTeacher, {
      scholarId: scholar,
    });
    expect(dossier).toBe("Kai loves bridges.");
  });

  test("scholar CANNOT read another scholar's dossier", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    await t.run(async (ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: lani,
        content: "Lani's private profile.",
      }),
    );
    const asKai = await withUser(t, kai);
    await expect(
      asKai.query(api.dossier.getForTeacher, { scholarId: lani }),
    ).rejects.toThrow("Forbidden");
  });

  test("teacher can read any scholar's dossier", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const lani = await seedUser(t, "scholar", "lani");
    await t.run(async (ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: lani,
        content: "Lani's private profile.",
      }),
    );
    const asTeacher = await withUser(t, teacher);
    const dossier = await asTeacher.query(api.dossier.getForTeacher, {
      scholarId: lani,
    });
    expect(dossier).toBe("Lani's private profile.");
  });

  test("scholar CANNOT write another scholar's dossier", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const asKai = await withUser(t, kai);
    await expect(
      asKai.mutation(api.dossier.updateByTeacher, {
        scholarId: lani,
        content: "Lani is bad at math.",
      }),
    ).rejects.toThrow("Forbidden");
  });
});

// ── observations: teacher notes a scholar shouldn't see ──────────────

describe("observations privacy gate", () => {
  test("scholar CANNOT list another scholar's observations", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const asKai = await withUser(t, kai);
    await expect(
      asKai.query(api.observations.listByScholar, { scholarId: lani }),
    ).rejects.toThrow("Forbidden");
  });

  test("scholar self-read excludes staff-only Whole Child observations", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const kai = await seedUser(t, "scholar", "kai");
    await t.run(async (ctx) => {
      await ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: kai,
        note: "Ordinary observation.",
        type: "praise",
      });
      await ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: kai,
        note: "Staff-only Whole Child take.",
        type: "note",
        category: "execFunction",
      });
    });

    const asKai = await withUser(t, kai);
    const rows = await asKai.query(api.observations.listByScholar, {
      scholarId: kai,
    });
    expect(rows.map((row) => row.note)).toEqual(["Ordinary observation."]);
  });

  test("scholar CANNOT remove another scholar's observation", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const obsId = await t.run(async (ctx) =>
      ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: lani,
        note: "Concern about Lani's focus.",
        type: "concern",
      }),
    );
    const asKai = await withUser(t, kai);
    await expect(
      asKai.mutation(api.observations.remove, { observationId: obsId }),
    ).rejects.toThrow("Forbidden");
    // And the row is still there.
    const stillThere = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(stillThere).not.toBeNull();
  });
});

// ── observations.setType: fix a mis-typed note without delete-and-re-add ──

describe("observations setType", () => {
  test("teacher can flip an observation's type praise → concern", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const lani = await seedUser(t, "scholar", "lani");
    const obsId = await t.run(async (ctx) =>
      ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: lani,
        note: "Fatigue / pacing note.",
        type: "praise",
      }),
    );
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.observations.setType, {
      observationId: obsId,
      type: "concern",
    });
    const updated = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(updated?.type).toBe("concern");
  });

  test("scholar CANNOT set the type of another scholar's observation", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const obsId = await t.run(async (ctx) =>
      ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: lani,
        note: "Concern about Lani's focus.",
        type: "concern",
      }),
    );
    const asKai = await withUser(t, kai);
    await expect(
      asKai.mutation(api.observations.setType, {
        observationId: obsId,
        type: "praise",
      }),
    ).rejects.toThrow("Forbidden");
    // The type is unchanged.
    const unchanged = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(unchanged?.type).toBe("concern");
  });

  test("setType rejects a type outside the four literals", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const lani = await seedUser(t, "scholar", "lani");
    const obsId = await t.run(async (ctx) =>
      ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: lani,
        note: "Some note.",
        type: "praise",
      }),
    );
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.observations.setType, {
        observationId: obsId,
        type: "bogus" as never,
      }),
    ).rejects.toThrow();
  });
});

// ── masteryObservations: what a scholar has demonstrated ─────────────

describe("masteryObservations privacy gate", () => {
  test("scholar CANNOT list another scholar's mastery", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const asKai = await withUser(t, kai);
    await expect(
      asKai.query(api.masteryObservations.listForScholar, { scholarId: lani }),
    ).rejects.toThrow("Forbidden");
  });
});
