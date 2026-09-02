import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  username: string,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
) {
  return await t.run(async (ctx) => {
    const institution =
      role === "scholar"
        ? ((await ctx.db
            .query("institutions")
            .filter((q) =>
              q.eq(q.field("slug"), "session-reopen"),
            )
            .unique()) ??
          {
            _id: await ctx.db.insert("institutions", {
              name: "Session Reopen",
              slug: "session-reopen",
              kind: "school",
              isPrimary: true,
            }),
          })
        : null;
    const userId = await ctx.db.insert("users", {
      name: username,
      username,
      role,
      ...(institution ? { institutionId: institution._id } : {}),
    });
    if (institution) {
      await ctx.db.insert("memberships", {
        userId,
        role: "scholar",
        institutionId: institution._id,
      });
    }
    return userId;
  });
}

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

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Tide Pools",
      isActive: true,
      badgeOnCompletion: {
        title: "Tide Pool Explorer",
        description: "Finished the tide-pool story.",
        icon: "🐚",
      },
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "The Story",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Write the tide-pool story",
      kind: "online",
      systemPrompt: "Help the scholar write.",
      order: 0,
      advanceRubric: { criteria: [{ id: "story", label: "Story" }] },
    });
    return { unitId, lessonId, activityId };
  });
}

/**
 * Simulate a FINISHED activity: an archived session carrying a document
 * (artifact), plus the durable completion + unit-badge records that live
 * OUTSIDE the session. This is the state a scholar is in when their work has
 * become a non-editable badge.
 */
async function seedFinishedWork(
  t: ReturnType<typeof convexTest>,
  {
    scholarId,
    unitId,
    lessonId,
    activityId,
    archived,
    assignmentId,
  }: {
    scholarId: Id<"users">;
    unitId: Id<"units">;
    lessonId: Id<"lessons">;
    activityId: Id<"activities">;
    archived: boolean;
    // When set, the finished session is assignment-anchored — so the plate
    // classifies its reopened row into classFocus/homework, not a Quest.
    assignmentId?: Id<"assignments">;
  },
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      lessonId,
      activityId,
      ...(assignmentId ? { assignmentId } : {}),
      title: "Write the tide-pool story",
      isArchived: archived,
      activityCompletedAt: Date.now() - 60_000,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "My tide-pool story",
      content: "Once upon a tide pool...",
      lastEditedBy: "scholar",
      type: "text",
    });
    const completionId = await ctx.db.insert("activityCompletions", {
      scholarId,
      activityId,
      lessonId,
      unitId,
      ...(assignmentId ? { assignmentId } : {}),
      completedAt: Date.now() - 60_000,
      sessionId,
    });
    const badgeId = await ctx.db.insert("scholarUnitBadges", {
      scholarId,
      unitId,
      earnedAt: Date.now() - 60_000,
      badgeSnapshot: {
        title: "Tide Pool Explorer",
        description: "Finished the tide-pool story.",
        icon: "🐚",
      },
    });
    return { sessionId, artifactId, completionId, badgeId };
  });
}

describe("sessions.reopen — keep working on finished work", () => {
  test("re-opens an archived session WITHOUT regressing completion, and keeps the artifact", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-1", "teacher");
    const scholarId = await seedUser(t, "scholar-1");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId, artifactId, completionId, badgeId } =
      await seedFinishedWork(t, {
        scholarId,
        unitId,
        lessonId,
        activityId,
        archived: true,
      });

    const asScholar = await withUser(t, scholarId);
    const before = await t.run(async (ctx) => ({
      completion: await ctx.db.get(completionId),
      badge: await ctx.db.get(badgeId),
    }));
    const result = await asScholar.mutation(api.sessions.reopen, {
      id: sessionId,
    });
    expect(String(result.id)).toBe(String(sessionId));

    // Session is now active again and explicitly marked as a re-entry...
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.isArchived).toBe(false);
    expect(session?.reopenedAt).toBeDefined();
    // ...but its activity-completion stamp is untouched (still complete).
    expect(session?.activityCompletedAt).toBeDefined();

    // Completion record survives UNCHANGED (unit stays complete — no regress).
    const completion = await t.run(async (ctx) => ctx.db.get(completionId));
    expect(completion).not.toBeNull();
    expect(completion?.completedAt).toBe(before.completion?.completedAt);
    // Badge survives UNCHANGED (no badge loss, no re-earn).
    const badge = await t.run(async (ctx) => ctx.db.get(badgeId));
    expect(badge).not.toBeNull();
    expect(badge?.earnedAt).toBe(before.badge?.earnedAt);
    expect(badge?.badgeSnapshot).toStrictEqual(before.badge?.badgeSnapshot);
    // The document is carried forward — still linked to the same session.
    const artifact = await t.run(async (ctx) => ctx.db.get(artifactId));
    expect(artifact?.sessionId).toStrictEqual(sessionId);
    expect(artifact?.content).toBe("Once upon a tide pool...");

    // Because the unit is already fully complete, the normal plate would drop
    // this session. The explicit re-entry marker keeps it findable as active
    // work without creating a second completion or un-completing the badge.
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = plate.rows.find(
      (r) => String(r.sessionId ?? "") === String(sessionId),
    );
    expect(row).toBeTruthy();
    expect(row?.isContinuation).toBe(false);
    expect(row?.unitCompletedCount).toBe(1);
    expect(row?.unitActivityCount).toBe(1);
  });

  test("continuing after re-open never un-completes or re-awards (single completion + badge remain)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-1b", "teacher");
    const scholarId = await seedUser(t, "scholar-1b");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: true,
    });

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.sessions.reopen, { id: sessionId });
    // Simulate "keep working": the scholar adds another message to the
    // re-opened, already-complete session.
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "Actually, let me revise the ending.",
        flagged: false,
      }),
    );

    // Exactly one completion + one badge still exist for this scholar/unit —
    // re-entry created no duplicates and deleted nothing.
    const { completions, badges } = await t.run(async (ctx) => ({
      completions: await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
      badges: await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .collect(),
    }));
    expect(completions).toHaveLength(1);
    expect(badges).toHaveLength(1);
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeDefined();
  });

  test("re-scoring reopened finished work still reconciles to one completion and one badge", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-1c", "teacher");
    const scholarId = await seedUser(t, "scholar-1c");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: true,
    });

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.sessions.reopen, { id: sessionId });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId,
        verdicts: [{ criterionId: "story", level: "full" as const }],
      }),
    );

    const { completions, badges, session } = await t.run(async (ctx) => ({
      completions: await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
      badges: await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .collect(),
      session: await ctx.db.get(sessionId),
    }));
    expect(completions).toHaveLength(1);
    expect(badges).toHaveLength(1);
    expect(session?.activityCompletedAt).toBeDefined();
    expect(session?.reopenedAt).toBeDefined();
  });

  test("is idempotent on an already-active session (completion preserved, re-entry marked)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-2", "teacher");
    const scholarId = await seedUser(t, "scholar-2");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId, completionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: false,
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.mutation(api.sessions.reopen, {
      id: sessionId,
    });
    expect(String(result.id)).toBe(String(sessionId));
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.isArchived).toBe(false);
    expect(session?.reopenedAt).toBeDefined();
    const completion = await t.run(async (ctx) => ctx.db.get(completionId));
    expect(completion).not.toBeNull();
  });

  test("role gate: a different scholar cannot re-open someone else's session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-3", "teacher");
    const ownerId = await seedUser(t, "owner-3");
    const otherId = await seedUser(t, "intruder-3");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId: ownerId,
      unitId,
      lessonId,
      activityId,
      archived: true,
    });

    const asOther = await withUser(t, otherId);
    await expect(
      asOther.mutation(api.sessions.reopen, { id: sessionId }),
    ).rejects.toThrow(/Forbidden/);

    // The session stays archived — the intruder's call had no effect.
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.isArchived).toBe(true);
  });
});

describe("sessions.reopen — reopened homework is resumable but NOT due", () => {
  // Regression (blind-pilot Days 4–5): re-opening a COMPLETED homework unit via
  // "Keep working on this" resurrected it in Home's HOMEWORK section as due
  // ("2 due" / Continue). The plate now flags such a row `isReopenedComplete`,
  // and the Home count excludes those rows — the card stays resumable, the
  // owed "due" count does not resurrect. Owed-homework count == the plate rows
  // with origin "homework" that are NOT reopened-complete (mirrors
  // components/ScholarPlate.tsx).
  const owedHomeworkCount = (
    rows: Array<{ origin: string; isReopenedComplete: boolean }>,
  ) =>
    rows.filter((r) => r.origin === "homework" && !r.isReopenedComplete).length;

  async function seedHomeworkAssignment(
    t: ReturnType<typeof convexTest>,
    {
      teacherId,
      scholarId,
      unitId,
      activityId,
    }: {
      teacherId: Id<"users">;
      scholarId: Id<"users">;
      unitId: Id<"units">;
      activityId: Id<"activities">;
    },
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: Date.now() - 3 * 86_400_000,
        // A live homework window pushed the unit's only activity.
        activitySchedule: [
          {
            activityId,
            mode: "homework" as const,
            setAt: Date.now() - 3_600_000,
          },
        ],
      }),
    );
  }

  test("completed → dropped from due; reopened → resumable card, still NOT due", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-hw", "teacher");
    const scholarId = await seedUser(t, "scholar-hw");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const assignmentId = await seedHomeworkAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      activityId,
    });
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: false,
      assignmentId,
    });

    const asScholar = await withUser(t, scholarId);

    // BEFORE re-opening: the completed homework is off the plate entirely (the
    // unit is fully complete, no re-entry yet) — nothing owed.
    const before = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(
      before.rows.find((r) => String(r.sessionId ?? "") === String(sessionId)),
    ).toBeUndefined();
    expect(owedHomeworkCount(before.rows)).toBe(0);

    // "Keep working on this" → re-enter the finished session.
    await asScholar.mutation(api.sessions.reopen, { id: sessionId });

    // AFTER: the card is back and resumable (real sessionId, homework origin)…
    const after = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = after.rows.find(
      (r) => String(r.sessionId ?? "") === String(sessionId),
    );
    expect(row).toBeTruthy();
    expect(row?.origin).toBe("homework");
    expect(row?.isReopenedComplete).toBe(true);
    expect(row?.isContinuation).toBe(false);
    // …but it does NOT resurrect as owed "due" work.
    expect(owedHomeworkCount(after.rows)).toBe(0);
  });

  test("genuinely-incomplete homework still lists as due (fix doesn't hide real work)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-hw2", "teacher");
    const scholarId = await seedUser(t, "scholar-hw2");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const assignmentId = await seedHomeworkAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      activityId,
    });
    // An in-progress (NOT complete) homework session — no completion record.
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Write the tide-pool story",
        isArchived: false,
        lastMessageAt: Date.now() - 5 * 60_000,
      }),
    );

    const asScholar = await withUser(t, scholarId);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = plate.rows.find(
      (r) => String(r.sessionId ?? "") === String(sessionId),
    );
    expect(row?.origin).toBe("homework");
    expect(row?.isReopenedComplete).toBe(false);
    expect(owedHomeworkCount(plate.rows)).toBe(1);
  });
});

describe("sessions.reopenableForUnit — resolve a unit badge to re-openable work", () => {
  test("returns the scholar's session that carries a document for the unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-4", "teacher");
    const scholarId = await seedUser(t, "scholar-4");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );

    // An earlier session in the unit with NO document (empty artifact)...
    const emptyId = await t.run(async (ctx) => {
      const s = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        title: "Warm-up",
        isArchived: true,
        lastMessageAt: Date.now() - 200_000,
      });
      await ctx.db.insert("artifacts", {
        sessionId: s,
        title: "blank",
        content: "",
        lastEditedBy: "scholar",
        type: "text",
      });
      return s;
    });
    // ...and the story session (has a real document), older by lastMessageAt.
    const { sessionId: storyId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: true,
    });
    await t.run(async (ctx) =>
      ctx.db.patch(storyId, { lastMessageAt: Date.now() - 300_000 }),
    );

    const asScholar = await withUser(t, scholarId);
    const target = await asScholar.query(api.sessions.reopenableForUnit, {
      unitId,
    });
    // The session with a real artifact wins over the more-recent empty one.
    expect(target).not.toBeNull();
    expect(String(target?.sessionId)).toBe(String(storyId));
    expect(String(target?.sessionId)).not.toBe(String(emptyId));
  });

  test("returns null when the scholar has no session for the unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-5", "teacher");
    const scholarId = await seedUser(t, "scholar-5");
    const { unitId } = await seedUnitWithActivity(t, teacherId);

    const asScholar = await withUser(t, scholarId);
    const target = await asScholar.query(api.sessions.reopenableForUnit, {
      unitId,
    });
    expect(target).toBeNull();
  });

  test("does not resolve another scholar's session for the unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-6", "teacher");
    const ownerId = await seedUser(t, "owner-6");
    const otherId = await seedUser(t, "other-6");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    await seedFinishedWork(t, {
      scholarId: ownerId,
      unitId,
      lessonId,
      activityId,
      archived: true,
    });

    // A different scholar with no work in the unit sees nothing.
    const asOther = await withUser(t, otherId);
    const target = await asOther.query(api.sessions.reopenableForUnit, {
      unitId,
    });
    expect(target).toBeNull();
  });
});

describe("sessions.finishedForScholar — finished work you can keep working on", () => {
  test("includes completed-but-NOT-archived class-focus work (with a document), tagged 'completed'", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-7", "teacher");
    const scholarId = await seedUser(t, "scholar-7");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    // A completed activity whose session was never archived — the "dropped"
    // class-focus case: complete, unit has no next activity, carries an artifact.
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: false,
    });

    const asScholar = await withUser(t, scholarId);
    const finished = await asScholar.query(api.sessions.finishedForScholar, {});
    const row = finished.find((r) => String(r._id) === String(sessionId));
    expect(row).toBeTruthy();
    expect(row?.finishedKind).toBe("completed");
  });

  test("still includes ARCHIVED sessions, tagged 'archived'", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-8", "teacher");
    const scholarId = await seedUser(t, "scholar-8");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: true,
    });

    const asScholar = await withUser(t, scholarId);
    const finished = await asScholar.query(api.sessions.finishedForScholar, {});
    const row = finished.find((r) => String(r._id) === String(sessionId));
    expect(row).toBeTruthy();
    expect(row?.finishedKind).toBe("archived");
  });

  test("excludes a completed session with NO document (empty artifact)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-9", "teacher");
    const scholarId = await seedUser(t, "scholar-9");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    // Completed + not archived, but the artifact is empty — nothing to re-enter.
    const sessionId = await t.run(async (ctx) => {
      const s = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        title: "Empty finish",
        isArchived: false,
        activityCompletedAt: Date.now() - 60_000,
      });
      await ctx.db.insert("artifacts", {
        sessionId: s,
        title: "blank",
        content: "",
        lastEditedBy: "scholar",
        type: "text",
      });
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        completedAt: Date.now() - 60_000,
        sessionId: s,
      });
      return s;
    });

    const asScholar = await withUser(t, scholarId);
    const finished = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(
      finished.find((r) => String(r._id) === String(sessionId)),
    ).toBeUndefined();
  });

  test("excludes a completed session when the unit still has a next incomplete activity (still a plate continuation)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-10", "teacher");
    const scholarId = await seedUser(t, "scholar-10");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    // A SECOND online activity in the unit that the scholar has NOT completed —
    // so activity 1's finished session is still reachable as a continuation and
    // must not double-surface in Finished.
    await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Second beat",
        kind: "online",
        systemPrompt: "Keep going.",
        order: 1,
      }),
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: false,
    });

    const asScholar = await withUser(t, scholarId);
    const finished = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(
      finished.find((r) => String(r._id) === String(sessionId)),
    ).toBeUndefined();
  });

  test("excludes a completed session when the next plate continuation is a Simulator", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-simulator-next", "teacher");
    const scholarId = await seedUser(t, "scholar-simulator-next");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Model the tide pool",
        kind: "simulator",
        systemPrompt: "Build a fish strategy.",
        order: 1,
      }),
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: false,
    });

    const asScholar = await withUser(t, scholarId);
    const finished = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(
      finished.find((row) => String(row._id) === String(sessionId)),
    ).toBeUndefined();
  });

  test("excludes a session the scholar has already re-entered (reopenedAt set → back on the active plate)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-11", "teacher");
    const scholarId = await seedUser(t, "scholar-11");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: false,
    });

    const asScholar = await withUser(t, scholarId);
    // Before re-entry it's in Finished...
    let finished = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(finished.find((r) => String(r._id) === String(sessionId))).toBeTruthy();

    // ...after "Keep working on this" it leaves Finished (now on the active plate).
    await asScholar.mutation(api.sessions.reopen, { id: sessionId });
    finished = await asScholar.query(api.sessions.finishedForScholar, {});
    expect(
      finished.find((r) => String(r._id) === String(sessionId)),
    ).toBeUndefined();
  });

  test("re-entering completed-but-not-archived work keeps EXACTLY ONE completion + one badge (invariant preserved for this class)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-12", "teacher");
    const scholarId = await seedUser(t, "scholar-12");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { sessionId } = await seedFinishedWork(t, {
      scholarId,
      unitId,
      lessonId,
      activityId,
      archived: false,
    });

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.sessions.reopen, { id: sessionId });
    // "Keep working": add a message, then re-score the already-complete session.
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "Let me sharpen the argument.",
        flagged: false,
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId,
        verdicts: [{ criterionId: "story", level: "full" as const }],
      }),
    );

    const { completions, badges, session } = await t.run(async (ctx) => ({
      completions: await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
      badges: await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .collect(),
      session: await ctx.db.get(sessionId),
    }));
    expect(completions).toHaveLength(1);
    expect(badges).toHaveLength(1);
    expect(session?.activityCompletedAt).toBeDefined();
    expect(session?.reopenedAt).toBeDefined();
  });

  test("does not surface another scholar's finished work", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher-13", "teacher");
    const ownerId = await seedUser(t, "owner-13");
    const otherId = await seedUser(t, "other-13");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    await seedFinishedWork(t, {
      scholarId: ownerId,
      unitId,
      lessonId,
      activityId,
      archived: false,
    });

    const asOther = await withUser(t, otherId);
    const finished = await asOther.query(api.sessions.finishedForScholar, {});
    expect(finished).toHaveLength(0);
  });
});
