// "Code it" missions offered through the teacher aide's entry
// (questProposals.offerCodeItQuestForUser): the registry's mission and title
// arrive as an ordinary Python Quest offer, one per (scholar, school, skill),
// refused for an unknown skill or a teacher at another school, and the tutor
// brief of the started Quest carries the mission. Also the read the aide uses
// to say which missions a scholar has already been offered.
//
// Fictional names only (the makeWorld cast).
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { internal, api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld } from "./factories/world";
import { codeItMissionFor } from "../lib/practice/codeItMissions";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
  });
  const home = world.schools[0];
  const scholar = home.scholars[0];
  const asScholar = await world.as.scholar(scholar);
  return { t, world, home, scholar, asScholar };
}

async function unitsOf(t: T, scholarId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("units")
      .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
      .collect(),
  );
}

const SKILL = "cx_multiply";
const OTHER_SKILL = "seq_arithmetic_explicit";

describe("offerCodeItQuestForUser", () => {
  test("offers the registry's mission as an offered Python Quest", async () => {
    const { t, home, scholar } = await setup();
    const entry = codeItMissionFor(SKILL)!;
    const outcome = await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: home.teacher.id,
      scholarId: scholar.id,
      skillKey: SKILL,
    });
    expect(outcome.created).toBe(true);
    expect(outcome.title).toBe(entry.title);
    const unit = await t.run((ctx) => ctx.db.get(outcome.unitId));
    expect(unit?.title).toBe(entry.title);
    expect(unit?.mission?.text).toBe(entry.mission);
    expect(unit?.questApproval).toMatchObject({
      state: "offered",
      kind: "python",
      offeredBy: home.teacher.id,
      ideaKey: `code-it:${SKILL}`,
    });
  });

  test("the same skill again is the same offer; another skill is a second one", async () => {
    const { t, home, scholar } = await setup();
    const args = { offererId: home.teacher.id, scholarId: scholar.id };
    const first = await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      ...args,
      skillKey: SKILL,
    });
    const again = await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      ...args,
      skillKey: SKILL,
    });
    expect(again.created).toBe(false);
    expect(again.unitId).toBe(first.unitId);
    const other = await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      ...args,
      skillKey: OTHER_SKILL,
    });
    expect(other.created).toBe(true);
    expect(other.unitId).not.toBe(first.unitId);
    expect(await unitsOf(t, scholar.id)).toHaveLength(2);
  });

  test("an unknown skill is refused with nothing written", async () => {
    const { t, home, scholar } = await setup();
    await expect(
      t.mutation(internal.questProposals.offerCodeItQuestForUser, {
        offererId: home.teacher.id,
        scholarId: scholar.id,
        skillKey: "not_a_skill",
      }),
    ).rejects.toThrow(/no Code it mission/);
    expect(await unitsOf(t, scholar.id)).toHaveLength(0);
  });

  test("a teacher at another school is refused with nothing written", async () => {
    const { t, world, scholar } = await setup();
    await expect(
      t.mutation(internal.questProposals.offerCodeItQuestForUser, {
        offererId: world.schools[1].teacher.id,
        scholarId: scholar.id,
        skillKey: SKILL,
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(await unitsOf(t, scholar.id)).toHaveLength(0);
  });

  test("once started, the one activity's brief carries the mission", async () => {
    const { t, home, scholar, asScholar } = await setup();
    const entry = codeItMissionFor(SKILL)!;
    const { unitId } = await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: home.teacher.id,
      scholarId: scholar.id,
      skillKey: SKILL,
    });
    const { activityId } = await asScholar.mutation(api.questProposals.startOfferedQuest, {
      unitId,
    });
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.appActivity).toBeFalsy();
    expect(activity?.systemPrompt).toContain(entry.mission);
  });
});

describe("codeItOffersForScholarInternal", () => {
  test("lists this scholar's Code it offers and where each stands", async () => {
    const { t, home, scholar, asScholar } = await setup();
    const args = { offererId: home.teacher.id, scholarId: scholar.id };
    const started = await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      ...args,
      skillKey: SKILL,
    });
    await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      ...args,
      skillKey: OTHER_SKILL,
    });
    // An ordinary offer with another key is not a Code it offer.
    await t.mutation(internal.questProposals.offerQuestForUser, {
      ...args,
      kind: "python",
      mission: "Count primes below 100.",
      title: "Primes",
      ideaKey: "something-else",
    });
    await asScholar.mutation(api.questProposals.startOfferedQuest, {
      unitId: started.unitId,
    });
    const offers = await t.query(internal.questProposals.codeItOffersForScholarInternal, {
      scholarId: scholar.id,
    });
    expect(
      [...offers].sort((a, b) => a.skillKey.localeCompare(b.skillKey)),
    ).toEqual([
      { skillKey: SKILL, state: "started" },
      { skillKey: OTHER_SKILL, state: "waiting" },
    ]);
  });

  test("an offer made at a school the scholar has left is not listed", async () => {
    const { t, world, home, scholar } = await setup();
    await t.mutation(internal.questProposals.offerCodeItQuestForUser, {
      offererId: home.teacher.id,
      scholarId: scholar.id,
      skillKey: SKILL,
    });
    await t.run((ctx) => ctx.db.patch(scholar.id, { institutionId: world.schools[1].id }));
    expect(
      await t.query(internal.questProposals.codeItOffersForScholarInternal, {
        scholarId: scholar.id,
      }),
    ).toEqual([]);
  });
});
