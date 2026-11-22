// Showing a Quest (TRA-684, PR 7a): the scholar says it is ready and writes how
// it works in their own words; a teacher at the school awards its badge under a
// name they choose. Covers who may do each (both award entry points, one rule),
// that awarding needs no "ready to show", where the badge's description comes
// from, one badge per Quest, the thread lines, and the scholar's own read.
//
// Fictional names only (the makeWorld cast).
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type World } from "./factories/world";
import { reconcileActivityCompletion } from "../lib/activityCompletionCore";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

const WORDS = "I want to build an app where a crocodile's jaws teach angles.";
const MISSION = "Show a 2nd grader what an angle is.";
const TEACHER_NOTES = "Teacher-only notes about this scholar.";
const HOW_IT_WORKS = "The jaws open to the angle you pick and the app names it.";

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

/** The scholar proposes and their teacher approves: an approved Quest. */
async function approvedQuest(
  ctx: Awaited<ReturnType<typeof setup>>,
  kind: "app" | "slides" | "python" = "app",
) {
  const { unitId, threadId } = await ctx.asScholar.mutation(
    api.questProposals.propose,
    { scholarWords: WORDS, mission: MISSION, kind, title: "Angle croc" },
  );
  await ctx.asTeacher.mutation(api.questProposals.answerProposal, {
    unitId,
    answer: "approve",
    expectedRevision: 1,
  });
  return { unitId, threadId };
}

async function messagesOf(t: T, threadId: Id<"parentThreads">) {
  return await t.run((ctx) =>
    ctx.db
      .query("parentMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect(),
  );
}

async function badgesOf(t: T, scholarId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
  );
}

async function asUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("markReadyToShow", () => {
  test("stores the words, posts them in the thread as the scholar, and awards nothing", async () => {
    const c = await setup();
    const { t, scholar, asScholar } = c;
    const { unitId, threadId } = await approvedQuest(c);

    const { readyToShowAt } = await asScholar.mutation(
      api.questShowing.markReadyToShow,
      { unitId, inMyWords: `  ${HOW_IT_WORKS}  ` },
    );

    const unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.questApproval).toMatchObject({
      state: "approved",
      inMyWords: HOW_IT_WORKS,
      readyToShowAt,
    });
    expect(unit?.questApproval?.shownAt).toBeUndefined();
    const lines = (await messagesOf(t, threadId)).filter(
      (m) => m._id === unit?.questApproval?.inMyWordsMessageId,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].authorType).toBe("scholar");
    expect(lines[0].authorUserId).toBe(scholar.id);
    expect(lines[0].body).toContain(HOW_IT_WORKS);
    expect(await badgesOf(t, scholar.id)).toHaveLength(0);
  });

  test("calling again updates the words and the thread line, keeping the first time", async () => {
    const c = await setup();
    const { t, asScholar } = c;
    const { unitId, threadId } = await approvedQuest(c);
    const first = await asScholar.mutation(api.questShowing.markReadyToShow, {
      unitId,
      inMyWords: HOW_IT_WORKS,
    });
    const before = (await messagesOf(t, threadId)).length;
    const second = await asScholar.mutation(api.questShowing.markReadyToShow, {
      unitId,
      inMyWords: "It also shows the angle's name in big letters.",
    });

    expect(second.readyToShowAt).toBe(first.readyToShowAt);
    const unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.questApproval?.inMyWords).toBe(
      "It also shows the angle's name in big letters.",
    );
    const messages = await messagesOf(t, threadId);
    expect(messages).toHaveLength(before);
    const line = messages.find((m) => m._id === unit?.questApproval?.inMyWordsMessageId);
    expect(line?.body).toContain("big letters");
    expect(await badgesOf(t, c.scholar.id)).toHaveLength(0);
  });

  test("bounds the words", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    const ready = (inMyWords: string) =>
      c.asScholar.mutation(api.questShowing.markReadyToShow, { unitId, inMyWords });
    await expect(ready("   ")).rejects.toThrow();
    await expect(ready("w".repeat(1001))).rejects.toThrow();
  });

  test("only the scholar's own approved Quest", async () => {
    const c = await setup();
    const { t, world, home, asScholar, asTeacher } = c;
    const { unitId } = await approvedQuest(c);
    const ready = { unitId, inMyWords: HOW_IT_WORKS };

    // A classmate, the teacher and a parent can't.
    const classmate = await world.as.scholar(home.scholars[1]);
    await expect(
      classmate.mutation(api.questShowing.markReadyToShow, ready),
    ).rejects.toThrow();
    await expect(
      asTeacher.mutation(api.questShowing.markReadyToShow, ready),
    ).rejects.toThrow(/Forbidden/);
    const asParent = await world.as.parent(home.parents[0]);
    await expect(
      asParent.mutation(api.questShowing.markReadyToShow, ready),
    ).rejects.toThrow();

    // A proposal still waiting, and an offer not started, are not Quests yet.
    const waiting = await asScholar.mutation(api.questProposals.propose, {
      scholarWords: WORDS,
      mission: MISSION,
      kind: "app",
      title: "Second",
    });
    await expect(
      asScholar.mutation(api.questShowing.markReadyToShow, {
        unitId: waiting.unitId,
        inMyWords: HOW_IT_WORKS,
      }),
    ).rejects.toThrow(/Quest not found/);
    const offer = await asTeacher.mutation(api.questProposals.offerQuest, {
      scholarId: c.scholar.id,
      kind: "app",
      mission: MISSION,
      title: "Offered",
    });
    await expect(
      asScholar.mutation(api.questShowing.markReadyToShow, {
        unitId: offer.unitId,
        inMyWords: HOW_IT_WORKS,
      }),
    ).rejects.toThrow(/Quest not found/);
    expect(
      (await t.run((ctx) => ctx.db.get(unitId)))?.questApproval?.readyToShowAt,
    ).toBeUndefined();
  });

  test("is refused once the badge is awarded", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    await c.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId,
      badgeName: "Angle Wrangler",
    });
    await expect(
      c.asScholar.mutation(api.questShowing.markReadyToShow, {
        unitId,
        inMyWords: HOW_IT_WORKS,
      }),
    ).rejects.toThrow(/already been shown/);
  });
});

describe("who may award", () => {
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
    test(`${who.label} can't award, by either path`, async () => {
      const c = await setup();
      const { unitId } = await approvedQuest(c);
      const userId = who.id(c.world);
      await expect(
        c.t.mutation(internal.questShowing.awardBadgeForUser, {
          unitId,
          badgeName: "Angle Wrangler",
          awarderId: userId,
        }),
      ).rejects.toThrow();
      const asThem = await asUser(c.t, userId);
      await expect(
        asThem.mutation(api.questShowing.awardBadge, {
          unitId,
          badgeName: "Angle Wrangler",
        }),
      ).rejects.toThrow();
      expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
      const unit = await c.t.run((ctx) => ctx.db.get(unitId));
      expect(unit?.questApproval?.shownAt).toBeUndefined();
    });
  }

  for (const who of allowed) {
    test(`${who.label} may award, through the internal path too`, async () => {
      const c = await setup();
      const { unitId } = await approvedQuest(c);
      const outcome = await c.t.mutation(internal.questShowing.awardBadgeForUser, {
        unitId,
        badgeName: "Angle Wrangler",
        awarderId: who.id(c.world),
      });
      expect(outcome).toMatchObject({
        badgeName: "Angle Wrangler",
        alreadyAwarded: false,
      });
      const unit = await c.t.run((ctx) => ctx.db.get(unitId));
      expect(unit?.questApproval).toMatchObject({
        awardedBy: who.id(c.world),
        badgeId: outcome.badgeId,
      });
    });
  }

  test("a read-only teacher can't award, by either path", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    await c.t.run((ctx) => ctx.db.patch(c.home.teacher.id, { readOnly: true }));
    await expect(
      c.t.mutation(internal.questShowing.awardBadgeForUser, {
        unitId,
        badgeName: "Angle Wrangler",
        awarderId: c.home.teacher.id,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      c.asTeacher.mutation(api.questShowing.awardBadge, {
        unitId,
        badgeName: "Angle Wrangler",
      }),
    ).rejects.toThrow();
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("only an approved Quest: a waiting proposal and an unstarted offer earn nothing", async () => {
    const c = await setup();
    const waiting = await c.asScholar.mutation(api.questProposals.propose, {
      scholarWords: WORDS,
      mission: MISSION,
      kind: "app",
    });
    const offer = await c.asTeacher.mutation(api.questProposals.offerQuest, {
      scholarId: c.scholar.id,
      kind: "app",
      mission: MISSION,
      title: "Offered",
    });
    for (const unitId of [waiting.unitId, offer.unitId]) {
      await expect(
        c.asTeacher.mutation(api.questShowing.awardBadge, {
          unitId,
          badgeName: "Angle Wrangler",
        }),
      ).rejects.toThrow(/waiting/);
    }
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });
});

describe("awarding", () => {
  test("works before the scholar says it is ready, and the scholar never can", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    const outcome = await c.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId,
      badgeName: "  Angle   Wrangler ",
    });
    expect(outcome.badgeName).toBe("Angle Wrangler");
    const unit = await c.t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.questApproval?.readyToShowAt).toBeUndefined();
    expect(unit?.questApproval).toMatchObject({
      shownAt: expect.any(Number),
      awardedBy: c.home.teacher.id,
      badgeId: outcome.badgeId,
    });
    const [badge] = await badgesOf(c.t, c.scholar.id);
    expect(badge.unitId).toBe(unitId);
    expect(badge.badgeSnapshot.title).toBe("Angle Wrangler");
    expect(badge.artStatus).toBe("generating");

    // The scholar can't award themselves another one or one of their own.
    await expect(
      c.asScholar.mutation(api.questShowing.awardBadge, {
        unitId,
        badgeName: "Self made",
      }),
    ).rejects.toThrow();
  });

  test("the description is the scholar's own words, else the mission, never the teacher's notes", async () => {
    // Words written: they are the description.
    const a = await setup();
    const ua = (await approvedQuest(a)).unitId;
    await a.t.run((ctx) => ctx.db.patch(ua, { description: TEACHER_NOTES }));
    await a.asScholar.mutation(api.questShowing.markReadyToShow, {
      unitId: ua,
      inMyWords: HOW_IT_WORKS,
    });
    await a.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId: ua,
      badgeName: "Angle Wrangler",
    });
    expect((await badgesOf(a.t, a.scholar.id))[0].badgeSnapshot.description).toBe(
      HOW_IT_WORKS,
    );

    // No words: the Quest's mission.
    const b = await setup();
    const ub = (await approvedQuest(b)).unitId;
    await b.t.run((ctx) => ctx.db.patch(ub, { description: TEACHER_NOTES }));
    await b.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId: ub,
      badgeName: "Angle Wrangler",
    });
    const [badge] = await badgesOf(b.t, b.scholar.id);
    expect(badge.badgeSnapshot.description).toBe(MISSION);
    expect(JSON.stringify(badge.badgeSnapshot)).not.toContain(TEACHER_NOTES);
  });

  test("one badge per Quest: a second award returns the first and changes nothing", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    const first = await c.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId,
      badgeName: "Angle Wrangler",
    });
    const second = await c.t.mutation(internal.questShowing.awardBadgeForUser, {
      unitId,
      badgeName: "A different name",
      awarderId: c.home.admin.id,
    });
    expect(second).toMatchObject({
      badgeId: first.badgeId,
      badgeName: "Angle Wrangler",
      alreadyAwarded: true,
    });
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(1);
    const unit = await c.t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.questApproval?.awardedBy).toBe(c.home.teacher.id);
  });

  test("bounds the badge's name", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    const award = (badgeName: string) =>
      c.asTeacher.mutation(api.questShowing.awardBadge, { unitId, badgeName });
    await expect(award("   ")).rejects.toThrow();
    await expect(award("n".repeat(61))).rejects.toThrow();
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("posts a line in the thread that is not a reply and moves no read marker", async () => {
    const c = await setup();
    const { unitId, threadId } = await approvedQuest(c);
    const threadBefore = await c.t.run((ctx) => ctx.db.get(threadId));
    await c.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId,
      badgeName: "Angle Wrangler",
    });
    const unit = await c.t.run((ctx) => ctx.db.get(unitId));
    const line = (await messagesOf(c.t, threadId)).find(
      (m) => m._id === unit?.questApproval?.awardMessageId,
    );
    expect(line?.authorType).toBe("teacher");
    expect(line?.authorUserId).toBe(c.home.teacher.id);
    expect(line?.body).toBe(
      `${c.home.teacher.name} awarded you the Angle Wrangler badge.`,
    );
    const threadAfter = await c.t.run((ctx) => ctx.db.get(threadId));
    expect(threadAfter?.lastReadByTeacherAt).toBe(threadBefore?.lastReadByTeacherAt);

    // forSelf: the badge line is not "a teacher replied".
    const { approved } = await c.asScholar.query(api.questProposals.forSelf, {});
    expect(approved).toHaveLength(1);
    expect(approved[0].reply).toBeNull();
  });
});

describe("forSelf", () => {
  test("an approved Quest carries ready-to-show, shown and the badge name", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    let row = (await c.asScholar.query(api.questProposals.forSelf, {})).approved[0];
    expect(row).toMatchObject({ readyToShowAt: null, shownAt: null, badgeName: null });

    await c.asScholar.mutation(api.questShowing.markReadyToShow, {
      unitId,
      inMyWords: HOW_IT_WORKS,
    });
    row = (await c.asScholar.query(api.questProposals.forSelf, {})).approved[0];
    expect(row.readyToShowAt).toEqual(expect.any(Number));
    expect(row.shownAt).toBeNull();

    await c.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId,
      badgeName: "Angle Wrangler",
    });
    row = (await c.asScholar.query(api.questProposals.forSelf, {})).approved[0];
    expect(row.shownAt).toEqual(expect.any(Number));
    expect(row.badgeName).toBe("Angle Wrangler");
  });
});

describe("aideAwardBadge (the Slack aide's tool)", () => {
  test("one approved Quest is awarded", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    const res = await c.t.mutation(internal.questShowing.aideAwardBadge, {
      callerUserId: c.home.teacher.id,
      scholarName: c.scholar.name,
      badgeName: "Angle Wrangler",
    });
    expect(res.status).toBe("awarded");
    expect((await badgesOf(c.t, c.scholar.id))[0].unitId).toBe(unitId);
  });

  test("several open Quests and no hint: asks, awards nothing; a hint or ready-to-show settles it", async () => {
    const c = await setup();
    const first = await approvedQuest(c);
    const second = await c.asScholar.mutation(api.questProposals.propose, {
      scholarWords: "A deck about volcano maps.",
      mission: "Teach a friend to read a contour map.",
      kind: "slides",
      title: "Volcano maps",
    });
    await c.asTeacher.mutation(api.questProposals.answerProposal, {
      unitId: second.unitId,
      answer: "approve",
      expectedRevision: 1,
    });
    const call = (questHint?: string) =>
      c.t.mutation(internal.questShowing.aideAwardBadge, {
        callerUserId: c.home.teacher.id,
        scholarName: c.scholar.name,
        badgeName: "Angle Wrangler",
        ...(questHint ? { questHint } : {}),
      });

    const asked = await call();
    expect(asked.status).toBe("choose");
    if (asked.status === "choose") {
      expect(asked.candidates.map((x) => x.title).sort()).toEqual([
        "Angle croc",
        "Volcano maps",
      ]);
      expect(asked.candidates.every((x) => x.readyToShow === false)).toBe(true);
    }
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);

    // Exactly one is ready to show: still a question, ready one listed first.
    await c.asScholar.mutation(api.questShowing.markReadyToShow, {
      unitId: second.unitId,
      inMyWords: "You read the lines to find the steep side.",
    });
    const byReady = await call();
    expect(byReady.status).toBe("choose");
    if (byReady.status === "choose") {
      expect(byReady.candidates[0]).toMatchObject({
        title: "Volcano maps",
        readyToShow: true,
      });
    }
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);

    // A hint that names neither Quest awards nothing and asks.
    const wrong = await call("zebra");
    expect(wrong.status).toBe("choose");
    if (wrong.status === "choose") expect(wrong.candidates).toHaveLength(2);
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);

    // Naming one awards that one.
    const byHint = await call("croc");
    expect(byHint).toMatchObject({ status: "awarded", title: "Angle croc" });
    expect((await badgesOf(c.t, c.scholar.id))[0].unitId).toBe(first.unitId);
  });

  test("a named Quest that doesn't match, with one Quest only, awards nothing", async () => {
    const c = await setup();
    await approvedQuest(c);
    const res = await c.t.mutation(internal.questShowing.aideAwardBadge, {
      callerUserId: c.home.teacher.id,
      scholarName: c.scholar.name,
      badgeName: "Angle Wrangler",
      questHint: "volcano",
    });
    expect(res.status).toBe("choose");
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("two open Quests separated by 100 newer archived units are still two", async () => {
    const c = await setup();
    await approvedQuest(c);
    const other = await c.asScholar.mutation(api.questProposals.propose, {
      scholarWords: WORDS,
      mission: "Another mission.",
      kind: "slides",
      title: "Older second",
    });
    await c.asTeacher.mutation(api.questProposals.answerProposal, {
      unitId: other.unitId,
      answer: "approve",
      expectedRevision: 1,
    });
    await c.t.run(async (ctx) => {
      for (let i = 0; i < 101; i++) {
        await ctx.db.insert("units", {
          teacherId: c.scholar.id,
          authorScholarId: c.scholar.id,
          title: `Archived ${i}`,
          isActive: false,
        });
      }
    });
    const res = await c.t.mutation(internal.questShowing.aideAwardBadge, {
      callerUserId: c.home.teacher.id,
      scholarName: c.scholar.name,
      badgeName: "Angle Wrangler",
    });
    expect(res.status).toBe("choose");
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("two ready to show is still a question", async () => {
    const c = await setup();
    const a = await approvedQuest(c);
    const b = await c.asScholar.mutation(api.questProposals.propose, {
      scholarWords: "Another one.",
      mission: "Another mission.",
      kind: "python",
      title: "Another",
    });
    await c.asTeacher.mutation(api.questProposals.answerProposal, {
      unitId: b.unitId,
      answer: "approve",
      expectedRevision: 1,
    });
    for (const unitId of [a.unitId, b.unitId]) {
      await c.asScholar.mutation(api.questShowing.markReadyToShow, {
        unitId,
        inMyWords: HOW_IT_WORKS,
      });
    }
    const res = await c.t.mutation(internal.questShowing.aideAwardBadge, {
      callerUserId: c.home.teacher.id,
      scholarName: c.scholar.name,
      badgeName: "Angle Wrangler",
    });
    expect(res.status).toBe("choose");
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("a scholar at another school is refused, and nothing is awarded", async () => {
    const c = await setup();
    await approvedQuest(c);
    await expect(
      c.t.mutation(internal.questShowing.aideAwardBadge, {
        callerUserId: c.world.schools[1].teacher.id,
        scholarName: c.scholar.name,
        badgeName: "Angle Wrangler",
      }),
    ).resolves.toMatchObject({ status: "choose_scholar", scholars: [] });
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("a scholar with no approved Quest has nothing to award", async () => {
    const c = await setup();
    const res = await c.t.mutation(internal.questShowing.aideAwardBadge, {
      callerUserId: c.home.teacher.id,
      scholarName: c.home.scholars[1].name,
      badgeName: "Angle Wrangler",
    });
    expect(res.status).toBe("none");
  });
});

describe("aideAwardBadge picks the scholar by exact name only", () => {
  async function twoKais() {
    const c = await setup();
    await approvedQuest(c);
    // A second "Kai" at the same school, with a Quest of their own.
    const other = c.home.scholars[1];
    await c.t.run(async (ctx) => {
      await ctx.db.patch(c.scholar.id, { name: "Kai Mahoe", username: "kai-m" });
      await ctx.db.patch(other.id, { name: "Kai Pele", username: "kai-p" });
    });
    return c;
  }
  const award = (c: Awaited<ReturnType<typeof setup>>, scholarName: string) =>
    c.t.mutation(internal.questShowing.aideAwardBadge, {
      callerUserId: c.home.teacher.id,
      scholarName,
      badgeName: "Angle Wrangler",
    });

  test("two kids named Kai: \"Kai\" awards nothing and returns both", async () => {
    const c = await twoKais();
    const res = await award(c, "Kai");
    expect(res.status).toBe("choose_scholar");
    if (res.status === "choose_scholar") {
      expect(res.scholars.map((s) => s.name).sort()).toEqual(["Kai Mahoe", "Kai Pele"]);
      expect(res.scholars.map((s) => s.username).sort()).toEqual(["kai-m", "kai-p"]);
    }
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("a partial match never awards, even when it is the only one", async () => {
    const c = await setup();
    await approvedQuest(c);
    await c.t.run((ctx) => ctx.db.patch(c.scholar.id, { name: "Noelani Akana" }));
    const res = await award(c, "noel");
    expect(res.status).toBe("choose_scholar");
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });

  test("an exact name, in any case and without accents, or the username, awards", async () => {
    const c = await twoKais();
    await c.t.run((ctx) => ctx.db.patch(c.scholar.id, { name: "Kai Mahoé" }));
    expect((await award(c, "  kai   MAHOE ")).status).toBe("awarded");
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(1);

    const d = await twoKais();
    expect((await award(d, "kai-m")).status).toBe("awarded");
  });
});

describe("a proposal or offer Quest earns its badge only from a teacher", () => {
  test("completing the maker mints no badge; the teacher's award then works", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c, "python");
    const unit = await c.t.run((ctx) => ctx.db.get(unitId));
    const activityId = unit!.questApproval!.activityId!;
    expect(unit?.badgeOnCompletion).toBeDefined();

    await c.t.run((ctx) =>
      reconcileActivityCompletion(ctx, { scholarId: c.scholar.id, activityId }),
    );
    const done = await c.t.run((ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", c.scholar.id).eq("unitId", unitId),
        )
        .collect(),
    );
    expect(done).toHaveLength(1);
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);

    const outcome = await c.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId,
      badgeName: "Angle Wrangler",
    });
    expect(outcome.alreadyAwarded).toBe(false);
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(1);
  });

  test("an older Quest without questApproval still mints on completion", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c, "python");
    const unit = await c.t.run((ctx) => ctx.db.get(unitId));
    const activityId = unit!.questApproval!.activityId!;
    await c.t.run((ctx) => ctx.db.patch(unitId, { questApproval: undefined }));
    await c.t.run((ctx) =>
      reconcileActivityCompletion(ctx, { scholarId: c.scholar.id, activityId }),
    );
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(1);
  });
});

describe("a badge that already exists", () => {
  test("the older manual award is reconciled, not duplicated, with no invented awarder", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    // The older path, on a Quest, now runs through the Quest core.
    const legacy = await c.asTeacher.mutation(api.badges.awardUnitBadge, {
      scholarId: c.scholar.id,
      unitId,
      title: "Legacy name",
    });
    expect(legacy.alreadyEarned).toBe(false);
    let unit = await c.t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.questApproval).toMatchObject({ badgeId: legacy.badgeId });
    expect(unit?.questApproval?.awardedBy).toBe(c.home.teacher.id);

    // A badge minted some other way (an older auto-mint) is picked up too.
    const d = await setup();
    const du = (await approvedQuest(d)).unitId;
    const badgeId = await d.t.run((ctx) =>
      ctx.db.insert("scholarUnitBadges", {
        scholarId: d.scholar.id,
        unitId: du,
        earnedAt: 12345,
        badgeSnapshot: { title: "Earlier badge" },
      }),
    );
    const outcome = await d.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId: du,
      badgeName: "Angle Wrangler",
    });
    expect(outcome).toMatchObject({ badgeId, alreadyAwarded: true, badgeName: "Earlier badge" });
    unit = await d.t.run((ctx) => ctx.db.get(du));
    expect(unit?.questApproval).toMatchObject({ badgeId, shownAt: 12345 });
    expect(unit?.questApproval?.awardedBy).toBeUndefined();
    expect(await badgesOf(d.t, d.scholar.id)).toHaveLength(1);
    const row = (await d.asScholar.query(api.questProposals.forSelf, {})).approved[0];
    expect(row.badgeName).toBe("Earlier badge");
    await expect(
      d.asScholar.mutation(api.questShowing.markReadyToShow, {
        unitId: du,
        inMyWords: HOW_IT_WORKS,
      }),
    ).rejects.toThrow(/already been shown/);
  });
});

describe("the scholar's ready-to-show line", () => {
  test("can't be edited or retracted in Messages, and a withdrawn line is never reused", async () => {
    const c = await setup();
    const { unitId, threadId } = await approvedQuest(c);
    await c.asScholar.mutation(api.questShowing.markReadyToShow, {
      unitId,
      inMyWords: HOW_IT_WORKS,
    });
    const unit = await c.t.run((ctx) => ctx.db.get(unitId));
    const messageId = unit!.questApproval!.inMyWordsMessageId!;
    await expect(
      c.asScholar.mutation(api.scholarMessages.editMessage, {
        messageId,
        body: "something else",
      }),
    ).rejects.toThrow(/ready-to-show/);
    await expect(
      c.asScholar.mutation(api.scholarMessages.retractMessage, { messageId }),
    ).rejects.toThrow(/ready-to-show/);

    // If it was withdrawn some other way, the new words get a new message.
    await c.t.run((ctx) => ctx.db.patch(messageId, { retractedAt: Date.now() }));
    await c.asScholar.mutation(api.questShowing.markReadyToShow, {
      unitId,
      inMyWords: "New words after a withdrawal.",
    });
    const after = await c.t.run((ctx) => ctx.db.get(unitId));
    const newId = after!.questApproval!.inMyWordsMessageId!;
    expect(newId).not.toBe(messageId);
    const lines = await messagesOf(c.t, threadId);
    expect(lines.find((m) => m._id === newId)?.body).toContain("New words after");
  });
});

describe("badge art input", () => {
  test("never carries the unit's teacher-facing description", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    await c.t.run((ctx) => ctx.db.patch(unitId, { description: TEACHER_NOTES }));
    const outcome = await c.asTeacher.mutation(api.questShowing.awardBadge, {
      unitId,
      badgeName: "Angle Wrangler",
    });
    const art = await c.t.query(internal.badges.getBadgeForArt, {
      badgeId: outcome.badgeId,
    });
    expect(art?.description).toBe(MISSION);
    expect(JSON.stringify(art)).not.toContain(TEACHER_NOTES);
  });
});

describe("the older manual award checks the unit", () => {
  test("another scholar's Quest, another school's unit and an archived unit are refused", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    const classmate = c.home.scholars[1];
    // Someone else's approved Quest.
    await expect(
      c.asTeacher.mutation(api.badges.awardUnitBadge, {
        scholarId: classmate.id,
        unitId,
      }),
    ).rejects.toThrow(/Unit not found/);
    // A unit stamped with another school.
    const foreign = await c.t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: c.home.teacher.id,
        title: "Elsewhere",
        isActive: true,
        institutionId: c.world.schools[1].id,
      }),
    );
    await expect(
      c.asTeacher.mutation(api.badges.awardUnitBadge, {
        scholarId: c.scholar.id,
        unitId: foreign,
      }),
    ).rejects.toThrow(/Unit not found/);
    // An archived unit.
    const archived = await c.t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: c.home.teacher.id,
        title: "Old",
        isActive: false,
      }),
    );
    await expect(
      c.asTeacher.mutation(api.badges.awardUnitBadge, {
        scholarId: c.scholar.id,
        unitId: archived,
      }),
    ).rejects.toThrow(/Unit not found/);
    expect(await badgesOf(c.t, c.scholar.id)).toHaveLength(0);
  });
});

describe("the older manual award's default name", () => {
  test("a long Quest title gets a generated name that fits, with no title typed", async () => {
    const c = await setup();
    const { unitId } = await approvedQuest(c);
    const title = "Investigating angles with a crocodile jaw demonstration";
    await c.t.run((ctx) =>
      ctx.db.patch(unitId, {
        title,
        badgeOnCompletion: { title: `${title} — completed` },
      }),
    );
    const res = await c.asTeacher.mutation(api.badges.awardUnitBadge, {
      scholarId: c.scholar.id,
      unitId,
    });
    const [badge] = await badgesOf(c.t, c.scholar.id);
    expect(res.badgeId).toBe(badge._id);
    expect(badge.badgeSnapshot.title.length).toBeLessThanOrEqual(60);
    expect(badge.badgeSnapshot.title).toMatch(/^Investigating angles.*… — completed$/);
    // A typed name over the limit is still refused.
    const d = await setup();
    const du = (await approvedQuest(d)).unitId;
    await expect(
      d.asTeacher.mutation(api.badges.awardUnitBadge, {
        scholarId: d.scholar.id,
        unitId: du,
        title: "n".repeat(61),
      }),
    ).rejects.toThrow();
  });
});
