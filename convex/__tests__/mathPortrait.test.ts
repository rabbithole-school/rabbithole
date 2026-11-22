import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import { atClock } from "./clockTestHelpers";

// The Math Skills portrait, end-to-end over the DB: the teacher read
// (`forScholar`) and the guardian-gated parent read (`childMathPortrait`) share
// ONE gatherer, so both must see the same shape — per touched domain, the
// level (placement credit included) beside the legacy "highest" figure (which
// placement credit never raises), and a REAL month-over-month trajectory of the
// level (never a fabricated slope). The
// parent read must additionally refuse anyone who isn't a guardian.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

const WNA = "whole-number-arithmetic";
const FRAC = "fraction-arithmetic";
const DAY = 86_400_000;

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedNode(
  t: TC,
  nodeKey: string,
  domain: string,
  grade: string,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("knowledgeNodes", { nodeKey, label: nodeKey, domain, grade }),
  );
}

async function seedMastery(
  t: TC,
  scholarId: Id<"users">,
  skillKey: string,
  domain: string,
  over: { source?: string; repetition?: number; becameFluentAt?: number } = {},
) {
  const now = Date.now();
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain,
      repetition: over.repetition ?? FLUENT_REPS,
      halfLifeDays: 30,
      frontier: false,
      source: over.source ?? "practice",
      updatedAt: now,
      // A stamped skill was learned in practice: access and fluency crossed
      // on the same attempt, so both transition stamps match.
      ...(over.becameFluentAt !== undefined
        ? { becameFluentAt: over.becameFluentAt, frontierAdvancedAt: over.becameFluentAt }
        : {}),
    }),
  );
}

describe("mathPortrait.forScholar — teacher read", () => {
  test("grade per touched domain + real rising trajectory", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const teacher = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "T", username: "t" });
    const scholar = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "S", username: "s" });

    await seedNode(t, "add", WNA, "1");
    await seedNode(t, "longdiv", WNA, "5");
    await seedNode(t, "longdiv2", WNA, "5"); // catalog-only → grade 5 is half-done
    await seedNode(t, "equiv", FRAC, "3");
    await seedNode(t, "equiv2", FRAC, "3"); // catalog-only

    // WNA: fluent at grade 1 long ago, then grade 5 just now → a real rise.
    await seedMastery(t, scholar, "add", WNA, { becameFluentAt: now - 200 * DAY });
    await seedMastery(t, scholar, "longdiv", WNA, { becameFluentAt: now - 1000 });
    // Fractions: one demonstrated-fluent skill at grade 3.
    await seedMastery(t, scholar, "equiv", FRAC, { becameFluentAt: now - 10 * DAY });

    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, {
      scholarId: scholar,
    });

    // Curriculum order: whole-number-arithmetic before fraction-arithmetic.
    expect(portrait.domains.map((d) => d.domain)).toEqual([WNA, FRAC]);

    const wna = portrait.domains[0];
    // The area's catalog starts at grade 1: grade 1 full, grades 2-4 have no
    // skills here and count as passed, half of grade 5 → "Grade 5.5". The
    // highest figure agrees here: grade 5 with half of it shown.
    expect(wna.gradeLabel).toBe("Grade 5.5");
    expect(wna.highestGradeLabel).toBe("Grade 5.5");
    expect(wna.fluentSkills).toBe(2);
    expect(wna.placementSkills).toBe(0);
    // Growth reflects the real rise from the earliest known point to now: all
    // of grade 1 back then (2.0), half of grade 5 now.
    expect(wna.growth).toEqual(
      expect.objectContaining({ fromLabel: "Grade 2.0", toLabel: "Grade 5.5" }),
    );
    // The series is monotonic non-decreasing and ends at the live value.
    const vals = wna.series.map((p) => p.value ?? -1);
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
    }
    expect(wna.series[wna.series.length - 1].value).toBe(wna.gradeValue);

    const frac = portrait.domains[1];
    expect(frac.gradeLabel).toBe("Grade 3.5");
    expect(frac.highestGradeLabel).toBe("Grade 3.5");
    // A single fluency event this window → no rise yet → "Building history".
    expect(frac.growth).toBeNull();
  });

  test("a placement credit raises the level, never the highest figure", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "T", username: "t2" });
    const scholar = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "S", username: "s2" });
    await seedNode(t, "add", WNA, "1");
    await seedNode(t, "longdiv", WNA, "5");
    // add is demonstrated-fluent (grade 1); the grade-5 skill is placement-only.
    await seedMastery(t, scholar, "add", WNA);
    await seedMastery(t, scholar, "longdiv", WNA, { source: "placement" });

    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, {
      scholarId: scholar,
    });
    expect(portrait.domains).toHaveLength(1);
    // Grade 1 shown, grades 2-4 have no skills here, grade 5 credited by the
    // placement check-in: ready to start grade 6.
    expect(portrait.domains[0].gradeLabel).toBe("Grade 6.0");
    expect(portrait.domains[0].highestGradeLabel).toBe("Grade 1.9");
    expect(portrait.domains[0].fluentSkills).toBe(1);
    expect(portrait.domains[0].placementSkills).toBe(1);
  });

  // The client queries never send the skill list (TRA-322): only the parent
  // aide's internal read asks for it, so neither screen's payload grows.
  test("the teacher read adds one overall level across every domain; the parent reads do not", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
    const scholar = await seedScholarInInstitution(t, { institutionId, name: "S", username: "s" });
    await t.run(async (ctx) => ctx.db.patch(scholar, { gradeLevel: "1" }));

    await seedNode(t, "count", WNA, "K");
    await seedNode(t, "add", WNA, "1");
    await seedNode(t, "half", FRAC, "1"); // an untouched domain still counts in grade 1
    await seedMastery(t, scholar, "count", WNA, { source: "placement" });
    await seedMastery(t, scholar, "add", WNA, { becameFluentAt: Date.now() - DAY });

    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, { scholarId: scholar });
    expect(portrait.domains.map((d) => d.domain)).toEqual([WNA]);
    expect(portrait.overall?.enrolledGradeRank).toBe(1);
    expect(portrait.overall?.level).toEqual(
      expect.objectContaining({
        value: 1.5,
        dailySkills: 1,
        placementSkills: 1,
        solidThroughRank: 0,
        bands: [
          { rank: 0, total: 1, daily: 0, placement: 1 },
          { rank: 1, total: 2, daily: 1, placement: 0 },
        ],
      }),
    );

    const forAide = await t.query(internal.mathPortrait.getScholarMathPortrait, { scholarId: scholar });
    expect(forAide.overall).toBeUndefined();
  });

  test("learned pace counts a skill only when the scholar missed it before it turned fluent", async () => {
    const t = convexTest(schema, modules);
    // Enrolled well before the term, so the pace window is the whole term.
    const { institutionId, teacher, scholar } = await atClock(Date.now() - 365 * DAY, async () => {
      const institutionId = await seedTestInstitution(t);
      const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
      const scholar = await seedScholarInInstitution(t, { institutionId, name: "S", username: "s" });
      return { institutionId, teacher, scholar };
    });
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("reportingPeriods", {
        label: "Fall",
        startsAt: now - 61 * DAY,
        endsAt: now + 30 * DAY,
        status: "open",
        institutionId,
      });
    });
    for (const key of ["a1", "a2", "a3", "a4"]) await seedNode(t, key, WNA, "1");
    await seedMastery(t, scholar, "a1", WNA, { becameFluentAt: now - 10 * DAY });
    await seedMastery(t, scholar, "a2", WNA, { becameFluentAt: now - 10 * DAY });
    await seedMastery(t, scholar, "a3", WNA, { becameFluentAt: now - 10 * DAY });
    await t.run(async (ctx) => {
      const attempt = (nodeKey: string, correct: boolean, createdAt: number) =>
        ctx.db.insert("practiceAttempts", { scholarId: scholar, nodeKey, correct, createdAt });
      await attempt("a1", false, now - 12 * DAY); // missed, then fluent: learned
      await attempt("a1", true, now - 11 * DAY);
      await attempt("a2", true, now - 11 * DAY); // never missed: already known
      await attempt("a3", false, now - 2 * DAY); // a miss AFTER fluent is not learning it
    });

    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, { scholarId: scholar });
    const pace = portrait.overall?.pace;
    expect(pace).toEqual(expect.objectContaining({ periodLabel: "Fall", learnedSkills: 1, knownSkills: 2 }));
    // Enrolled before the term: the window is the whole term.
    expect(pace?.windowStartsAt).toBe(pace?.periodStartsAt);
    // One of grade 1's four skills is 2.5 school months, over about two months.
    expect(pace?.learnedMonths).toBeCloseTo(2.5);
    expect(pace?.pace).toBeCloseTo(2.5 / (61 / 30.44), 1);
  });

  test("below the level the term started at, one miss is a slip and two is learning", async () => {
    const t = convexTest(schema, modules);
    // Enrolled well before the term, so the pace window is the whole term.
    const { institutionId, teacher, scholar } = await atClock(Date.now() - 365 * DAY, async () => {
      const institutionId = await seedTestInstitution(t);
      const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
      const scholar = await seedScholarInInstitution(t, { institutionId, name: "S", username: "s" });
      return { institutionId, teacher, scholar };
    });
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("reportingPeriods", {
        label: "Fall",
        startsAt: now - 61 * DAY,
        endsAt: now + 30 * DAY,
        status: "open",
        institutionId,
      });
    });
    await seedNode(t, "kp", WNA, "K");
    for (const key of ["p1a", "p1b", "b1", "b2"]) await seedNode(t, key, WNA, "1");
    for (const key of ["p2a", "p2b", "c1", "c2"]) await seedNode(t, key, WNA, "2");
    // Placement credit puts the level at the term's start at exactly 2.0:
    // all of K, half of grade 1, half of grade 2.
    for (const key of ["kp", "p1a", "p1b", "p2a", "p2b"]) {
      await seedMastery(t, scholar, key, WNA, { source: "placement" });
    }
    for (const key of ["b1", "b2", "c1"]) {
      await seedMastery(t, scholar, key, WNA, { becameFluentAt: now - 10 * DAY });
    }
    await t.run(async (ctx) => {
      const miss = (nodeKey: string, createdAt: number) =>
        ctx.db.insert("practiceAttempts", { scholarId: scholar, nodeKey, correct: false, createdAt });
      await miss("b1", now - 12 * DAY); // grade 1, one miss: already known
      await miss("b2", now - 13 * DAY); // grade 1, two misses: learned
      await miss("b2", now - 12 * DAY);
      await miss("c1", now - 12 * DAY); // grade 2, one miss: learned
    });

    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, { scholarId: scholar });
    expect(portrait.overall?.pace).toEqual(expect.objectContaining({ learnedSkills: 2, knownSkills: 1 }));
  });

  test("a scholar who joined after the term began is measured from the day they joined", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    // Kalani joined 40 days ago, 60 days into a term that began 100 days ago.
    const { institutionId, teacher, kalani } = await atClock(now - 40 * DAY, async () => {
      const institutionId = await seedTestInstitution(t);
      const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
      const kalani = await seedScholarInInstitution(t, { institutionId, name: "Kalani", username: "kalani" });
      return { institutionId, teacher, kalani };
    });
    // Pua joined just now: under a school month in the window.
    const pua = await seedScholarInInstitution(t, { institutionId, name: "Pua", username: "pua" });
    const [kalaniJoined, puaJoined] = await t.run(async (ctx) => {
      await ctx.db.insert("reportingPeriods", {
        label: "Fall",
        startsAt: now - 100 * DAY,
        endsAt: now + 30 * DAY,
        status: "open",
        institutionId,
      });
      return [(await ctx.db.get(kalani))!._creationTime, (await ctx.db.get(pua))!._creationTime];
    });
    expect(kalaniJoined).toBeGreaterThan(now - 100 * DAY);
    for (const key of ["a1", "a2"]) await seedNode(t, key, WNA, "1");
    for (const scholar of [kalani, pua]) {
      await seedMastery(t, scholar, "a1", WNA, { becameFluentAt: now - DAY });
      await t.run((ctx) =>
        ctx.db.insert("practiceAttempts", { scholarId: scholar, nodeKey: "a1", correct: false, createdAt: now - 2 * DAY }),
      );
    }

    const asTeacher = await withUser(t, teacher);
    const forKalani = await asTeacher.query(api.mathPortrait.forScholar, { scholarId: kalani });
    const kalaniPace = forKalani.overall?.pace;
    expect(kalaniPace?.periodStartsAt).toBe(now - 100 * DAY);
    expect(kalaniPace?.windowStartsAt).toBe(kalaniJoined);
    // 40 days of school, not 100.
    expect(kalaniPace?.schoolMonths).toBeCloseTo(40 / 30.44, 2);
    // a1 is half of grade 1 (5 months), learned in those 40 days.
    expect(kalaniPace?.learnedMonths).toBeCloseTo(5);
    expect(kalaniPace?.pace).toBeCloseTo(5 / (40 / 30.44), 2);
    // Every area's new learning reads the same window.
    expect(forKalani.domains[0].termLearnedMonths).toBeCloseTo(5);

    const puaPace = (await asTeacher.query(api.mathPortrait.forScholar, { scholarId: pua })).overall?.pace;
    expect(puaPace?.windowStartsAt).toBe(puaJoined);
    // Under one school month: no rate is stated.
    expect(puaPace?.pace).toBeNull();
  });

  test("a placement credit demonstrated later is not growth (cross-family review)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
    const scholar = await seedScholarInInstitution(t, { institutionId, name: "Malu", username: "malu" });
    for (const key of ["a1", "a2"]) await seedNode(t, key, WNA, "1");
    // Placed by the check-in, then demonstrated a week ago: the demonstrating
    // attempt stamps becameFluentAt but not frontierAdvancedAt.
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar, skillKey: "a1", domain: WNA, repetition: FLUENT_REPS, halfLifeDays: 30,
        frontier: false, source: "practice", updatedAt: Date.now(), becameFluentAt: Date.now() - 7 * DAY,
      }),
    );
    const portrait = await (await withUser(t, teacher)).query(api.mathPortrait.forScholar, { scholarId: scholar });
    const [wna] = portrait.domains;
    expect(wna.gradeValue).toBeCloseTo(1.5);
    expect(wna.series.every((p) => p.value !== null && Math.abs(p.value - 1.5) < 1e-9)).toBe(true);
    expect(wna.growth).toBeNull();
  });

  test("the window's start day is the school's day, not UTC's (cross-family review)", async () => {
    const t = convexTest(schema, modules);
    // 02:00 UTC on Nov 2 is still Nov 1 in Honolulu, the default school zone.
    const joinedAt = Date.UTC(2026, 10, 2, 2, 0);
    const { institutionId, teacher, scholar } = await atClock(joinedAt, async () => {
      const institutionId = await seedTestInstitution(t);
      const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
      const scholar = await seedScholarInInstitution(t, { institutionId, name: "Ikaika", username: "ikaika" });
      return { institutionId, teacher, scholar };
    });
    await t.run((ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Fall",
        startsAt: Date.UTC(2026, 7, 11),
        endsAt: Date.now() + 30 * DAY,
        status: "open",
        institutionId,
      }),
    );
    await seedNode(t, "a1", WNA, "1");
    await seedMastery(t, scholar, "a1", WNA);
    const pace = (await (await withUser(t, teacher)).query(api.mathPortrait.forScholar, { scholarId: scholar })).overall?.pace;
    expect(pace?.windowStartsDay).toBe("2026-11-01");
  });

  test("no current reporting period for the scholar's school means no pace", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
    const scholar = await seedScholarInInstitution(t, { institutionId, name: "S", username: "s" });
    await seedNode(t, "a1", WNA, "1");
    await seedMastery(t, scholar, "a1", WNA, { becameFluentAt: Date.now() - DAY });
    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, { scholarId: scholar });
    expect(portrait.overall?.pace).toBeNull();
  });

  test("the teacher read carries no fluent-skill list", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "T", username: "t5" });
    const scholar = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "S", username: "s5" });
    await seedNode(t, "add", WNA, "1");
    await seedMastery(t, scholar, "add", WNA);
    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, {
      scholarId: scholar,
    });
    expect(portrait.domains[0].fluentSkills).toBe(1);
    expect(portrait.domains[0]).not.toHaveProperty("fluentSkillLabels");
  });

  test("a scholar with no practice yet → empty portrait (no fabricated zero)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "T", username: "t3" });
    const scholar = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "S", username: "s3" });
    const asTeacher = await withUser(t, teacher);
    const portrait = await asTeacher.query(api.mathPortrait.forScholar, {
      scholarId: scholar,
    });
    expect(portrait.domains).toEqual([]);
  });
});

describe("parents.childMathPortrait — guardian-gated", () => {
  test("a linked guardian reads their child; same-school staff may preview; another school is refused", async () => {
    const t = convexTest(schema, modules);
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "A", username: "admin", role: "platform_admin" }),
    );
    const kai = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "K", username: "kai" });
    await seedNode(t, "add", WNA, "1");
    await seedMastery(t, kai, "add", WNA);

    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });

    // The linked guardian gets the portrait.
    const asParent = await withUser(t, parentId);
    const portrait = await asParent.query(api.parents.childMathPortrait, {
      scholarId: kai,
    });
    expect(portrait.domains[0].gradeLabel).toBe("Grade 2.0");
    expect(portrait.domains[0].highestGradeLabel).toBe("Grade 1.9");
    expect(portrait.domains[0]).not.toHaveProperty("fluentSkillLabels");

    // A teacher who is NOT a guardian of kai but can reach kai in their own
    // school may PREVIEW the family's portrait ("View as parent") — the same
    // non-sensitive read they already have on the teacher dashboard.
    const teacher = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "T", username: "t4" });
    const asTeacher = await withUser(t, teacher);
    const previewed = await asTeacher.query(api.parents.childMathPortrait, {
      scholarId: kai,
    });
    expect(previewed.domains[0].gradeLabel).toBe("Grade 2.0");

    // A teacher at ANOTHER school is refused — the preview never crosses the
    // institution boundary.
    const outsider = await seedStaffWithMembership(t, {
      institutionId: await seedTestInstitution(t, { slug: "other-school" }),
      name: "O",
      username: "outsider",
    });
    const asOutsider = await withUser(t, outsider);
    await expect(
      asOutsider.query(api.parents.childMathPortrait, { scholarId: kai }),
    ).rejects.toThrow(/not a guardian/i);
  });
});

describe("parents.childMathPortrait — the parent Math page's fields", () => {
  test("overall level and pace, each area's new learning this term, and its three newest demonstrated skills", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    // Mele was enrolled well before the term, so the pace window is the whole term.
    const { institutionId, mele } = await atClock(now - 365 * DAY, async () => {
      const institutionId = await seedTestInstitution(t);
      const mele = await seedScholarInInstitution(t, { institutionId, name: "Mele", username: "mele" });
      return { institutionId, mele };
    });
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "A", username: "admin", role: "platform_admin" }),
    );
    const noa = await seedScholarInInstitution(t, { institutionId, name: "Noa", username: "noa" });
    await t.run(async (ctx) => {
      await ctx.db.patch(mele, { gradeLevel: "1" });
      await ctx.db.insert("reportingPeriods", {
        label: "Fall",
        startsAt: now - 30 * DAY,
        endsAt: now + 60 * DAY,
        status: "open",
        institutionId,
      });
    });
    for (const key of ["p1", "a0", "a1", "a2", "a3", "a4"]) await seedNode(t, key, WNA, "1");
    await seedMastery(t, mele, "p1", WNA, { source: "placement" });
    await seedMastery(t, mele, "a0", WNA); // fluent before the stamp existed
    await seedMastery(t, mele, "a1", WNA, { becameFluentAt: now - 40 * DAY }); // before the term
    await seedMastery(t, mele, "a2", WNA, { becameFluentAt: now - 20 * DAY });
    await seedMastery(t, mele, "a3", WNA, { becameFluentAt: now - 10 * DAY });
    await seedMastery(t, mele, "a4", WNA, { becameFluentAt: now - 5 * DAY });
    await seedNode(t, "f1", FRAC, "1");
    await seedMastery(t, mele, "f1", FRAC, { becameFluentAt: now - 5 * DAY });
    // a2 was missed twice before it went fluent: learned this term (grade 1 is
    // below the first grade not yet solid, so it takes two misses). a3, a4 and
    // f1 went fluent with no misses: already known, first shown this term.
    await t.run(async (ctx) => {
      for (const createdAt of [now - 25 * DAY, now - 24 * DAY]) {
        await ctx.db.insert("practiceAttempts", { scholarId: mele, nodeKey: "a2", correct: false, createdAt });
      }
    });

    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@example.com",
      scholarIds: [mele],
    });
    const { parentId: otherParent } = await asAdmin.mutation(api.parents.createParent, {
      name: "Q",
      email: "q@example.com",
      scholarIds: [noa],
    });

    const portrait = await (await withUser(t, parentId)).query(api.parents.childMathPortrait, {
      scholarId: mele,
    });
    const [wna, frac] = portrait.domains;
    expect(wna.gradeValue).toBeCloseTo(2.0);
    // Only the learned skill counts: one of the area's six grade-1 skills is
    // a sixth of a 10-month grade. The already-known a3 and a4 add nothing.
    expect(wna.termLearnedMonths).toBeCloseTo(10 / 6);
    // An area whose only new fluent skill was already known learned nothing new.
    expect(frac.domain).toBe(FRAC);
    expect(frac.termLearnedMonths).toBe(0);
    // Three newest demonstrated, newest first; the placement credit is never named.
    expect(wna.recentFluentSkillLabels).toEqual(["a4", "a3", "a2"]);
    expect(wna.fluentSkills).toBe(5);
    expect(wna.placementSkills).toBe(1);
    // The full list stays off the parent's payload.
    expect(wna).not.toHaveProperty("fluentSkillLabels");
    // The two stat tiles' inputs.
    expect(portrait.overall?.level?.value).toBeCloseTo(2.0);
    expect(portrait.overall?.enrolledGradeRank).toBe(1);
    expect(portrait.overall?.pace).toEqual(
      expect.objectContaining({ periodLabel: "Fall", periodStartsAt: now - 30 * DAY, learnedSkills: 1, knownSkills: 3 }),
    );

    // A parent who is not Mele's guardian is still refused.
    await expect(
      (await withUser(t, otherParent)).query(api.parents.childMathPortrait, { scholarId: mele }),
    ).rejects.toThrow(/not a guardian/i);
  });

  test("with no current term there is no new-this-term amount and no pace", async () => {
    const t = convexTest(schema, modules);
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "A", username: "admin", role: "platform_admin" }),
    );
    const kai = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "K", username: "kai" });
    await seedNode(t, "add", WNA, "1");
    await seedMastery(t, kai, "add", WNA, { becameFluentAt: Date.now() - DAY });
    const { parentId } = await (await withUser(t, admin)).mutation(api.parents.createParent, {
      name: "P",
      email: "p@example.com",
      scholarIds: [kai],
    });
    const portrait = await (await withUser(t, parentId)).query(api.parents.childMathPortrait, { scholarId: kai });
    expect(portrait.domains[0]).not.toHaveProperty("termLearnedMonths");
    expect(portrait.domains[0].recentFluentSkillLabels).toEqual(["add"]);
    expect(portrait.overall?.pace).toBeNull();
  });
});

// TRA-322: the parent aide's read names the skills behind the tile's "N skills
// fluent", so its list is exactly the set `fluentSkills` counts: equal when
// every counted skill has a catalog label, shorter otherwise, never longer, and
// never an internal skill key.
describe("mathPortrait.getScholarMathPortrait — the tile's skill list", () => {
  async function seedLabelledNodes(t: TC) {
    await t.run(async (ctx) => {
      for (const [nodeKey, label, domain, grade] of [
        ["add", "Add within 10", WNA, "1"],
        ["sub", "Subtract within 10", WNA, "1"],
        ["longdiv", "Long division", WNA, "5"],
        ["mult", "Multiply by 10", WNA, "4"],
        ["equiv", "Equivalent fractions", FRAC, "3"],
        ["blank_label", "  ", FRAC, "3"],
      ] as const) {
        await ctx.db.insert("knowledgeNodes", { nodeKey, label, domain, grade });
      }
    });
  }

  test("one label per counted skill: placement credits and unstarted skills stay out", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const scholar = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "S", username: "s6" });
    await seedLabelledNodes(t);
    await seedMastery(t, scholar, "add", WNA);
    await seedMastery(t, scholar, "longdiv", WNA, { becameFluentAt: now - 1000 });
    // A placement credit and a skill still being learned are not counted.
    await seedMastery(t, scholar, "sub", WNA, { source: "placement" });
    await seedMastery(t, scholar, "mult", WNA, { repetition: 0 });
    await seedMastery(t, scholar, "equiv", FRAC, { repetition: 0 });

    const portrait = await t.run((ctx) =>
      ctx.runQuery(internal.mathPortrait.getScholarMathPortrait, {
        scholarId: scholar,
        withFluentSkillLabels: true,
      }),
    );
    expect(portrait.domains.map((d) => d.domain)).toEqual([WNA, FRAC]);
    // Every counted skill is labelled here, so the list matches the count.
    for (const d of portrait.domains) {
      expect(d.fluentSkillLabels).toHaveLength(d.fluentSkills);
    }
    const [wna, frac] = portrait.domains;
    expect(wna.fluentSkills).toBe(2);
    expect([...(wna.fluentSkillLabels ?? [])].sort()).toEqual([
      "Add within 10",
      "Long division",
    ]);
    expect(frac.fluentSkills).toBe(0);
    expect(frac.fluentSkillLabels).toEqual([]);

    // Without the option (any other caller) there is no list at all.
    const plain = await t.run((ctx) =>
      ctx.runQuery(internal.mathPortrait.getScholarMathPortrait, { scholarId: scholar }),
    );
    expect(plain.domains[0]).not.toHaveProperty("fluentSkillLabels");
  });

  test("a counted skill with no usable label is counted but never named by its key", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "S", username: "s7" });
    await seedLabelledNodes(t);
    await seedMastery(t, scholar, "equiv", FRAC);
    // A blank catalog label, and a fluent row whose catalog node is missing.
    await seedMastery(t, scholar, "blank_label", FRAC);
    await seedMastery(t, scholar, "prime_composite", FRAC);

    const portrait = await t.run((ctx) =>
      ctx.runQuery(internal.mathPortrait.getScholarMathPortrait, {
        scholarId: scholar,
        withFluentSkillLabels: true,
      }),
    );
    const frac = portrait.domains[0];
    expect(frac.fluentSkills).toBe(3);
    expect(frac.fluentSkillLabels).toEqual(["Equivalent fractions"]);
    expect(frac.fluentSkillLabels!.length).toBeLessThanOrEqual(frac.fluentSkills);
  });
});
