// The staff read behind the Approve / Not this one buttons in a teacher's
// Messages (TRA-689): `questProposals.forStaff` answers only for staff who may
// answer the proposal (the same rule as `answerProposal`), and a fresh Quest
// thread shows in the teaching team's "Mine" list until someone replies.
//
// Fictional names only (the makeWorld cast). No copy assertions.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type World } from "./factories/world";

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
  const asScholar = await world.as.scholar(home.scholars[0]);
  const { unitId, threadId } = await asScholar.mutation(
    api.questProposals.propose,
    {
      scholarWords: "I want to make something about tides.",
      mission: "Show a younger kid why the sea goes in and out.",
      kind: "app",
      title: "Tide maker",
    },
  );
  return { t, world, home, asScholar, unitId, threadId };
}

async function asUser(
  t: Awaited<ReturnType<typeof setup>>["t"],
  userId: Id<"users">,
) {
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

describe("questProposals.forStaff", () => {
  test("a teacher at the school sees the state, revision and proposal message", async () => {
    const { world, home, unitId } = await setup();
    const asTeacher = await world.as.staffOf(home);
    const read = await asTeacher.query(api.questProposals.forStaff, { unitId });
    expect(read).toMatchObject({
      state: "waiting",
      revision: 1,
      advisorName: null,
      answeredByName: null,
    });
    expect(read?.proposalMessageId).not.toBeNull();
  });

  test("after an answer it names who answered", async () => {
    const { world, home, unitId } = await setup();
    const asTeacher = await world.as.staffOf(home);
    await asTeacher.mutation(api.questProposals.answerProposal, {
      unitId,
      answer: "approve",
      expectedRevision: 1,
    });
    const read = await asTeacher.query(api.questProposals.forStaff, { unitId });
    expect(read).toMatchObject({
      state: "approved",
      advisorName: home.teacher.name,
      answeredByName: home.teacher.name,
    });
  });

  test("follows the scholar's edit with a new revision", async () => {
    const { world, home, asScholar, unitId } = await setup();
    await asScholar.mutation(api.questProposals.editProposal, {
      unitId,
      mission: "Show a younger kid why tides come twice a day.",
    });
    const asTeacher = await world.as.staffOf(home);
    const read = await asTeacher.query(api.questProposals.forStaff, { unitId });
    expect(read?.revision).toBe(2);
  });

  const refused: { label: string; id: (w: World) => Id<"users"> }[] = [
    { label: "the scholar", id: (w) => w.schools[0].scholars[0].id },
    { label: "another scholar", id: (w) => w.schools[0].scholars[1].id },
    { label: "a parent", id: (w) => w.schools[0].parents[0].id },
    { label: "operations staff", id: (w) => w.schools[0].ops.id },
    { label: "a teacher at another school", id: (w) => w.schools[1].teacher.id },
    { label: "an admin at another school", id: (w) => w.schools[1].admin.id },
  ];
  for (const who of refused) {
    test(`${who.label} gets nothing`, async () => {
      const { t, world, unitId } = await setup();
      const asThem = await asUser(t, who.id(world));
      expect(
        await asThem.query(api.questProposals.forStaff, { unitId }),
      ).toBeNull();
    });
  }

  test("nothing once the scholar has withdrawn the waiting proposal", async () => {
    const { t, world, home, unitId } = await setup();
    await t.run((ctx) => ctx.db.patch(unitId, { isActive: false }));
    const asTeacher = await world.as.staffOf(home);
    expect(
      await asTeacher.query(api.questProposals.forStaff, { unitId }),
    ).toBeNull();
  });
});

describe("a Quest thread in the team's lists", () => {
  test("shows in Mine until a teacher has written, never for another school, and not in the default call", async () => {
    const { world, home, threadId } = await setup();
    const asTeacher = await world.as.staffOf(home);
    const mine = await asTeacher.query(api.scholarMessages.listThreads, {
      kind: "about",
      filter: "mine",
    });
    expect(mine.threads.map((t) => t._id)).toContain(threadId);

    const asOther = await world.as.staffOf(world.schools[1]);
    const theirs = await asOther.query(api.scholarMessages.listThreads, {
      kind: "about",
      filter: "all",
    });
    expect(theirs.threads).toHaveLength(0);

    const plain = await asTeacher.query(api.scholarMessages.listThreads, {});
    expect(plain.threads.map((t) => t._id)).not.toContain(threadId);
  });
});
