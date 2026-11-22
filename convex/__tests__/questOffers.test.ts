// A teacher's offer (TRA-696): a Quest that arrives already approved. Covers
// who may offer (both entry points, one rule), the idempotent ideaKey, the
// scholar starting it (one maker activity, the teacher kept as advisor) or
// setting it aside, every place an offer is treated like a waiting proposal
// (no session, no classmate, no assignment, out of the old list reads, no app
// before start), and the scholar's own read.
//
// Fictional names only (the makeWorld cast).
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type World } from "./factories/world";
import { questsForScholar } from "../lib/questLifecycle";
import { assertProposedQuestRecipients } from "../lib/questStructure";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

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
  const asTeacher = await world.as.staffOf(home);
  return { t, world, home, scholar, asScholar, asTeacher };
}

function offerArgs(
  scholarId: Id<"users">,
  overrides: Partial<{
    kind: "app" | "slides" | "python";
    title: string;
    mission: string;
    ideaKey: string;
  }> = {},
) {
  return {
    scholarId,
    kind: overrides.kind ?? ("app" as const),
    mission: overrides.mission ?? MISSION,
    title: overrides.title ?? "Angle croc",
    ...(overrides.ideaKey ? { ideaKey: overrides.ideaKey } : {}),
  };
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

async function unitsOf(t: T, scholarId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("units")
      .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
      .collect(),
  );
}

describe("offering", () => {
  test("makes the scholar's own Quest, offered, with the teacher as advisor and no activity", async () => {
    const { t, home, scholar, asTeacher } = await setup();
    const { unitId, threadId, created } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    expect(created).toBe(true);

    const { unit, lessons, activities } = await unitParts(t, unitId);
    expect(unit?.authorScholarId).toBe(scholar.id);
    expect(unit?.institutionId).toBe(home.id);
    expect(unit?.isActive).toBe(true);
    expect(unit?.title).toBe("Angle croc");
    expect(unit?.mission?.text).toBe(MISSION);
    expect(unit?.questApproval).toMatchObject({
      state: "offered",
      kind: "app",
      advisorId: home.teacher.id,
      offeredBy: home.teacher.id,
      revision: 1,
      threadId,
    });
    expect(unit?.questApproval?.offeredAt).toBeTypeOf("number");
    expect(lessons).toHaveLength(0);
    expect(activities).toHaveLength(0);
  });

  test("opens the Quest's thread with one line from the teacher, not counted as a reply", async () => {
    const { t, home, scholar, asScholar, asTeacher } = await setup();
    const { unitId, threadId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const { messages, thread } = await t.run(async (ctx) => ({
      messages: await ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
      thread: await ctx.db.get(threadId),
    }));
    expect(messages).toHaveLength(1);
    expect(messages[0].authorType).toBe("teacher");
    expect(messages[0].authorUserId).toBe(home.teacher.id);
    expect(messages[0].body).toBe(
      `${home.teacher.name} picked this Quest for you: ${MISSION}`,
    );
    // No staff read marker moved for a line a staff action wrote itself.
    expect(thread?.lastReadByTeacherAt).toBeUndefined();

    const { offered } = await asScholar.query(api.questProposals.forSelf, {});
    expect(offered).toHaveLength(1);
    expect(offered[0].unitId).toBe(unitId);
    expect(offered[0].reply).toBeNull();
  });

  test("bounds every text input", async () => {
    const { scholar, asTeacher } = await setup();
    const offer = (args: ReturnType<typeof offerArgs>) =>
      asTeacher.mutation(api.questProposals.offerQuest, args);
    await expect(offer(offerArgs(scholar.id, { mission: "  " }))).rejects.toThrow();
    await expect(
      offer(offerArgs(scholar.id, { mission: "m".repeat(141) })),
    ).rejects.toThrow();
    await expect(
      offer(offerArgs(scholar.id, { title: "t".repeat(81) })),
    ).rejects.toThrow();
    await expect(
      offer(offerArgs(scholar.id, { ideaKey: "k".repeat(201) })),
    ).rejects.toThrow();
  });

  test("an empty title falls back to the mission", async () => {
    const { t, scholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { title: "  " }),
    );
    const { unit } = await unitParts(t, unitId);
    expect(unit?.title).toBe(MISSION);
  });
});

describe("who may offer", () => {
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
    test(`${who.label} can't offer, by either path`, async () => {
      const { t, world, scholar } = await setup();
      const userId = who.id(world);
      await expect(
        t.mutation(internal.questProposals.offerQuestForUser, {
          ...offerArgs(scholar.id),
          offererId: userId,
        }),
      ).rejects.toThrow(/Forbidden/);
      const sessionId = await t.run((ctx) =>
        ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
      );
      const asThem = t.withIdentity({
        subject: `${userId}|${sessionId}`,
        issuer: "https://convex.dev",
      });
      await expect(
        asThem.mutation(api.questProposals.offerQuest, offerArgs(scholar.id)),
      ).rejects.toThrow();
      expect(await unitsOf(t, scholar.id)).toHaveLength(0);
    });
  }

  for (const who of allowed) {
    test(`${who.label} may offer, through the internal path too`, async () => {
      const { t, world, scholar } = await setup();
      const outcome = await t.mutation(internal.questProposals.offerQuestForUser, {
        ...offerArgs(scholar.id),
        offererId: who.id(world),
      });
      expect(outcome.created).toBe(true);
      const { unit } = await unitParts(t, outcome.unitId);
      expect(unit?.questApproval).toMatchObject({
        state: "offered",
        advisorId: who.id(world),
      });
    });
  }

  test("a read-only teacher can't offer, by either path", async () => {
    const { t, home, scholar, asTeacher } = await setup();
    await t.run((ctx) => ctx.db.patch(home.teacher.id, { readOnly: true }));
    await expect(
      t.mutation(internal.questProposals.offerQuestForUser, {
        ...offerArgs(scholar.id),
        offererId: home.teacher.id,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asTeacher.mutation(api.questProposals.offerQuest, offerArgs(scholar.id)),
    ).rejects.toThrow();
    expect(await unitsOf(t, scholar.id)).toHaveLength(0);
  });

  test("an unknown or non-scholar target reads the same as a refusal", async () => {
    const { home, asTeacher } = await setup();
    await expect(
      asTeacher.mutation(api.questProposals.offerQuest, offerArgs(home.teacher.id)),
    ).rejects.toThrow(/Forbidden/);
  });

  test("nobody offers a scholar who has left the school", async () => {
    const { t, world, home, scholar } = await setup();
    await t.run((ctx) => ctx.db.patch(scholar.id, { institutionId: world.schools[1].id }));
    await expect(
      t.mutation(internal.questProposals.offerQuestForUser, {
        ...offerArgs(scholar.id),
        offererId: home.teacher.id,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("ideaKey", () => {
  test("a repeated tap returns the same offer and makes no second unit", async () => {
    const { t, scholar, asTeacher } = await setup();
    const args = offerArgs(scholar.id, { ideaKey: "idea-1" });
    const first = await asTeacher.mutation(api.questProposals.offerQuest, args);
    const second = await asTeacher.mutation(api.questProposals.offerQuest, args);
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(await unitsOf(t, scholar.id)).toHaveLength(1);
    const messages = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", first.threadId))
        .collect(),
    );
    expect(messages).toHaveLength(1);
  });

  test("another teacher's tap of the same key is the same offer; another key or scholar is a new one", async () => {
    const { t, world, home, scholar, asTeacher } = await setup();
    const asAdmin = await world.as.staffOf(home, "school_admin");
    const first = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { ideaKey: "idea-1" }),
    );
    const again = await asAdmin.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { ideaKey: "idea-1" }),
    );
    expect(again.unitId).toBe(first.unitId);
    const otherKey = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { ideaKey: "idea-2" }),
    );
    expect(otherKey.unitId).not.toBe(first.unitId);
    const otherScholar = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(home.scholars[1].id, { ideaKey: "idea-1" }),
    );
    expect(otherScholar.unitId).not.toBe(first.unitId);
    expect(await unitsOf(t, scholar.id)).toHaveLength(2);
  });

  test("a repeat after the scholar started it returns the same Quest, never a new one", async () => {
    const { t, scholar, asScholar, asTeacher } = await setup();
    const args = offerArgs(scholar.id, { ideaKey: "idea-1" });
    const first = await asTeacher.mutation(api.questProposals.offerQuest, args);
    await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId: first.unitId });
    const again = await asTeacher.mutation(api.questProposals.offerQuest, args);
    expect(again.unitId).toBe(first.unitId);
    expect(await unitsOf(t, scholar.id)).toHaveLength(1);
  });

  test("after a transfer, the same key at the new school is a new offer there", async () => {
    const { t, world, scholar, asTeacher } = await setup();
    const args = offerArgs(scholar.id, { ideaKey: "idea-1" });
    const atHome = await asTeacher.mutation(api.questProposals.offerQuest, args);
    await t.run((ctx) => ctx.db.patch(scholar.id, { institutionId: world.schools[1].id }));
    const asOther = await world.as.staffOf(world.schools[1]);
    const there = await asOther.mutation(api.questProposals.offerQuest, args);
    expect(there.created).toBe(true);
    expect(there.unitId).not.toBe(atHome.unitId);
    expect((await unitParts(t, there.unitId)).unit?.institutionId).toBe(world.schools[1].id);
    // And a repeat there is the school's own offer.
    const again = await asOther.mutation(api.questProposals.offerQuest, args);
    expect(again).toEqual({ ...there, created: false });
  });

  test("a refused caller learns nothing from a key that exists", async () => {
    const { t, world, scholar, asTeacher } = await setup();
    const args = offerArgs(scholar.id, { ideaKey: "idea-1" });
    await asTeacher.mutation(api.questProposals.offerQuest, args);
    await expect(
      t.mutation(internal.questProposals.offerQuestForUser, {
        ...args,
        offererId: world.schools[1].teacher.id,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("starting an offer", () => {
  test("approves it, keeps the teacher as advisor and makes exactly one app activity", async () => {
    const { t, home, asScholar, scholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const started = await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId });
    const { unit, lessons, activities } = await unitParts(t, unitId);
    expect(unit?.questApproval).toMatchObject({
      state: "approved",
      advisorId: home.teacher.id,
      offeredBy: home.teacher.id,
      activityId: started.activityId,
    });
    expect(lessons).toHaveLength(1);
    expect(activities).toHaveLength(1);
    expect(activities[0]._id).toBe(started.activityId);
    expect(activities[0].appActivity).toBe(true);
    expect(started.threadId).toBe(unit?.questApproval?.threadId);
  });

  test("a second start, or a double tap, makes nothing new", async () => {
    const { t, asScholar, scholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const [a, b] = await Promise.all([
      asScholar.mutation(api.questProposals.startOfferedQuest, { unitId }),
      asScholar.mutation(api.questProposals.startOfferedQuest, { unitId }),
    ]);
    const later = await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId });
    expect(b.activityId).toBe(a.activityId);
    expect(later.activityId).toBe(a.activityId);
    const { activities, lessons } = await unitParts(t, unitId);
    expect(lessons).toHaveLength(1);
    expect(activities).toHaveLength(1);
  });

  test("makes a slides and a python maker for those kinds", async () => {
    const { t, asScholar, scholar, asTeacher } = await setup();
    for (const kind of ["slides", "python"] as const) {
      const { unitId } = await asTeacher.mutation(
        api.questProposals.offerQuest,
        offerArgs(scholar.id, { kind }),
      );
      await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId });
      const { activities } = await unitParts(t, unitId);
      expect(activities).toHaveLength(1);
      expect(activities[0].appActivity).toBeFalsy();
    }
  });

  test("only the offer's own scholar starts it, and only an offer", async () => {
    const { t, world, home, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const asClassmate = await world.as.scholar(home.scholars[1]);
    await expect(
      asClassmate.mutation(api.questProposals.startOfferedQuest, { unitId }),
    ).rejects.toThrow();
    await expect(
      asTeacher.mutation(api.questProposals.startOfferedQuest, { unitId }),
    ).rejects.toThrow(/Forbidden/);
    expect((await unitParts(t, unitId)).activities).toHaveLength(0);

    // A scholar's own proposal is not an offer: starting it is refused.
    const proposal = await asScholar.mutation(api.questProposals.propose, {
      scholarWords: "A crocodile that teaches angles.",
      mission: MISSION,
      kind: "app",
    });
    await expect(
      asScholar.mutation(api.questProposals.startOfferedQuest, { unitId: proposal.unitId }),
    ).rejects.toThrow(/not found/);
  });

  test("an offer set aside, or from a school the scholar has left, can't be started", async () => {
    const { t, world, scholar, asScholar, asTeacher } = await setup();
    const aside = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await asScholar.mutation(api.questProposals.setOfferAside, { unitId: aside.unitId });
    await expect(
      asScholar.mutation(api.questProposals.startOfferedQuest, { unitId: aside.unitId }),
    ).rejects.toThrow(/not found/);

    const moved = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { title: "Another" }),
    );
    await t.run((ctx) => ctx.db.patch(scholar.id, { institutionId: world.schools[1].id }));
    await expect(
      asScholar.mutation(api.questProposals.startOfferedQuest, { unitId: moved.unitId }),
    ).rejects.toThrow(/not found/);
  });

  test("after start the answer line still isn't a reply, and the Quest reads as approved", async () => {
    const { asScholar, scholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId });
    const read = await asScholar.query(api.questProposals.forSelf, {});
    expect(read.offered).toHaveLength(0);
    expect(read.approved).toHaveLength(1);
    expect(read.approved[0]).toMatchObject({ unitId, kind: "app", begun: false });
    expect(read.approved[0].reply).toBeNull();
    expect(read.approved[0].advisorName).toBeTruthy();
  });
});

describe("attribution", () => {
  test("a started offer reads as teacher-sourced, a proposal's Quest as the scholar's", async () => {
    const { t, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId });
    const proposal = await asScholar.mutation(api.questProposals.propose, {
      scholarWords: "A crocodile that teaches angles.",
      mission: MISSION,
      kind: "app",
    });
    await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId: proposal.unitId,
      answer: "approve",
      expectedRevision: 1,
    });
    const quests = await t.run((ctx) => questsForScholar(ctx, scholar.id));
    expect(quests.find((q) => q.unitId === unitId)?.source).toBe("teacher");
    expect(quests.find((q) => q.unitId === proposal.unitId)?.source).toBe("scholar");
  });
});

describe("setting an offer aside", () => {
  test("archives it: never declined, deleted or answered, and it leaves the offered list", async () => {
    const { t, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await asScholar.mutation(api.questProposals.setOfferAside, { unitId });
    await asScholar.mutation(api.questProposals.setOfferAside, { unitId });
    const { unit } = await unitParts(t, unitId);
    expect(unit?.isActive).toBe(false);
    expect(unit?.questApproval?.state).toBe("offered");
    const read = await asScholar.query(api.questProposals.forSelf, {});
    expect(read.offered).toHaveLength(0);
    expect(read.approved).toHaveLength(0);
  });

  test("only the offer's own scholar, and not a started Quest", async () => {
    const { t, world, home, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const asClassmate = await world.as.scholar(home.scholars[1]);
    await expect(
      asClassmate.mutation(api.questProposals.setOfferAside, { unitId }),
    ).rejects.toThrow();
    await expect(
      asTeacher.mutation(api.questProposals.setOfferAside, { unitId }),
    ).rejects.toThrow(/Forbidden/);
    expect((await unitParts(t, unitId)).unit?.isActive).toBe(true);

    await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId });
    await expect(
      asScholar.mutation(api.questProposals.setOfferAside, { unitId }),
    ).rejects.toThrow(/not found/);
    expect((await unitParts(t, unitId)).unit?.isActive).toBe(true);
  });
});

describe("an offer is treated like a waiting proposal", () => {
  test("no session opens on it, for the scholar or a classmate", async () => {
    const { world, home, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await expect(asScholar.mutation(api.sessions.create, { unitId })).rejects.toThrow();
    const asClassmate = await world.as.scholar(home.scholars[1]);
    await expect(asClassmate.mutation(api.sessions.create, { unitId })).rejects.toThrow();
  });

  test("a classmate can't open it even once the scholar has started it", async () => {
    const { world, home, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const { activityId } = await asScholar.mutation(api.questProposals.startOfferedQuest, {
      unitId,
    });
    const asClassmate = await world.as.scholar(home.scholars[1]);
    await expect(
      asClassmate.mutation(api.sessions.create, { unitId, activityId }),
    ).rejects.toThrow();
  });

  test("it reaches nobody by assignment or push", () => {
    const offered = {
      questApproval: { state: "offered" as const, kind: "app" as const, revision: 1 },
      authorScholarId: "scholar" as Id<"users">,
    };
    expect(() =>
      assertProposedQuestRecipients(offered, ["scholar" as Id<"users">]),
    ).toThrow();
    const started = {
      ...offered,
      questApproval: { ...offered.questApproval, state: "approved" as const },
    };
    expect(() =>
      assertProposedQuestRecipients(started, ["scholar" as Id<"users">]),
    ).not.toThrow();
    expect(() =>
      assertProposedQuestRecipients(started, ["classmate" as Id<"users">]),
    ).toThrow();
  });

  test("it takes no lesson or activity from anyone", async () => {
    const { scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await expect(
      asScholar.mutation(api.lessons.create, { unitId, title: "Mine" }),
    ).rejects.toThrow();
    await expect(
      asTeacher.mutation(api.lessons.create, { unitId, title: "Theirs" }),
    ).rejects.toThrow();
  });

  test("it stays out of the old list reads until started", async () => {
    const { t, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const ids = (rows: Array<{ unitId?: Id<"units">; _id?: Id<"units"> }>) =>
      rows.map((r) => String(r.unitId ?? r._id));
    const read = async () => ({
      quests: ids(await t.run((ctx) => questsForScholar(ctx, scholar.id))),
      notStarted: ids(await asScholar.query(api.units.myIndependentStudyUnits, {})),
      picker: ids(await asScholar.query(api.units.list, {})),
      board: ids(await asTeacher.query(api.quests.listForScholar, { scholarId: scholar.id })),
    });
    const before = await read();
    for (const list of Object.values(before)) expect(list).not.toContain(String(unitId));

    await asScholar.mutation(api.questProposals.startOfferedQuest, { unitId });
    const after = await read();
    expect(after.notStarted).toContain(String(unitId));
    expect(after.picker).toContain(String(unitId));
  });

  test("no app is built before it is started, and one is after, for an app offer", async () => {
    const { t, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await expect(asScholar.mutation(api.sessions.create, { unitId })).rejects.toThrow();

    const { activityId } = await asScholar.mutation(api.questProposals.startOfferedQuest, {
      unitId,
    });
    const { id } = await asScholar.mutation(api.sessions.create, { unitId, activityId });
    const c = await t.query(internal.sessionHelpers.getSessionContext, { sessionId: id });
    expect(c?.appCreationAllowed).toBe(true);
  });

  test("a slides offer never opens the app builder", async () => {
    const { t, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { kind: "slides" }),
    );
    const { activityId } = await asScholar.mutation(api.questProposals.startOfferedQuest, {
      unitId,
    });
    const { id } = await asScholar.mutation(api.sessions.create, { unitId, activityId });
    const c = await t.query(internal.sessionHelpers.getSessionContext, { sessionId: id });
    expect(c?.appCreationAllowed).toBe(false);
  });

  test("only the teacher shapes it: the scholar can't edit it, nobody answers it", async () => {
    const { t, scholar, asScholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await expect(
      asScholar.mutation(api.questProposals.editProposal, { unitId, mission: "Mine now." }),
    ).rejects.toThrow();
    await expect(
      asTeacher.mutation(api.questProposals.answerProposal, {
        unitId,
        answer: "decline",
        expectedRevision: 1,
      }),
    ).rejects.toThrow();
    const { unit } = await unitParts(t, unitId);
    expect(unit?.mission?.text).toBe(MISSION);
    expect(unit?.questApproval?.state).toBe("offered");
    expect(await asTeacher.query(api.questProposals.forStaff, { unitId })).toBeNull();
  });

  test("it never posts to Slack as a proposal", async () => {
    const { t, scholar, asTeacher } = await setup();
    const { unitId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    const plan = await t.query(internal.questProposalSlack.postPlan, { unitId });
    expect(plan.ok).toBe(false);
  });
});

describe("the scholar's own read", () => {
  test("returns offers as a third list, newest first, with who offered", async () => {
    const { world, home, scholar, asScholar, asTeacher } = await setup();
    const first = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { title: "First", kind: "slides" }),
    );
    const second = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id, { title: "Second", mission: "Make a poster." }),
    );
    const read = await asScholar.query(api.questProposals.forSelf, {});
    expect(read.waiting).toEqual([]);
    expect(read.approved).toEqual([]);
    expect(read.offered.map((o) => o.unitId)).toEqual([second.unitId, first.unitId]);
    expect(read.offered[0]).toMatchObject({
      unitId: second.unitId,
      title: "Second",
      mission: "Make a poster.",
      kind: "app",
      offeredByName: home.teacher.name,
      threadId: second.threadId,
      reply: null,
    });
    expect(read.offered[0].offeredAt).toBeTypeOf("number");
    expect(read.offered[1].kind).toBe("slides");

    // Not a classmate's, not staff's.
    const asClassmate = await world.as.scholar(home.scholars[1]);
    expect((await asClassmate.query(api.questProposals.forSelf, {})).offered).toEqual([]);
    expect((await asTeacher.query(api.questProposals.forSelf, {})).offered).toEqual([]);
  });

  test("a teacher's later message in the thread is a reply", async () => {
    const { home, scholar, asScholar, asTeacher } = await setup();
    const { threadId } = await asTeacher.mutation(
      api.questProposals.offerQuest,
      offerArgs(scholar.id),
    );
    await asTeacher.mutation(api.scholarMessages.reply, {
      threadId,
      body: "Tell me what you think.",
    });
    const read = await asScholar.query(api.questProposals.forSelf, {});
    expect(read.offered[0].reply).toMatchObject({ teacherName: home.teacher.name });
  });
});
