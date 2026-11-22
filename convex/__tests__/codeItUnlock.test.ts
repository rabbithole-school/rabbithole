// "Code it" missions that unlock on their own (lib/codeItUnlock.ts): shown in
// questProposals.forSelf `unlocked` only for a scholar fluent on the skill by
// demonstrated practice who has switched coding challenges on (they start
// off) and has no Quest with the mission's ideaKey yet; at most two, newest
// first. startUnlockedCodeIt re-checks all of it, mints an approved Python
// Quest with no teacher on it, and is idempotent. users.setCodeItEnabled
// changes only the caller's own row; users.setCodeItEnabledForUser is the
// staff CLI path. A teacher's direct offer never reads the switch.
// dismissUnlockedCodeIt takes one mission off the list, so the next
// earned one fills its slot.
//
// Fictional names only (the makeWorld cast).
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld } from "./factories/world";
import { codeItMissionFor } from "../lib/practice/codeItMissions";
import { FLUENT_REPS } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

const SKILL = "cx_multiply";
const OTHER = "seq_arithmetic_explicit";
const THIRD = "fn_compose";

/** By default the scholar has switched coding challenges on; pass
 *  `{ enabled: false }` for the untouched default (off). */
async function setup({ enabled = true }: { enabled?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 2,
    parentsPerSchool: 0,
  });
  const home = world.schools[0];
  const scholar = home.scholars[0];
  const asScholar = await world.as.scholar(scholar);
  const asTeacher = await world.as.staffOf(home);
  if (enabled) {
    await asScholar.mutation(api.users.setCodeItEnabled, { enabled: true });
  }
  return { t, world, home, scholar, asScholar, asTeacher };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function seedMastery(
  t: T,
  scholarId: Id<"users">,
  skillKey: string,
  opts: { source?: string; repetition?: number; becameFluentAt?: number } = {},
) {
  await t.run((ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain: "algebra_2",
      repetition: opts.repetition ?? FLUENT_REPS,
      halfLifeDays: 4,
      frontier: false,
      source: opts.source ?? "practice",
      updatedAt: 1,
      ...(opts.becameFluentAt !== undefined
        ? { becameFluentAt: opts.becameFluentAt }
        : {}),
    }),
  );
}

async function unlockedOf(s: Setup) {
  const read = await s.asScholar.query(api.questProposals.forSelf, {});
  return read.unlocked.map((u) => u.skillKey);
}

async function unitsOf(t: T, scholarId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("units")
      .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
      .collect(),
  );
}

describe("forSelf unlocked", () => {
  test("nothing without a mastery row", async () => {
    const s = await setup();
    expect(await unlockedOf(s)).toEqual([]);
  });

  test("placement credit at fluent reps does not unlock", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL, { source: "placement" });
    expect(await unlockedOf(s)).toEqual([]);
  });

  test("off by default: a fluent scholar who never turned it on sees none", async () => {
    const s = await setup({ enabled: false });
    await seedMastery(s.t, s.scholar.id, SKILL);
    expect(await unlockedOf(s)).toEqual([]);
  });

  test("turning it on shows the unlocked row; turning it off hides it again", async () => {
    const s = await setup({ enabled: false });
    await seedMastery(s.t, s.scholar.id, SKILL);
    await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: true });
    expect(await unlockedOf(s)).toEqual([SKILL]);
    await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: false });
    expect(await unlockedOf(s)).toEqual([]);
  });

  test("a teacher's offer of the mission, or one set aside, keeps it out", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    await seedMastery(s.t, s.scholar.id, OTHER);
    await s.t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: s.home.teacher.id,
      scholarId: s.scholar.id,
      skillKey: SKILL,
    });
    const aside = await s.t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: s.home.teacher.id,
      scholarId: s.scholar.id,
      skillKey: OTHER,
    });
    await s.asScholar.mutation(api.questProposals.setOfferAside, { unitId: aside.unitId });
    const read = await s.asScholar.query(api.questProposals.forSelf, {});
    expect(read.unlocked).toEqual([]);
    // The teacher's offer still shows as an offer.
    expect(read.offered.map((o) => o.title)).toContain(codeItMissionFor(SKILL)!.title);
  });

  test("fluent by practice, with no Python history: unlocked", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    const read = await s.asScholar.query(api.questProposals.forSelf, {});
    const entry = codeItMissionFor(SKILL)!;
    expect(read.unlocked).toEqual([
      { skillKey: SKILL, title: entry.title, mission: entry.mission, kind: "python" },
    ]);
  });

  test("at most two, the most recently earned first", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL, { becameFluentAt: 1_000 });
    await seedMastery(s.t, s.scholar.id, OTHER, { becameFluentAt: 3_000 });
    await seedMastery(s.t, s.scholar.id, THIRD, { becameFluentAt: 2_000 });
    expect(await unlockedOf(s)).toEqual([OTHER, THIRD]);
  });

  test("one scholar's fluency unlocks nothing for a classmate", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    const classmate = await s.world.as.scholar(s.home.scholars[1]);
    await classmate.mutation(api.users.setCodeItEnabled, { enabled: true });
    const read = await classmate.query(api.questProposals.forSelf, {});
    expect(read.unlocked).toEqual([]);
  });
});

describe("startUnlockedCodeIt", () => {
  test("mints an approved Python Quest with no teacher on it", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    const entry = codeItMissionFor(SKILL)!;

    const started = await s.asScholar.mutation(api.questProposals.startUnlockedCodeIt, {
      skillKey: SKILL,
    });
    const unit = await s.t.run((ctx) => ctx.db.get(started.unitId));
    expect(unit?.authorScholarId).toBe(s.scholar.id);
    expect(unit?.institutionId).toBe(s.home.id);
    expect(unit?.title).toBe(entry.title);
    expect(unit?.mission?.text).toBe(entry.mission);
    expect(unit?.questApproval).toMatchObject({
      state: "approved",
      kind: "python",
      ideaKey: `code-it:${SKILL}`,
      activityId: started.activityId,
      threadId: started.threadId,
    });
    expect(unit?.questApproval?.offeredBy).toBeUndefined();
    expect(unit?.questApproval?.advisorId).toBeUndefined();
    expect(unit?.questApproval?.answeredBy).toBeUndefined();

    const activity = await s.t.run((ctx) => ctx.db.get(started.activityId));
    expect(activity?.appActivity).toBeFalsy();
    expect(activity?.systemPrompt).toContain(entry.mission);
    expect(activity?.systemPrompt).toContain(
      "The scholar unlocked this Quest by becoming fluent on a practice skill, and chose to start it",
    );
    expect(activity?.systemPrompt).not.toContain("A teacher picked");

    // Its thread exists and carries no line: nobody wrote one.
    const messages = await s.t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", started.threadId!))
        .collect(),
    );
    expect(messages).toEqual([]);

    // It leaves `unlocked` and appears in `approved`, with no advisor.
    const read = await s.asScholar.query(api.questProposals.forSelf, {});
    expect(read.unlocked).toEqual([]);
    expect(read.approved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unitId: started.unitId,
          advisorName: null,
          activityId: started.activityId,
        }),
      ]),
    );
  });

  test("a second call returns the same Quest and writes nothing", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    const first = await s.asScholar.mutation(api.questProposals.startUnlockedCodeIt, {
      skillKey: SKILL,
    });
    const before = (await unitsOf(s.t, s.scholar.id)).length;
    const again = await s.asScholar.mutation(api.questProposals.startUnlockedCodeIt, {
      skillKey: SKILL,
    });
    expect(again).toEqual(first);
    expect(await unitsOf(s.t, s.scholar.id)).toHaveLength(before);
  });

  describe("refused, with nothing written", () => {
    async function expectRefused(s: Setup, pattern: RegExp, skillKey = SKILL) {
      const before = (await unitsOf(s.t, s.scholar.id)).length;
      await expect(
        s.asScholar.mutation(api.questProposals.startUnlockedCodeIt, { skillKey }),
      ).rejects.toThrow(pattern);
      expect(await unitsOf(s.t, s.scholar.id)).toHaveLength(before);
    }

    test("no mastery row", async () => {
      const s = await setup();
      await expectRefused(s, /fluent on its skill/);
    });

    test("placement credit", async () => {
      const s = await setup();
      await seedMastery(s.t, s.scholar.id, SKILL, { source: "placement" });
      await expectRefused(s, /fluent on its skill/);
    });

    test("coding challenges never turned on (the default)", async () => {
      const s = await setup({ enabled: false });
      await seedMastery(s.t, s.scholar.id, SKILL);
      await expectRefused(s, /turned off/);
    });

    test("coding challenges turned back off", async () => {
      const s = await setup();
      await seedMastery(s.t, s.scholar.id, SKILL);
      await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: false });
      await expectRefused(s, /turned off/);
    });

    test("a teacher already offered it", async () => {
      const s = await setup();
      await seedMastery(s.t, s.scholar.id, SKILL);
      await s.t.mutation(internal.questProposals.offerCodeItQuestForUser, {
        offererId: s.home.teacher.id,
        scholarId: s.scholar.id,
        skillKey: SKILL,
      });
      await expectRefused(s, /already have this Quest/);
    });

    test("an unknown skill", async () => {
      const s = await setup();
      await expectRefused(s, /doesn't exist/, "not_a_skill");
    });

    test("a teacher calling it", async () => {
      const s = await setup();
      await seedMastery(s.t, s.scholar.id, SKILL);
      const before = (await unitsOf(s.t, s.scholar.id)).length;
      await expect(
        s.asTeacher.mutation(api.questProposals.startUnlockedCodeIt, { skillKey: SKILL }),
      ).rejects.toThrow(/Forbidden/);
      expect(await unitsOf(s.t, s.scholar.id)).toHaveLength(before);
    });
  });

  test("a teacher offering the mission after the scholar started it gets that Quest back", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    const started = await s.asScholar.mutation(api.questProposals.startUnlockedCodeIt, {
      skillKey: SKILL,
    });
    const offer = await s.t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: s.home.teacher.id,
      scholarId: s.scholar.id,
      skillKey: SKILL,
    });
    expect(offer).toMatchObject({
      created: false,
      unitId: started.unitId,
      startedByScholar: true,
    });
    const offers = await s.t.query(internal.questProposals.codeItOffersForScholarInternal, {
      scholarId: s.scholar.id,
    });
    expect(offers).toEqual([{ skillKey: SKILL, state: "unlocked_started" }]);
  });
});

describe("setCodeItEnabled", () => {
  test("changes only the caller's own row, and turns back off", async () => {
    const s = await setup({ enabled: false });
    const classmateId = s.home.scholars[1].id;
    await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: true });
    const [me, classmate] = await s.t.run(async (ctx) => [
      await ctx.db.get(s.scholar.id),
      await ctx.db.get(classmateId),
    ]);
    expect(me?.codeItEnabled).toBe(true);
    expect(classmate?.codeItEnabled).toBeUndefined();
    await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: false });
    expect((await s.t.run((ctx) => ctx.db.get(s.scholar.id)))?.codeItEnabled).toBeUndefined();
  });

  test("a teacher's offer reaches the scholar whether the switch is on or off", async () => {
    const s = await setup({ enabled: false });
    await seedMastery(s.t, s.scholar.id, SKILL);
    await seedMastery(s.t, s.scholar.id, OTHER);
    await s.t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: s.home.teacher.id,
      scholarId: s.scholar.id,
      skillKey: OTHER,
    });
    // Off (the default): no unlocked row, but the offer shows.
    let read = await s.asScholar.query(api.questProposals.forSelf, {});
    expect(read.unlocked).toEqual([]);
    expect(read.offered.map((o) => o.title)).toContain(codeItMissionFor(OTHER)!.title);
    // On: the other skill unlocks beside it, and the offer is unchanged.
    await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: true });
    read = await s.asScholar.query(api.questProposals.forSelf, {});
    expect(read.unlocked.map((u) => u.skillKey)).toEqual([SKILL]);
    expect(read.offered.map((o) => o.title)).toContain(codeItMissionFor(OTHER)!.title);
    // The scholar can start the teacher's offer with the switch off.
    await s.asScholar.mutation(api.users.setCodeItEnabled, { enabled: false });
    const offer = read.offered.find((o) => o.title === codeItMissionFor(OTHER)!.title)!;
    const started = await s.asScholar.mutation(api.questProposals.startOfferedQuest, {
      unitId: offer.unitId as Id<"units">,
    });
    expect(started.activityId).toBeTruthy();
  });

  test("a teacher can't call it", async () => {
    const s = await setup({ enabled: false });
    await expect(
      s.asTeacher.mutation(api.users.setCodeItEnabled, { enabled: true }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("setCodeItEnabledForUser", () => {
  test("switches one scholar on and off, reporting whether it changed", async () => {
    const s = await setup({ enabled: false });
    const classmateId = s.home.scholars[1].id;
    await seedMastery(s.t, s.scholar.id, SKILL);
    expect(
      await s.t.mutation(internal.users.setCodeItEnabledForUser, {
        userId: s.scholar.id,
        enabled: true,
      }),
    ).toEqual({ userId: s.scholar.id, enabled: true, changed: true });
    expect(
      await s.t.mutation(internal.users.setCodeItEnabledForUser, {
        userId: s.scholar.id,
        enabled: true,
      }),
    ).toEqual({ userId: s.scholar.id, enabled: true, changed: false });
    expect(await unlockedOf(s)).toEqual([SKILL]);
    expect((await s.t.run((ctx) => ctx.db.get(classmateId)))?.codeItEnabled).toBeUndefined();
    expect(
      await s.t.mutation(internal.users.setCodeItEnabledForUser, {
        userId: s.scholar.id,
        enabled: false,
      }),
    ).toEqual({ userId: s.scholar.id, enabled: false, changed: true });
    expect((await s.t.run((ctx) => ctx.db.get(s.scholar.id)))?.codeItEnabled).toBeUndefined();
    expect(await unlockedOf(s)).toEqual([]);
  });

  test("refuses a user who is not a scholar", async () => {
    const s = await setup({ enabled: false });
    await expect(
      s.t.mutation(internal.users.setCodeItEnabledForUser, {
        userId: s.home.teacher.id,
        enabled: true,
      }),
    ).rejects.toThrow(/not a scholar/);
    expect((await s.t.run((ctx) => ctx.db.get(s.home.teacher.id)))?.codeItEnabled).toBeUndefined();
  });

  test("refuses a missing user", async () => {
    const s = await setup({ enabled: false });
    const goneId = s.home.scholars[1].id;
    await s.t.run((ctx) => ctx.db.delete(goneId));
    await expect(
      s.t.mutation(internal.users.setCodeItEnabledForUser, { userId: goneId, enabled: true }),
    ).rejects.toThrow(/No user/);
  });
});

describe("dismissUnlockedCodeIt", () => {
  test("that one mission leaves, the next earned fills its slot, the others stay", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL, { becameFluentAt: 3_000 });
    await seedMastery(s.t, s.scholar.id, OTHER, { becameFluentAt: 2_000 });
    await seedMastery(s.t, s.scholar.id, THIRD, { becameFluentAt: 1_000 });
    expect(await unlockedOf(s)).toEqual([SKILL, OTHER]);

    const result = await s.asScholar.mutation(api.questProposals.dismissUnlockedCodeIt, {
      skillKey: SKILL,
    });
    expect(result).toEqual({ skillKey: SKILL, changed: true });
    expect(await unlockedOf(s)).toEqual([OTHER, THIRD]);
    // Only that one: coding challenges stay on.
    const me = await s.t.run((ctx) => ctx.db.get(s.scholar.id));
    expect(me?.codeItEnabled).toBe(true);
    expect(me?.codeItDismissedSkills).toEqual([SKILL]);
  });

  test("idempotent", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    await s.asScholar.mutation(api.questProposals.dismissUnlockedCodeIt, { skillKey: SKILL });
    const again = await s.asScholar.mutation(api.questProposals.dismissUnlockedCodeIt, {
      skillKey: SKILL,
    });
    expect(again).toEqual({ skillKey: SKILL, changed: false });
    expect((await s.t.run((ctx) => ctx.db.get(s.scholar.id)))?.codeItDismissedSkills).toEqual([
      SKILL,
    ]);
  });

  test("a dismissed mission can't be started on its own, but a teacher can still offer it", async () => {
    const s = await setup();
    await seedMastery(s.t, s.scholar.id, SKILL);
    await s.asScholar.mutation(api.questProposals.dismissUnlockedCodeIt, { skillKey: SKILL });
    await expect(
      s.asScholar.mutation(api.questProposals.startUnlockedCodeIt, { skillKey: SKILL }),
    ).rejects.toThrow(/off your list/);

    const offer = await s.t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: s.home.teacher.id,
      scholarId: s.scholar.id,
      skillKey: SKILL,
    });
    expect(offer).toMatchObject({ created: true, startedByScholar: false });
    const read = await s.asScholar.query(api.questProposals.forSelf, {});
    expect(read.offered.map((o) => o.unitId)).toEqual([offer.unitId]);
    const started = await s.asScholar.mutation(api.questProposals.startOfferedQuest, {
      unitId: offer.unitId,
    });
    expect(started.unitId).toBe(offer.unitId);
  });

  test("another scholar is unaffected", async () => {
    const s = await setup();
    const classmate = s.home.scholars[1];
    await seedMastery(s.t, s.scholar.id, SKILL);
    await seedMastery(s.t, classmate.id, SKILL);
    await s.asScholar.mutation(api.questProposals.dismissUnlockedCodeIt, { skillKey: SKILL });
    const asClassmate = await s.world.as.scholar(classmate);
    await asClassmate.mutation(api.users.setCodeItEnabled, { enabled: true });
    const theirs = await asClassmate.query(api.questProposals.forSelf, {});
    expect(theirs.unlocked.map((u) => u.skillKey)).toEqual([SKILL]);
  });

  test("a teacher can't call it, and an unknown skill is refused", async () => {
    const s = await setup();
    await expect(
      s.asTeacher.mutation(api.questProposals.dismissUnlockedCodeIt, { skillKey: SKILL }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      s.asScholar.mutation(api.questProposals.dismissUnlockedCodeIt, { skillKey: "not_a_skill" }),
    ).rejects.toThrow(/doesn't exist/);
    expect((await s.t.run((ctx) => ctx.db.get(s.scholar.id)))?.codeItDismissedSkills).toBeUndefined();
  });
});
