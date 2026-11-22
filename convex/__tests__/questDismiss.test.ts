// The × on a row of a scholar's own Quests list (questProposals.dismissQuest):
// a teacher's offer is set aside, a waiting proposal is withdrawn, and a
// started Quest is taken off the list with its work kept, through the same
// cascade a teacher's retract runs, so a teacher's reopen brings it back.
// Only the Quest's own scholar, at their current school; idempotent.
//
// Fictional names only (the makeWorld cast).
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld } from "./factories/world";
import { FLUENT_REPS } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const MISSION = "Show a 2nd grader what an angle is.";

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 2,
    parentsPerSchool: 0,
  });
  const home = world.schools[0];
  const scholar = home.scholars[0];
  const asScholar = await world.as.scholar(scholar);
  const asClassmate = await world.as.scholar(home.scholars[1]);
  const asTeacher = await world.as.staffOf(home);
  return { t, world, home, scholar, asScholar, asClassmate, asTeacher };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function proposeOne(s: Setup) {
  return await s.asScholar.mutation(api.questProposals.propose, {
    scholarWords: "I want to make a game about angles",
    mission: MISSION,
    kind: "app",
  });
}

async function offerOne(s: Setup) {
  return await s.asTeacher.mutation(api.questProposals.offerQuest, {
    scholarId: s.scholar.id,
    kind: "app",
    mission: MISSION,
    title: "Angle croc",
  });
}

/** An approved Quest the scholar has begun: started from an unlocked
 *  "Code it" mission, with a session on its maker activity. */
async function startedQuest(s: Setup) {
  await s.t.run((ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId: s.scholar.id,
      skillKey: "cx_multiply",
      domain: "algebra_2",
      repetition: FLUENT_REPS,
      halfLifeDays: 4,
      frontier: false,
      source: "practice",
      updatedAt: 1,
    }),
  );
  // Coding challenges start off; this scholar has switched them on.
  await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: true });
  const started = await s.asScholar.mutation(api.questProposals.startUnlockedCodeIt, {
    skillKey: "cx_multiply",
  });
  const session = await s.asScholar.mutation(api.sessions.create, {
    activityId: started.activityId,
  });
  return { ...started, sessionId: session.id as Id<"sessions"> };
}

async function read(s: Setup) {
  return await s.asScholar.query(api.questProposals.forSelf, {});
}

async function unitOf(s: Setup, unitId: Id<"units">) {
  return await s.t.run((ctx) => ctx.db.get(unitId));
}

describe("dismissQuest", () => {
  test("a teacher's offer is set aside: archived, nothing deleted or declined", async () => {
    const s = await setup();
    const offer = await offerOne(s);
    expect((await read(s)).offered).toHaveLength(1);
    const result = await s.asScholar.mutation(api.questProposals.dismissQuest, {
      unitId: offer.unitId,
    });
    expect(result).toEqual({ unitId: offer.unitId, changed: true });
    const unit = await unitOf(s, offer.unitId);
    expect(unit?.isActive).toBe(false);
    expect(unit?.questApproval?.state).toBe("offered");
    expect((await read(s)).offered).toEqual([]);
  });

  test("a waiting proposal is withdrawn, and a teacher can no longer answer it", async () => {
    const s = await setup();
    const proposal = await proposeOne(s);
    expect((await read(s)).waiting).toHaveLength(1);
    await s.asScholar.mutation(api.questProposals.dismissQuest, { unitId: proposal.unitId });
    const unit = await unitOf(s, proposal.unitId);
    expect(unit?.isActive).toBe(false);
    expect(unit?.questApproval?.state).toBe("waiting");
    expect((await read(s)).waiting).toEqual([]);
    expect(
      await s.asTeacher.query(api.questProposals.forStaff, { unitId: proposal.unitId }),
    ).toBeNull();
    await expect(
      s.asTeacher.mutation(api.questProposals.answerProposal, {
        unitId: proposal.unitId,
        answer: "approve",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/not found/);
  });

  test("a started Quest leaves the list with its work kept; a teacher's reopen restores it", async () => {
    const s = await setup();
    const quest = await startedQuest(s);
    expect((await read(s)).approved.map((q) => q.unitId)).toEqual([quest.unitId]);

    await s.asScholar.mutation(api.questProposals.dismissQuest, { unitId: quest.unitId });
    const unit = await unitOf(s, quest.unitId);
    expect(unit?.isActive).toBe(false);
    expect(unit?.questApproval).toMatchObject({
      state: "approved",
      activityId: quest.activityId,
    });
    const session = await s.t.run((ctx) => ctx.db.get(quest.sessionId));
    expect(session).not.toBeNull();
    expect(session?.isArchived).toBe(true);
    expect((await read(s)).approved).toEqual([]);
    // The mission does not unlock again: its Quest still exists.
    expect((await read(s)).unlocked).toEqual([]);

    await s.asTeacher.mutation(api.quests.reopen, { unitId: quest.unitId });
    expect((await unitOf(s, quest.unitId))?.isActive).toBe(true);
    expect((await s.t.run((ctx) => ctx.db.get(quest.sessionId)))?.isArchived).toBe(false);
    expect((await read(s)).approved.map((q) => q.unitId)).toEqual([quest.unitId]);
  });

  test("idempotent: a second × changes nothing", async () => {
    const s = await setup();
    const quest = await startedQuest(s);
    await s.asScholar.mutation(api.questProposals.dismissQuest, { unitId: quest.unitId });
    const again = await s.asScholar.mutation(api.questProposals.dismissQuest, {
      unitId: quest.unitId,
    });
    expect(again).toEqual({ unitId: quest.unitId, changed: false });
    expect((await unitOf(s, quest.unitId))?.isActive).toBe(false);
  });

  describe("refused, with nothing changed", () => {
    test("a classmate", async () => {
      const s = await setup();
      const offer = await offerOne(s);
      await expect(
        s.asClassmate.mutation(api.questProposals.dismissQuest, { unitId: offer.unitId }),
      ).rejects.toThrow(/not found/);
      expect((await unitOf(s, offer.unitId))?.isActive).toBe(true);
    });

    test("a teacher", async () => {
      const s = await setup();
      const proposal = await proposeOne(s);
      await expect(
        s.asTeacher.mutation(api.questProposals.dismissQuest, { unitId: proposal.unitId }),
      ).rejects.toThrow(/Forbidden/);
      expect((await unitOf(s, proposal.unitId))?.isActive).toBe(true);
    });

    test("a Quest stamped with a school the scholar has since left", async () => {
      const s = await setup();
      const offer = await offerOne(s);
      await s.t.run((ctx) =>
        ctx.db.patch(offer.unitId, { institutionId: s.world.schools[1].id }),
      );
      await expect(
        s.asScholar.mutation(api.questProposals.dismissQuest, { unitId: offer.unitId }),
      ).rejects.toThrow(/not found/);
      expect((await unitOf(s, offer.unitId))?.isActive).toBe(true);
    });

    test("a school that is suspended", async () => {
      const s = await setup();
      const offer = await offerOne(s);
      await s.t.run((ctx) => ctx.db.patch(s.home.id, { disabledAt: 1 }));
      // Refused before the handler runs (the sign-in wrapper's paused-school
      // check), or by its own live-school check: either way, nothing changes.
      await expect(
        s.asScholar.mutation(api.questProposals.dismissQuest, { unitId: offer.unitId }),
      ).rejects.toThrow();
      expect((await unitOf(s, offer.unitId))?.isActive).toBe(true);
    });
  });
});
