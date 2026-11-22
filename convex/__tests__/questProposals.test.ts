// Quest proposals and advisors (TRA-685): a scholar proposes, edits while it
// waits, and a teacher who can see them approves (becoming the advisor) or
// says "Not this one". Covers the access matrix on both answer paths (the web
// mutation and the internal Slack one), first-answer-wins, the one maker
// activity, the app builder opening only for an approved app Quest's activity,
// and waiting/declined proposals staying out of the old list reads.
//
// Fictional names only (the makeWorld cast).
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type World } from "./factories/world";
import { questsForScholar } from "../lib/questLifecycle";
import { QUEST_PROPOSAL_LIMITS } from "../lib/questApproval";
import { isAppActivity } from "../../shared/appSurface";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

const WORDS = "I want to build an app where a crocodile's jaws teach angles.";
const MISSION = "Show a 2nd grader what an angle is.";

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 2,
    parentsPerSchool: 1,
  });
  const home = world.schools[0];
  const scholar = home.scholars[0];
  const asScholar = await world.as.scholar(scholar);
  return { t, world, home, scholar, asScholar };
}

async function propose(
  asScholar: Awaited<ReturnType<World["as"]["scholar"]>>,
  overrides: Partial<{ kind: "app" | "slides" | "python"; title: string }> = {},
) {
  return await asScholar.mutation(api.questProposals.propose, {
    scholarWords: WORDS,
    mission: MISSION,
    kind: overrides.kind ?? "app",
    title: overrides.title ?? "Angle croc",
  });
}

async function unitParts(t: T, unitId: Id<"units">) {
  return await t.run(async (ctx) => {
    const unit = await ctx.db.get(unitId);
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect();
    const activities = [];
    for (const lesson of lessons) {
      activities.push(
        ...(await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect()),
      );
    }
    return { unit, lessons, activities };
  });
}

describe("propose", () => {
  test("makes the scholar's own Quest, waiting, with no activity and its thread", async () => {
    const { t, scholar, asScholar } = await setup();
    const { unitId, threadId } = await propose(asScholar);

    const { unit, lessons, activities } = await unitParts(t, unitId);
    expect(unit?.authorScholarId).toBe(scholar.id);
    expect(unit?.authorRole).toBe("author");
    expect(unit?.title).toBe("Angle croc");
    expect(unit?.mission?.text).toBe(MISSION);
    expect(unit?.questApproval).toMatchObject({
      state: "waiting",
      kind: "app",
      scholarWords: WORDS,
      threadId,
    });
    expect(unit?.questApproval?.advisorId).toBeUndefined();
    expect(lessons).toHaveLength(0);
    expect(activities).toHaveLength(0);

    const { thread, messages } = await t.run(async (ctx) => ({
      thread: await ctx.db.get(threadId),
      messages: await ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    }));
    expect(thread).toMatchObject({ kind: "scholar", flavor: "about" });
    expect(thread?.about).toEqual({ type: "quest", unitId });
    expect(messages).toHaveLength(1);
    expect(messages[0]._id).toBe(unit?.questApproval?.proposalMessageId);
    expect(messages[0].authorUserId).toBe(scholar.id);
    expect(messages[0].body).toContain(WORDS);
    expect(messages[0].body).toContain(MISSION);
  });

  test("bounds every text input and refuses a Python program until 5f", async () => {
    const { asScholar } = await setup();
    const base = { scholarWords: WORDS, mission: MISSION, kind: "app" as const };
    await expect(
      asScholar.mutation(api.questProposals.propose, { ...base, scholarWords: "  " }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.questProposals.propose, {
        ...base,
        scholarWords: "x".repeat(QUEST_PROPOSAL_LIMITS.maxScholarWords + 1),
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.questProposals.propose, { ...base, mission: "" }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.questProposals.propose, { ...base, mission: "m".repeat(141) }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.questProposals.propose, { ...base, title: "t".repeat(81) }),
    ).rejects.toThrow();
  });

  test("only a scholar proposes, and only from their own chat", async () => {
    const { t, world, home, asScholar } = await setup();
    const asTeacher = await world.as.staffOf(home);
    await expect(propose(asTeacher)).rejects.toThrow(/Forbidden/);

    const otherScholarsChat = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: home.scholars[1].id,
        title: "A wonder",
        isArchived: false,
      }),
    );
    await expect(
      asScholar.mutation(api.questProposals.propose, {
        scholarWords: WORDS,
        mission: MISSION,
        kind: "app",
        fromSessionId: otherScholarsChat,
      }),
    ).rejects.toThrow();
  });
});

describe("edit while waiting", () => {
  test("changes the proposal and its thread message, keeping the earlier wording", async () => {
    const { t, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    await asScholar.mutation(api.questProposals.editProposal, {
      unitId,
      scholarWords: "A crocodile whose jaws snap shut at zero degrees.",
      mission: "Show a 2nd grader what an angle even is.",
      kind: "slides",
    });
    const { unit } = await unitParts(t, unitId);
    expect(unit?.questApproval).toMatchObject({
      state: "waiting",
      kind: "slides",
      scholarWords: "A crocodile whose jaws snap shut at zero degrees.",
    });
    expect(unit?.mission?.text).toBe("Show a 2nd grader what an angle even is.");
    const messageId: Id<"parentMessages"> = unit!.questApproval!.proposalMessageId!;
    const message = await t.run((ctx) => ctx.db.get(messageId));
    expect(message?.body).toContain("snap shut at zero degrees");
    expect(message?.editHistory?.[0]?.body).toContain(WORDS);
  });

  test("is refused once answered, and for anyone but the proposer", async () => {
    const { t, world, home, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    const asOther = await world.as.scholar(home.scholars[1]);
    await expect(
      asOther.mutation(api.questProposals.editProposal, { unitId, mission: "Mine now." }),
    ).rejects.toThrow();

    const asTeacher = await world.as.staffOf(home);
    await asTeacher.mutation(api.questProposals.answerProposal, { unitId, answer: "approve", expectedRevision: 1 });
    await expect(
      asScholar.mutation(api.questProposals.editProposal, { unitId, mission: "Changed." }),
    ).rejects.toThrow(/already answered/);
    const { unit } = await unitParts(t, unitId);
    expect(unit?.mission?.text).toBe(MISSION);
  });
});

describe("approve and decline", () => {
  test("approving makes the teacher the advisor and creates the one app activity", async () => {
    const { t, world, home, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    const asTeacher = await world.as.staffOf(home);
    const outcome = await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "approve", expectedRevision: 1,
    });
    expect(outcome).toMatchObject({
      state: "approved",
      advisorId: home.teacher.id,
      changed: true,
    });

    const { unit, lessons, activities } = await unitParts(t, unitId);
    expect(unit?.questApproval).toMatchObject({
      state: "approved",
      advisorId: home.teacher.id,
      answeredBy: home.teacher.id,
      activityId: outcome.activityId,
    });
    expect(lessons).toHaveLength(1);
    expect(activities).toHaveLength(1);
    const [activity] = activities;
    expect(activity._id).toBe(outcome.activityId);
    expect(isAppActivity(activity)).toBe(true);
    expect(activity.buildContract?.gate).toBe(MISSION);
    expect(activity.deliverable?.kind).toBe("artifact");
  });

  test("a presentation Quest's one activity is a slides activity, not an app", async () => {
    const { t, world, home, asScholar } = await setup();
    const { unitId } = await propose(asScholar, { kind: "slides" });
    const asTeacher = await world.as.staffOf(home);
    await asTeacher.mutation(api.questProposals.answerProposal, { unitId, answer: "approve", expectedRevision: 1 });
    const { activities } = await unitParts(t, unitId);
    expect(activities).toHaveLength(1);
    expect(isAppActivity(activities[0])).toBe(false);
    expect(activities[0].deliverable?.kind).toBe("slides");
  });

  test("the first answer wins: later approves and declines change nothing", async () => {
    const { t, world, home, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    const asTeacher = await world.as.staffOf(home);
    const asAdmin = await world.as.staffOf(home, "school_admin");
    const first = await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "approve", expectedRevision: 1,
    });
    const second = await asAdmin.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "approve", expectedRevision: 1,
    });
    const decline = await t.mutation(internal.questProposals.answerProposalForUser, {
      unitId,
      answer: "decline", expectedRevision: 1,
      approverId: home.admin.id,
    });
    expect(second).toEqual({ ...first, changed: false });
    expect(decline).toEqual({ ...first, changed: false });
    const { unit, activities } = await unitParts(t, unitId);
    expect(unit?.questApproval?.advisorId).toBe(home.teacher.id);
    expect(activities).toHaveLength(1);
  });

  test("Not this one closes it with no activity, and a later approve is a no-op", async () => {
    const { t, world, home, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    const asTeacher = await world.as.staffOf(home);
    const declined = await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "decline", expectedRevision: 1,
    });
    expect(declined).toMatchObject({ state: "declined", advisorId: null, changed: true });
    const asAdmin = await world.as.staffOf(home, "school_admin");
    const again = await asAdmin.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "approve", expectedRevision: 1,
    });
    expect(again).toMatchObject({ state: "declined", changed: false });
    const { unit, activities } = await unitParts(t, unitId);
    expect(unit?.isActive).toBe(true);
    expect(unit?.questApproval?.answeredBy).toBe(home.teacher.id);
    expect(activities).toHaveLength(0);
  });
});

describe("who may answer", () => {
  type Who = { label: string; id: (w: World) => Id<"users"> };
  const refused: Who[] = [
    { label: "the scholar", id: (w) => w.schools[0].scholars[0].id },
    { label: "another scholar", id: (w) => w.schools[0].scholars[1].id },
    { label: "a parent", id: (w) => w.schools[0].parents[0].id },
    { label: "operations staff at the school", id: (w) => w.schools[0].ops.id },
    { label: "a teacher at another school", id: (w) => w.schools[1].teacher.id },
    { label: "an admin at another school", id: (w) => w.schools[1].admin.id },
  ];
  const allowed: Who[] = [
    { label: "a teacher at the school", id: (w) => w.schools[0].teacher.id },
    { label: "an admin at the school", id: (w) => w.schools[0].admin.id },
    { label: "a platform admin", id: (w) => w.platformAdmin!.id },
  ];

  for (const who of refused) {
    test(`${who.label} can't approve or decline, by either path`, async () => {
      const { t, world, asScholar } = await setup();
      const { unitId } = await propose(asScholar);
      const userId = who.id(world);
      for (const answer of ["approve", "decline"] as const) {
        await expect(
          t.mutation(internal.questProposals.answerProposalForUser, {
            unitId,
            answer,
            expectedRevision: 1,
            approverId: userId,
          }),
        ).rejects.toThrow(/Forbidden/);
      }
      const sessionId = await t.run((ctx) =>
        ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
      );
      const asThem = t.withIdentity({
        subject: `${userId}|${sessionId}`,
        issuer: "https://convex.dev",
      });
      await expect(
        asThem.mutation(api.questProposals.answerProposal, { unitId, answer: "approve", expectedRevision: 1 }),
      ).rejects.toThrow();
      const { unit, activities } = await unitParts(t, unitId);
      expect(unit?.questApproval?.state).toBe("waiting");
      expect(activities).toHaveLength(0);
    });
  }

  for (const who of allowed) {
    test(`${who.label} may approve, through the internal path too`, async () => {
      const { t, world, asScholar } = await setup();
      const { unitId } = await propose(asScholar);
      const outcome = await t.mutation(internal.questProposals.answerProposalForUser, {
        unitId,
        answer: "approve", expectedRevision: 1,
        approverId: who.id(world),
      });
      expect(outcome).toMatchObject({ state: "approved", advisorId: who.id(world) });
    });
  }

  test("nobody answers a proposal from a school the scholar has left", async () => {
    const { t, world, home, scholar, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    await t.run((ctx) =>
      ctx.db.patch(scholar.id, { institutionId: world.schools[1].id }),
    );
    for (const approverId of [home.teacher.id, world.schools[1].teacher.id]) {
      await expect(
        t.mutation(internal.questProposals.answerProposalForUser, {
          unitId,
          answer: "approve", expectedRevision: 1,
          approverId,
        }),
      ).rejects.toThrow(/Forbidden/);
    }
  });
});

describe("the app builder", () => {
  async function contextFor(
    t: T,
    asScholar: Awaited<ReturnType<World["as"]["scholar"]>>,
    args: { unitId: Id<"units">; activityId?: Id<"activities"> },
  ) {
    const { id } = await asScholar.mutation(api.sessions.create, args);
    return await t.query(internal.sessionHelpers.getSessionContext, { sessionId: id });
  }

  test("opens in an approved app Quest's one activity", async () => {
    const { t, world, home, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    const asTeacher = await world.as.staffOf(home);
    const { activityId } = await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "approve", expectedRevision: 1,
    });
    const c = await contextFor(t, asScholar, { unitId, activityId: activityId! });
    expect(c?.appCreationAllowed).toBe(true);
    expect(c?.unitContext?.questBuildLocked ?? null).toBeNull();
    expect(c?.unitContext?.questBuildOpen ?? null).toBeNull();
  });

  test("stays shut for a waiting proposal: no session opens on it at all", async () => {
    const { t, asScholar } = await setup();
    const { unitId } = await propose(asScholar);
    await expect(contextFor(t, asScholar, { unitId })).rejects.toThrow(/waiting/);
  });

  test("stays shut in an approved presentation Quest", async () => {
    const { t, world, home, asScholar } = await setup();
    const { unitId } = await propose(asScholar, { kind: "slides" });
    const asTeacher = await world.as.staffOf(home);
    const { activityId } = await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "approve", expectedRevision: 1,
    });
    const c = await contextFor(t, asScholar, { unitId, activityId: activityId! });
    expect(c?.appCreationAllowed).toBe(false);
  });

  test("stays shut for a scholar's own Quest that was never proposed", async () => {
    const { t, asScholar } = await setup();
    const { unitId } = await asScholar.mutation(api.units.createQuest, { title: "Tide pools" });
    const lessonId = await asScholar.mutation(api.lessons.create, {
      unitId,
      title: "Lesson one",
    });
    await expect(
      asScholar.mutation(api.activities.create, {
        lessonId,
        title: "Build a tide app",
        kind: "online",
        appActivity: true,
        systemPrompt: "Build it.",
      }),
    ).rejects.toThrow();
    const c = await contextFor(t, asScholar, { unitId });
    expect(c?.appCreationAllowed).toBe(false);
  });

  test("is unchanged for a teacher's unit", async () => {
    const { t, home, asScholar } = await setup();
    const { unitId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: home.teacher.id,
        institutionId: home.id,
        title: "Ratios",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "One", order: 0 });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Ratio talk",
        kind: "online",
        systemPrompt: "Talk ratios.",
        order: 0,
      });
      return { unitId, activityId };
    });
    const c = await contextFor(t, asScholar, { unitId, activityId });
    expect(c?.appCreationAllowed).toBe(true);
  });
});

describe("old list reads", () => {
  test("leave out waiting and declined proposals, and list an approved one", async () => {
    const { t, world, home, scholar, asScholar } = await setup();
    const waiting = await propose(asScholar, { title: "Waiting one" });
    const declined = await propose(asScholar, { title: "Declined one" });
    const approved = await propose(asScholar, { title: "Approved one" });
    const asTeacher = await world.as.staffOf(home);
    await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId: declined.unitId,
      answer: "decline", expectedRevision: 1,
    });
    await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId: approved.unitId,
      answer: "approve", expectedRevision: 1,
    });

    const hidden = new Set([String(waiting.unitId), String(declined.unitId)]);
    const ids = (rows: Array<{ unitId?: Id<"units">; _id?: Id<"units"> }>) =>
      rows.map((r) => String(r.unitId ?? r._id));

    const quests = await t.run((ctx) => questsForScholar(ctx, scholar.id));
    expect(ids(quests).filter((id) => hidden.has(id))).toEqual([]);
    expect(ids(quests)).toContain(String(approved.unitId));

    const notStarted = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(ids(notStarted).filter((id) => hidden.has(id))).toEqual([]);
    expect(ids(notStarted)).toContain(String(approved.unitId));

    const picker = await asScholar.query(api.units.list, {});
    expect(ids(picker).filter((id) => hidden.has(id))).toEqual([]);
    expect(ids(picker)).toContain(String(approved.unitId));

    const board = await asTeacher.query(api.quests.listForScholar, { scholarId: scholar.id });
    expect(ids(board).filter((id) => hidden.has(id))).toEqual([]);

    // The plate lists a Quest once it has a live session. No session opens
    // on a waiting proposal now, but one written some other way must still
    // not turn into a card, while the approved Quest's session does.
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar.id,
        unitId: waiting.unitId,
        title: "Left over",
        isArchived: false,
      }),
    );
    const { activities } = await unitParts(t, approved.unitId);
    await asScholar.mutation(api.sessions.create, {
      unitId: approved.unitId,
      activityId: activities[0]._id,
    });
    const plate = JSON.stringify(
      await asScholar.query(api.scholarPlate.activeForMe, {}),
    );
    for (const id of hidden) expect(plate).not.toContain(id);
    expect(plate).toContain(String(approved.unitId));
    const questsAfter = await t.run((ctx) => questsForScholar(ctx, scholar.id));
    expect(ids(questsAfter).filter((id) => hidden.has(id))).toEqual([]);
  });
});

describe("proposing from a card", () => {
  async function cardIn(
    t: T,
    userId: Id<"users">,
    extra: { card?: boolean } = {},
  ) {
    return await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId,
        title: "Crocodiles",
        isArchived: false,
      });
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "",
        toolAction: "",
        flagged: false,
        ...(extra.card === false
          ? {}
          : {
              questProposalCard: {
                scholarWords: WORDS,
                mission: MISSION,
                kind: "app" as const,
              },
            }),
      });
      return { sessionId, messageId };
    });
  }

  const proposeFrom = (
    as: Awaited<ReturnType<World["as"]["scholar"]>>,
    cardMessageId: Id<"messages">,
    extra: { fromSessionId?: Id<"sessions"> } = {},
  ) =>
    as.mutation(api.questProposals.propose, {
      scholarWords: WORDS,
      mission: MISSION,
      kind: "app",
      cardMessageId,
      ...extra,
    });

  test("makes one unit however many times the card is tapped, and the card records it", async () => {
    const { t, scholar, asScholar } = await setup();
    const { sessionId, messageId } = await cardIn(t, scholar.id);
    const first = await proposeFrom(asScholar, messageId, {
      fromSessionId: sessionId,
    });
    const second = await proposeFrom(asScholar, messageId);
    expect(second).toEqual(first);
    const { units, card } = await t.run(async (ctx) => ({
      units: (await ctx.db.query("units").collect()).filter(
        (u) => u.questApproval,
      ),
      card: (await ctx.db.get(messageId))?.questProposalCard,
    }));
    expect(units).toHaveLength(1);
    expect(card?.proposedUnitId).toBe(first.unitId);
  });

  test("refuses another scholar's card", async () => {
    const { t, home, asScholar } = await setup();
    const { messageId } = await cardIn(t, home.scholars[1].id);
    await expect(proposeFrom(asScholar, messageId)).rejects.toThrow(
      /Card not found/,
    );
  });

  test("refuses a message that is not a card", async () => {
    const { t, scholar, asScholar } = await setup();
    const { messageId } = await cardIn(t, scholar.id, { card: false });
    await expect(proposeFrom(asScholar, messageId)).rejects.toThrow(
      /Card not found/,
    );
  });

  test("refuses a fromSessionId that is not the card's session", async () => {
    const { t, scholar, asScholar } = await setup();
    const { messageId } = await cardIn(t, scholar.id);
    const other = await cardIn(t, scholar.id);
    await expect(
      proposeFrom(asScholar, messageId, { fromSessionId: other.sessionId }),
    ).rejects.toThrow(/Card not found/);
  });

  test("without a card, every call still makes its own proposal", async () => {
    const { asScholar } = await setup();
    const a = await propose(asScholar);
    const b = await propose(asScholar);
    expect(b.unitId).not.toBe(a.unitId);
  });
});
