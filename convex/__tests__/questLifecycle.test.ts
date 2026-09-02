import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  deriveQuestState,
  questFactsForPair,
  questsForScholar,
  type QuestFacts,
} from "../lib/questLifecycle";
import { unitOnlineProgressForScholar } from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Standard fixtures (verbatim from .claude/rules/rabbithole-testing.md) ──

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

// ── Local builders for quest shapes ─────────────────────────────────────

async function seedUnit(
  t: ReturnType<typeof convexTest>,
  args: {
    teacherId: Id<"users">;
    authorScholarId: Id<"users">;
    isActive?: boolean;
    title?: string;
    emoji?: string;
    description?: string;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", {
      teacherId: args.teacherId,
      authorScholarId: args.authorScholarId,
      title: args.title ?? "Quest Unit",
      emoji: args.emoji,
      description: args.description,
      isActive: args.isActive ?? true,
    }),
  );
}

/** A TEACHER-authored catalog unit — no `authorScholarId`, so it's NOT picked
 *  up by `by_authorScholar`; only a scholar's assignment-less session on it
 *  (a "free-start") makes it their quest. */
async function seedCatalogUnit(
  t: ReturnType<typeof convexTest>,
  args: { teacherId: Id<"users">; isActive?: boolean; title?: string },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", {
      teacherId: args.teacherId,
      title: args.title ?? "Catalog Unit",
      isActive: args.isActive ?? true,
    }),
  );
}

async function seedOnlineActivity(
  t: ReturnType<typeof convexTest>,
  unitId: Id<"units">,
  order = 0,
) {
  return await t.run(async (ctx) => {
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: `Lesson ${order}`,
      order,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: `Activity ${order}`,
      kind: "online",
      systemPrompt: "You are a tutor.",
      order,
    });
    return { lessonId, activityId };
  });
}

/** A single "choice" lesson holding `optionCount` online activities, of which
 *  the scholar must complete `pickCount` (default 1) for the lesson to be
 *  satisfied. Returns the lesson + all option activity ids. */
async function seedChoiceLesson(
  t: ReturnType<typeof convexTest>,
  unitId: Id<"units">,
  args: { optionCount: number; pickCount?: number; order?: number },
) {
  return await t.run(async (ctx) => {
    const order = args.order ?? 0;
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: `Choice Lesson ${order}`,
      order,
      selectionMode: "choice" as const,
      choicePickCount: args.pickCount ?? 1,
    });
    const activityIds: Id<"activities">[] = [];
    for (let i = 0; i < args.optionCount; i++) {
      activityIds.push(
        await ctx.db.insert("activities", {
          lessonId,
          title: `Option ${order}.${i}`,
          kind: "online",
          systemPrompt: "You are a tutor.",
          order: i,
        }),
      );
    }
    return { lessonId, activityIds };
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    unitId: Id<"units">;
    activityId?: Id<"activities">;
    title?: string;
    lastMessageAt?: number;
    isArchived?: boolean;
    isTestDrive?: boolean;
    isOffline?: boolean;
    reopenedAt?: number;
    assignmentId?: Id<"assignments">;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: args.userId,
      unitId: args.unitId,
      activityId: args.activityId,
      title: args.title ?? "Session",
      isArchived: args.isArchived ?? false,
      isTestDrive: args.isTestDrive,
      isOffline: args.isOffline,
      reopenedAt: args.reopenedAt,
      lastMessageAt: args.lastMessageAt,
      assignmentId: args.assignmentId,
    }),
  );
}

async function seedCompletion(
  t: ReturnType<typeof convexTest>,
  args: {
    scholarId: Id<"users">;
    activityId: Id<"activities">;
    unitId: Id<"units">;
    sessionId?: Id<"sessions">;
    assignmentId?: Id<"assignments">;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("activityCompletions", {
      scholarId: args.scholarId,
      activityId: args.activityId,
      unitId: args.unitId,
      sessionId: args.sessionId,
      assignmentId: args.assignmentId,
      completedAt: Date.now(),
    }),
  );
}

async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  args: {
    teacherId: Id<"users">;
    scholarId: Id<"users">;
    unitId: Id<"units">;
    activityIds: Id<"activities">[];
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId: args.teacherId,
      unitId: args.unitId,
      scholarIds: [args.scholarId],
      startedAt: Date.now(),
      activitySchedule: args.activityIds.map((activityId) => ({
        activityId,
        mode: "classFocus" as const,
        setAt: Date.now(),
      })),
    }),
  );
}

async function seedBadge(
  t: ReturnType<typeof convexTest>,
  args: { scholarId: Id<"users">; unitId: Id<"units"> },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("scholarUnitBadges", {
      scholarId: args.scholarId,
      unitId: args.unitId,
      earnedAt: Date.now(),
      badgeSnapshot: { title: "Badge" },
    }),
  );
}

async function seedSeedOffer(
  t: ReturnType<typeof convexTest>,
  args: {
    scholarId: Id<"users">;
    unitId: Id<"units">;
    status?: "pending" | "active" | "dismissed" | "completed";
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId: args.scholarId,
      origin: "teacher",
      status: args.status ?? "pending",
      topic: "An offered quest",
      suggestionType: "teacher_suggestion",
      rationale: "Because it's interesting",
      unitId: args.unitId,
    }),
  );
}

// ── Pure deriveQuestState — exhaustive branch coverage ──────────────────

const ALL_FALSE: QuestFacts = {
  unitIsActive: true,
  hasLiveSession: false,
  badgeEarned: false,
  hasNonTerminalSeedOffer: false,
  allActivitiesComplete: false,
};

describe("deriveQuestState (pure)", () => {
  test("retracted dominates everything when the unit is inactive", () => {
    // Even with a badge, a live session, an offer, and completion all set,
    // an inactive unit is retracted.
    expect(
      deriveQuestState({
        unitIsActive: false,
        hasLiveSession: true,
        badgeEarned: true,
        hasNonTerminalSeedOffer: true,
        allActivitiesComplete: true,
      }).state,
    ).toBe("retracted");
    // And with nothing else set.
    expect(
      deriveQuestState({ ...ALL_FALSE, unitIsActive: false }).state,
    ).toBe("retracted");
  });

  test("finished when the badge is earned (over active/offered)", () => {
    expect(
      deriveQuestState({
        ...ALL_FALSE,
        badgeEarned: true,
        hasLiveSession: true,
        hasNonTerminalSeedOffer: true,
      }).state,
    ).toBe("finished");
  });

  test("finished when all activities complete (no badge needed)", () => {
    expect(
      deriveQuestState({
        ...ALL_FALSE,
        allActivitiesComplete: true,
        hasLiveSession: true,
      }).state,
    ).toBe("finished");
  });

  test("active when a live session exists (no badge / not all complete)", () => {
    expect(
      deriveQuestState({
        ...ALL_FALSE,
        hasLiveSession: true,
        hasNonTerminalSeedOffer: true, // active beats offered
      }).state,
    ).toBe("active");
  });

  test("offered when only an open seed offer exists", () => {
    expect(
      deriveQuestState({ ...ALL_FALSE, hasNonTerminalSeedOffer: true }).state,
    ).toBe("offered");
  });

  test("dormant when active but no offer, no session, no completion, no badge", () => {
    expect(deriveQuestState(ALL_FALSE).state).toBe("dormant");
  });

  test("precedence chain: finished > active > offered > dormant", () => {
    const base = { unitIsActive: true, allActivitiesComplete: false } as const;
    expect(
      deriveQuestState({
        ...base,
        badgeEarned: true,
        hasLiveSession: true,
        hasNonTerminalSeedOffer: true,
      }).state,
    ).toBe("finished");
    expect(
      deriveQuestState({
        ...base,
        badgeEarned: false,
        hasLiveSession: true,
        hasNonTerminalSeedOffer: true,
      }).state,
    ).toBe("active");
    expect(
      deriveQuestState({
        ...base,
        badgeEarned: false,
        hasLiveSession: false,
        hasNonTerminalSeedOffer: true,
      }).state,
    ).toBe("offered");
    expect(
      deriveQuestState({
        ...base,
        badgeEarned: false,
        hasLiveSession: false,
        hasNonTerminalSeedOffer: false,
      }).state,
    ).toBe("dormant");
  });
});

// ── questsForScholar (async collector) ──────────────────────────────────

describe("questsForScholar", () => {
  test("scholar-authored active unit with a live session → active / inProgress", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const { activityId } = await seedOnlineActivity(t, unitId);
    await seedSession(t, { userId: scholar, unitId, activityId });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    const q = quests[0];
    expect(q.state).toBe("active");
    expect(q.lane).toBe("inProgress");
    expect(q.source).toBe("scholar");
    expect(q.hasLiveSession).toBe(true);
    expect(q.onlineActivityCount).toBe(1);
    expect(q.completedCount).toBe(0);
    expect(q.badgeEarned).toBe(false);
    expect(q.unitIsActive).toBe(true);
    expect(q.lastTouched).not.toBeNull();
  });

  test("badged unit → finished / badged", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s2" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const { activityId } = await seedOnlineActivity(t, unitId);
    await seedSession(t, { userId: scholar, unitId, activityId });
    await seedBadge(t, { scholarId: scholar, unitId });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].state).toBe("finished");
    expect(quests[0].lane).toBe("badged");
    expect(quests[0].badgeEarned).toBe(true);
  });

  test("offered unit (seed, no session) → offered / offered / teacher", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s3" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    await seedSeedOffer(t, { scholarId: scholar, unitId, status: "pending" });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].state).toBe("offered");
    expect(quests[0].lane).toBe("offered");
    expect(quests[0].source).toBe("teacher");
    expect(quests[0].hasLiveSession).toBe(false);
    expect(quests[0].lastTouched).toBeNull();
  });

  test("offeredAt is the offer seed's creation time (null once terminal / never offered)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s3a" });

    // A unit with a pending offer → offeredAt equals the seed's _creationTime.
    const offeredUnit = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "Offered",
    });
    const seedId = await seedSeedOffer(t, {
      scholarId: scholar,
      unitId: offeredUnit,
      status: "pending",
    });
    const seedDoc = await t.run((ctx) => ctx.db.get(seedId));

    // A scholar-authored unit with no offer at all → offeredAt null.
    const bareUnit = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "Bare",
    });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    const byUnit = new Map(quests.map((q) => [String(q.unitId), q]));
    expect(byUnit.get(String(offeredUnit))?.offeredAt).toBe(
      seedDoc!._creationTime,
    );
    expect(byUnit.get(String(bareUnit))?.offeredAt).toBeNull();
  });

  test("offeredAt is null when the only seed offer is terminal (dismissed)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s3c" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    await seedSeedOffer(t, { scholarId: scholar, unitId, status: "dismissed" });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].offeredAt).toBeNull();
    expect(quests[0].state).toBe("dormant");
  });

  test("a dismissed seed does NOT make a bare unit offered (→ dormant)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s3b" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    await seedSeedOffer(t, { scholarId: scholar, unitId, status: "dismissed" });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].state).toBe("dormant");
  });

  test("deactivated (inactive) unit → retracted", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s4" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      isActive: false,
    });
    const { activityId } = await seedOnlineActivity(t, unitId);
    // A lingering live session must NOT rescue a deactivated unit.
    await seedSession(t, { userId: scholar, unitId, activityId });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].state).toBe("retracted");
    expect(quests[0].unitIsActive).toBe(false);
  });

  test("bare active unit (no session / seed / badge) → dormant", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s5" });
    await seedUnit(t, { teacherId: teacher, authorScholarId: scholar });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].state).toBe("dormant");
    expect(quests[0].lane).toBe("offered");
    expect(quests[0].hasLiveSession).toBe(false);
  });

  test("all activities complete, no badge → finished, but lane stays inProgress (deliberate divergence)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s6" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const { activityId } = await seedOnlineActivity(t, unitId);
    const sessionId = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId,
      unitId,
      sessionId,
    });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    const q = quests[0];
    expect(q.completedCount).toBe(1);
    expect(q.onlineActivityCount).toBe(1);
    // Canonical state: the unit is finished (all activities done, no badge).
    expect(q.state).toBe("finished");
    // Completion-skip drops the finished session from the "live" set …
    expect(q.hasLiveSession).toBe(false);
    // … but the back-compat lane still reads raw session presence.
    expect(q.lane).toBe("inProgress");
  });

  test("a completed session in a unit with more work still counts as live (active)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s7" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const first = await seedOnlineActivity(t, unitId, 0);
    await seedOnlineActivity(t, unitId, 1); // a 2nd, still-incomplete activity
    const sessionId = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId: first.activityId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: first.activityId,
      unitId,
      sessionId,
    });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    const q = quests[0];
    expect(q.onlineActivityCount).toBe(2);
    expect(q.completedCount).toBe(1);
    // Session's own activity is complete, but the unit has more → still live.
    expect(q.hasLiveSession).toBe(true);
    expect(q.state).toBe("active");
  });

  test("assignment-scoped completion counts toward active quest progress", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "assigned-quest-1" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const first = await seedOnlineActivity(t, unitId, 0);
    const second = await seedOnlineActivity(t, unitId, 1);
    const assignmentId = await seedAssignment(t, {
      teacherId: teacher,
      scholarId: scholar,
      unitId,
      activityIds: [first.activityId, second.activityId],
    });
    const sessionId = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId: first.activityId,
      assignmentId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: first.activityId,
      unitId,
      sessionId,
      assignmentId,
    });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].completedCount).toBe(1);
    expect(quests[0].onlineActivityCount).toBe(2);
    expect(quests[0].state).toBe("active");
  });

  test("all assignment-scoped completions finish a quest without a badge", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "assigned-quest-2" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const first = await seedOnlineActivity(t, unitId, 0);
    const second = await seedOnlineActivity(t, unitId, 1);
    const assignmentId = await seedAssignment(t, {
      teacherId: teacher,
      scholarId: scholar,
      unitId,
      activityIds: [first.activityId, second.activityId],
    });
    for (const activityId of [first.activityId, second.activityId]) {
      const sessionId = await seedSession(t, {
        userId: scholar,
        unitId,
        activityId,
        assignmentId,
      });
      await seedCompletion(t, {
        scholarId: scholar,
        activityId,
        unitId,
        sessionId,
        assignmentId,
      });
    }

    const [quests, facts] = await Promise.all([
      t.run((ctx) => questsForScholar(ctx, scholar)),
      t.run((ctx) => questFactsForPair(ctx, scholar, unitId)),
    ]);
    expect(quests).toHaveLength(1);
    expect(quests[0].completedCount).toBe(quests[0].onlineActivityCount);
    expect(quests[0].badgeEarned).toBe(false);
    expect(facts).not.toBeNull();
    expect(deriveQuestState(facts!).state).toBe("finished");
  });

  test("unit online progress remains assignment-scoped", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "assigned-quest-3" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const { activityId } = await seedOnlineActivity(t, unitId);
    const assignmentId = await seedAssignment(t, {
      teacherId: teacher,
      scholarId: scholar,
      unitId,
      activityIds: [activityId],
    });
    const sessionId = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId,
      assignmentId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId,
      unitId,
      sessionId,
      assignmentId,
    });

    const completedOnline = await t.run(async (ctx) => {
      const progress = await unitOnlineProgressForScholar(ctx, scholar, unitId);
      return progress.completedOnline;
    });
    expect(completedOnline).toBe(0);
  });

  test("mixed IS + assignment completions union toward a finished quest", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "assigned-quest-mix" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const first = await seedOnlineActivity(t, unitId, 0);
    const second = await seedOnlineActivity(t, unitId, 1);
    const assignmentId = await seedAssignment(t, {
      teacherId: teacher,
      scholarId: scholar,
      unitId,
      activityIds: [first.activityId, second.activityId],
    });

    // First activity finished in an assignment-LESS IS (free-start) session.
    const isSession = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId: first.activityId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: first.activityId,
      unitId,
      sessionId: isSession,
    });
    // Second activity finished in an ASSIGNMENT-scoped session.
    const assignedSession = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId: second.activityId,
      assignmentId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: second.activityId,
      unitId,
      sessionId: assignedSession,
      assignmentId,
    });

    const [quests, facts] = await Promise.all([
      t.run((ctx) => questsForScholar(ctx, scholar)),
      t.run((ctx) => questFactsForPair(ctx, scholar, unitId)),
    ]);
    expect(quests).toHaveLength(1);
    expect(quests[0].completedCount).toBe(2);
    expect(quests[0].onlineActivityCount).toBe(2);
    expect(quests[0].state).toBe("finished");
    expect(facts).not.toBeNull();
    expect(deriveQuestState(facts!).state).toBe("finished");
  });

  test("a choice lesson is satisfied by a single assignment-scoped completion", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "assigned-quest-choice" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    // One choice lesson, 2 options, pick 1 — the choice denominator is 1.
    const { activityIds } = await seedChoiceLesson(t, unitId, {
      optionCount: 2,
      pickCount: 1,
    });
    const assignmentId = await seedAssignment(t, {
      teacherId: teacher,
      scholarId: scholar,
      unitId,
      activityIds,
    });
    const sessionId = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId: activityIds[0],
      assignmentId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: activityIds[0],
      unitId,
      sessionId,
      assignmentId,
    });

    const [quests, facts] = await Promise.all([
      t.run((ctx) => questsForScholar(ctx, scholar)),
      t.run((ctx) => questFactsForPair(ctx, scholar, unitId)),
    ]);
    expect(quests).toHaveLength(1);
    // The denominator is the choice pickCount (1), not the option count (2).
    expect(quests[0].onlineActivityCount).toBe(1);
    expect(quests[0].completedCount).toBe(1);
    expect(quests[0].state).toBe("finished");
    expect(facts).not.toBeNull();
    expect(deriveQuestState(facts!).state).toBe("finished");
  });

  test("assignment-finished quest drops from the live/quest lane (hasLiveSession false)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "assigned-quest-lane" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const first = await seedOnlineActivity(t, unitId, 0);
    const second = await seedOnlineActivity(t, unitId, 1);
    const assignmentId = await seedAssignment(t, {
      teacherId: teacher,
      scholarId: scholar,
      unitId,
      activityIds: [first.activityId, second.activityId],
    });
    // The scholar's plate card is an assignment-LESS IS session on the FIRST
    // activity, whose own completion is unassigned → the card's own activity is
    // genuinely complete (not blocked by the assignment-scoped skip).
    const isSession = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId: first.activityId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: first.activityId,
      unitId,
      sessionId: isSession,
    });
    // The unit's REMAINING work (the second activity) is finished under the
    // assignment — the row the old, assignment-scoped projection discarded.
    const assignedSession = await seedSession(t, {
      userId: scholar,
      unitId,
      activityId: second.activityId,
      assignmentId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: second.activityId,
      unitId,
      sessionId: assignedSession,
      assignmentId,
    });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    // Blind read counts the assignment completion → the unit has no work left,
    // the IS session's own activity is complete, and it was not reopened, so it
    // is no longer live. scholarPlate gates its IS/quest card lane on exactly
    // this, so the card would drop — the intended "finished quests fall out".
    // (Under the OLD scoped read the second completion was invisible, nextItem
    // stayed non-null, hasLiveSession stayed true, and the card lingered.)
    expect(quests[0].completedCount).toBe(2);
    expect(quests[0].onlineActivityCount).toBe(2);
    expect(quests[0].hasLiveSession).toBe(false);
    expect(quests[0].state).toBe("finished");
  });

  test("duplicate assigned + unassigned completions for one activity collapse", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "assigned-quest-dupe" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const first = await seedOnlineActivity(t, unitId, 0);
    const second = await seedOnlineActivity(t, unitId, 1);
    const assignmentId = await seedAssignment(t, {
      teacherId: teacher,
      scholarId: scholar,
      unitId,
      activityIds: [first.activityId, second.activityId],
    });
    // TWO completion rows for the SAME activity — one unassigned, one assigned.
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: first.activityId,
      unitId,
    });
    await seedCompletion(t, {
      scholarId: scholar,
      activityId: first.activityId,
      unitId,
      assignmentId,
    });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    // The two rows dedupe by activityId → 1 of 2 done, not 2 of 2.
    expect(quests[0].completedCount).toBe(1);
    expect(quests[0].onlineActivityCount).toBe(2);
    // No session / offer and work still remains → dormant (crucially NOT
    // finished, which double-counting the activity would have produced).
    expect(quests[0].state).toBe("dormant");
  });

  test("archived / test-drive / offline sessions do not count as live", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s8" });
    const unitId = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
    });
    const { activityId } = await seedOnlineActivity(t, unitId);
    await seedSession(t, { userId: scholar, unitId, activityId, isArchived: true });
    await seedSession(t, { userId: scholar, unitId, activityId, isTestDrive: true });
    await seedSession(t, { userId: scholar, unitId, activityId, isOffline: true });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].hasLiveSession).toBe(false);
    expect(quests[0].state).toBe("dormant");
  });

  test("sorted by lastTouched desc", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s9" });
    const older = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "Older",
    });
    const newer = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "Newer",
    });
    const a1 = await seedOnlineActivity(t, older);
    const a2 = await seedOnlineActivity(t, newer);
    await seedSession(t, {
      userId: scholar,
      unitId: older,
      activityId: a1.activityId,
      lastMessageAt: 1_000,
    });
    await seedSession(t, {
      userId: scholar,
      unitId: newer,
      activityId: a2.activityId,
      lastMessageAt: 9_000,
    });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests.map((q) => q.title)).toEqual(["Newer", "Older"]);
  });

  test("returns nothing for a scholar with no authored units", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "s10" });
    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toEqual([]);
  });
});

// ── Parity with units.listScholarAuthored's canonical state ─────────────

describe("questsForScholar reproduces listScholarAuthored state", () => {
  test("same inputs → same canonical state on every active unit", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "parity" });

    // offered: a pending seed, no session.
    const offeredUnit = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "Offered",
    });
    await seedSeedOffer(t, { scholarId: scholar, unitId: offeredUnit });

    // active: a live session on an incomplete unit.
    const inProgressUnit = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "InProgress",
    });
    const ip = await seedOnlineActivity(t, inProgressUnit);
    await seedSession(t, {
      userId: scholar,
      unitId: inProgressUnit,
      activityId: ip.activityId,
    });

    // finished: a badge earned.
    const badgedUnit = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "Badged",
    });
    const bd = await seedOnlineActivity(t, badgedUnit);
    await seedSession(t, {
      userId: scholar,
      unitId: badgedUnit,
      activityId: bd.activityId,
    });
    await seedBadge(t, { scholarId: scholar, unitId: badgedUnit });

    const asTeacher = await withUser(t, teacher);
    const board = await asTeacher.query(api.units.listScholarAuthored, {});
    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));

    const boardStateById = new Map<string, string>(
      board.map((u: { _id: Id<"units">; state: string }) => [
        String(u._id),
        u.state,
      ]),
    );
    // Every active unit the board lists must get the SAME state from the helper.
    expect(boardStateById.size).toBe(3);
    for (const q of quests) {
      expect(q.state).toBe(boardStateById.get(String(q.unitId)));
    }
    // And also the same source classification.
    const boardSourceById = new Map<string, string>(
      board.map((u: { _id: Id<"units">; source: string }) => [
        String(u._id),
        u.source,
      ]),
    );
    for (const q of quests) {
      expect(q.source).toBe(boardSourceById.get(String(q.unitId)));
    }
  });
});

// ── Catalog free-starts (widened collector) ─────────────────────────────

describe("questsForScholar — catalog free-starts", () => {
  test("teacher catalog unit + an assignment-less session → active / scholar-sourced", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "cat1" });
    const unitId = await seedCatalogUnit(t, { teacherId: teacher });
    const { activityId } = await seedOnlineActivity(t, unitId);
    // A free-start: the scholar started this teacher-authored catalog unit with
    // NO assignment. They don't author it, so `by_authorScholar` misses it.
    await seedSession(t, { userId: scholar, unitId, activityId });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    const q = quests[0];
    expect(String(q.unitId)).toBe(String(unitId));
    expect(q.state).toBe("active");
    // Self-chosen → always scholar-sourced, even though a teacher authored the unit.
    expect(q.source).toBe("scholar");
    expect(q.hasLiveSession).toBe(true);
    expect(q.unitIsActive).toBe(true);
  });

  test("catalog free-start → finished when all activities complete", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "cat2" });
    const unitId = await seedCatalogUnit(t, { teacherId: teacher });
    const { activityId } = await seedOnlineActivity(t, unitId);
    const sessionId = await seedSession(t, { userId: scholar, unitId, activityId });
    await seedCompletion(t, { scholarId: scholar, activityId, unitId, sessionId });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    const q = quests[0];
    expect(q.completedCount).toBe(1);
    expect(q.onlineActivityCount).toBe(1);
    expect(q.state).toBe("finished");
    // Completion-skip drops the finished session from the live set.
    expect(q.hasLiveSession).toBe(false);
    expect(q.source).toBe("scholar");
  });

  test("catalog free-start → retracted when the catalog unit is deactivated", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "cat3" });
    const unitId = await seedCatalogUnit(t, {
      teacherId: teacher,
      isActive: false,
    });
    const { activityId } = await seedOnlineActivity(t, unitId);
    // A lingering live session must NOT rescue a deactivated catalog unit.
    await seedSession(t, { userId: scholar, unitId, activityId });

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(1);
    expect(quests[0].state).toBe("retracted");
    expect(quests[0].unitIsActive).toBe(false);
  });

  test("an ASSIGNED session on a catalog unit is NOT a free-start quest", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "cat4" });
    const unitId = await seedCatalogUnit(t, { teacherId: teacher });
    const { activityId } = await seedOnlineActivity(t, unitId);
    const assignmentId = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId, mode: "classFocus", setAt: Date.now() },
        ],
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        activityId,
        assignmentId,
        title: "Assigned",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );

    // The only session is assignment-anchored → the widening (assignment-LESS
    // sessions only) must not adopt the unit as a self-chosen quest.
    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests).toHaveLength(0);
  });

  test("a catalog free-start does NOT appear on the teacher quests board", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "cat5" });

    // A catalog free-start (teacher unit + assignment-less session)…
    const catalogUnit = await seedCatalogUnit(t, { teacherId: teacher });
    const { activityId: catActivity } = await seedOnlineActivity(t, catalogUnit);
    await seedSession(t, {
      userId: scholar,
      unitId: catalogUnit,
      activityId: catActivity,
    });
    // …and a genuinely scholar-authored quest, so the scholar is on the board.
    const authoredUnit = await seedUnit(t, {
      teacherId: teacher,
      authorScholarId: scholar,
      title: "Authored",
    });
    const { activityId: authActivity } = await seedOnlineActivity(t, authoredUnit);
    await seedSession(t, {
      userId: scholar,
      unitId: authoredUnit,
      activityId: authActivity,
    });

    // The helper covers BOTH (plate scope)…
    const quests = await t.run((ctx) => questsForScholar(ctx, scholar));
    expect(quests.map((q) => String(q.unitId)).sort()).toEqual(
      [String(catalogUnit), String(authoredUnit)].sort(),
    );

    // …but the board lists the AUTHORED unit only (design §4).
    const asTeacher = await withUser(t, teacher);
    const board = await asTeacher.query(api.units.listScholarAuthored, {});
    const boardUnitIds = board.map((u: { _id: Id<"units"> }) => String(u._id));
    expect(boardUnitIds).toContain(String(authoredUnit));
    expect(boardUnitIds).not.toContain(String(catalogUnit));
  });
});
