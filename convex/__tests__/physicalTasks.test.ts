import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: physicalTasks is the execution/observation record behind the
// tutor's `suggest_physical_task` tool (Phase 2). These tests pin creation +
// best-effort equipment linking, the scholar-owned "I'm back" completion, and
// the owner/teacher access boundary (a different scholar can neither read nor
// complete another's task).

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  username: string,
  institutionId?: Id<"institutions">,
) {
  const fixtureInstitutionId = institutionId ?? (await seedTestInstitution(t));
  return role === "teacher"
    ? seedStaffWithMembership(t, {
        institutionId: fixtureInstitutionId,
        name: `Test ${username}`,
        username,
      })
    : seedScholarInInstitution(t, {
        institutionId: fixtureInstitutionId,
        name: `Test ${username}`,
        username,
      });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const s: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", s);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedSession(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", { userId, title: "Exploring", isArchived: false }),
  );
}

describe("physicalTasks — create + link", () => {
  test("create links equipmentId by name within the scholar's institution", async () => {
    const t = convexTest(schema, modules);
    const inst = await t.run(async (ctx) =>
      ctx.db.insert("institutions", { slug: "moli", name: "Moli", kind: "school" as const }),
    );
    const scholar = await seedUser(t, "scholar", "kai", inst);
    const gearId = await t.run(async (ctx) =>
      ctx.db.insert("equipment", {
        institutionId: inst,
        name: "Set of hand bells",
        tutorSuggestable: true,
        isActive: true,
      }),
    );
    const sessionId = await seedSession(t, scholar);

    const taskId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: scholar,
      equipmentName: "set of hand bells", // case-insensitive match
      spaceName: "Music Room",
      prompt: "Ring two together and tell me what you notice.",
    });
    const row = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(row?.equipmentId).toBe(gearId);
    expect(row?.status).toBe("suggested");
    expect(row?.equipmentName).toBe("Set of hand bells");
  });

  test("create still records the task when no equipment matches (name is durable)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "loner");
    const sessionId = await seedSession(t, scholar);
    const taskId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: scholar,
      equipmentName: "Mystery gadget",
      prompt: "Go explore.",
    });
    const row = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(row?.equipmentId).toBeUndefined();
    expect(row?.equipmentName).toBe("Mystery gadget");
  });
});

describe("physicalTasks — completion + access", () => {
  test("the owning scholar can mark it done (idempotent); a stranger cannot", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const mallory = await seedUser(t, "scholar", "mallory");
    const sessionId = await seedSession(t, kai);
    const taskId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Singing bowl",
      prompt: "Strike it different ways.",
    });

    const asMallory = await withUser(t, mallory);
    await expect(
      asMallory.mutation(api.physicalTasks.markDone, { id: taskId }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asMallory.query(api.physicalTasks.getForCard, { id: taskId }),
    ).rejects.toThrow(/forbidden/i);

    const asKai = await withUser(t, kai);
    await asKai.mutation(api.physicalTasks.markDone, { id: taskId });
    const card = await asKai.query(api.physicalTasks.getForCard, { id: taskId });
    expect(card?.status).toBe("completed");
    // Idempotent — second call keeps the first completion timestamp.
    const firstCompletedAt = (await t.run(async (ctx) => ctx.db.get(taskId)))
      ?.completedAt;
    await asKai.mutation(api.physicalTasks.markDone, { id: taskId });
    const secondCompletedAt = (await t.run(async (ctx) => ctx.db.get(taskId)))
      ?.completedAt;
    expect(secondCompletedAt).toBe(firstCompletedAt);
  });

  test("a teacher can read the whole session's tasks", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "lehua");
    const sessionId = await seedSession(t, kai);
    await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Compass & straight-edge",
      prompt: "Draw a hexagon.",
    });

    const asTeacher = await withUser(t, teacher);
    const list = await asTeacher.query(api.physicalTasks.listForSession, {
      sessionId,
    });
    expect(list.map((x) => x.equipmentName)).toEqual(["Compass & straight-edge"]);
  });

  test("listForScholar returns only COMPLETED tasks, newest first (owner/teacher only)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const stranger = await seedUser(t, "scholar", "nosy");
    const sessionId = await seedSession(t, kai);
    const doneId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Singing bowl",
      prompt: "Strike it.",
    });
    await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Metronome",
      prompt: "Set a beat.",
    });
    const asKai = await withUser(t, kai);
    await asKai.mutation(api.physicalTasks.markDone, { id: doneId });

    const mine = await asKai.query(api.physicalTasks.listForScholar, {
      scholarId: kai,
    });
    // Only the completed one surfaces (suggested-but-not-done is not portfolio).
    expect(mine.map((x) => x.equipmentName)).toEqual(["Singing bowl"]);

    const asStranger = await withUser(t, stranger);
    await expect(
      asStranger.query(api.physicalTasks.listForScholar, { scholarId: kai }),
    ).rejects.toThrow(/forbidden/i);
  });
});
