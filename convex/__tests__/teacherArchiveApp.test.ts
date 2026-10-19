// Teacher archive for scholar-built apps (review/teacher-archive-scholar-apps.html).
// archiveApp / restoreApp across the free-play lineage, their refusals, the
// relaunch hold (a launch resolves to the archived session, never a fresh
// one), and one test per §6 chokepoint: the scholar is refused, a teacher
// still reads where reading is allowed, and writes are refused for everyone.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { reapAndInsertAssistantPlaceholder } from "../sessions";
import { TEACHER_ARCHIVED_CODE, unarchivePatch } from "../lib/teacherArchive";
import {
  grantStaffCapability,
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

const APP_HTML = "<html><body>APP-lava-runner</body></html>";

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

type World = {
  institutionId: Id<"institutions">;
  teacherId: Id<"users">;
  otherTeacherId: Id<"users">;
  scholarId: Id<"users">;
  unitId: Id<"units">;
  lessonId: Id<"lessons">;
  activityId: Id<"activities">;
  sessionId: Id<"sessions">;
  artifactId: Id<"artifacts">;
  copyId: Id<"sessions">;
  chatSessionId: Id<"sessions">;
};

async function seedWorld(t: T): Promise<World> {
  const institutionId = await seedTestInstitution(t);
  const otherInstitutionId = await seedTestInstitution(t, {
    slug: "other-school",
    name: "Other School",
  });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    username: "avery-stone",
  });
  const otherTeacherId = await seedStaffWithMembership(t, {
    institutionId: otherInstitutionId,
    username: "other-teacher",
  });
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  return await t.run(async (ctx) => {
    // A scholar-authored quest: startable by its author with no assignment.
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Lava quest",
      isActive: true,
      institutionId,
      authorScholarId: scholarId,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lava lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build Lava Runner",
      kind: "vibecode",
      order: 0,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Build Lava Runner",
      sessionMode: "vibecode",
      isArchived: false,
      unitId,
      lessonId,
      activityId,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Lava Runner",
      content: APP_HTML,
      lastEditedBy: "ai",
      revision: 3,
      type: "code",
      language: "html",
    });
    const copyId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Lava Runner (free play)",
      sessionMode: "vibecode",
      isArchived: false,
      unitId,
      lessonId,
      activityId,
      freePlay: true,
      freePlayOf: sessionId,
    });
    await ctx.db.insert("artifacts", {
      sessionId: copyId,
      title: "Lava Runner",
      content: APP_HTML,
      lastEditedBy: "ai",
      revision: 0,
      type: "code",
      language: "html",
    });
    const chatSessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Just a chat",
      isArchived: false,
    });
    return {
      institutionId,
      teacherId,
      otherTeacherId,
      scholarId,
      unitId,
      lessonId,
      activityId,
      sessionId,
      artifactId,
      copyId,
      chatSessionId,
    };
  });
}

async function archived(t: T): Promise<World> {
  const w = await seedWorld(t);
  const asTeacher = await asUser(t, w.teacherId);
  await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });
  return w;
}

const REFUSAL = /Your teacher archived this app/;
// requireActiveScholarAccess's cross-tenant refusal.
const CROSS_TENANT = /Forbidden|access|institution/i;

async function expectTeacherArchivedRefusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).not.toBeNull();
  expect(String((err as Error).message ?? err)).toMatch(
    new RegExp(`${REFUSAL.source}|${TEACHER_ARCHIVED_CODE}`),
  );
}

describe("archiveApp / restoreApp", () => {
  test("archives and restores the whole free-play lineage from either end", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);

    // From the copy: the root comes along.
    const { sessionIds } = await asTeacher.mutation(api.sessions.archiveApp, {
      id: w.copyId,
    });
    expect(sessionIds.map(String).sort()).toEqual(
      [w.sessionId, w.copyId].map(String).sort(),
    );
    for (const id of [w.sessionId, w.copyId]) {
      const s = await t.run((ctx) => ctx.db.get(id));
      expect(s?.isArchived).toBe(true);
      expect(typeof s?.teacherArchivedAt).toBe("number");
    }
    // Idempotent: a re-archive keeps the stamp and succeeds.
    const first = (await t.run((ctx) => ctx.db.get(w.sessionId)))
      ?.teacherArchivedAt;
    await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });
    expect(
      (await t.run((ctx) => ctx.db.get(w.sessionId)))?.teacherArchivedAt,
    ).toBe(first);

    // From the root: the copy comes back too.
    const restored = await asTeacher.mutation(api.sessions.restoreApp, {
      id: w.sessionId,
    });
    expect(restored.sessionIds).toHaveLength(2);
    for (const id of [w.sessionId, w.copyId]) {
      const s = await t.run((ctx) => ctx.db.get(id));
      expect(s?.isArchived).toBe(false);
      expect(s?.teacherArchivedAt).toBeUndefined();
    }
    // Idempotent restore.
    await asTeacher.mutation(api.sessions.restoreApp, { id: w.copyId });

    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((a) => a.action).sort()).toEqual([
      "session.app_archived",
      "session.app_archived",
      "session.app_restored",
      "session.app_restored",
    ]);
    expect(audit[0].institutionId).toBe(w.institutionId);
    expect(audit[0].targetUserId).toBe(w.scholarId);
    expect(JSON.parse(audit[0].detail ?? "{}").sessionIds).toHaveLength(2);
  });

  test("refuses an app-less session", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    await expect(
      asTeacher.mutation(api.sessions.archiveApp, { id: w.chatSessionId }),
    ).rejects.toThrow(/no app/);
  });

  test("refuses a test drive", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const driveId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("sessions", {
        userId: w.teacherId,
        institutionId: w.institutionId,
        title: "Rehearsal",
        isArchived: false,
        isTestDrive: true,
        activityId: w.activityId,
      });
      await ctx.db.insert("artifacts", {
        sessionId: id,
        title: "App",
        content: APP_HTML,
        lastEditedBy: "ai",
        type: "code",
      });
      return id;
    });
    const asTeacher = await asUser(t, w.teacherId);
    await expect(
      asTeacher.mutation(api.sessions.archiveApp, { id: driveId }),
    ).rejects.toThrow(/rehearsal/);
  });

  test("refuses a scholar caller (archive and restore)", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    await expect(
      asScholar.mutation(api.sessions.archiveApp, { id: w.copyId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asScholar.mutation(api.sessions.restoreApp, { id: w.sessionId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("refuses a teacher at another institution", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asOther = await asUser(t, w.otherTeacherId);
    await expect(
      asOther.mutation(api.sessions.archiveApp, { id: w.sessionId }),
    ).rejects.toThrow(CROSS_TENANT);
    const s = await t.run((ctx) => ctx.db.get(w.sessionId));
    expect(s?.teacherArchivedAt).toBeUndefined();
  });

  test("refuses a curriculum:run staffer and a parent", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const runnerId = await seedStaffWithMembership(t, {
      institutionId: w.institutionId,
      role: "staff",
      username: "lehua-torres",
    });
    await grantStaffCapability(t, runnerId, w.institutionId, "curriculum:run");
    const parentId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        name: "Hoku Makani",
        username: "hoku-makani",
        role: "parent",
      });
      await ctx.db.insert("guardianships", {
        parentUserId: id,
        scholarUserId: w.scholarId,
        createdBy: w.teacherId,
      });
      return id;
    });
    for (const who of [runnerId, parentId]) {
      const as = await asUser(t, who);
      await expect(
        as.mutation(api.sessions.archiveApp, { id: w.sessionId }),
      ).rejects.toThrow(/Forbidden/);
    }
    const s = await t.run((ctx) => ctx.db.get(w.sessionId));
    expect(s?.teacherArchivedAt).toBeUndefined();
  });

  test("restore puts back the prior archived state per session", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // The scholar had already archived the free-play copy themselves.
    await t.run((ctx) => ctx.db.patch(w.copyId, { isArchived: true }));
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });
    await asTeacher.mutation(api.sessions.restoreApp, { id: w.sessionId });
    const root = await t.run((ctx) => ctx.db.get(w.sessionId));
    const copy = await t.run((ctx) => ctx.db.get(w.copyId));
    expect(root?.isArchived).toBe(false);
    expect(copy?.isArchived).toBe(true);
    expect(copy?.teacherArchivedAt).toBeUndefined();
    expect(copy?.teacherArchivePriorArchived).toBeUndefined();
  });

  test("a Quest retract during the archive survives the restore", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.quests.retract, { unitId: w.unitId });
    await asTeacher.mutation(api.sessions.restoreApp, { id: w.sessionId });
    const root = await t.run((ctx) => ctx.db.get(w.sessionId));
    expect(root?.teacherArchivedAt).toBeUndefined();
    expect(root?.isArchived).toBe(true);
  });

  test("retract, then reopen, during the archive: restore brings back the open session", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.quests.retract, { unitId: w.unitId });
    await asTeacher.mutation(api.quests.reopen, { unitId: w.unitId });
    // Still held while archived.
    const held = await t.run((ctx) => ctx.db.get(w.sessionId));
    expect(held?.isArchived).toBe(true);
    expect(held?.teacherArchivedAt).toBeDefined();
    await asTeacher.mutation(api.sessions.restoreApp, { id: w.sessionId });
    const root = await t.run((ctx) => ctx.db.get(w.sessionId));
    expect(root?.teacherArchivedAt).toBeUndefined();
    expect(root?.isArchived).toBe(false);
  });

  test("unarchivePatch keeps a teacher archive and records the un-archive for restore", () => {
    expect(unarchivePatch({})).toEqual({ isArchived: false });
    expect(unarchivePatch({ teacherArchivedAt: 1 })).toEqual({
      teacherArchivePriorArchived: false,
    });
  });

  test("the lineage reaches copies of copies", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const grandchild = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Copy of copy",
        isArchived: false,
        activityId: w.activityId,
        freePlay: true,
        freePlayOf: w.copyId,
      }),
    );
    const asTeacher = await asUser(t, w.teacherId);
    const { sessionIds } = await asTeacher.mutation(api.sessions.archiveApp, {
      id: grandchild,
    });
    expect(sessionIds.map(String).sort()).toEqual(
      [w.sessionId, w.copyId, grandchild].map(String).sort(),
    );
  });
});

describe("relaunch resolves to the archived session", () => {
  test("sessions.create returns the archived session and inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const before = await t.run((ctx) => ctx.db.query("sessions").collect());
    const asScholar = await asUser(t, w.scholarId);
    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.activityId,
    });
    expect(id).toBe(w.sessionId);
    const after = await t.run((ctx) => ctx.db.query("sessions").collect());
    expect(after).toHaveLength(before.length);
    const s = await t.run((ctx) => ctx.db.get(w.sessionId));
    expect(s?.isArchived).toBe(true);
    expect(s?.teacherArchivedAt).toBeDefined();
  });

  test("sessions.startUnit returns the archived session and inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const before = await t.run((ctx) => ctx.db.query("sessions").collect());
    const asScholar = await asUser(t, w.scholarId);
    const { id } = await asScholar.mutation(api.sessions.startUnit, {
      unitId: w.unitId,
    });
    expect(id).toBe(w.sessionId);
    const after = await t.run((ctx) => ctx.db.query("sessions").collect());
    expect(after).toHaveLength(before.length);
  });
});

async function scopeToAssignment(t: T, w: World) {
  return await t.run(async (ctx) => {
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId: w.teacherId,
      unitId: w.unitId,
      scholarIds: [w.scholarId],
      startedAt: Date.now() - 60_000,
      activitySchedule: [
        {
          activityId: w.activityId,
          mode: "classFocus" as const,
          setAt: Date.now() - 60_000,
          endsAt: Date.now() + 60 * 60_000,
        },
      ],
    });
    await ctx.db.patch(w.sessionId, { assignmentId });
    return assignmentId;
  });
}

describe("relaunch of an assignment-scoped archived app", () => {
  async function setup(t: T) {
    const w = await seedWorld(t);
    const assignmentId = await scopeToAssignment(t, w);
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });
    const count = async () =>
      (await t.run((ctx) => ctx.db.query("sessions").collect())).length;
    return { w, assignmentId, before: await count(), count };
  }

  test("sessions.create with the assignment resolves to it", async () => {
    const t = convexTest(schema, modules);
    const { w, assignmentId, before, count } = await setup(t);
    const asScholar = await asUser(t, w.scholarId);
    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.activityId,
      assignmentId,
    });
    expect(id).toBe(w.sessionId);
    expect(await count()).toBe(before);
  });

  test("sessions.create WITHOUT the assignment still resolves to it", async () => {
    const t = convexTest(schema, modules);
    const { w, before, count } = await setup(t);
    const asScholar = await asUser(t, w.scholarId);
    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.activityId,
    });
    expect(id).toBe(w.sessionId);
    expect(await count()).toBe(before);
  });

  test("sessions.startUnit resolves to it", async () => {
    const t = convexTest(schema, modules);
    const { w, before, count } = await setup(t);
    const asScholar = await asUser(t, w.scholarId);
    const { id } = await asScholar.mutation(api.sessions.startUnit, {
      unitId: w.unitId,
    });
    expect(id).toBe(w.sessionId);
    expect(await count()).toBe(before);
  });

  test("sessions.createFromSeed resolves to it", async () => {
    const t = convexTest(schema, modules);
    const { w, before, count } = await setup(t);
    const seedId = await t.run((ctx) =>
      ctx.db.insert("seeds", {
        scholarId: w.scholarId,
        origin: "teacher",
        status: "active",
        topic: "Lava quest",
        suggestionType: "teacher_suggestion",
        rationale: "Keep building",
        unitId: w.unitId,
        teacherId: w.teacherId,
      }),
    );
    const asScholar = await asUser(t, w.scholarId);
    const { id } = await asScholar.mutation(api.sessions.createFromSeed, {
      seedId,
    });
    expect(id).toBe(w.sessionId);
    expect(await count()).toBe(before);
  });
});

describe("write / undo / use guards", () => {
  test("tutor turns: sendMessage refuses scholar AND teacher; no message written", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    for (const who of [w.scholarId, w.teacherId]) {
      const as = await asUser(t, who);
      await expectTeacherArchivedRefusal(
        as.mutation(api.sessions.sendMessage, {
          sessionId: w.sessionId,
          message: "make it faster",
        }),
      );
    }
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(0);
  });

  test("reapAndInsertAssistantPlaceholder refuses (covers every streaming path)", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    await expectTeacherArchivedRefusal(
      t.run(async (ctx) => {
        const s = (await ctx.db.get(w.sessionId))!;
        await reapAndInsertAssistantPlaceholder(ctx, s);
      }),
    );
  });

  test("sessions.unarchive and sessions.reopen refuse", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    await expectTeacherArchivedRefusal(
      asScholar.mutation(api.sessions.unarchive, { id: w.sessionId }),
    );
    await expectTeacherArchivedRefusal(
      asScholar.mutation(api.sessions.reopen, { id: w.sessionId }),
    );
    const asTeacher = await asUser(t, w.teacherId);
    await expectTeacherArchivedRefusal(
      asTeacher.mutation(api.sessions.unarchive, { id: w.sessionId }),
    );
  });

  test("reopenableForUnit skips the archived session", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    const result = await asScholar.query(api.sessions.reopenableForUnit, {
      unitId: w.unitId,
    });
    expect(result).toBeNull();
  });

  test("sessions.startFreePlay refuses, even with an existing copy", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    await expectTeacherArchivedRefusal(
      asScholar.mutation(api.sessions.startFreePlay, { sessionId: w.sessionId }),
    );
  });

  test("artifacts.scholarUpdate / scholarCreate / deleteArtifact refuse", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    for (const who of [w.scholarId, w.teacherId]) {
      const as = await asUser(t, who);
      await expectTeacherArchivedRefusal(
        as.mutation(api.artifacts.scholarUpdate, {
          artifactId: w.artifactId,
          content: "<html>changed</html>",
          baseRevision: 3,
        }),
      );
      await expectTeacherArchivedRefusal(
        as.mutation(api.artifacts.scholarCreate, { sessionId: w.sessionId }),
      );
      await expectTeacherArchivedRefusal(
        as.mutation(api.artifacts.deleteArtifact, { artifactId: w.artifactId }),
      );
    }
    const artifact = await t.run((ctx) => ctx.db.get(w.artifactId));
    expect(artifact?.content).toBe(APP_HTML);
  });

  test("appStates.updateSessionState / clearSessionState refuse", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    await expectTeacherArchivedRefusal(
      asScholar.mutation(api.appStates.updateSessionState, {
        artifactId: w.artifactId,
        patch: { score: 9 },
      }),
    );
    await expectTeacherArchivedRefusal(
      asScholar.mutation(api.appStates.clearSessionState, {
        artifactId: w.artifactId,
      }),
    );
  });

  test("appStates.requestSessionActionForTutor refuses", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    await expectTeacherArchivedRefusal(
      t.run((ctx) =>
        ctx.runMutation(internal.appStates.requestSessionActionForTutor, {
          sessionId: w.sessionId,
          artifactId: w.artifactId,
          callerUserId: w.scholarId,
          name: "jump",
        }),
      ),
    );
  });

  test("deliverables.submit, ensureActivitySetup, update and the tutor's code writes refuse", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.patch(w.activityId, {
        deliverable: {
          kind: "text",
          prompt: "Show your game.",
          mode: "none",
          criteria: [],
        },
      }),
    );
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });
    const asScholar = await asUser(t, w.scholarId);
    await expectTeacherArchivedRefusal(
      asScholar.mutation(api.deliverables.submit, {
        activityId: w.activityId,
        sessionId: w.sessionId,
        textContent: "done",
      }),
    );
    expect(
      await asScholar.mutation(api.sessions.ensureActivitySetup, {
        sessionId: w.sessionId,
      }),
    ).toEqual({ initialized: false });
    await expectTeacherArchivedRefusal(
      asScholar.mutation(api.sessions.update, {
        id: w.sessionId,
        title: "Renamed",
      }),
    );
    await expectTeacherArchivedRefusal(
      t.run((ctx) =>
        ctx.runMutation(internal.artifacts.aiStrReplace, {
          sessionId: w.sessionId,
          artifactId: w.artifactId,
          oldStr: "lava",
          newStr: "ice",
        }),
      ),
    );
    await expectTeacherArchivedRefusal(
      t.run((ctx) =>
        ctx.runMutation(internal.artifacts.aiCreate, {
          sessionId: w.sessionId,
          title: "New app",
          content: "<html></html>",
        }),
      ),
    );
    const turnMsg = await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId: w.sessionId,
        role: "assistant",
        content: "",
        flagged: false,
      }),
    );
    expect(
      await t.run((ctx) =>
        ctx.runMutation(internal.codeArtifactRevisions.recordTurnRevision, {
          sessionId: w.sessionId,
          messageId: turnMsg,
          baselineRevision: 0,
        }),
      ),
    ).toEqual({ recorded: false });
    const artifact = await t.run((ctx) => ctx.db.get(w.artifactId));
    expect(artifact?.content).toBe(APP_HTML);
  });

  test("getSessionContext surfaces teacherArchivedAt for the stream gate", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, {
        sessionId: w.sessionId,
      }),
    );
    expect(typeof context?.teacherArchivedAt).toBe("number");
  });

  test("quests.reopen leaves the teacher-archived session archived", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    // A plain (scholar-undoable) archived session in the same quest.
    const plainId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Notes",
        isArchived: true,
        unitId: w.unitId,
      }),
    );
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.quests.reopen, { unitId: w.unitId });
    const held = await t.run((ctx) => ctx.db.get(w.sessionId));
    expect(held?.isArchived).toBe(true);
    expect(held?.teacherArchivedAt).toBeDefined();
    expect((await t.run((ctx) => ctx.db.get(plainId)))?.isArchived).toBe(false);
  });

  test("negative control: ensureActivitySetup still initializes a normal session", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.patch(w.activityId, {
        deliverable: {
          kind: "text",
          prompt: "Show your game.",
          mode: "none",
          criteria: [],
        },
      }),
    );
    const asScholar = await asUser(t, w.scholarId);
    const res = await asScholar.mutation(api.sessions.ensureActivitySetup, {
      sessionId: w.sessionId,
    });
    expect(res.initialized).toBe(true);
  });

  test("completion records are untouched by archive and restore", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: w.scholarId,
        activityId: w.activityId,
        sessionId: w.sessionId,
        completedAt: 1,
      }),
    );
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });
    await asTeacher.mutation(api.sessions.restoreApp, { id: w.sessionId });
    const completions = await t.run((ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      sessionId: w.sessionId,
      completedAt: 1,
    });
  });
});

describe("read guards", () => {
  test("artifacts.getBySession / getById: scholar empty, teacher reads", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    expect(
      await asScholar.query(api.artifacts.getBySession, {
        sessionId: w.sessionId,
      }),
    ).toEqual([]);
    expect(
      await asScholar.query(api.artifacts.getById, { artifactId: w.artifactId }),
    ).toBeNull();
    expect(
      (
        await asScholar.query(api.artifacts.getByScholar, {
          scholarId: w.scholarId,
        })
      ).some((a) => a._id === w.artifactId),
    ).toBe(false);

    const asTeacher = await asUser(t, w.teacherId);
    expect(
      await asTeacher.query(api.artifacts.getBySession, {
        sessionId: w.sessionId,
      }),
    ).toHaveLength(1);
    expect(
      (await asTeacher.query(api.artifacts.getById, { artifactId: w.artifactId }))
        ?.content,
    ).toBe(APP_HTML);
  });

  test("codeArtifactRevisions: scholar empty/refused, teacher reads", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const revisionId = await t.run((ctx) =>
      ctx.db.insert("codeArtifactRevisions", {
        sessionId: w.sessionId,
        artifactId: w.artifactId,
        revision: 3,
        html: APP_HTML,
        createdAt: 1,
      }),
    );
    const asScholar = await asUser(t, w.scholarId);
    expect(
      await asScholar.query(api.codeArtifactRevisions.listForSession, {
        sessionId: w.sessionId,
      }),
    ).toEqual([]);
    await expectTeacherArchivedRefusal(
      asScholar.query(api.codeArtifactRevisions.getRevisionHtml, { revisionId }),
    );

    const asTeacher = await asUser(t, w.teacherId);
    expect(
      await asTeacher.query(api.codeArtifactRevisions.listForSession, {
        sessionId: w.sessionId,
      }),
    ).toHaveLength(1);
    expect(
      (
        await asTeacher.query(api.codeArtifactRevisions.getRevisionHtml, {
          revisionId,
        })
      )?.html,
    ).toBe(APP_HTML);
  });

  test("appAssets.authorizeArtifactAssets: scholar refused, teacher allowed", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    await expectTeacherArchivedRefusal(
      t.run((ctx) =>
        ctx.runQuery(internal.appAssets.authorizeArtifactAssets, {
          artifactId: w.artifactId,
          callerUserId: w.scholarId,
          assetIds: [],
        }),
      ),
    );
    await expect(
      t.run((ctx) =>
        ctx.runQuery(internal.appAssets.authorizeArtifactAssets, {
          artifactId: w.artifactId,
          callerUserId: w.teacherId,
          assetIds: [],
        }),
      ),
    ).resolves.toEqual([]);
  });

  test("appAi.listForSession: scholar empty, teacher reads", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    expect(
      await asScholar.query(api.appAi.listForSession, { sessionId: w.sessionId }),
    ).toEqual([]);
    const asTeacher = await asUser(t, w.teacherId);
    await expect(
      asTeacher.query(api.appAi.listForSession, { sessionId: w.sessionId }),
    ).resolves.toEqual([]);
  });

  test("appStates.getSessionState: scholar null, teacher reads", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await asUser(t, w.scholarId);
    await asScholar.mutation(api.appStates.updateSessionState, {
      artifactId: w.artifactId,
      patch: { score: 4 },
    });
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });

    expect(
      await asScholar.query(api.appStates.getSessionState, {
        artifactId: w.artifactId,
      }),
    ).toBeNull();
    expect(
      (
        await asTeacher.query(api.appStates.getSessionState, {
          artifactId: w.artifactId,
        })
      )?.doc,
    ).toEqual({ score: 4 });
  });

  test("getWithMessages: scholar gets the row with no transcript; teacher gets both", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId: w.sessionId,
        role: "user",
        content: "make lava",
        flagged: false,
      }),
    );
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.mutation(api.sessions.archiveApp, { id: w.sessionId });

    const asScholar = await asUser(t, w.scholarId);
    const forScholar = await asScholar.query(api.sessions.getWithMessages, {
      id: w.sessionId,
    });
    expect(forScholar.session.teacherArchivedAt).toBeDefined();
    expect(forScholar.messages).toEqual([]);
    expect(forScholar.session.freePlayEligible).toBe(false);

    const forTeacher = await asTeacher.query(api.sessions.getWithMessages, {
      id: w.sessionId,
    });
    expect(forTeacher.messages).toHaveLength(1);
  });
});

describe("read-model fields", () => {
  test("finishedForScholar items carry teacherArchivedAt", async () => {
    const t = convexTest(schema, modules);
    const w = await archived(t);
    const asScholar = await asUser(t, w.scholarId);
    const finished = await asScholar.query(api.sessions.finishedForScholar, {});
    const row = finished.find((r) => r._id === w.sessionId);
    expect(row?.finishedKind).toBe("archived");
    expect(typeof row?.teacherArchivedAt).toBe("number");
  });

  test("homeForScholar rows carry hasApp", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    const home = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId: w.scholarId,
    });
    // The plate shows one row for the activity (root or its copy; both hold
    // the app).
    const appRow = home.rows.find((r) => r.activityId === w.activityId);
    const chatRow = home.rows.find((r) => r.sessionId === w.chatSessionId);
    expect(appRow?.hasApp).toBe(true);
    expect(chatRow?.hasApp).toBe(false);
  });

  test("listSessionStatesForScholar lists a teacher-archived app in any mode, stateless or not", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // A chat-primary (non-vibecode) session holding an app, never played.
    const chatAppId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Chat with an app",
        isArchived: false,
      });
      await ctx.db.insert("artifacts", {
        sessionId: id,
        title: "Side app",
        content: APP_HTML,
        lastEditedBy: "ai",
        type: "code",
      });
      return id;
    });
    const asTeacher = await asUser(t, w.teacherId);
    expect(
      (
        await asTeacher.query(api.appStates.listSessionStatesForScholar, {
          scholarId: w.scholarId,
        })
      ).some((s) => s.sessionId === chatAppId),
    ).toBe(false);

    await asTeacher.mutation(api.sessions.archiveApp, { id: chatAppId });
    const rows = await asTeacher.query(
      api.appStates.listSessionStatesForScholar,
      { scholarId: w.scholarId },
    );
    const row = rows.find((s) => s.sessionId === chatAppId);
    expect(row).toMatchObject({ doc: null, log: [], version: 0 });
    expect(typeof row?.teacherArchivedAt).toBe("number");
  });
});
