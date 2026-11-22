// The scholar's own read of their Quest proposals (TRA-691): `questProposals.forSelf`
// returns the caller's waiting proposals and approved Quests, each with the
// Quest's thread and a teacher's latest reply there. Pins who sees what: own
// rows only, declined absent, the advisor's display name (never a login), the
// session-driven `begun` flag, a reply only from a teacher at the school, and
// nothing from a school the scholar has left.
//
// Fictional names only (the makeWorld cast). No copy assertions.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

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

type Setup = Awaited<ReturnType<typeof setup>>;

async function propose(
  asScholar: Setup["asScholar"],
  title: string,
  kind: "app" | "slides" = "app",
) {
  return await asScholar.mutation(api.questProposals.propose, {
    scholarWords: "I want to make something about tides.",
    mission: "Show a younger kid why the sea goes in and out.",
    kind,
    title,
  });
}

async function answer(
  asTeacher: Setup["asTeacher"],
  unitId: Awaited<ReturnType<typeof propose>>["unitId"],
  decision: "approve" | "decline",
) {
  return await asTeacher.mutation(api.questProposals.answerProposal, {
    unitId,
    answer: decision,
    expectedRevision: 1,
  });
}

describe("questProposals.forSelf", () => {
  test("a waiting proposal reads as the scholar wrote it, with its thread", async () => {
    const { asScholar } = await setup();
    const { unitId, threadId } = await propose(asScholar, "Tide maker");

    const { waiting, approved } = await asScholar.query(api.questProposals.forSelf, {});
    expect(approved).toEqual([]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      unitId,
      title: "Tide maker",
      mission: "Show a younger kid why the sea goes in and out.",
      kind: "app",
      revision: 1,
      threadId,
      reply: null,
    });
    expect(typeof waiting[0].proposedAt).toBe("number");
  });

  test("only the caller's own rows, newest first", async () => {
    const { world, home, asScholar } = await setup();
    const asOther = await world.as.scholar(home.scholars[1]);
    await propose(asOther, "Not mine");
    const first = await propose(asScholar, "First");
    const second = await propose(asScholar, "Second");

    const { waiting } = await asScholar.query(api.questProposals.forSelf, {});
    expect(waiting.map((row) => row.unitId)).toEqual([second.unitId, first.unitId]);

    const theirs = await asOther.query(api.questProposals.forSelf, {});
    expect(theirs.waiting.map((row) => row.title)).toEqual(["Not mine"]);
  });

  test("an approved Quest carries its advisor's name, activity and thread; declined is absent", async () => {
    const { asScholar, asTeacher, home } = await setup();
    const approvedOne = await propose(asScholar, "Approved one");
    const declinedOne = await propose(asScholar, "Declined one");
    const outcome = await answer(asTeacher, approvedOne.unitId, "approve");
    await answer(asTeacher, declinedOne.unitId, "decline");

    const { waiting, approved } = await asScholar.query(api.questProposals.forSelf, {});
    expect(waiting).toEqual([]);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      unitId: approvedOne.unitId,
      title: "Approved one",
      kind: "app",
      advisorName: home.teacher.name,
      activityId: outcome.activityId,
      begun: false,
      threadId: approvedOne.threadId,
      reply: null,
    });
  });

  test("an advisor with no display name reads null, never their login", async () => {
    const { t, asScholar, asTeacher, home } = await setup();
    const { unitId } = await propose(asScholar, "Nameless advisor");
    await t.run((ctx) => ctx.db.patch(home.teacher.id, { name: undefined }));
    await answer(asTeacher, unitId, "approve");

    const { approved } = await asScholar.query(api.questProposals.forSelf, {});
    expect(approved[0].advisorName).toBeNull();
  });

  test("begun turns true once the scholar has a session on the activity", async () => {
    const { asScholar, asTeacher } = await setup();
    const { unitId } = await propose(asScholar, "Begin me");
    const outcome = await answer(asTeacher, unitId, "approve");
    const activityId = outcome.activityId!;

    const before = await asScholar.query(api.questProposals.forSelf, {});
    expect(before.approved[0].begun).toBe(false);

    await asScholar.mutation(api.sessions.create, { unitId, activityId });

    const after = await asScholar.query(api.questProposals.forSelf, {});
    expect(after.approved[0].begun).toBe(true);
  });

  test("a teacher at the school sets the reply; one from another school is ignored", async () => {
    const { t, world, home, asScholar, asTeacher } = await setup();
    const { unitId, threadId } = await propose(asScholar, "Replied to");
    await asTeacher.mutation(api.scholarMessages.reply, {
      threadId,
      body: "Love this. Have you seen how the moon pulls on water?",
    });
    // Nothing lets another school's teacher post here; this row is made by
    // hand, newer than the real reply.
    await t.run((ctx) =>
      ctx.db.insert("parentMessages", {
        threadId,
        authorType: "teacher",
        authorUserId: world.schools[1].teacher.id,
        body: "Not from this school.",
        sentAt: Date.now() + 60_000,
      }),
    );

    const { waiting } = await asScholar.query(api.questProposals.forSelf, {});
    expect(waiting[0]).toMatchObject({
      unitId,
      reply: { teacherName: home.teacher.name, threadId },
    });

    // After approval the same reply rides on the approved row.
    await answer(asTeacher, unitId, "approve");
    const { approved } = await asScholar.query(api.questProposals.forSelf, {});
    expect(approved[0].reply).toEqual({ teacherName: home.teacher.name, threadId });
  });

  test("a message only from another school's teacher gives no reply", async () => {
    const { t, world, asScholar } = await setup();
    const { threadId } = await propose(asScholar, "Only a stranger wrote");
    await t.run((ctx) =>
      ctx.db.insert("parentMessages", {
        threadId,
        authorType: "teacher",
        authorUserId: world.schools[1].teacher.id,
        body: "Not from this school.",
      }),
    );
    const { waiting } = await asScholar.query(api.questProposals.forSelf, {});
    expect(waiting[0].reply).toBeNull();
  });

  test("a proposal stamped at a school the scholar has left is absent", async () => {
    const { t, world, scholar, asScholar, asTeacher } = await setup();
    await propose(asScholar, "Left behind waiting");
    const approvedOne = await propose(asScholar, "Left behind approved");
    await answer(asTeacher, approvedOne.unitId, "approve");
    expect(
      (await asScholar.query(api.questProposals.forSelf, {})).waiting,
    ).toHaveLength(1);

    await t.run((ctx) =>
      ctx.db.patch(scholar.id, { institutionId: world.schools[1].id }),
    );

    const after = await asScholar.query(api.questProposals.forSelf, {});
    expect(after).toEqual({ waiting: [], approved: [], offered: [], unlocked: [] });
  });

  test("anyone but a scholar gets empty lists", async () => {
    const { world, home, asScholar, asTeacher } = await setup();
    await propose(asScholar, "Not for staff");
    const asParent = await world.as.parent(home.parents[0]);
    for (const caller of [asTeacher, asParent]) {
      expect(await caller.query(api.questProposals.forSelf, {})).toEqual({
        waiting: [],
        approved: [],
        offered: [],
        unlocked: [],
      });
    }
  });
});
