// Home's Archived filter (review/home-finished-filter.html): the tab fields
// finishedForScholar rows carry (origin, subject, isApp), the plate's isApp,
// and the relaunch rule that makes archiving assigned work from Home safe — a
// launch resumes the session the scholar archived instead of a blank copy.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

type T = ReturnType<typeof convexTest>;

async function asUser(t: T, userId: Id<"users">) {
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

async function seedWorld(t: T) {
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    username: "avery-stone",
  });
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  return await t.run(async (ctx) => {
    // Assigned science work, pushed as homework.
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Volcanoes",
      subject: "Science",
      isActive: true,
      institutionId,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Eruptions",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build a volcano quiz",
      kind: "vibecode",
      order: 0,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now() - 60_000,
      activitySchedule: [
        {
          activityId,
          mode: "homework" as const,
          setAt: Date.now() - 60_000,
        },
      ],
    });
    const assignedAppId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Build a volcano quiz",
      sessionMode: "vibecode",
      isArchived: false,
      unitId,
      lessonId,
      activityId,
      assignmentId,
    });
    await ctx.db.insert("artifacts", {
      sessionId: assignedAppId,
      title: "Volcano quiz",
      content: "<html><body>quiz</body></html>",
      lastEditedBy: "ai",
      revision: 1,
      type: "code",
      language: "html",
    });
    // The scholar's own open exploration: a chat with no app.
    const chatId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Why is lava red?",
      isArchived: false,
    });
    return {
      institutionId,
      teacherId,
      scholarId,
      unitId,
      lessonId,
      activityId,
      assignmentId,
      assignedAppId,
      chatId,
    };
  });
}

describe("finishedForScholar tab fields", () => {
  test("rows carry origin, subject and isApp", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    await asScholar.mutation(api.sessions.archive, { id: w.assignedAppId });
    await asScholar.mutation(api.sessions.archive, { id: w.chatId });

    const rows = await asScholar.query(api.sessions.finishedForScholar, {});
    const app = rows.find((r) => r._id === w.assignedAppId);
    const chat = rows.find((r) => r._id === w.chatId);
    expect(app).toMatchObject({
      finishedKind: "archived",
      origin: "homework",
      subject: "Science",
      isApp: true,
    });
    expect(chat).toMatchObject({
      finishedKind: "archived",
      origin: "is",
      subject: null,
      isApp: false,
    });
  });
});

describe("plate isApp", () => {
  test("a session holding a code artifact is an app row; a chat is not", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {
      includeWebActivities: true,
    });
    const app = plate.rows.find((r) => r.sessionId === w.assignedAppId);
    const chat = plate.rows.find((r) => r.sessionId === w.chatId);
    expect(app?.isApp).toBe(true);
    expect(chat?.isApp).toBe(false);
  });
});

describe("relaunching assigned work the scholar archived", () => {
  test("sessions.create resumes the archived session instead of inserting a blank one", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    await asScholar.mutation(api.sessions.archive, { id: w.assignedAppId });
    const before = (await t.run((ctx) => ctx.db.query("sessions").collect()))
      .length;

    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.activityId,
      assignmentId: w.assignmentId,
    });

    expect(id).toBe(w.assignedAppId);
    const after = await t.run((ctx) => ctx.db.query("sessions").collect());
    expect(after).toHaveLength(before);
    const resumed = await t.run((ctx) => ctx.db.get(w.assignedAppId));
    expect(resumed?.isArchived).toBe(false);
  });

  test("a completed archived session is not resumed; the launch starts fresh", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: w.scholarId,
        activityId: w.activityId,
        unitId: w.unitId,
        assignmentId: w.assignmentId,
        sessionId: w.assignedAppId,
        completedAt: Date.now(),
      }),
    );
    await asScholar.mutation(api.sessions.archive, { id: w.assignedAppId });

    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.activityId,
      assignmentId: w.assignmentId,
    });

    expect(id).not.toBe(w.assignedAppId);
    const old = await t.run((ctx) => ctx.db.get(w.assignedAppId));
    expect(old?.isArchived).toBe(true);
  });
});

describe("archived assigned work lives only under Archived", () => {
  test("archiving unfinished pushed homework leaves no Start row on the plate", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    const before = await asScholar.query(api.scholarPlate.activeForMe, {
      includeWebActivities: true,
    });
    expect(
      before.rows.filter((r) => r.activityId === w.activityId),
    ).toHaveLength(1);

    await asScholar.mutation(api.sessions.archive, { id: w.assignedAppId });

    const after = await asScholar.query(api.scholarPlate.activeForMe, {
      includeWebActivities: true,
    });
    expect(after.rows.filter((r) => r.activityId === w.activityId)).toEqual([]);
    const archived = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(archived.map((r) => r._id)).toContain(w.assignedAppId);
  });
});

describe("isComplete picks Unarchive vs Keep working", () => {
  test("unfinished archived work is not complete; finished archived work is", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    await asScholar.mutation(api.sessions.archive, { id: w.assignedAppId });
    await asScholar.mutation(api.sessions.archive, { id: w.chatId });
    let rows = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(rows.find((r) => r._id === w.assignedAppId)?.isComplete).toBe(false);
    // An open exploration has no activity to complete: it unarchives.
    expect(rows.find((r) => r._id === w.chatId)?.isComplete).toBe(false);

    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: w.scholarId,
        activityId: w.activityId,
        unitId: w.unitId,
        assignmentId: w.assignmentId,
        sessionId: w.assignedAppId,
        completedAt: Date.now(),
      }),
    );
    rows = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(rows.find((r) => r._id === w.assignedAppId)?.isComplete).toBe(true);
  });
});

describe("one origin rule for active and archived rows", () => {
  test("a live class-focus push beats an earlier expired homework push in both lists", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.patch(w.assignmentId, {
        activitySchedule: [
          {
            activityId: w.activityId,
            mode: "homework" as const,
            setAt: Date.now() - 3 * 60 * 60_000,
            endsAt: Date.now() - 2 * 60 * 60_000,
          },
          {
            activityId: w.activityId,
            mode: "classFocus" as const,
            setAt: Date.now() - 60_000,
            endsAt: Date.now() + 60 * 60_000,
          },
        ],
      }),
    );
    const asScholar = await asUser(t, w.scholarId);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {
      includeWebActivities: true,
    });
    const active = plate.rows.find((r) => r.sessionId === w.assignedAppId);
    expect(active?.origin).toBe("classFocus");

    await asScholar.mutation(api.sessions.archive, { id: w.assignedAppId });
    const rows = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(rows.find((r) => r._id === w.assignedAppId)?.origin).toBe(
      active?.origin,
    );
  });
});

describe("archive boundaries", () => {
  test("a teacher-archived session wins over the scholar's own archived one and stays locked", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    await asScholar.mutation(api.sessions.archive, { id: w.assignedAppId });
    // A second, teacher-archived session for the same activity.
    const teacherHeldId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Build a volcano quiz (v2)",
        sessionMode: "vibecode",
        isArchived: false,
        unitId: w.unitId,
        lessonId: w.lessonId,
        activityId: w.activityId,
        assignmentId: w.assignmentId,
      });
      await ctx.db.insert("artifacts", {
        sessionId: id,
        title: "Volcano quiz v2",
        content: "<html><body>v2</body></html>",
        lastEditedBy: "ai",
        revision: 1,
        type: "code",
        language: "html",
      });
      return id;
    });
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.sessions.archiveApp, { id: teacherHeldId });

    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.activityId,
      assignmentId: w.assignmentId,
    });

    expect(id).toBe(teacherHeldId);
    const held = await t.run((ctx) => ctx.db.get(teacherHeldId));
    expect(held?.isArchived).toBe(true);
    expect(typeof held?.teacherArchivedAt).toBe("number");
    const own = await t.run((ctx) => ctx.db.get(w.assignedAppId));
    expect(own?.isArchived).toBe(true);
  });

  test("a scholar can't archive or unarchive another scholar's session", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const otherId = await seedScholarInInstitution(t, {
      institutionId: w.institutionId,
      username: "hoku-makani",
    });
    const asOther = await asUser(t, otherId);
    await expect(
      asOther.mutation(api.sessions.archive, { id: w.chatId }),
    ).rejects.toThrow(/Forbidden/);
    const asScholar = await asUser(t, w.scholarId);
    await asScholar.mutation(api.sessions.archive, { id: w.chatId });
    await expect(
      asOther.mutation(api.sessions.unarchive, { id: w.chatId }),
    ).rejects.toThrow(/Forbidden/);
  });
});
