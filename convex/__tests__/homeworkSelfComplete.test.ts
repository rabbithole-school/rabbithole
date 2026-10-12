import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { reconcilePortfolioMaterialization } from "../portfolioMaterialize";
import { reconcileActivityCompletion } from "../lib/activityCompletionCore";
import {
  grantInstitutionMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * TRA-458 — a scholar can finish homework the app can't see them do.
 *
 * Offline homework (a read-aloud) and link-out web homework (a video link)
 * happen off the app, so nothing the scholar did recorded a completion and the
 * rows piled up on Home. The scholar's own mark now writes the SAME completion
 * a teacher mark writes, stamped as the scholar's, so the teacher can see and
 * undo it.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function seedUser(
  t: TC,
  role: "scholar" | "teacher",
  name: string,
  institutionId?: Id<"institutions">,
) {
  const inst = institutionId ?? (await seedTestInstitution(t));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username: `${name.toLowerCase().replace(/\W/g, "")}-${Math.random().toString(36).slice(2, 6)}`,
      role,
      institutionId: inst,
    }),
  );
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, inst, role);
  }
  return { userId, institutionId: inst };
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function setup(t: TC) {
  const teacher = await seedUser(t, "teacher", "Ms. Rivera");
  const kai = await seedUser(t, "scholar", "Kai", teacher.institutionId);
  const maya = await seedUser(t, "scholar", "Maya", teacher.institutionId);
  return {
    teacherId: teacher.userId,
    kaiId: kai.userId,
    mayaId: maya.userId,
    asTeacher: await withUser(t, teacher.userId),
    asKai: await withUser(t, kai.userId),
    asMaya: await withUser(t, maya.userId),
  };
}

async function dispatch(
  asTeacher: Awaited<ReturnType<typeof withUser>>,
  scholarId: Id<"users">,
  kind: "offline" | "web" | "online",
) {
  return asTeacher.mutation(api.assignments.dispatchActivity, {
    scholarId,
    title:
      kind === "offline"
        ? "Reading night: Knights ch. 1–4"
        : kind === "web"
          ? "Read aloud: The Tide Pool"
          : "Talk it through",
    activityKind: kind,
    mode: "homework",
    dueAt: Date.now() - 86_400_000,
    ...(kind === "offline"
      ? { description: "Read chapters 1–4 out loud to someone at home." }
      : kind === "web"
        ? { webUrl: "https://example.test/read-aloud" }
        : { systemPrompt: "Explore." }),
  });
}

const pickIds = ({
  assignmentId,
  activityId,
}: {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
}) => ({ assignmentId, activityId });

const completionsFor = (t: TC, assignmentId: Id<"assignments">) =>
  t.run((ctx) =>
    ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect(),
  );

const plateHasRow = async (
  asScholar: Awaited<ReturnType<typeof withUser>>,
  activityId: Id<"activities">,
) => {
  const plate = await asScholar.query(api.scholarPlate.activeForMe, {
    includeWebActivities: true,
  });
  return plate.rows.some((row) => row.activityId === activityId);
};

describe("markHomeworkDoneForSelf (offline container's I did it)", () => {
  test("the scholar's mark records a completion that drops the row from Home and take-home homework, and the teacher sees it as a self-mark", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");
    expect(await plateHasRow(asKai, activityId)).toBe(true);

    const res = await asKai.mutation(
      api.activityCompletions.markHomeworkDoneForSelf,
      { assignmentId, activityId },
    );
    expect(res).toMatchObject({ ok: true, created: true });

    const rows = await completionsFor(t, assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scholarId: kaiId,
      activityId,
      source: "scholar_home",
      action: "scholar_marked_homework_done",
    });
    expect(await plateHasRow(asKai, activityId)).toBe(false);

    const homework = await asKai.query(api.assignments.homeworkForMe, {});
    const entry = homework.find((h) => h.activityId === activityId);
    expect(entry?.completedByMe).toBe(true);

    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId,
    });
    const row = progress?.adHocActivities.find((a) => a.activityId === activityId);
    expect(row?.completedScholarIds).toEqual([kaiId]);
    expect(row?.selfMarked.map((m) => m.scholarId)).toEqual([kaiId]);
  });

  test("the offline container offers the mark only to the owning scholar, then flips to their own mark", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");
    const { id: sessionId } = await asKai.mutation(
      api.sessions.openOfflineHomework,
      { assignmentId, activityId },
    );

    const before = await asKai.query(api.portfolio.offlineSessionView, { sessionId });
    expect(before).toMatchObject({ canMarkDone: true, selfMark: null });
    const asStaff = await asTeacher.query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    expect(asStaff).toMatchObject({ canMarkDone: false, selfMark: null });

    await asKai.mutation(api.activityCompletions.markHomeworkDoneForSelf, {
      assignmentId,
      activityId,
    });
    const after = await asKai.query(api.portfolio.offlineSessionView, { sessionId });
    expect(after?.canMarkDone).toBe(false);
    expect(after?.selfMark).toMatchObject({ canUndo: true });
  });

  test("refuses a scholar the entry doesn't target, an online activity, a staff caller, and an ended push", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai, asMaya } = await setup(t);
    const pick = ({ assignmentId, activityId }: {
      assignmentId: Id<"assignments">;
      activityId: Id<"activities">;
    }) => ({ assignmentId, activityId });
    const offline = pick(await dispatch(asTeacher, kaiId, "offline"));
    const online = pick(await dispatch(asTeacher, kaiId, "online"));

    // Maya isn't on Kai's one-scholar dispatch.
    expect(
      await asMaya.mutation(api.activityCompletions.markHomeworkDoneForSelf, offline),
    ).toMatchObject({ ok: false, reason: "not_yours" });
    // Online homework completes through the tutor.
    expect(
      await asKai.mutation(api.activityCompletions.markHomeworkDoneForSelf, online),
    ).toMatchObject({ ok: false, reason: "not_homework" });
    // A teacher can't "say" the scholar did it.
    expect(
      await asTeacher.mutation(api.activityCompletions.markHomeworkDoneForSelf, offline),
    ).toMatchObject({ ok: false });

    // Ended by the teacher → legible refusal, no write.
    await t.run(async (ctx) => {
      const a = await ctx.db.get(offline.assignmentId);
      await ctx.db.patch(offline.assignmentId, {
        activitySchedule: a!.activitySchedule!.map((e) => ({
          ...e,
          endsAt: Date.now() - 1000,
        })),
      });
    });
    expect(
      await asKai.mutation(api.activityCompletions.markHomeworkDoneForSelf, offline),
    ).toMatchObject({ ok: false, reason: "ended" });

    expect(await completionsFor(t, offline.assignmentId)).toHaveLength(0);
    expect(await completionsFor(t, online.assignmentId)).toHaveLength(0);
  });

  test("a per-scholar entry on a shared assignment refuses a roster scholar it doesn't name", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, kaiId, mayaId, asKai, asMaya } = await setup(t);
    const { assignmentId, activityId } = await t.run(async (ctx) => {
      const activityId = await ctx.db.insert("activities", {
        title: "Family interview",
        kind: "offline",
        order: 0,
        scholarDescription: "Ask a grown-up about a family tradition.",
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [kaiId, mayaId],
        title: "Family stories",
        kind: "adHocDispatch",
        startedAt: Date.now(),
        activitySchedule: [
          {
            activityId,
            mode: "homework" as const,
            setAt: Date.now() - 1000,
            scholarIds: [kaiId],
          },
        ],
      });
      return { assignmentId, activityId };
    });
    expect(
      await asMaya.mutation(api.activityCompletions.markHomeworkDoneForSelf, {
        assignmentId,
        activityId,
      }),
    ).toMatchObject({ ok: false, reason: "not_yours" });
    expect(
      await asKai.mutation(api.activityCompletions.markHomeworkDoneForSelf, {
        assignmentId,
        activityId,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("the Run page Done line (unit assignment)", () => {
  test("a self-marked lesson homework counts as done and is flagged as the scholar's own mark", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, kaiId, mayaId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Knights and castles",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Reading nights",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Reading night: Knights ch. 5–8",
        kind: "offline",
        order: 0,
        scholarDescription: "Read chapters 5–8 aloud.",
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [kaiId, mayaId],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId, mode: "homework" as const, setAt: Date.now() - 1000 },
        ],
      });
      return { assignmentId, activityId };
    });
    await asKai.mutation(api.activityCompletions.markHomeworkDoneForSelf, {
      assignmentId,
      activityId,
    });
    await asTeacher.mutation(api.activityCompletions.markCompleteForGroup, {
      assignmentId,
      activityId,
      scholarIds: [mayaId],
    });
    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId,
    });
    const row = progress?.lessons[0].activities[0];
    expect(new Set(row?.completedScholarIds)).toEqual(new Set([kaiId, mayaId]));
    expect(row?.doneCount).toBe(2);
    // Only Kai's is his own mark; Maya's was the teacher's.
    expect(row?.selfMarked.map((m) => m.scholarId)).toEqual([kaiId]);
  });
});

describe("undo is scoped to the scholar's own mark", () => {
  test("the scholar can undo their own mark and the row returns to Home", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");
    const res = await asKai.mutation(
      api.activityCompletions.markHomeworkDoneForSelf,
      { assignmentId, activityId },
    );
    if (!res.ok) throw new Error("expected a mark");

    expect(
      await asKai.mutation(api.activityCompletions.undoHomeworkDoneForSelf, {
        completionId: res.completionId,
      }),
    ).toEqual({ ok: true });
    expect(await completionsFor(t, assignmentId)).toHaveLength(0);
    expect(await plateHasRow(asKai, activityId)).toBe(true);
  });

  test("the scholar's undo never deletes a teacher's mark — including one that confirmed their own", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");

    const res = await asKai.mutation(
      api.activityCompletions.markHomeworkDoneForSelf,
      { assignmentId, activityId },
    );
    if (!res.ok) throw new Error("expected a mark");
    // The teacher marks the class done: that vouches for Kai's mark.
    await asTeacher.mutation(api.activityCompletions.markCompleteForGroup, {
      assignmentId,
      activityId,
    });
    const [row] = await completionsFor(t, assignmentId);
    expect(row.source).toBeUndefined();

    expect(
      await asKai.mutation(api.activityCompletions.undoHomeworkDoneForSelf, {
        completionId: res.completionId,
      }),
    ).toMatchObject({ ok: false });
    expect(await completionsFor(t, assignmentId)).toHaveLength(1);
  });

  test("another scholar can't undo it, and nobody but the teacher can once the push has ended", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai, asMaya } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");
    const res = await asKai.mutation(
      api.activityCompletions.markHomeworkDoneForSelf,
      { assignmentId, activityId },
    );
    if (!res.ok) throw new Error("expected a mark");

    expect(
      await asMaya.mutation(api.activityCompletions.undoHomeworkDoneForSelf, {
        completionId: res.completionId,
      }),
    ).toMatchObject({ ok: false });

    await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      await ctx.db.patch(assignmentId, {
        activitySchedule: a!.activitySchedule!.map((e) => ({
          ...e,
          endsAt: Date.now() - 1000,
        })),
      });
    });
    expect(
      await asKai.mutation(api.activityCompletions.undoHomeworkDoneForSelf, {
        completionId: res.completionId,
      }),
    ).toMatchObject({ ok: false, reason: "ended" });
    expect(await completionsFor(t, assignmentId)).toHaveLength(1);

    // The teacher's chip undo (session-less, assignment-stamped row).
    await asTeacher.mutation(api.activityCompletions.unmarkComplete, {
      activityId,
      scholarId: kaiId,
      assignmentId,
    });
    expect(await completionsFor(t, assignmentId)).toHaveLength(0);
  });
});

describe("webActivitySessions.finalize — the existing Done, made honest", () => {
  test("Done on lesson-less ad-hoc web homework records the scholar's mark and drops the row from Home", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "web");
    expect(await plateHasRow(asKai, activityId)).toBe(true);

    const { sessionId } = await asKai.mutation(api.webActivitySessions.start, {
      activityId,
      assignmentId,
    });
    const result = await asKai.mutation(api.webActivitySessions.finalize, {
      sessionId,
      markDone: true,
    });
    expect(result).toMatchObject({
      completed: true,
      undoAvailable: true,
      refusal: null,
    });
    const rows = await completionsFor(t, assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scholarId: kaiId,
      source: "scholar_home",
      action: "scholar_marked_homework_done",
    });
    expect(await plateHasRow(asKai, activityId)).toBe(false);
  });

  test("Done after the push ended says so instead of closing silently", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "web");
    const { sessionId } = await asKai.mutation(api.webActivitySessions.start, {
      activityId,
      assignmentId,
    });
    await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      await ctx.db.patch(assignmentId, {
        activitySchedule: a!.activitySchedule!.map((e) => ({
          ...e,
          endsAt: Date.now() - 1000,
        })),
      });
    });
    const result = await asKai.mutation(api.webActivitySessions.finalize, {
      sessionId,
      markDone: true,
    });
    expect(result.completed).toBe(false);
    expect(result.refusal?.reason).toBe("ended");
    expect(await completionsFor(t, assignmentId)).toHaveLength(0);
  });

  test("closing without Done records nothing and reports no refusal", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "web");
    const { sessionId } = await asKai.mutation(api.webActivitySessions.start, {
      activityId,
      assignmentId,
    });
    const result = await asKai.mutation(api.webActivitySessions.finalize, {
      sessionId,
    });
    expect(result).toMatchObject({ completed: false, refusal: null });
    expect(await completionsFor(t, assignmentId)).toHaveLength(0);
  });
});

describe("a scan confirms a self-mark", () => {
  test("paper evidence for the same homework clears the scholar provenance", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");
    const res = await asKai.mutation(
      api.activityCompletions.markHomeworkDoneForSelf,
      { assignmentId, activityId },
    );
    if (!res.ok) throw new Error("expected a mark");
    const { id: sessionId } = await asKai.mutation(
      api.sessions.openOfflineHomework,
      { assignmentId, activityId },
    );
    // A scanned page filed to this scholar + activity + assignment.
    await t.run(async (ctx) => {
      const fileStorageId = await ctx.storage.store(
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xdb])], {
          type: "image/jpeg",
        }),
      );
      const itemId = await ctx.db.insert("portfolioItems", {
        scholarId: kaiId,
        activityId,
        assignmentId,
        title: "reading_log.jpg",
        source: "google_drive",
        fileStorageId,
        fileMimeType: "image/jpeg",
        matchStatus: "matched",
        assignmentStatus: "none",
        processingStatus: "ready",
      } as Doc<"portfolioItems">);
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId: kaiId,
        attributedAt: Date.now(),
      });
      await reconcilePortfolioMaterialization(ctx, itemId);
    });
    const rows = await completionsFor(t, assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBeUndefined();
    const view = await asKai.query(api.portfolio.offlineSessionView, { sessionId });
    expect(view?.selfMark).toBeNull();
  });
});

describe("unmarkComplete's assignment-scoped undo is the teacher's alone", () => {
  test("a scholar can't use it to delete a teacher's class mark or a scan's completion", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const teacherMarked = pickIds(await dispatch(asTeacher, kaiId, "offline"));
    await asTeacher.mutation(api.activityCompletions.markCompleteForGroup, {
      assignmentId: teacherMarked.assignmentId,
      activityId: teacherMarked.activityId,
    });
    const scanned = pickIds(await dispatch(asTeacher, kaiId, "offline"));
    await t.run(async (ctx) => {
      const fileStorageId = await ctx.storage.store(
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xdb])], { type: "image/jpeg" }),
      );
      const itemId = await ctx.db.insert("portfolioItems", {
        scholarId: kaiId,
        activityId: scanned.activityId,
        assignmentId: scanned.assignmentId,
        title: "reading_log.jpg",
        source: "google_drive",
        fileStorageId,
        fileMimeType: "image/jpeg",
        matchStatus: "matched",
        assignmentStatus: "none",
        processingStatus: "ready",
      } as Doc<"portfolioItems">);
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId: kaiId,
        attributedAt: Date.now(),
      });
      await reconcilePortfolioMaterialization(ctx, itemId);
    });
    expect(await completionsFor(t, scanned.assignmentId)).toHaveLength(1);

    for (const { assignmentId, activityId } of [teacherMarked, scanned]) {
      await expect(
        asKai.mutation(api.activityCompletions.unmarkComplete, {
          activityId,
          assignmentId,
        }),
      ).rejects.toThrow("Only the teacher");
      expect(await completionsFor(t, assignmentId)).toHaveLength(1);
    }
  });

  test("a teacher with access to the scholar but not this assignment can't undo on it", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const kai = await t.run((ctx) => ctx.db.get(kaiId));
    const other = await seedUser(t, "teacher", "Mr. Okafor", kai!.institutionId);
    const asOther = await withUser(t, other.userId);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");
    await asKai.mutation(api.activityCompletions.markHomeworkDoneForSelf, {
      assignmentId,
      activityId,
    });

    await expect(
      asOther.mutation(api.activityCompletions.unmarkComplete, {
        activityId,
        scholarId: kaiId,
        assignmentId,
      }),
    ).rejects.toThrow("Not your assignment");
    expect(await completionsFor(t, assignmentId)).toHaveLength(1);
  });
});

describe("any non-scholar completion clears the self-mark provenance", () => {
  test("a later write through the completion core (a rubric pass) confirms the scholar's mark", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "web");
    await asKai.mutation(api.activityCompletions.markHomeworkDoneForSelf, {
      assignmentId,
      activityId,
    });
    const [marked] = await completionsFor(t, assignmentId);
    expect(marked.source).toBe("scholar_home");

    // No caller opts in: the core's default is to clear.
    await t.run((ctx) =>
      reconcileActivityCompletion(ctx, {
        scholarId: kaiId,
        activityId,
        assignmentId,
        note: "Rubric passed",
      }),
    );
    const rows = await completionsFor(t, assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBeUndefined();
    expect(rows[0].action).toBeUndefined();
    // …so the scholar can no longer undo work something else vouched for.
    expect(
      await asKai.mutation(api.activityCompletions.undoHomeworkDoneForSelf, {
        completionId: rows[0]._id,
      }),
    ).toMatchObject({ ok: false });
  });

  test("a scholar re-mark never re-stamps provenance onto a teacher's row", async () => {
    const t = convexTest(schema, modules);
    const { kaiId, asTeacher, asKai } = await setup(t);
    const { assignmentId, activityId } = await dispatch(asTeacher, kaiId, "offline");
    await asTeacher.mutation(api.activityCompletions.markCompleteForGroup, {
      assignmentId,
      activityId,
    });
    const res = await asKai.mutation(
      api.activityCompletions.markHomeworkDoneForSelf,
      { assignmentId, activityId },
    );
    expect(res).toMatchObject({ ok: true, created: false });
    const rows = await completionsFor(t, assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBeUndefined();
  });
});

describe("finalize on lessoned web homework (the refactor off the hand-rolled insert)", () => {
  test("markDone writes exactly one row with lesson + unit, refreshes completedAt on a repeat, and runs the badge cascade", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, kaiId, asKai } = await setup(t);
    const { assignmentId, activityId, unitId, lessonId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Tide pools",
        isActive: true,
        badgeOnCompletion: { title: "Tide Watcher", icon: "🌊" },
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Watch and wonder",
        order: 0,
      });
      const onlineId = await ctx.db.insert("activities", {
        lessonId,
        title: "Talk it through",
        kind: "online",
        order: 0,
        systemPrompt: "Explore.",
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Watch: tide pool life",
        kind: "web",
        webUrl: "https://example.test/tide-pools",
        order: 1,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [kaiId],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId, mode: "homework" as const, setAt: Date.now() - 1000 },
        ],
      });
      // The unit's one online activity is already done, so the badge cascade
      // this web completion runs is what mints the badge.
      await ctx.db.insert("activityCompletions", {
        scholarId: kaiId,
        activityId: onlineId,
        lessonId,
        unitId,
        assignmentId,
        completedAt: Date.now() - 5000,
      });
      return { assignmentId, activityId, unitId, lessonId };
    });

    const finalizeDone = async () => {
      const { sessionId } = await asKai.mutation(api.webActivitySessions.start, {
        activityId,
        assignmentId,
      });
      return asKai.mutation(api.webActivitySessions.finalize, {
        sessionId,
        markDone: true,
      });
    };
    const webRows = async () =>
      (await completionsFor(t, assignmentId)).filter(
        (r) => r.activityId === activityId,
      );

    expect(await finalizeDone()).toMatchObject({
      completed: true,
      undoAvailable: true,
    });
    const [first] = await webRows();
    expect(first).toMatchObject({
      scholarId: kaiId,
      lessonId,
      unitId,
      source: "scholar_home",
      action: "scholar_marked_homework_done",
    });
    const badges = await t.run((ctx) =>
      ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", kaiId).eq("unitId", unitId),
        )
        .collect(),
    );
    expect(badges).toHaveLength(1);

    // A second Done dedupes onto the same row and refreshes completedAt (the
    // old hand-rolled path's re-mark behavior, kept by the core's patch).
    const stale = first.completedAt - 60_000;
    await t.run((ctx) => ctx.db.patch(first._id, { completedAt: stale }));
    expect(await finalizeDone()).toMatchObject({
      completed: true,
      undoAvailable: false,
    });
    const again = await webRows();
    expect(again).toHaveLength(1);
    expect(again[0]._id).toBe(first._id);
    expect(again[0].completedAt).toBeGreaterThan(stale);
  });
});
