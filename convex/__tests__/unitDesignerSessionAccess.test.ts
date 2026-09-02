import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * Ownership gate on getUnitDesignerContextForSession — the unit-scoped
 * Curriculum Bot loads a session's transcript as AI context. Without the
 * caller check, an authenticated staffer could pass another teacher's
 * chats._id and read that session's bot transcript (cross-staff
 * leak). The /aide-stream route only proves the caller is staff; THIS query
 * is what proves they own the session. Mirrors getContextForChat.
 */
async function seedSessionWorld(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const teacherA = await ctx.db.insert("users", {
      name: "Teacher A",
      username: "teacherA",
      role: "teacher",
    });
    const teacherB = await ctx.db.insert("users", {
      name: "Teacher B",
      username: "teacherB",
      role: "teacher",
    });
    const admin = await ctx.db.insert("users", {
      name: "Admin",
      username: "adminUser",
      role: "platform_admin",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId: teacherA,
      title: "Owned Unit",
      isActive: true,
    });
    const sessionId = await ctx.db.insert("chats", {
      teacherId: teacherA,
      title: "A's bot session",
      unitId,
      pinned: false,
      lastMessageAt: 0,
    });
    return { teacherA, teacherB, admin, sessionId };
  });
}

const load = (
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"chats">,
  callerUserId: Id<"users">,
) =>
  t.run(async (ctx) =>
    ctx.runQuery(
      internal.curriculumAssistant.getUnitDesignerContextForSession,
      { sessionId, callerUserId },
    ),
  );

describe("getUnitDesignerContextForSession ownership gate", () => {
  test("the owning teacher gets the session context", async () => {
    const t = convexTest(schema, modules);
    const { teacherA, sessionId } = await seedSessionWorld(t);
    const ctx = await load(t, sessionId, teacherA);
    expect(ctx).not.toBeNull();
    expect(ctx?.teacherId).toBe(teacherA);
  });

  test("a different teacher is denied (null) — no cross-staff leak", async () => {
    const t = convexTest(schema, modules);
    const { teacherB, sessionId } = await seedSessionWorld(t);
    expect(await load(t, sessionId, teacherB)).toBeNull();
  });

  test("an admin may read any session (override)", async () => {
    const t = convexTest(schema, modules);
    const { admin, sessionId } = await seedSessionWorld(t);
    expect(await load(t, sessionId, admin)).not.toBeNull();
  });
});
