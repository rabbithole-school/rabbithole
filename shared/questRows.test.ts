import { describe, expect, test } from "vitest";
import {
  QUEST_MARK,
  approvedQuestRow,
  offeredQuestRow,
  proposalRowCount,
  approvedActiveFirst,
  checkInMyWords,
  readyToShowWhen,
  proposalCoverage,
  proposalRows,
  questForSession,
  questDismissal,
  questKindLabel,
  unlockedQuestRow,
  waitingQuestRow,
} from "./questRows";

const waiting = {
  unitId: "u1",
  title: "Angle croc",
  mission: "Show a 2nd grader what an angle is.",
  kind: "app",
  emoji: "🐊",
  reply: null,
};

const approved = {
  ...waiting,
  unitId: "u2",
  title: "Prime hunt",
  kind: "python",
  emoji: null,
  advisorName: "Ms. Rivera",
  begun: false,
};

describe("questKindLabel", () => {
  test("names each kind, and says nothing for one this build doesn't know", () => {
    expect(questKindLabel("app")).toBe("An app");
    expect(questKindLabel("slides")).toBe("A presentation");
    expect(questKindLabel("python")).toBe("A Python program");
    expect(questKindLabel("sculpture")).toBeNull();
  });
});

describe("waitingQuestRow", () => {
  test("rocket on the ground, waiting, and a quiet View", () => {
    const row = waitingQuestRow(waiting);
    expect(row).toMatchObject({
      mark: "🐊",
      title: "Angle croc",
      content: "Mission: Show a 2nd grader what an angle is.",
      meta: "An app · Waiting for a teacher",
      rocket: "ground",
      replyLink: null,
      verb: { label: "View", weight: "quiet" },
    });
  });

  test("a teacher's reply ends the meta line as a link to the thread", () => {
    const named = waitingQuestRow({
      ...waiting,
      reply: { teacherName: "Ms. Rivera", threadId: "t1" },
    });
    expect(named.replyLink).toEqual({ label: "Ms. Rivera replied", threadId: "t1" });
    const unnamed = waitingQuestRow({
      ...waiting,
      reply: { teacherName: null, threadId: "t1" },
    });
    expect(unnamed.replyLink?.label).toBe("A teacher replied");
  });

  test("an unknown kind drops out of the meta line; no mission, no content line", () => {
    const row = waitingQuestRow({ ...waiting, kind: "sculpture", mission: "  " });
    expect(row.meta).toBe("Waiting for a teacher");
    expect(row.content).toBeNull();
  });
});

describe("approvedQuestRow", () => {
  test("launched, the advisor named, Start building until begun", () => {
    const row = approvedQuestRow(approved);
    expect(row).toMatchObject({
      mark: QUEST_MARK,
      meta: "A Python program · Advisor: Ms. Rivera",
      rocket: "launched",
      verb: { label: "Start building", weight: "outline" },
    });
  });

  test("Continue, solid, once begun", () => {
    const row = approvedQuestRow({ ...approved, begun: true });
    expect(row.verb).toEqual({ label: "Continue", weight: "solid" });
  });

  test("an approved Quest the kid unlocked says so instead of naming an approval", () => {
    const row = approvedQuestRow({ ...approved, advisorName: null, unlocked: true });
    expect(row.meta).toContain("Unlocked by your practice");
    expect(row.meta).not.toContain("Approved");
  });

  test("an advisor with no display name still reads as approved", () => {
    const row = approvedQuestRow({ ...approved, advisorName: "  " });
    expect(row.meta).toBe("A Python program · Approved");
  });
});

describe("proposalRows", () => {
  test("approved Quests first, then waiting proposals, each in the order given", () => {
    const rows = proposalRows({
      approved: [approved, { ...approved, unitId: "u3" }],
      waiting: [waiting, { ...waiting, unitId: "u4" }],
    });
    expect(rows.map((r) => [r.status, r.quest.unitId])).toEqual([
      ["approved", "u2"],
      ["approved", "u3"],
      ["waiting", "u1"],
      ["waiting", "u4"],
    ]);
    expect(new Set(rows.map((r) => r.row.key)).size).toBe(4);
  });
});

describe("proposalCoverage", () => {
  test("every unit, and every chat a proposal came from, so older lists can leave them out", () => {
    const coverage = proposalCoverage({
      approved: [{ ...approved, fromSessionId: "s2" }],
      waiting: [{ ...waiting, fromSessionId: null }],
    });
    expect(coverage.unitIds).toEqual(new Set(["u1", "u2"]));
    expect(coverage.sessionIds).toEqual(new Set(["s2"]));
  });
});

describe("offeredQuestRow", () => {
  const offered = { ...waiting, unitId: "u3", offeredByName: "Ms. Rivera" };

  test("rocket still on the ground, picked by the teacher, outline Start building", () => {
    expect(offeredQuestRow(offered)).toMatchObject({
      key: "offer:u3",
      meta: "An app · Picked for you by Ms. Rivera",
      rocket: "ground",
      replyLink: null,
      verb: { label: "Start building", weight: "outline" },
    });
  });

  test("a reply ends the meta line; a nameless teacher is still a teacher", () => {
    const row = offeredQuestRow({
      ...offered,
      offeredByName: "  ",
      reply: { teacherName: "Ms. Rivera", threadId: "t9" },
    });
    expect(row.meta).toBe("An app · Picked for you by a teacher");
    expect(row.replyLink).toEqual({ label: "Ms. Rivera replied", threadId: "t9" });
  });

  test("an unknown kind drops out of the meta line", () => {
    expect(offeredQuestRow({ ...offered, kind: "sculpture" }).meta).toBe(
      "Picked for you by Ms. Rivera",
    );
  });
});

describe("offers among the proposal rows", () => {
  const offered = { ...waiting, unitId: "u3", offeredByName: "Ms. Rivera" };

  test("approved, then offered, then waiting", () => {
    const rows = proposalRows({ approved: [approved], offered: [offered], waiting: [waiting] });
    expect(rows.map((r) => [r.status, r.row.key])).toEqual([
      ["approved", "quest:u2"],
      ["offered", "offer:u3"],
      ["waiting", "proposal:u1"],
    ]);
  });

  test("a read with no offered list still draws; offers count and are covered", () => {
    expect(proposalRows({ approved: [], waiting: [waiting] })).toHaveLength(1);
    expect(proposalRowCount({ approved: [approved], offered: [offered], waiting: [] })).toBe(2);
    expect(proposalRowCount({ approved: [], waiting: [] })).toBe(0);
    const covered = proposalCoverage({
      approved: [],
      offered: [{ unitId: "u3", fromSessionId: null }],
      waiting: [],
    });
    expect([...covered.unitIds]).toEqual(["u3"]);
  });
});

describe("showing a Quest", () => {
  test("ready to show adds to the meta line and keeps the rocket and button", () => {
    const row = approvedQuestRow({ ...approved, readyToShowAt: 1000, shownAt: null });
    expect(row.meta).toBe("A Python program \u00b7 Advisor: Ms. Rivera \u00b7 Ready to show");
    expect(row.rocket).toBe("launched");
    expect(row.verb).toEqual({ label: "Start building", weight: "outline" });
  });

  test("a shown Quest is a gold star naming the badge, with a quiet View", () => {
    const row = approvedQuestRow({
      ...approved,
      begun: true,
      readyToShowAt: 1000,
      shownAt: 2000,
      badgeName: "Prime Hunter",
    });
    expect(row.rocket).toBe("star");
    expect(row.meta).toBe("A Python program \u00b7 Prime Hunter \u00b7 Advisor: Ms. Rivera");
    expect(row.verb).toEqual({ label: "View", weight: "quiet" });
  });

  test("a shown Quest with no badge name still reads cleanly", () => {
    const row = approvedQuestRow({ ...approved, shownAt: 2000, badgeName: null });
    expect(row.meta).toBe("A Python program \u00b7 Advisor: Ms. Rivera");
    expect(row.rocket).toBe("star");
  });

  test("shown Quests stay in the list, below the waiting ones", () => {
    const rows = proposalRows({
      approved: [
        { ...approved, unitId: "shown", shownAt: 5 },
        { ...approved, unitId: "active" },
      ],
      waiting: [waiting],
    });
    expect(rows.map((r) => r.quest.unitId)).toEqual(["active", "u1", "shown"]);
    expect(approvedActiveFirst([{ shownAt: 1 }, { shownAt: null }, {}]).active).toHaveLength(2);
  });

  test("the sheet's words: empty waits, over the limit says so, otherwise trimmed", () => {
    expect(checkInMyWords("   ")).toEqual({ ok: false, reason: null });
    expect(checkInMyWords(" it opens ")).toEqual({ ok: true, words: "it opens" });
    const long = checkInMyWords("x".repeat(1001));
    expect(long.ok).toBe(false);
  });

  test("the time reads as a clock time today and a day after", () => {
    const now = new Date(2026, 10, 12, 15, 0).getTime();
    expect(readyToShowWhen(new Date(2026, 10, 12, 9, 5).getTime(), now)).toMatch(/9:05/);
    expect(readyToShowWhen(new Date(2026, 10, 9, 9, 5).getTime(), now)).toMatch(/Nov 9/);
  });
});

describe("questForSession", () => {
  const rows = [
    { unitId: "u-croc", activityId: "a-croc" },
    { unitId: "u-prime", activityId: "a-prime" },
  ];

  test("a session on the Quest's maker activity is the Quest's", () => {
    expect(questForSession(rows, { unitId: "u-prime", activityId: "a-prime" })).toBe(rows[1]);
  });

  test("another activity added to the Quest's unit is not", () => {
    expect(questForSession(rows, { unitId: "u-prime", activityId: "a-extra" })).toBeNull();
  });

  test("a session with no activity goes by its unit", () => {
    expect(questForSession(rows, { unitId: "u-croc", activityId: null })).toBe(rows[0]);
    expect(questForSession(rows, { unitId: "u-croc" })).toBe(rows[0]);
  });

  test("a session outside every Quest's unit is not a Quest's", () => {
    expect(questForSession(rows, { unitId: "u-other", activityId: "a-croc" })).toBeNull();
  });
});

describe("unlocked Code it missions", () => {
  const unlocked = {
    skillKey: "cx_multiply",
    title: "Multiply complex numbers by hand",
    mission: "Write times(a, b, c, d) for (a+bi)(c+di).",
    kind: "python",
  };
  const offered = { ...waiting, unitId: "u3", offeredByName: "Ms. Rivera" };
  const shown = { ...approved, unitId: "u4", shownAt: 2000 };

  test("rocket on the ground, unlocked by practice, outline Start building", () => {
    expect(unlockedQuestRow(unlocked)).toEqual({
      key: "unlock:cx_multiply",
      mark: QUEST_MARK,
      title: "Multiply complex numbers by hand",
      content: "Mission: Write times(a, b, c, d) for (a+bi)(c+di).",
      replyLink: null,
      meta: "A Python program · Unlocked by your practice",
      rocket: "ground",
      verb: { label: "Start building", weight: "outline" },
    });
  });

  test("an unknown kind drops out of the meta line", () => {
    expect(unlockedQuestRow({ ...unlocked, kind: "mystery" }).meta).toBe(
      "Unlocked by your practice",
    );
  });

  test("after offers and waiting proposals, before Quests already shown", () => {
    const rows = proposalRows({
      approved: [approved, shown],
      offered: [offered],
      waiting: [waiting],
      unlocked: [unlocked],
    });
    expect(rows.map((r) => [r.status, r.row.key])).toEqual([
      ["approved", "quest:u2"],
      ["offered", "offer:u3"],
      ["waiting", "proposal:u1"],
      ["unlocked", "unlock:cx_multiply"],
      ["approved", "quest:u4"],
    ]);
  });

  test("they count as rows, cover nothing, and an older read without them still works", () => {
    expect(proposalRowCount({ approved: [], waiting: [], unlocked: [unlocked] })).toBe(1);
    expect(
      proposalRowCount({ approved: [approved], offered: [offered], waiting: [], unlocked: [unlocked] }),
    ).toBe(3);
    expect(proposalRows({ approved: [], waiting: [] })).toEqual([]);
    const read = { approved: [], waiting: [], unlocked: [unlocked] };
    const covered = proposalCoverage(read);
    expect(covered.unitIds.size).toBe(0);
  });
});

describe("questDismissal", () => {
  test("unit rows go through dismissQuest; only a started Quest asks first", () => {
    expect(questDismissal({ status: "offered", quest: { unitId: "u3" } })).toEqual({
      mutation: "dismissQuest",
      unitId: "u3",
      confirm: false,
    });
    expect(questDismissal({ status: "waiting", quest: { unitId: "u1" } })).toEqual({
      mutation: "dismissQuest",
      unitId: "u1",
      confirm: false,
    });
    expect(questDismissal({ status: "approved", quest: { unitId: "u2" } })).toEqual({
      mutation: "dismissQuest",
      unitId: "u2",
      confirm: true,
    });
  });

  test("an unlocked mission dismisses that one skill, with no question", () => {
    expect(questDismissal({ status: "unlocked", quest: { skillKey: "cx_multiply" } })).toEqual({
      mutation: "dismissUnlockedCodeIt",
      skillKey: "cx_multiply",
      confirm: false,
    });
  });

  test("every row proposalRows draws has a dismissal", () => {
    const rows = proposalRows({
      approved: [approved],
      offered: [{ ...waiting, unitId: "u3", offeredByName: null }],
      waiting: [waiting],
      unlocked: [{ skillKey: "cx_multiply", title: "T", mission: "M", kind: "python" }],
    });
    expect(rows.map((entry) => questDismissal(entry).mutation)).toEqual([
      "dismissQuest",
      "dismissQuest",
      "dismissQuest",
      "dismissUnlockedCodeIt",
    ]);
  });
});
