import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Institution boundary regression for the role-only per-scholar gates audited
// in the faux-scholar-read-audit pass. `requireTeacherOrSelf` (and its
// scholar-admin sibling) only check ROLE — teacher vs. scholar — never
// whether the caller's institution actually includes the target scholar.
// `requireActiveScholarAccess` (convex/lib/access.ts) is the real per-scholar
// institution gate; these tests pin it onto two representative call sites
// (seeds.listByScholar — the confirmed instance — and dossier.getForTeacher /
// updateByTeacher, the highest-stakes teacher-facing profile) so a future
// regression that drops the gate is caught here, not in production.

type TestCtx = ReturnType<typeof convexTest>;

async function seedInstitution(t: TestCtx, name: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      kind: "school",
    }),
  );
}

async function seedUser(
  t: TestCtx,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      institutionId,
    }),
  );
}

async function grantMembership(
  t: TestCtx,
  userId: Id<"users">,
  role: Role,
  institutionId?: Id<"institutions">,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("memberships", { userId, role, institutionId });
  });
}

async function withUser(t: TestCtx, userId: Id<"users">) {
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

const CROSS_INSTITUTION_ERROR = "Forbidden: scholar is not in your current context";

describe("seeds.listByScholar — institution boundary", () => {
  test("teacher at institution B CANNOT read institution-A scholar's seeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "School A");
    const instB = await seedInstitution(t, "School B");
    const scholarA = await seedUser(t, "scholar", "scholarA", instA);
    const teacherB = await seedUser(t, "teacher", "teacherB", instB);
    await grantMembership(t, teacherB, "teacher", instB);
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholarA,
        origin: "ai",
        status: "pending",
        topic: "Why do kettles boil faster up a mountain?",
        rationale: "Scholar A couldn't explain pressure/altitude — key gap.",
        scholarInvitation: "Why does a kettle boil faster up a mountain?",
        approachHint: "Probe boiling point vs. atmospheric pressure.",
        suggestionType: "frontier",
      }),
    );

    const asTeacherB = await withUser(t, teacherB);
    await expect(
      asTeacherB.query(api.seeds.listByScholar, { scholarId: scholarA }),
    ).rejects.toThrow(CROSS_INSTITUTION_ERROR);
  });

  test("the scholar's OWN teacher (same institution) CAN read their seeds — full teacher fields", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "School A");
    const scholarA = await seedUser(t, "scholar", "scholarA", instA);
    const teacherA = await seedUser(t, "teacher", "teacherA", instA);
    await grantMembership(t, teacherA, "teacher", instA);
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholarA,
        origin: "ai",
        status: "pending",
        topic: "Why do kettles boil faster up a mountain?",
        rationale: "Scholar A couldn't explain pressure/altitude — key gap.",
        scholarInvitation: "Why does a kettle boil faster up a mountain?",
        approachHint: "Probe boiling point vs. atmospheric pressure.",
        suggestionType: "frontier",
      }),
    );

    const asTeacherA = await withUser(t, teacherA);
    const rows = await asTeacherA.query(api.seeds.listByScholar, {
      scholarId: scholarA,
    });
    expect(rows).toHaveLength(1);
    // Teacher viewer gets the diagnostic teacher-only fields, unredacted.
    expect(rows[0]).toMatchObject({
      rationale: "Scholar A couldn't explain pressure/altitude — key gap.",
      approachHint: "Probe boiling point vs. atmospheric pressure.",
    });
  });

  test("the scholar CAN read their own seeds — redacted (no rationale/approachHint leak)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "School A");
    const scholarA = await seedUser(t, "scholar", "scholarA", instA);
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholarA,
        origin: "ai",
        status: "pending",
        topic: "Why do kettles boil faster up a mountain?",
        rationale: "Scholar A couldn't explain pressure/altitude — key gap.",
        scholarInvitation: "Why does a kettle boil faster up a mountain?",
        approachHint: "Probe boiling point vs. atmospheric pressure.",
        suggestionType: "frontier",
      }),
    );

    const asScholarA = await withUser(t, scholarA);
    const rows = await asScholarA.query(api.seeds.listByScholar, {
      scholarId: scholarA,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].rationale).toBe(
      "Why does a kettle boil faster up a mountain?",
    );
    expect(rows[0].approachHint).toBeUndefined();
  });

  test("a scholar still CANNOT read another scholar's seeds (role-only gate unchanged)", async () => {
    const t = convexTest(schema, modules);
    const scholarA = await seedUser(t, "scholar", "scholarA");
    const scholarB = await seedUser(t, "scholar", "scholarB");
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholarB,
        origin: "ai",
        status: "pending",
        topic: "Bridges",
        rationale: "Lani's private profile.",
        suggestionType: "frontier",
      }),
    );

    const asScholarA = await withUser(t, scholarA);
    await expect(
      asScholarA.query(api.seeds.listByScholar, { scholarId: scholarB }),
    ).rejects.toThrow("Forbidden");
  });
});

describe("dossier privacy gate — institution boundary", () => {
  test("teacher at institution B CANNOT read institution-A scholar's dossier", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "School A");
    const instB = await seedInstitution(t, "School B");
    const scholarA = await seedUser(t, "scholar", "scholarA", instA);
    const teacherB = await seedUser(t, "teacher", "teacherB", instB);
    await grantMembership(t, teacherB, "teacher", instB);
    await t.run(async (ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: scholarA,
        content: "Scholar A loves bridges.",
      }),
    );

    const asTeacherB = await withUser(t, teacherB);
    await expect(
      asTeacherB.query(api.dossier.getForTeacher, { scholarId: scholarA }),
    ).rejects.toThrow(CROSS_INSTITUTION_ERROR);
  });

  test("teacher at institution B CANNOT write institution-A scholar's dossier", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "School A");
    const instB = await seedInstitution(t, "School B");
    const scholarA = await seedUser(t, "scholar", "scholarA", instA);
    const teacherB = await seedUser(t, "teacher", "teacherB", instB);
    await grantMembership(t, teacherB, "teacher", instB);

    const asTeacherB = await withUser(t, teacherB);
    await expect(
      asTeacherB.mutation(api.dossier.updateByTeacher, {
        scholarId: scholarA,
        content: "Injected via a cross-institution write.",
      }),
    ).rejects.toThrow(CROSS_INSTITUTION_ERROR);
    // Nothing was written.
    const rows = await t.run((ctx) => ctx.db.query("scholarDossiers").collect());
    expect(rows).toHaveLength(0);
  });

  test("the scholar's OWN teacher (same institution) CAN read + write their dossier", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "School A");
    const scholarA = await seedUser(t, "scholar", "scholarA", instA);
    const teacherA = await seedUser(t, "teacher", "teacherA", instA);
    await grantMembership(t, teacherA, "teacher", instA);
    await t.run(async (ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: scholarA,
        content: "Scholar A loves bridges.",
      }),
    );

    const asTeacherA = await withUser(t, teacherA);
    const content = await asTeacherA.query(api.dossier.getForTeacher, {
      scholarId: scholarA,
    });
    expect(content).toBe("Scholar A loves bridges.");

    await asTeacherA.mutation(api.dossier.updateByTeacher, {
      scholarId: scholarA,
      content: "Updated by their own teacher.",
    });
    const updated = await t.run(async (ctx) =>
      ctx.db
        .query("scholarDossiers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarA))
        .first(),
    );
    expect(updated?.content).toBe("Updated by their own teacher.");
  });

  test("the scholar CAN read their own dossier (self-access bypasses the institution boundary)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "School A");
    const scholarA = await seedUser(t, "scholar", "scholarA", instA);
    await t.run(async (ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: scholarA,
        content: "Scholar A loves bridges.",
      }),
    );

    const asScholarA = await withUser(t, scholarA);
    const content = await asScholarA.query(api.dossier.getForTeacher, {
      scholarId: scholarA,
    });
    expect(content).toBe("Scholar A loves bridges.");
  });
});
