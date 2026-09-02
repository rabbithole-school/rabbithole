import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: a unit-design chat is only continuable where a `unitId` is in
// hand — `sendUnitSessionMessage` is what gives it the unit tools + prompt and
// stamps `unitId` on its messages. The generic full-screen chat surface has no
// unit context, so continuing such a thread there would silently fall through
// `sendSessionMessage` and drop both. The ownership boundary is therefore
// enforced at the source: the generic library query never lists a unit chat,
// and `listSessionsForUnit` remains their canonical history.

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

async function seedTeacherWithUnit(t: ReturnType<typeof convexTest>) {
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    role: "teacher",
    name: "Lehua Torres",
    username: "lehua_torres",
  });
  const unitId = await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Aquaponics QUEST",
      isActive: true,
    }),
  );
  return { teacherId, unitId };
}

describe("chat ownership — unit-design threads live with their unit", () => {
  test("the generic library excludes unit chats; the unit list includes them", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, unitId } = await seedTeacherWithUnit(t);
    const asTeacher = await withUser(t, teacherId);

    const generalChatId = await asTeacher.mutation(
      api.curriculumAssistant.createChat,
      {},
    );
    const unitChatId = await asTeacher.mutation(
      api.curriculumAssistant.createUnitSession,
      { unitId },
    );

    const generic = await asTeacher.query(
      api.curriculumAssistant.listSessions,
      {},
    );
    expect(generic.map((s) => s._id)).toEqual([generalChatId]);
    expect(generic.every((s) => s.unitId === undefined)).toBe(true);

    const forUnit = await asTeacher.query(
      api.curriculumAssistant.listSessionsForUnit,
      { unitId },
    );
    expect(forUnit.map((s) => s._id)).toEqual([unitChatId]);
  });

  test("a scholar-scoped chat is ordinary — it stays in the generic library", async () => {
    // Only the unit link moves a thread out of the generic surface: that
    // surface can continue a scholar-scoped thread perfectly well.
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      name: "Hoku Makani",
      username: "hoku_makani",
    });
    const scholarId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Kai Kahale",
        username: "kai_kahale",
        role: "scholar",
        institutionId,
      }),
    );
    const asTeacher = await withUser(t, teacherId);

    const scholarChatId = await asTeacher.mutation(
      api.curriculumAssistant.createChat,
      { scholarId },
    );

    const generic = await asTeacher.query(
      api.curriculumAssistant.listSessions,
      {},
    );
    expect(generic.map((s) => s._id)).toEqual([scholarChatId]);
  });
});
