import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";

// The Math Skills portrait, end-to-end over the DB: the teacher read
// (`forScholar`) and the guardian-gated parent read (`childMathPortrait`) share
// ONE gatherer, so both must see the same shape — per touched domain, the
// demonstrated-fluent grade + a REAL month-over-month trajectory (never a
// fabricated slope), and never a provisional credit inflating the grade. The
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
      ...(over.becameFluentAt !== undefined
        ? { becameFluentAt: over.becameFluentAt }
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
    // Frontier grade 5, 1 of grade 5's 2 catalog skills fluent → "Grade 5.5".
    expect(wna.gradeLabel).toBe("Grade 5.5");
    expect(wna.fluentSkills).toBe(2);
    // Growth reflects the real rise from the earliest known point to now: the
    // grade-1 catalog is fully consolidated back then (caps at .9), grade 5 now.
    expect(wna.growth).toEqual(
      expect.objectContaining({ fromLabel: "Grade 1.9", toLabel: "Grade 5.5" }),
    );
    // The series is monotonic non-decreasing and ends at the live value.
    const vals = wna.series.map((p) => p.value ?? -1);
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
    }
    expect(wna.series[wna.series.length - 1].value).toBe(wna.gradeValue);

    const frac = portrait.domains[1];
    expect(frac.gradeLabel).toBe("Grade 3.5");
    // A single fluency event this window → no rise yet → "Building history".
    expect(frac.growth).toBeNull();
  });

  test("a provisional (placement) credit never inflates the grade", async () => {
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
    expect(portrait.domains[0].gradeLabel).toBe("Grade 1.9");
    expect(portrait.domains[0].fluentSkills).toBe(1);
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
  test("a linked guardian reads their child; a non-guardian is refused", async () => {
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
    expect(portrait.domains[0].gradeLabel).toBe("Grade 1.9");

    // A teacher who is NOT a guardian of kai is refused.
    const teacher = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "T", username: "t4" });
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.query(api.parents.childMathPortrait, { scholarId: kai }),
    ).rejects.toThrow(/not a guardian/i);
  });
});
