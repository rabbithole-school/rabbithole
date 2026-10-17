import { convexTest, type TestConvex } from "convex-test";
import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { assembleCurriculumTools } from "../lib/aideTools";
import { accessibleScholarIds } from "../lib/access";
import { staffCapabilityInstitutionIds } from "../lib/staffCapabilities";
import { ROLES } from "../lib/roles";
import {
  makeActivity,
  makeLesson,
  makeSession,
  makeUnit,
  makeWorld,
} from "./factories/world";
import {
  grantStaffCapability,
  seedStaffWithMembership,
} from "./institutionTestHelpers";

/**
 * `curriculum:run` — "you can run the units you make" (lib/curriculumRun.ts).
 * A base staffer holding curriculum:edit + curriculum:run may assign a unit
 * she can edit to scholars at its school, run the assignments she owns, read
 * their progress + hand-ins, and Preflight with a synthetic scholar. She gets
 * no scholar lens and no learning-record read. Teachers are unchanged.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;
type Tool = { name: string; run: (input: Record<string, unknown>) => Promise<string> };

async function asUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

function actionCtx(t: T): ActionCtx {
  const query = t.query as (ref: unknown, args: unknown) => Promise<unknown>;
  const mutation = t.mutation as (ref: unknown, args: unknown) => Promise<unknown>;
  return {
    runQuery: (ref: unknown, args: unknown) =>
      getFunctionName(ref as Parameters<typeof getFunctionName>[0]).includes(":canOffer")
        ? Promise.resolve(false)
        : query(ref, args),
    runMutation: (ref: unknown, args: unknown) => mutation(ref, args),
  } as unknown as ActionCtx;
}

const DAY = 24 * 60 * 60 * 1000;

async function seed(t: T) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 2,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const [home, other] = world.schools;

  // Base staff with BOTH grants at the home school — and nothing else.
  const runnerId = await seedStaffWithMembership(t, {
    institutionId: home.id,
    role: "staff",
    name: "Pua Designer",
    username: "pua-designer",
  });
  await grantStaffCapability(t, runnerId, home.id, "curriculum:edit");
  await grantStaffCapability(t, runnerId, home.id, "curriculum:run");

  // Base staff with curriculum:edit only.
  const editorId = await seedStaffWithMembership(t, {
    institutionId: home.id,
    role: "staff",
    name: "Kawika Builder",
    username: "kawika-builder",
  });
  await grantStaffCapability(t, editorId, home.id, "curriculum:edit");

  const unit = await makeUnit(t, home.teacher, home, { title: "Tide Pools" });
  const lesson = await makeLesson(t, unit, { title: "Anemones" });
  const activity = await makeActivity(t, lesson, { title: "Sketch an anemone" });
  const activity2 = await makeActivity(t, lesson, {
    title: "Name its parts",
    order: 1,
  });

  const foreignUnit = await makeUnit(t, other.teacher, other, { title: "Lava Flows" });
  const foreignLesson = await makeLesson(t, foreignUnit);
  const foreignActivity = await makeActivity(t, foreignLesson);

  return {
    world,
    home,
    other,
    runnerId,
    editorId,
    unit,
    lesson,
    activity,
    activity2,
    foreignUnit,
    foreignActivity,
    homeScholarIds: home.scholars.map((s) => s.id),
    otherScholarIds: other.scholars.map((s) => s.id),
  };
}

describe("curriculum:run — the run path for the units she builds", () => {
  test("assigns her unit, pushes, schedules, reads progress, and Preflights synthetically", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const runner = await asUser(t, s.runnerId);

    const me = await runner.query(api.users.currentUser, {});
    expect(me?.hasCurriculumAccess).toBe(true);
    expect(me?.hasCurriculumRunAccess).toBe(true);

    // The assignee picker: identity fields for the unit's school only.
    const assignable = await runner.query(
      api.assignments.assignableScholarsForRunner,
      { unitId: s.unit },
    );
    expect(assignable.map((row) => row.id).sort()).toEqual(
      [...s.homeScholarIds].sort(),
    );
    expect(Object.keys(assignable[0]).sort()).toEqual(
      ["enrollmentStanding", "id", "image", "name", "username"].sort(),
    );

    const assignmentId = await runner.mutation(api.assignments.assignWork, {
      unitId: s.unit,
      scholarIds: s.homeScholarIds,
      startsAt: Date.now(),
      target: { kind: "unit" },
    });
    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(assignment?.teacherId).toBe(s.runnerId);

    await runner.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId: s.activity,
      mode: "homework",
      dueAt: Date.now() + 3 * DAY,
    });
    await runner.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId: s.activity2,
      mode: "classFocus",
      startsAt: Date.now() + 5 * DAY,
    });
    await runner.mutation(api.assignments.rescheduleActivity, {
      assignmentId,
      activityId: s.activity2,
      startsAt: Date.now() + 6 * DAY,
    });
    await runner.mutation(api.assignments.clearActivity, {
      assignmentId,
      activityId: s.activity2,
    });

    // Her own Run page: progress, but no record fields or transcript links.
    const scholarSession = await makeSession(t, s.homeScholarIds[0], {
      assignmentId,
      unitId: s.unit,
      activityId: s.activity,
    });
    const run = await runner.query(api.assignments.get, { assignmentId });
    expect(run?.roster).toHaveLength(2);
    for (const row of run?.roster ?? []) {
      expect(row.readingLevel).toBeNull();
      expect(row.sessionId).toBeNull();
      expect(row.lastMessagePreview).toBeNull();
    }
    expect(
      run?.roster.some((row) => row.sessionStartedAt !== null),
    ).toBe(true);
    const progress = await runner.query(api.assignments.activityProgress, {
      assignmentId,
    });
    expect(progress?.rosterSize).toBe(2);
    const listed = await runner.query(api.assignments.listForTeacher, {});
    expect(listed.map((row) => row._id)).toContain(assignmentId);

    // Hand-ins on her own assignment: the deliverable, never the session link.
    await t.run((ctx) =>
      ctx.db.insert("deliverables", {
        scholarId: s.homeScholarIds[0],
        activityId: s.activity,
        assignmentId,
        sessionId: scholarSession,
        textContent: "An anemone has tentacles.",
        submittedAt: Date.now(),
      } as unknown as Omit<Doc<"deliverables">, "_id" | "_creationTime">),
    );
    const handIns = await runner.query(
      api.activities.collateDeliverablesForActivity,
      { activityId: s.activity, assignmentId },
    );
    expect(handIns).toHaveLength(1);
    expect(handIns[0].sessionId).toBeNull();
    // With the school:operations trim (#4254): an ops-only staffer still gets
    // nothing, even naming this assignment. A teacher is unchanged — the
    // lifetime view, session link included.
    const opsOnly = await asUser(t, s.home.ops.id);
    expect(
      await opsOnly.query(api.activities.collateDeliverablesForActivity, {
        activityId: s.activity,
        assignmentId,
      }),
    ).toEqual([]);
    expect(
      await opsOnly.query(api.activities.collateDeliverablesForActivity, {
        activityId: s.activity,
      }),
    ).toEqual([]);
    const teacherView = await (
      await asUser(t, s.home.teacher.id)
    ).query(api.activities.collateDeliverablesForActivity, {
      activityId: s.activity,
    });
    expect(teacherView).toHaveLength(1);
    expect(teacherView[0].sessionId).toBe(scholarSession);

    // Preflight: a synthetic rehearsal she owns, on a unit she can run.
    const drive = await runner.mutation(api.sessions.create, {
      activityId: s.activity,
      isTestDrive: true,
    });
    const driveRow = await t.run((ctx) => ctx.db.get(drive.id));
    expect(driveRow?.isTestDrive).toBe(true);
    expect(driveRow?.userId).toBe(s.runnerId);
    expect(driveRow?.testDriveAsScholarId).toBeUndefined();
    expect(driveRow?.testDriveSyntheticName).toBe("Practice scholar");
    // She may edit the sim on her own rehearsal.
    await runner.mutation(api.sessions.setTestDriveViewAs, {
      sessionId: drive.id,
      mode: "synthetic",
      syntheticName: "Curious second grader",
    });
  });

  test("grants no lens and no scholar access", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // A run-only grant (no curriculum:edit) is inert and lens-free.
    const runOnly = await seedStaffWithMembership(t, {
      institutionId: s.home.id,
      role: "staff",
      name: "Run Only",
      username: "run-only",
    });
    await grantStaffCapability(t, runOnly, s.home.id, "curriculum:run");
    await t.run(async (ctx) => {
      expect((await staffCapabilityInstitutionIds(ctx, runOnly)).size).toBe(0);
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", s.runnerId))
        .first();
      expect((await accessibleScholarIds(ctx, membership!)).size).toBe(0);
    });
    const asRunOnly = await asUser(t, runOnly);
    expect(
      (await asRunOnly.query(api.users.currentUser, {}))?.hasCurriculumRunAccess,
    ).toBe(false);
  });

  test("refuses other people's assignments, foreign units and scholars, real View-as, and record reads", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const runner = await asUser(t, s.runnerId);
    const teacher = await asUser(t, s.home.teacher.id);

    // Someone else's assignment on the very unit she built.
    const teacherAssignment = await teacher.mutation(api.assignments.assignWork, {
      unitId: s.unit,
      scholarIds: s.homeScholarIds,
      startsAt: Date.now(),
      target: { kind: "unit" },
    });
    await expect(
      runner.mutation(api.assignments.pushActivity, {
        assignmentId: teacherAssignment,
        activityId: s.activity,
        mode: "classFocus",
      }),
    ).rejects.toThrow(/Not your assignment/);
    await expect(
      runner.mutation(api.assignments.scheduleActivity, {
        assignmentId: teacherAssignment,
        activityId: s.activity,
        mode: "classFocus",
        startsAt: Date.now() + DAY,
      }),
    ).rejects.toThrow(/Not your assignment/);
    expect(
      await runner.query(api.assignments.get, { assignmentId: teacherAssignment }),
    ).toBeNull();
    expect(
      await runner.query(api.assignments.activityProgress, {
        assignmentId: teacherAssignment,
      }),
    ).toBeNull();
    expect(
      await runner.query(api.activities.collateDeliverablesForActivity, {
        activityId: s.activity,
        assignmentId: teacherAssignment,
      }),
    ).toEqual([]);
    expect(
      await runner.query(api.activities.collateDeliverablesForActivity, {
        activityId: s.activity,
      }),
    ).toEqual([]);

    // A unit she can't edit (another school's).
    await expect(
      runner.mutation(api.assignments.assignWork, {
        unitId: s.foreignUnit,
        scholarIds: s.otherScholarIds,
        startsAt: Date.now(),
        target: { kind: "unit" },
      }),
    ).rejects.toThrow(/Forbidden|not allowed/);
    await expect(
      runner.mutation(api.assignments.create, {
        unitId: s.foreignUnit,
        scholarIds: s.otherScholarIds,
      }),
    ).rejects.toThrow(/Forbidden|not allowed/);

    // Her unit, but a scholar at another school.
    await expect(
      runner.mutation(api.assignments.assignWork, {
        unitId: s.unit,
        scholarIds: [s.homeScholarIds[0], s.otherScholarIds[0]],
        startsAt: Date.now(),
        target: { kind: "unit" },
      }),
    ).rejects.toThrow(/not at this unit's school/);
    // Her unit, but another unit's activity as the target.
    await expect(
      runner.mutation(api.assignments.assignWork, {
        unitId: s.unit,
        scholarIds: s.homeScholarIds,
        startsAt: Date.now(),
        target: {
          kind: "activity",
          activityId: s.foreignActivity,
          mode: "classFocus",
        },
      }),
    ).rejects.toThrow(/not part of this assignment's unit/);

    // Real-scholar View-as stays teacher-only.
    await expect(
      runner.mutation(api.sessions.create, {
        activityId: s.activity,
        isTestDrive: true,
        testDriveAsScholarId: s.homeScholarIds[0],
      }),
    ).rejects.toThrow(/teacher-only/);
    await expect(
      runner.mutation(api.sessions.create, {
        activityId: s.foreignActivity,
        isTestDrive: true,
      }),
    ).rejects.toThrow(/Forbidden|not allowed/);
    const drive = await runner.mutation(api.sessions.create, {
      activityId: s.activity,
      isTestDrive: true,
    });
    await expect(
      runner.mutation(api.sessions.setTestDriveViewAs, {
        sessionId: drive.id,
        mode: "real",
        realScholarId: s.homeScholarIds[0],
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      runner.mutation(api.sessions.setTestDriveViewAs, {
        sessionId: drive.id,
        mode: "self",
      }),
    ).rejects.toThrow(/Forbidden/);

    // Transcript, mastery, portfolio: closed.
    const scholarSession = await makeSession(t, s.homeScholarIds[0], {
      assignmentId: teacherAssignment,
    });
    await expect(
      runner.query(api.sessions.getWithMessages, { id: scholarSession }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      runner.query(api.masteryObservations.listForScholar, {
        scholarId: s.homeScholarIds[0],
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      runner.query(api.portfolio.listForScholar, {
        scholarId: s.homeScholarIds[0],
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      runner.query(api.mcp.getSessionTranscript, {
        scholarName: s.home.scholars[0].name,
        sessionId: scholarSession,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("curriculum:edit alone is refused every run action", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const editor = await asUser(t, s.editorId);
    const teacher = await asUser(t, s.home.teacher.id);
    const teacherAssignment = await teacher.mutation(api.assignments.assignWork, {
      unitId: s.unit,
      scholarIds: s.homeScholarIds,
      startsAt: Date.now(),
      target: { kind: "unit" },
    });

    expect(
      (await editor.query(api.users.currentUser, {}))?.hasCurriculumRunAccess,
    ).toBe(false);
    await expect(
      editor.mutation(api.assignments.assignWork, {
        unitId: s.unit,
        scholarIds: s.homeScholarIds,
        startsAt: Date.now(),
        target: { kind: "unit" },
      }),
    ).rejects.toThrow(/teacher or admin role required/);
    await expect(
      editor.mutation(api.assignments.create, {
        unitId: s.unit,
        scholarIds: s.homeScholarIds,
      }),
    ).rejects.toThrow(/teacher or admin role required/);
    for (const call of [
      () =>
        editor.mutation(api.assignments.pushActivity, {
          assignmentId: teacherAssignment,
          activityId: s.activity,
          mode: "classFocus",
        }),
      () =>
        editor.mutation(api.assignments.scheduleActivity, {
          assignmentId: teacherAssignment,
          activityId: s.activity,
          mode: "classFocus",
          startsAt: Date.now() + DAY,
        }),
      () =>
        editor.mutation(api.assignments.clearActivity, {
          assignmentId: teacherAssignment,
          activityId: s.activity,
        }),
      () => editor.query(api.assignments.get, { assignmentId: teacherAssignment }),
      () => editor.query(api.assignments.listForTeacher, {}),
      () =>
        editor.query(api.assignments.assignableScholarsForRunner, {
          unitId: s.unit,
        }),
    ]) {
      await expect(call()).rejects.toThrow(/teacher or admin role required/);
    }
    // isTestDrive is silently dropped for her (unchanged), so no rehearsal
    // session is created as a test drive.
    await expect(
      editor.mutation(api.sessions.create, {
        activityId: s.activity,
        isTestDrive: true,
      }),
    ).rejects.toThrow();
  });

  test("teachers are unchanged", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const teacher = await asUser(t, s.home.teacher.id);
    const assignmentId = await teacher.mutation(api.assignments.assignWork, {
      unitId: s.unit,
      scholarIds: s.homeScholarIds,
      startsAt: Date.now(),
      target: { kind: "unit" },
    });
    await teacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId: s.activity,
      mode: "classFocus",
    });
    const session = await makeSession(t, s.homeScholarIds[0], {
      assignmentId,
      unitId: s.unit,
      activityId: s.activity,
    });
    const run = await teacher.query(api.assignments.get, { assignmentId });
    expect(run?.roster.find((row) => row.sessionId === session)).toBeTruthy();
    // Teachers keep real-scholar View-as.
    const drive = await teacher.mutation(api.sessions.create, {
      activityId: s.activity,
      isTestDrive: true,
      testDriveAsScholarId: s.homeScholarIds[0],
    });
    const row = await t.run((ctx) => ctx.db.get(drive.id));
    expect(row?.testDriveAsScholarId).toBe(s.homeScholarIds[0]);
    expect(row?.testDriveSyntheticName).toBeUndefined();
    // The runner picker is empty for a teacher (they use listScholars).
    expect(
      await teacher.query(api.assignments.assignableScholarsForRunner, {}),
    ).toEqual([]);
  });
});

describe("curriculum:run list and schedule reads end with the grant", () => {
  test("only rows she can still run are listed; revoking empties them", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const runner = await asUser(t, s.runnerId);
    const mine = await runner.mutation(api.assignments.assignWork, {
      unitId: s.unit,
      scholarIds: s.homeScholarIds,
      startsAt: Date.now(),
      target: { kind: "unit" },
    });
    // A row she "owns" on a unit at a school where she holds no grant (the
    // reviewer's probe), and an old unit-less row (an ex-teacher's dispatch).
    const foreignRow = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: s.runnerId,
        unitId: s.foreignUnit,
        scholarIds: s.otherScholarIds,
        startedAt: Date.now(),
        activitySchedule: [
          {
            activityId: s.foreignActivity,
            mode: "classFocus",
            setAt: Date.now(),
          },
        ],
      }),
    );
    const oldDispatch = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: s.runnerId,
        scholarIds: s.homeScholarIds,
        startedAt: Date.now(),
        kind: "adHocDispatch",
        activitySchedule: [],
      }),
    );

    const listed = (await runner.query(api.assignments.listForTeacher, {})).map(
      (row) => row._id,
    );
    expect(listed).toEqual([mine]);
    expect(listed).not.toContain(foreignRow);
    expect(listed).not.toContain(oldDispatch);
    expect(
      await runner.query(api.assignments.listForUnit, { unitId: s.foreignUnit }),
    ).toEqual([]);
    const aideList = await t.query(internal.assignments.aideListAssignments, {
      callerUserId: s.runnerId,
    });
    expect(aideList.map((row) => row.assignmentId)).toEqual([mine]);
    const aideSchedule = await t.query(
      internal.assignments.aideScheduleForTeacher,
      { callerUserId: s.runnerId },
    );
    expect(
      aideSchedule.every((row) => row.assignmentId === mine),
    ).toBe(true);
    expect(
      aideSchedule.some((row) => row.assignmentId === foreignRow),
    ).toBe(false);

    // Revoke curriculum:run: the UI lists refuse, the aide lists go empty.
    await t.run(async (ctx) => {
      const grants = await ctx.db
        .query("staffCapabilityGrants")
        .withIndex("by_grantee_capability", (q) =>
          q.eq("granteeUserId", s.runnerId).eq("capability", "curriculum:run"),
        )
        .collect();
      for (const grant of grants) {
        await ctx.db.patch(grant._id, {
          revokedAt: Date.now(),
          revokedBy: s.home.admin.id,
        });
      }
    });
    await expect(
      runner.query(api.assignments.listForTeacher, {}),
    ).rejects.toThrow(/teacher or admin role required/);
    expect(
      await t.query(internal.assignments.aideListAssignments, {
        callerUserId: s.runnerId,
      }),
    ).toEqual([]);
    expect(
      await t.query(internal.assignments.aideScheduleForTeacher, {
        callerUserId: s.runnerId,
      }),
    ).toEqual([]);
  });

  test("a demoted ex-teacher keeps no list of her old runs", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const teacher = await asUser(t, s.home.teacher.id);
    await teacher.mutation(api.assignments.assignWork, {
      unitId: s.unit,
      scholarIds: s.homeScholarIds,
      startsAt: Date.now(),
      target: { kind: "unit" },
    });
    // Demoted to base staff with no grants: no run standing anywhere.
    await t.run((ctx) => ctx.db.patch(s.home.teacher.id, { role: "staff" }));
    expect(
      await t.query(internal.assignments.aideListAssignments, {
        callerUserId: s.home.teacher.id,
      }),
    ).toEqual([]);
    await expect(
      teacher.query(api.assignments.listForTeacher, {}),
    ).rejects.toThrow(/teacher or admin role required/);
  });
});

describe("granting curriculum:run from the staff editor", () => {
  test("a school admin grants it beside curriculum:edit; it never outlives curriculum:edit", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const admin = await asUser(t, s.home.admin.id);
    const base = {
      userId: s.editorId,
      institutionId: s.home.id,
      programGroupAccess: [],
    };

    await expect(
      admin.mutation(api.staffCapabilities.updateForStaff, {
        ...base,
        canEditCurriculum: false,
        canRunCurriculum: true,
      }),
    ).rejects.toThrow(/requires curriculum access/);

    await admin.mutation(api.staffCapabilities.updateForStaff, {
      ...base,
      canEditCurriculum: true,
      canRunCurriculum: true,
    });
    const granted = await admin.query(api.staffCapabilities.editorForStaff, {
      userId: s.editorId,
      institutionId: s.home.id,
    });
    expect(granted.canRunCurriculum).toBe(true);

    // Saving other toggles (canRunCurriculum omitted) keeps it.
    await admin.mutation(api.staffCapabilities.updateForStaff, {
      ...base,
      canEditCurriculum: true,
    });
    expect(
      (
        await admin.query(api.staffCapabilities.editorForStaff, {
          userId: s.editorId,
          institutionId: s.home.id,
        })
      ).canRunCurriculum,
    ).toBe(true);

    // Dropping curriculum:edit drops curriculum:run with it.
    await admin.mutation(api.staffCapabilities.updateForStaff, {
      ...base,
      canEditCurriculum: false,
    });
    const revoked = await admin.query(api.staffCapabilities.editorForStaff, {
      userId: s.editorId,
      institutionId: s.home.id,
    });
    expect(revoked.canEditCurriculum).toBe(false);
    expect(revoked.canRunCurriculum).toBe(false);

    // Teachers run curriculum by role; the grant is for base staff only.
    await expect(
      admin.mutation(api.staffCapabilities.updateForStaff, {
        ...base,
        userId: s.home.teacher.id,
        canEditCurriculum: true,
        canRunCurriculum: true,
      }),
    ).rejects.toThrow(/Only base staff/);
  });
});

describe("curriculum:run in the staff aide (Slack / MCP / web)", () => {
  async function toolsFor(t: T, callerUserId: Id<"users">) {
    return (await assembleCurriculumTools(actionCtx(t), () => {}, {
      role: ROLES.STAFF,
      callerUserId,
      surface: "private",
    })) as unknown as Tool[];
  }

  test("offers the run subset, scoped to her unit's school, and no record reads", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const names = (await toolsFor(t, s.runnerId)).map((tool) => tool.name);
    for (const name of [
      "assign_unit",
      "assign_activity_now",
      "list_assignments",
      "get_assignment",
      "get_assignment_progress",
      "schedule_activity",
      "reschedule_activity",
      "clear_activity",
      "push_activity_now",
    ]) {
      expect(names).toContain(name);
    }
    for (const name of [
      "list_scholars",
      "get_scholar_dossier",
      "get_scholar_mastery",
      "get_session_transcript",
      "get_scholar_work_samples",
      "get_granule_coverage",
      "set_assignment_scholars",
      "archive_assignment",
      "publish_unit",
    ]) {
      expect(names).not.toContain(name);
    }

    const tools = await toolsFor(t, s.runnerId);
    const tool = (name: string) => tools.find((x) => x.name === name)!;
    const ok = JSON.parse(
      await tool("assign_unit").run({
        unitId: s.unit,
        scholarNames: [s.home.scholars[0].name],
      }),
    ) as { assignmentId?: Id<"assignments"> };
    expect(ok.assignmentId).toBeTruthy();
    const progress = JSON.parse(
      await tool("get_assignment_progress").run({
        assignmentId: ok.assignmentId,
      }),
    ) as { roster: Array<{ sessionId: unknown; sessionUrl: unknown }> };
    expect(progress.roster.every((r) => r.sessionId === null)).toBe(true);
    expect(progress.roster.every((r) => r.sessionUrl === null)).toBe(true);

    // Group names and membership are not hers to read: groupName is refused.
    const byGroup = await tool("assign_unit").run({
      unitId: s.unit,
      groupName: "Geckos",
    });
    expect(byGroup).toMatch(/Name the scholars instead/);

    // A scholar at another school can't even be resolved by name.
    const refused = await tool("assign_unit").run({
      unitId: s.unit,
      scholarNames: [s.other.scholars[0].name],
    });
    expect(refused).toMatch(/Could not resolve/);
  });

  test("curriculum:edit alone gets no assignment tools", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const names = (await toolsFor(t, s.editorId)).map((tool) => tool.name);
    expect(names).not.toContain("assign_unit");
    expect(names).not.toContain("push_activity_now");
  });
});
