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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" | "curriculum_designer" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    // defaultMode "classFocus" so create() does NOT auto-add it to the
    // schedule — we want a clean slate to schedule it ourselves.
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "...",
      order: 0,
      defaultMode: "classFocus",
    });
    return { unitId, lessonId, activityId };
  });
}

describe("focus lock lifts on completion (currentClassFocusForMe)", () => {
  test("class-focus entry is INCLUDED for the scholar before completion", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(1);
    expect(String(focus[0].activityId)).toBe(String(activityId));
    expect(focus[0].completedByMe).toBe(false);
  });

  test("class-focus entry is EXCLUDED for the scholar once completed", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    // Scholar completes the focused activity under this assignment.
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    // The lock lifts — no live class-focus entry remains for the scholar.
    expect(focus).toHaveLength(0);
  });

  test("a BARE completion (no assignmentId) also lifts the lock", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    // A completion of the same activity with no assignmentId (e.g. a
    // non-assignment session of that activity) still counts.
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        completedAt: Date.now(),
      }),
    );

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(0);
  });

  test("a completion under a LIVE sibling assignment on the same unit DOES lift the lock", async () => {
    // The prod 2026-07-27 scenario: a scholar on two live assignments for the
    // same unit (devPilot.addToAssignmentByUnitTitle patches every live
    // assignment on a unit) marks done from one assignment's surface while
    // the class-focus push lives on the sibling. The work is the same work —
    // the lock must lift regardless of which surface stamped the completion.
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const focusAssignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const siblingAssignmentId = await asTeacher.mutation(
      api.assignments.create,
      { unitId, scholarIds: [scholarId] },
    );
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: focusAssignmentId,
      activityId,
      mode: "classFocus",
    });

    // Mark done through the REAL writer, from the sibling assignment's
    // surface: a session under the sibling stamps the sibling's assignmentId
    // onto the completion row (upsertActivityCompletion).
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        activityId,
        assignmentId: siblingAssignmentId,
        title: "Sibling-surface session",
        isArchived: false,
      }),
    );
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId,
      sessionId,
    });
    const stamped = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(stamped).toHaveLength(1);
    expect(String(stamped[0].assignmentId)).toBe(String(siblingAssignmentId));

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(0);
  });

  test("a completion from an ARCHIVED same-unit assignment does NOT lift the lock", async () => {
    // The cross-run protection the schema note on
    // activityCompletions.assignmentId is about: a previous (archived) run of
    // the unit doesn't pre-complete this run's focus.
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    const previousRunId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(previousRunId, { archivedAt: Date.now() });
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        assignmentId: previousRunId,
        completedAt: Date.now(),
      });
    });

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    // Still locked to THIS assignment's push.
    expect(focus).toHaveLength(1);
    expect(String(focus[0].assignmentId)).toBe(String(assignmentId));
  });

  test("a completion stamped with an assignment on a DIFFERENT unit does NOT lift the lock", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    // A live assignment on ANOTHER unit — a completion stamped with it must
    // not satisfy this unit's focus (the sibling arm is unit-scoped).
    const otherUnitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId,
        title: "Other Unit",
        isActive: true,
      }),
    );
    const otherAssignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId: otherUnitId,
      scholarIds: [scholarId],
    });
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        assignmentId: otherAssignmentId,
        completedAt: Date.now(),
      }),
    );

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(1);
    expect(String(focus[0].assignmentId)).toBe(String(assignmentId));
  });

  test("ad-hoc dispatches (no unitId) do NOT bleed into each other via the sibling arm", async () => {
    // Two kind:"adHocDispatch" assignments share the same activity, both with
    // a live classFocus push. Neither has a unitId, so the sibling arm must
    // stay out entirely — a completion stamped with one dispatch clears only
    // that dispatch's focus, never the other's (undefined === undefined must
    // not read as "same unit"). Contrived via direct inserts: the real
    // dispatchActivity mints a fresh activity per dispatch.
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    const now = Date.now();
    const { dispatchB } = await t.run(async (ctx) => {
      const activityId = await ctx.db.insert("activities", {
        title: "Ad-hoc exploration",
        kind: "online",
        systemPrompt: "...",
        order: 0,
      });
      const mkDispatch = () =>
        ctx.db.insert("assignments", {
          teacherId,
          scholarIds: [scholarId],
          kind: "adHocDispatch",
          startedAt: now,
          activitySchedule: [
            { activityId, mode: "classFocus", setAt: now },
          ],
        });
      const dispatchA = await mkDispatch();
      const dispatchB = await mkDispatch();
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        assignmentId: dispatchA,
        completedAt: now,
      });
      return { dispatchB };
    });

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    // Dispatch A's focus is cleared by its own completion; dispatch B's holds.
    expect(focus).toHaveLength(1);
    expect(String(focus[0].assignmentId)).toBe(String(dispatchB));
  });

  test("the TEACHER-facing view is unchanged after the scholar completes", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    // Baseline: teacher sees the push on both surfaces.
    expect(
      await asTeacher.query(api.assignments.currentClassFocusForMe, {}),
    ).toHaveLength(1);
    const agendaBefore = await asTeacher.query(
      api.assignments.scheduleForTeacher,
      {},
    );
    expect(agendaBefore).toHaveLength(1);

    // Scholar completes it.
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );

    // Teacher still sees the push — the completion exclusion is scholar-only.
    expect(
      await asTeacher.query(api.assignments.currentClassFocusForMe, {}),
    ).toHaveLength(1);
    const agendaAfter = await asTeacher.query(
      api.assignments.scheduleForTeacher,
      {},
    );
    expect(agendaAfter).toHaveLength(1);
    // The teacher's roll-up correctly reflects the completion.
    expect(agendaAfter[0].completedCount).toBe(1);
    expect(agendaAfter[0].state).toBe("done");
  });
});

// A card-sort done together in class is an `offline` activity: it has no
// scholar-launched surface, so the scholar can't self-complete it. Such a
// focus must NOT drive the read-only lock (policy b, PR #707) — the frontend
// gates the lock on `soloStartableByMe`. Here we assert the honest flag the
// backend hands the frontend.
async function seedUnitWithActivityOfKind(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  kind: Doc<"activities">["kind"],
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: `Test Unit (${kind})`,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: `Test Activity (${kind})`,
      kind,
      // systemPrompt is only meaningful for online activities; harmless here.
      systemPrompt: "...",
      order: 0,
      // classFocus default so create() doesn't auto-schedule it.
      defaultMode: "classFocus",
    });
    return { unitId, lessonId, activityId };
  });
}

async function pushClassFocusOfKind(
  t: ReturnType<typeof convexTest>,
  kind: Doc<"activities">["kind"],
) {
  const teacherId = await seedUser(t, "teacher");
  const scholarId = await seedUser(t, "scholar");
  const { unitId, activityId } = await seedUnitWithActivityOfKind(
    t,
    teacherId,
    kind,
  );
  const asTeacher = await withUser(t, teacherId);
  const asScholar = await withUser(t, scholarId);
  const assignmentId = await asTeacher.mutation(api.assignments.create, {
    unitId,
    scholarIds: [scholarId],
  });
  await asTeacher.mutation(api.assignments.pushActivity, {
    assignmentId,
    activityId,
    mode: "classFocus",
  });
  return await asScholar.query(api.assignments.currentClassFocusForMe, {});
}

describe("currentClassFocusForMe: soloStartableByMe (policy b)", () => {
  test("a NORMAL solo focus (online) is solo-startable → drives the lock", async () => {
    const t = convexTest(schema, modules);
    const focus = await pushClassFocusOfKind(t, "online");
    expect(focus).toHaveLength(1);
    expect(focus[0].soloStartableByMe).toBe(true);
  });

  test("a Simulator Workbench focus is solo-startable", async () => {
    const t = convexTest(schema, modules);
    const focus = await pushClassFocusOfKind(t, "simulator");
    expect(focus).toHaveLength(1);
    expect(focus[0].soloStartableByMe).toBe(true);
  });

  test("a card-sort done together in class (offline) is NOT solo-startable → no lock", async () => {
    const t = convexTest(schema, modules);
    const focus = await pushClassFocusOfKind(t, "offline");
    // The entry is still returned (teacher awareness / pin), but flagged
    // non-solo so the frontend won't hard-lock the scholar's other cards.
    expect(focus).toHaveLength(1);
    expect(focus[0].soloStartableByMe).toBe(false);
  });

  test("a share-back focus is NOT solo-startable", async () => {
    const t = convexTest(schema, modules);
    const focus = await pushClassFocusOfKind(t, "shareBack");
    expect(focus).toHaveLength(1);
    expect(focus[0].soloStartableByMe).toBe(false);
  });

  test("a web focus IS solo-startable (scholar can launch it)", async () => {
    const t = convexTest(schema, modules);
    const focus = await pushClassFocusOfKind(t, "web");
    expect(focus).toHaveLength(1);
    expect(focus[0].soloStartableByMe).toBe(true);
  });

  test("a problem_set focus IS solo-startable (practice engine)", async () => {
    const t = convexTest(schema, modules);
    const focus = await pushClassFocusOfKind(t, "problem_set");
    expect(focus).toHaveLength(1);
    expect(focus[0].soloStartableByMe).toBe(true);
  });
});

describe("an overrun focus keeps its label and loses its wall", () => {
  // A teacher running long is normal: their own surface says "running long"
  // and offers Extend / Wrap, so the focus is not over until a human ends it.
  // The scholar's surfaces used to disagree with that AND with each other —
  // the Now ladder dropped the entry on `endsAt` and declared the day quiet
  // (rendering its "Open work" fallback) while the plate directly below kept
  // printing "Class focus" for the very same row.
  //
  // The fix separates the two jobs a focus does. It still SHOWS until it is
  // wrapped, so both surfaces agree; it stops BLOCKING at `endsAt`, so a
  // slipped clear job costs a stale line on a screen rather than a scholar
  // sealed inside one unit with no teacher around to release them.

  async function overrunFocus() {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    // Wind the window shut without wrapping the focus — exactly the state a
    // dropped `autoClearActivity` leaves behind.
    await t.run(async (ctx) => {
      const assignment = await ctx.db.get(assignmentId);
      const schedule = (assignment?.activitySchedule ?? []).map((entry) => ({
        ...entry,
        endsAt: Date.now() - 60_000,
      }));
      await ctx.db.patch(assignmentId, { activitySchedule: schedule });
    });

    return { asScholar, activityId };
  }

  test("it is still returned to the scholar as class focus", async () => {
    const { asScholar, activityId } = await overrunFocus();
    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(1);
    expect(String(focus[0].activityId)).toBe(String(activityId));
    expect(focus[0].mode).toBe("classFocus");
  });

  test("it can no longer drive the read-only wall", async () => {
    const { asScholar } = await overrunFocus();
    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    // `pickLockingFocus` only walls on a solo-startable entry, so dropping
    // this is what takes the wall down — the activity is an `online` kind
    // that would otherwise qualify.
    expect(focus[0].soloStartableByMe).toBe(false);
  });
});
