import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { mondayWeekOf, goalKeywords } from "../weeklyGoals";
import { buildWeeklyGoalsSection } from "../sessionHelpers";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Standard fixtures (copy of rabbithole-testing.md shapes) ─────────

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  const name = overrides.name ?? `Test ${role}`;
  const username = overrides.username ?? `test${role}${Math.random().toString(36).slice(2, 6)}`;
  const institutionId = await seedTestInstitution(t);
  return role === "scholar"
    ? seedScholarInInstitution(t, { institutionId, name, username })
    : seedStaffWithMembership(t, { institutionId, name, username });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: "A session",
      isArchived: false,
    }),
  );
}

// ── Pure helper: buildWeeklyGoalsSection ─────────────────────────────

describe("buildWeeklyGoalsSection", () => {
  test("returns null when there are no goals", () => {
    expect(buildWeeklyGoalsSection(null)).toBeNull();
    expect(buildWeeklyGoalsSection([])).toBeNull();
  });

  test("renders each goal's text and optional plan", () => {
    const text = buildWeeklyGoalsSection([
      { text: "Get better at estimating", strategy: "check my answer is sensible" },
      { text: "Finish my volcano diagram" },
    ])!;
    expect(text).not.toBeNull();
    expect(text).toContain("This scholar's goals for this week");
    expect(text).toContain("Get better at estimating");
    expect(text).toContain("their plan: check my answer is sensible");
    expect(text).toContain("Finish my volcano diagram");
  });

  test("carries anti-nag / anti-verdict guidance and never invents goals", () => {
    const text = buildWeeklyGoalsSection([{ text: "Read a chapter book" }])!;
    const lower = text.toLowerCase();
    expect(lower).toContain("do not nag");
    expect(lower).toContain("verdict");
    // A not-met goal is fine — not a grade.
    expect(lower).toContain("not a grade");
    // Never fabricate a goal the scholar didn't set.
    expect(lower).toContain("never invent");
  });

  test("omits the plan clause when a goal has no strategy", () => {
    const text = buildWeeklyGoalsSection([{ text: "Ask one big question" }])!;
    expect(text).toContain('"Ask one big question"');
    expect(text).not.toContain("their plan");
  });
});

// ── Week math ─────────────────────────────────────────────────────────

describe("mondayWeekOf", () => {
  test("returns the Monday (YYYY-MM-DD) of the week, HST", () => {
    // 2026-07-08 is a Wednesday. 12:00 UTC that day is 02:00 HST same day.
    const wed = Date.parse("2026-07-08T12:00:00Z");
    expect(mondayWeekOf(wed, 0)).toBe("2026-07-06"); // Monday
    expect(mondayWeekOf(wed, -1)).toBe("2026-06-29"); // last Monday
  });

  test("uses the requested institution timezone across DST", () => {
    expect(
      mondayWeekOf(
        Date.parse("2026-03-08T16:00:00Z"),
        0,
        "America/New_York",
      ),
    ).toBe("2026-03-02");
    expect(
      mondayWeekOf(
        Date.parse("2026-03-09T16:00:00Z"),
        0,
        "America/New_York",
      ),
    ).toBe("2026-03-09");
    expect(
      mondayWeekOf(
        Date.parse("2026-11-01T17:00:00Z"),
        1,
        "America/New_York",
      ),
    ).toBe("2026-11-02");
  });
});

// ── Cap of 3 non-archived goals per scholar per week ─────────────────

describe("weeklyGoals.create — weekly cap", () => {
  test("allows up to 3 goals, rejects the 4th", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    for (let i = 0; i < 3; i++) {
      await asScholar.mutation(api.weeklyGoals.create, { text: `Goal ${i}` });
    }
    await expect(
      asScholar.mutation(api.weeklyGoals.create, { text: "One too many" }),
    ).rejects.toThrow(/up to 3/i);

    // Archiving one frees a slot again (teacher archives).
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacherId);
    const goals = await asScholar.query(api.weeklyGoals.myGoals, {});
    await asTeacher.mutation(api.weeklyGoals.archive, {
      goalId: goals.current[0]._id,
    });
    await expect(
      asScholar.mutation(api.weeklyGoals.create, { text: "Now there's room" }),
    ).resolves.toBeTruthy();
  });

  test("a scholar-created goal is ACTIVE immediately, source scholar, own id", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    const goal = await asScholar.mutation(api.weeklyGoals.create, {
      text: "Learn my times tables",
      strategy: "practice 5 minutes a day",
    });
    // The scholar owns the loop end-to-end: no approval gate, so it's live at once.
    expect(goal!.status).toBe("active");
    expect(goal!.source).toBe("scholar");
    expect(goal!.scholarId).toBe(scholarId);
    expect(goal!.strategy).toBe("practice 5 minutes a day");
    expect(goal!.activatedAt).toBeGreaterThan(0);
  });
});

// ── Gates: role + ownership ──────────────────────────────────────────

describe("weeklyGoals — gates", () => {
  test("a scholar cannot archive/veto a goal (teacher-only gate fires)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    const goal = await asScholar.mutation(api.weeklyGoals.create, {
      text: "Close me myself",
    });
    await expect(
      asScholar.mutation(api.weeklyGoals.archive, { goalId: goal!._id }),
    ).rejects.toThrow(/teacher or admin/i);
  });

  test("a scholar cannot suggest a goal for another scholar", async () => {
    const t = convexTest(schema, modules);
    const scholarA = await seedUser(t, "scholar");
    const scholarB = await seedUser(t, "scholar");
    const asA = await withUser(t, scholarA);
    await expect(
      asA.mutation(api.weeklyGoals.suggest, {
        scholarId: scholarB,
        text: "Not your call",
      }),
    ).rejects.toThrow(/teacher or admin/i);
  });

  test("setOutcome is owner-only", async () => {
    const t = convexTest(schema, modules);
    const scholarA = await seedUser(t, "scholar");
    const scholarB = await seedUser(t, "scholar");
    const asA = await withUser(t, scholarA);
    const asB = await withUser(t, scholarB);

    // A scholar-set goal is active on creation — no teacher approval needed.
    const goal = await asA.mutation(api.weeklyGoals.create, {
      text: "Finish the model",
    });
    expect(goal!.status).toBe("active");

    // Another scholar can't mark someone else's goal.
    await expect(
      asB.mutation(api.weeklyGoals.setOutcome, {
        goalId: goal!._id,
        outcome: "met",
      }),
    ).rejects.toThrow(/forbidden/i);

    // The owner can.
    const done = await asA.mutation(api.weeklyGoals.setOutcome, {
      goalId: goal!._id,
      outcome: "not_yet",
      reflection: "Ran out of time but I'm close",
    });
    expect(done!.status).toBe("not_yet");
    expect(done!.reflection).toContain("Ran out of time");
  });

  test("setOutcome refuses a still-proposed (teacher-suggested) goal", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);
    // Only a teacher SUGGESTION is `proposed` now (a scholar's own goal is active).
    const suggested = await asTeacher.mutation(api.weeklyGoals.suggest, {
      scholarId,
      text: "Not accepted yet",
    });
    expect(suggested!.status).toBe("proposed");
    await expect(
      asScholar.mutation(api.weeklyGoals.setOutcome, {
        goalId: suggested!._id,
        outcome: "met",
      }),
    ).rejects.toThrow(/isn't active/i);
  });
});

// ── Scholar accepts a teacher-suggested goal ─────────────────────────

describe("weeklyGoals — teacher suggestion → scholar accepts", () => {
  test("suggest creates a proposed goal the scholar can accept", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    const suggested = await asTeacher.mutation(api.weeklyGoals.suggest, {
      scholarId,
      text: "Try a harder problem set",
      teacherNote: "You're ready for this",
    });
    expect(suggested!.status).toBe("proposed");
    expect(suggested!.source).toBe("teacher");

    const accepted = await asScholar.mutation(api.weeklyGoals.accept, {
      goalId: suggested!._id,
    });
    expect(accepted!.status).toBe("active");
  });
});

// ── Ownership & agency: scholar owns their goal; suggestions need a yes ──

describe("weeklyGoals — ownership & agency", () => {
  test("a scholar's OWN goal is active on set — nothing to accept", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    const own = await asScholar.mutation(api.weeklyGoals.create, {
      text: "Own it end to end",
    });
    expect(own!.source).toBe("scholar");
    expect(own!.status).toBe("active");

    // There's nothing to accept — it's already theirs, live.
    await expect(
      asScholar.mutation(api.weeklyGoals.accept, { goalId: own!._id }),
    ).rejects.toThrow(/only a proposed goal can be accepted/i);

    const mine = await asScholar.query(api.weeklyGoals.myGoals, {});
    expect(mine.current[0].status).toBe("active");
  });

  test("a teacher SUGGESTION stays proposed until the scholar accepts it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    const suggested = await asTeacher.mutation(api.weeklyGoals.suggest, {
      scholarId,
      text: "Teacher's pick",
    });
    expect(suggested!.source).toBe("teacher");
    expect(suggested!.status).toBe("proposed");

    // Not live behind the scholar's back — it waits for their yes.
    const before = await asTeacher.query(api.weeklyGoals.listForScholar, {
      scholarId,
    });
    expect(before[0].status).toBe("proposed");

    const accepted = await asScholar.mutation(api.weeklyGoals.accept, {
      goalId: suggested!._id,
    });
    expect(accepted!.status).toBe("active");
  });

  test("both live paths work: scholar sets → active; teacher suggests → scholar accepts", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    // Scholar-set → active immediately.
    const own = await asScholar.mutation(api.weeklyGoals.create, {
      text: "My idea",
    });
    expect(own!.status).toBe("active");

    // Teacher-suggested → scholar accepts → active.
    const suggested = await asTeacher.mutation(api.weeklyGoals.suggest, {
      scholarId,
      text: "Teacher idea",
    });
    const accepted = await asScholar.mutation(api.weeklyGoals.accept, {
      goalId: suggested!._id,
    });
    expect(accepted!.status).toBe("active");
  });

  test("a scholar still cannot accept ANOTHER scholar's teacher-suggested goal", async () => {
    const t = convexTest(schema, modules);
    const scholarA = await seedUser(t, "scholar");
    const scholarB = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asB = await withUser(t, scholarB);
    const asTeacher = await withUser(t, teacherId);

    const suggested = await asTeacher.mutation(api.weeklyGoals.suggest, {
      scholarId: scholarA,
      text: "For A only",
    });
    await expect(
      asB.mutation(api.weeklyGoals.accept, { goalId: suggested!._id }),
    ).rejects.toThrow(/forbidden/i);
  });
});

// ── getSessionContext propagation ────────────────────────────────────

describe("getSessionContext — weekly goals plumbing", () => {
  test("a scholar's active goal reaches the tutor context immediately; a proposed suggestion does not", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await seedSession(t, scholarId);

    // A teacher SUGGESTION sits proposed → NOT injected (waits for scholar's yes).
    await asTeacher.mutation(api.weeklyGoals.suggest, {
      scholarId,
      text: "A suggestion the scholar hasn't taken on",
    });
    let ctxOut = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut!.weeklyGoals).toHaveLength(0);

    // The scholar sets their OWN goal → active on set → injected right away
    // (no approval gate).
    await asScholar.mutation(api.weeklyGoals.create, {
      text: "Explain my reasoning out loud",
      strategy: "say the why before the what",
    });
    ctxOut = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut!.weeklyGoals).toHaveLength(1);
    expect(ctxOut!.weeklyGoals[0].text).toBe("Explain my reasoning out loud");
    expect(ctxOut!.weeklyGoals[0].strategy).toBe("say the why before the what");

    // And it renders into the prompt section.
    const section = buildWeeklyGoalsSection(ctxOut!.weeklyGoals);
    expect(section).toContain("Explain my reasoning out loud");
  });
});

// ── Scholar-owned lifecycle: self-mark achieved + teacher visibility/veto ──

describe("weeklyGoals — scholar owns the loop", () => {
  test("the scholar marks their OWN goal achieved, no teacher needed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    const goal = await asScholar.mutation(api.weeklyGoals.create, {
      text: "Get better at big division",
    });
    expect(goal!.status).toBe("active");

    const done = await asScholar.mutation(api.weeklyGoals.setOutcome, {
      goalId: goal!._id,
      outcome: "met",
      reflection: "Nailed the long ones",
    });
    expect(done!.status).toBe("met");
    expect(done!.reflection).toContain("Nailed");

    const mine = await asScholar.query(api.weeklyGoals.myGoals, {});
    expect(mine.current.find((g) => g._id === goal!._id)!.status).toBe("met");
  });

  test("a teacher can SEE every scholar goal (visibility)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    await asScholar.mutation(api.weeklyGoals.create, { text: "Read every day" });
    const seen = await asTeacher.query(api.weeklyGoals.listForScholar, {
      scholarId,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("Read every day");
    expect(seen[0].status).toBe("active");
  });

  test("teacher veto/close degrades gracefully: the goal quietly leaves the scholar's week + the tutor", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await seedSession(t, scholarId);

    const goal = await asScholar.mutation(api.weeklyGoals.create, {
      text: "A goal the teacher will set aside",
    });

    // It's live + feeding the tutor.
    let ctxOut = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut!.weeklyGoals).toHaveLength(1);

    // The teacher vetoes/closes it after the fact.
    const closed = await asTeacher.mutation(api.weeklyGoals.archive, {
      goalId: goal!._id,
    });
    expect(closed!.status).toBe("archived");

    // Graceful on the scholar side: it simply disappears — no error, nothing
    // punitive — and it no longer feeds the tutor.
    const mine = await asScholar.query(api.weeklyGoals.myGoals, {});
    expect(mine.current.find((g) => g._id === goal!._id)).toBeUndefined();
    ctxOut = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut!.weeklyGoals).toHaveLength(0);
  });

  test("a teacher can edit a scholar's goal in place (override), leaving it live", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    const goal = await asScholar.mutation(api.weeklyGoals.create, {
      text: "riting more",
    });
    const edited = await asTeacher.mutation(api.weeklyGoals.annotate, {
      goalId: goal!._id,
      text: "Write a little every day",
      teacherNote: "Fixed the wording — nice goal!",
    });
    expect(edited!.text).toBe("Write a little every day");
    expect(edited!.teacherNote).toContain("nice goal");
    // Editing doesn't gate it — it's still the scholar's active goal.
    expect(edited!.status).toBe("active");
  });
});

// ── Practice-movement "look at this" moment ──────────────────────────

async function seedMovedSkill(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  opts: { nodeKey: string; label: string; domain?: string },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: opts.nodeKey,
      label: opts.label,
      domain: opts.domain ?? "math",
    });
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: opts.nodeKey,
      domain: opts.domain ?? "math",
      repetition: 5,
      halfLifeDays: 4,
      frontier: true,
      source: "practice",
      updatedAt: Date.now(),
      becameFluentAt: Date.now(),
    });
  });
}

describe("weeklyGoals — practice-movement moment", () => {
  test("an ACTIVE goal whose subject moved surfaces the movement", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    // Active on set — no approval needed.
    const goal = await asScholar.mutation(api.weeklyGoals.create, {
      text: "Get better at big division",
    });
    await seedMovedSkill(t, scholarId, {
      nodeKey: "division_with_remainders",
      label: "Division with remainders",
    });

    const data = await asScholar.query(api.weeklyGoals.myGoals, {});
    const g = data.current.find((x) => x._id === goal!._id);
    expect(g!.movement).not.toBeNull();
    expect(g!.movement!.skills).toContain("Division with remainders");
  });

  test("no movement when the moved skill doesn't match the goal subject", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    const goal = await asScholar.mutation(api.weeklyGoals.create, {
      text: "Get better at big division",
    });
    // A fraction skill moved — unrelated to division.
    await seedMovedSkill(t, scholarId, {
      nodeKey: "fraction_as_parts",
      label: "Fractions as parts of a whole",
    });

    const data = await asScholar.query(api.weeklyGoals.myGoals, {});
    const g = data.current.find((x) => x._id === goal!._id);
    expect(g!.movement).toBeNull();
  });

  test("a still-proposed (teacher-suggested) goal shows no movement even if the skill moved", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    // A teacher suggestion the scholar hasn't accepted yet → still proposed.
    const goal = await asTeacher.mutation(api.weeklyGoals.suggest, {
      scholarId,
      text: "Get better at big division",
    });
    await seedMovedSkill(t, scholarId, {
      nodeKey: "division_with_remainders",
      label: "Division with remainders",
    });

    const data = await asScholar.query(api.weeklyGoals.myGoals, {});
    const g = data.current.find((x) => x._id === goal!._id);
    expect(g!.status).toBe("proposed");
    expect(g!.movement).toBeNull();
  });
});

// ── goalKeywords (subject extraction) ────────────────────────────────

describe("goalKeywords", () => {
  test("drops generic goal-verbs/filler, keeps subject words ≥4 chars", () => {
    expect(goalKeywords("Get better at big division")).toEqual(["division"]);
  });

  test("keeps multiple distinct subject tokens", () => {
    const kws = goalKeywords("practise my times tables");
    expect(kws).toContain("times");
    expect(kws).toContain("tables");
    expect(kws).not.toContain("my");
  });
});
