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
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
  weekdayForDayKey,
} from "../../shared/institutionDay";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

function nextWeekday(dayKey: string) {
  let candidate = dayKey;
  do {
    candidate = shiftDayKey(candidate, 1);
  } while (weekdayForDayKey(candidate) === 0 || weekdayForDayKey(candidate) === 6);
  return candidate;
}

async function seedPlanWorld(t: ReturnType<typeof convexTest>) {
  const institutionId = await seedTestInstitution(t, { slug: "take-home-school" });
  await t.run((ctx) =>
    ctx.db.patch(institutionId, { timeZone: TIME_ZONE }),
  );
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    name: "Lehua Torres",
    username: "take-home-teacher",
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
    username: "take-home-scholar",
  });
  const unitId = await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Tide pools",
      isActive: true,
    }),
  );
  const lessonId = await t.run((ctx) =>
    ctx.db.insert("lessons", { unitId, title: "Patterns", order: 0 }),
  );
  const homeworkActivityId = await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId,
      title: "Moon journal",
      kind: "online",
      order: 0,
    }),
  );
  const suggestedActivityId = await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId,
      title: "Sketch a shoreline",
      kind: "online",
      order: 1,
    }),
  );
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      lessonId,
      activityId: suggestedActivityId,
      title: "Shoreline ideas",
      isArchived: false,
    }),
  );
  const today = dayKeyForTimezone(Date.now(), TIME_ZONE);
  const dueAt = dayStartForDayKey(nextWeekday(today), TIME_ZONE) + 12 * 60 * 60_000;
  await t.run((ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now() - 60_000,
      activitySchedule: [
        {
          activityId: homeworkActivityId,
          mode: "homework",
          setAt: Date.now() - 60_000,
          dueAt,
        },
      ],
    }),
  );

  const questUnitId = await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId,
      institutionId,
      authorScholarId: scholarId,
      title: "Coral colors",
      isActive: true,
    }),
  );
  const questLessonId = await t.run((ctx) =>
    ctx.db.insert("lessons", { unitId: questUnitId, title: "Light", order: 0 }),
  );
  await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId: questLessonId,
      title: "Compare pigments",
      kind: "online",
      order: 0,
    }),
  );
  const questSessionId = await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      unitId: questUnitId,
      lessonId: questLessonId,
      title: "Coral questions",
      isArchived: false,
    }),
  );

  return {
    institutionId,
    scholarId,
    unitId,
    homeworkActivityId,
    suggestedActivityId,
    sessionId,
    questUnitId,
    questSessionId,
  };
}

describe("takeHomePlans", () => {
  test("does not add a dormant Quest before it has a session to open", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    const dormantUnitId = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: world.scholarId,
        institutionId: world.institutionId,
        authorScholarId: world.scholarId,
        title: "Cloud atlas",
        isActive: true,
      }),
    );
    const asScholar = await withUser(t, world.scholarId);

    await expect(
      asScholar.mutation(api.takeHomePlans.addSuggestion, {
        suggestion: { kind: "quest", unitId: dormantUnitId },
      }),
    ).rejects.toThrow(/no longer available/i);
  });

  test("derives assigned work and hypotheses without storing assigned homework", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    const asScholar = await withUser(t, world.scholarId);

    await expect(
      t.query(api.takeHomePlans.forSelf, { now: Date.now() }),
    ).rejects.toThrow();
    const plan = await asScholar.query(api.takeHomePlans.forSelf, {
      now: Date.now(),
    });

    expect(plan.dayKey).toBe(dayKeyForTimezone(Date.now(), TIME_ZONE));
    expect(plan).toMatchObject({ isPrimary: false, printsTonight: false });
    expect(plan.assigned).toMatchObject([
      {
        activityId: world.homeworkActivityId,
        label: "Moon journal",
        activityKind: "online",
      },
    ]);
    expect(plan.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "activity",
          sessionId: world.sessionId,
          activityId: world.suggestedActivityId,
        }),
        expect.objectContaining({
          kind: "quest",
          unitId: world.questUnitId,
          sessionId: world.questSessionId,
        }),
      ]),
    );
    expect(plan.suggestions[0]).toMatchObject({
      kind: "quest",
      unitId: world.questUnitId,
    });
    expect(
      await t.run((ctx) => ctx.db.query("takeHomePlanItems").collect()),
    ).toHaveLength(0);
  });

  test("only suggests activities touched today while keeping open Quests actionable", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    const asScholar = await withUser(t, world.scholarId);
    const tomorrow = shiftDayKey(
      dayKeyForTimezone(Date.now(), TIME_ZONE),
      1,
    );

    const plan = await asScholar.query(api.takeHomePlans.forSelf, {
      now: dayStartForDayKey(tomorrow, TIME_ZONE) + 12 * 60 * 60_000,
    });

    expect(plan.suggestions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "activity",
          sessionId: world.sessionId,
        }),
      ]),
    );
    expect(plan.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "quest",
          unitId: world.questUnitId,
          sessionId: world.questSessionId,
        }),
      ]),
    );
  });

  test("records scholar actions, returns removed work to suggestions, and supports completion undo", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    const asScholar = await withUser(t, world.scholarId);

    const activityItemId = await asScholar.mutation(api.takeHomePlans.addSuggestion, {
      suggestion: { kind: "activity", sessionId: world.sessionId },
    });
    await expect(
      asScholar.mutation(api.takeHomePlans.addSuggestion, {
        suggestion: { kind: "activity", sessionId: world.sessionId },
      }),
    ).rejects.toThrow(/no longer available/i);
    await asScholar.mutation(api.takeHomePlans.markActivityDone, {
      itemId: activityItemId,
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_activity", (q) =>
            q.eq("scholarId", world.scholarId).eq("activityId", world.suggestedActivityId),
          )
          .collect(),
      ),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_activity", (q) =>
            q.eq("scholarId", world.scholarId).eq("activityId", world.suggestedActivityId),
          )
          .unique(),
      ),
    ).toMatchObject({
      source: "scholar_home",
      action: "scholar_marked_take_home_done",
    });
    await asScholar.mutation(api.takeHomePlans.undoMarkActivityDone, {
      itemId: activityItemId,
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_activity", (q) =>
            q.eq("scholarId", world.scholarId).eq("activityId", world.suggestedActivityId),
          )
          .collect(),
      ),
    ).toHaveLength(0);
    await asScholar.mutation(api.takeHomePlans.removeItem, { itemId: activityItemId });
    expect(
      (await asScholar.query(api.takeHomePlans.forSelf, { now: Date.now() })).suggestions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "activity", sessionId: world.sessionId }),
      ]),
    );

    const noteId = await asScholar.mutation(api.takeHomePlans.addNote, {
      text: "  Pack colored pencils.  ",
    });
    await asScholar.mutation(api.takeHomePlans.editNote, {
      itemId: noteId,
      text: "Pack field notebook.",
    });
    await asScholar.mutation(api.takeHomePlans.setNoteChecked, {
      itemId: noteId,
      checked: true,
    });
    await asScholar.mutation(api.takeHomePlans.removeItem, { itemId: noteId });
    expect(await t.run((ctx) => ctx.db.get(noteId))).toBeNull();

    const removedQuestItemId = await asScholar.mutation(api.takeHomePlans.addSuggestion, {
      suggestion: { kind: "quest", unitId: world.questUnitId },
    });
    await asScholar.mutation(api.takeHomePlans.removeItem, {
      itemId: removedQuestItemId,
    });
    expect(
      (await asScholar.query(api.takeHomePlans.forSelf, { now: Date.now() }))
        .suggestions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "quest", unitId: world.questUnitId }),
      ]),
    );
    const questItemId = await asScholar.mutation(api.takeHomePlans.addSuggestion, {
      suggestion: { kind: "quest", unitId: world.questUnitId },
    });
    await asScholar.mutation(api.takeHomePlans.closeQuest, { itemId: questItemId });
    expect(await t.run((ctx) => ctx.db.get(world.questSessionId))).toMatchObject({
      isArchived: true,
    });
    expect(
      await t.run((ctx) => ctx.db.query("scholarUnitBadges").collect()),
    ).toHaveLength(0);
    await asScholar.mutation(api.takeHomePlans.undoCloseQuest, {
      itemId: questItemId,
    });

    expect(await t.run((ctx) => ctx.db.get(world.questSessionId))).toMatchObject({
      isArchived: false,
    });

    const plan = await asScholar.query(api.takeHomePlans.forSelf, { now: Date.now() });
    expect(plan.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "quest",
          unitId: world.questUnitId,
          checked: false,
        }),
      ]),
    );
    expect(plan.selected).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "note", text: "Pack field notebook." }),
      ]),
    );
  });

  test("caps suggestions at three cards", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    await t.run(async (ctx) => {
      const lessonId = (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", world.unitId))
          .first()
      )!._id;
      for (let i = 0; i < 4; i += 1) {
        const activityId = await ctx.db.insert("activities", {
          lessonId,
          title: `Extra idea ${i}`,
          kind: "online",
          order: i + 10,
        });
        await ctx.db.insert("sessions", {
          userId: world.scholarId,
          unitId: world.unitId,
          lessonId,
          activityId,
          title: `Extra session ${i}`,
          isArchived: false,
        });
      }
    });
    const asScholar = await withUser(t, world.scholarId);

    const plan = await asScholar.query(api.takeHomePlans.forSelf, {
      now: Date.now(),
    });

    expect(plan.suggestions).toHaveLength(3);
  });

  test("atomically resolves suggestions and restores exactly its own outcome on undo", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    const asScholar = await withUser(t, world.scholarId);

    const activity = await asScholar.mutation(api.takeHomePlans.resolveSuggestion, {
      suggestion: { kind: "activity", sessionId: world.sessionId },
    });
    expect(activity).toMatchObject({ kind: "activity", undoAvailable: true });
    const plan = await asScholar.query(api.takeHomePlans.forSelf, { now: Date.now() });
    expect(plan.selected).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activityId: world.suggestedActivityId }),
      ]),
    );
    expect(plan.resolvedToday).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: activity.itemId, kind: "activity", actions: ["undo"] }),
      ]),
    );
    expect(plan.suggestions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "activity",
          sessionId: world.sessionId,
        }),
      ]),
    );
    await asScholar.mutation(api.takeHomePlans.undoResolveSuggestion, {
      itemId: activity.itemId,
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_activity", (q) =>
            q.eq("scholarId", world.scholarId).eq("activityId", world.suggestedActivityId),
          )
          .collect(),
      ),
    ).toHaveLength(0);

    const quest = await asScholar.mutation(api.takeHomePlans.resolveSuggestion, {
      suggestion: { kind: "quest", unitId: world.questUnitId },
    });
    expect(quest).toMatchObject({ kind: "quest", undoAvailable: true });
    expect(await t.run((ctx) => ctx.db.get(world.questSessionId))).toMatchObject({
      isArchived: true,
    });
    expect(await t.run((ctx) => ctx.db.query("scholarUnitBadges").collect())).toHaveLength(0);
    await asScholar.mutation(api.takeHomePlans.undoResolveSuggestion, {
      itemId: quest.itemId,
    });
    expect(await t.run((ctx) => ctx.db.get(world.questSessionId))).toMatchObject({
      isArchived: false,
    });
  });

  test("idempotently adds a present Quest and recreates it after removal", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    const asScholar = await withUser(t, world.scholarId);

    const itemId = await asScholar.mutation(api.takeHomePlans.addSessionToPlan, {
      sessionId: world.questSessionId,
    });
    expect(await t.run((ctx) => ctx.db.get(itemId))).toMatchObject({
      kind: "quest",
      unitId: world.questUnitId,
      sessionId: world.questSessionId,
    });
    expect(
      await asScholar.mutation(api.takeHomePlans.addSessionToPlan, {
        sessionId: world.questSessionId,
      }),
    ).toBe(itemId);
    await asScholar.mutation(api.takeHomePlans.removeItem, { itemId });
    const replacementItemId = await asScholar.mutation(
      api.takeHomePlans.addSessionToPlan,
      { sessionId: world.questSessionId },
    );
    expect(replacementItemId).not.toBe(itemId);
    expect(await t.run((ctx) => ctx.db.get(itemId))).toBeNull();
  });

  test("returns narrow Quest pins and starts canonical teacher suggestions in today's plan", async () => {
    const t = convexTest(schema, modules);
    const world = await seedPlanWorld(t);
    const { selectedSeedId } = await t.run(async (ctx) => {
      const selectedSeedId = await ctx.db.insert("seeds", {
        scholarId: world.scholarId,
        origin: "teacher",
        status: "active",
        topic: "Tide-pool Quest",
        suggestionType: "teacher_suggestion",
        rationale: "Teacher-only diagnostic detail",
        scholarInvitation: "Trace one pattern in the tide pools.",
        unitId: world.unitId,
      });
      return { selectedSeedId };
    });
    const asScholar = await withUser(t, world.scholarId);

    const before = await asScholar.query(api.takeHomePlans.forSelf, { now: Date.now() });
    expect(before).not.toHaveProperty("newQuestCandidates");

    const started = await asScholar.mutation(api.takeHomePlans.startSeedInPlan, {
      seedId: selectedSeedId,
    });
    expect(started.kind).toBe("quest");
    expect(await t.run((ctx) => ctx.db.get(started.itemId))).toMatchObject({
      kind: "quest",
      unitId: world.unitId,
      sessionId: started.sessionId,
    });
    const pins = await asScholar.query(api.takeHomePlans.pinningForSelf, { now: Date.now() });
    expect(pins).toMatchObject({
      dayKey: dayKeyForTimezone(Date.now(), TIME_ZONE),
      pins: [{ itemId: started.itemId, unitId: world.unitId, sessionId: started.sessionId }],
    });
  });

  test("does not let a scholar mutate another institution's plan item", async () => {
    const t = convexTest(schema, modules);
    const first = await seedPlanWorld(t);
    const secondInstitutionId = await seedTestInstitution(t, {
      slug: "other-take-home-school",
    });
    const secondScholarId = await seedScholarInInstitution(t, {
      institutionId: secondInstitutionId,
      name: "Avery Stone",
      username: "other-take-home-scholar",
    });
    const asFirst = await withUser(t, first.scholarId);
    const asSecond = await withUser(t, secondScholarId);
    const itemId = await asFirst.mutation(api.takeHomePlans.addNote, {
      text: "Private note",
    });

    await expect(asSecond.mutation(api.takeHomePlans.removeItem, { itemId })).rejects.toThrow(
      /plan item not found/i,
    );
  });
});
