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

// Why this file: listByScholar documents authorName as null when the author
// "has no name". A whitespace-only or empty stored name must therefore resolve
// to null so the UI falls back to "A teacher" instead of rendering a blank
// author prefix (" noted — …").

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

describe("observations author name normalization", () => {
  test("whitespace-only author name resolves to null", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);

    const teacher = await t.run((ctx) =>
      ctx.db.insert("users", { name: "   ", username: "teach", role: "teacher" }),
    );
    await t.run((ctx) => ctx.db.patch(teacher, { institutionId }));
    await grantInstitutionMembership(t, teacher, institutionId, "teacher");

    const scholar = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Kai", username: "kai", role: "scholar" }),
    );
    await t.run((ctx) => ctx.db.patch(scholar, { institutionId }));

    await t.run((ctx) =>
      ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: scholar,
        note: "Concern about focus.",
        type: "concern",
      }),
    );

    const asTeacher = await withUser(t, teacher);
    const rows = await asTeacher.query(api.observations.listByScholar, {
      scholarId: scholar,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].authorName).toBeNull();
  });

  test("real author name is preserved", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);

    const teacher = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Ms. Kawena", username: "teach", role: "teacher" }),
    );
    await t.run((ctx) => ctx.db.patch(teacher, { institutionId }));
    await grantInstitutionMembership(t, teacher, institutionId, "teacher");

    const scholar = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Kai", username: "kai", role: "scholar" }),
    );
    await t.run((ctx) => ctx.db.patch(scholar, { institutionId }));

    await t.run((ctx) =>
      ctx.db.insert("observations", {
        teacherId: teacher,
        scholarId: scholar,
        note: "Great progress.",
        type: "praise",
      }),
    );

    const asTeacher = await withUser(t, teacher);
    const rows = await asTeacher.query(api.observations.listByScholar, {
      scholarId: scholar,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].authorName).toBe("Ms. Kawena");
  });
});
