import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FRACTION_ARITHMETIC_DOMAIN } from "../seed/fractionArithmeticGraph";
import { FLUENT_REPS } from "../lib/practice/scheduler";
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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId =
    role === "teacher"
      ? await seedStaffWithMembership(t, {
          institutionId,
          name: overrides.name ?? `Test ${role}`,
          username: overrides.username ?? `test${role}`,
        })
      : await seedScholarInInstitution(t, {
          institutionId,
          name: overrides.name ?? `Test ${role}`,
          username: overrides.username ?? `test${role}`,
        });
  await t.run((ctx) =>
    ctx.db.patch(userId, {
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );
  return userId;
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

async function seedNode(
  t: ReturnType<typeof convexTest>,
  domain: string,
  strand: string,
  nodeKey = `${domain}_${strand}`,
  grade?: string,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("knowledgeNodes", {
      nodeKey,
      label: nodeKey,
      domain,
      strand,
      grade,
    }),
  );
}

describe("mathFocus current checkpoints", () => {
    test("resolves a teacher override ahead of a group checkpoint", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      await seedNode(
        t,
        FRACTION_ARITHMETIC_DOMAIN,
        "comparison",
        "compare_fourths",
        "4",
      );
      await seedNode(
        t,
        FRACTION_ARITHMETIC_DOMAIN,
        "equivalence",
        "equivalent_fractions",
        "5",
      );
      const groupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Fraction Workshop",
          scholarIds: [scholarId],
        }),
      );
      const asTeacher = await withUser(t, teacherId);

      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
        groupId,
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      });
      let state = await asTeacher.query(api.mathFocus.checkpointForScholar, {
        scholarId,
      });
      expect(state.effective).toMatchObject({
        source: "group",
        strand: "comparison",
        grade: "4",
      });
      await asTeacher.mutation(api.mathFocus.setScholarCheckpointOverride, {
        scholarId,
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "equivalence",
        grade: "5",
      });
      state = await asTeacher.query(api.mathFocus.checkpointForScholar, {
        scholarId,
      });
      expect(state.effective).toMatchObject({
        source: "teacher",
        strand: "equivalence",
        grade: "5",
      });

      await asTeacher.mutation(api.mathFocus.clearScholarCheckpointOverride, {
        scholarId,
      });
      state = await asTeacher.query(api.mathFocus.checkpointForScholar, {
        scholarId,
      });
      expect(state.effective).toMatchObject({
        source: "group",
        strand: "comparison",
      });
    });

    test("checkpointForScholar is teacher-only (a scholar cannot read their own steer)", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      await t.run((ctx) =>
        ctx.db.insert("scholarCheckpointOverride", {
          scholarId,
          domain: FRACTION_ARITHMETIC_DOMAIN,
          strand: "comparison",
          grade: "4",
          source: "teacher",
          updatedBy: teacherId,
          updatedAt: 1,
        }),
      );

      // The steer target is a teacher-facing planning signal, not something the
      // scholar should read about themselves — the query is teacherQuery-gated.
      const asScholar = await withUser(t, scholarId);
      await expect(
        asScholar.query(api.mathFocus.checkpointForScholar, { scholarId }),
      ).rejects.toThrow("teacher or admin role required");

      const asTeacher = await withUser(t, teacherId);
      const state = await asTeacher.query(
        api.mathFocus.checkpointForScholar,
        { scholarId },
      );
      expect(state.effective).toMatchObject({
        source: "teacher",
        strand: "comparison",
      });
    });

    test("rejects every group checkpoint surface before exposing foreign preview members", async () => {
      const t = convexTest(schema, modules);
      const schoolA = await seedTestInstitution(t, {
        slug: "math-focus-school-a",
        isPrimary: true,
      });
      const schoolB = await seedTestInstitution(t, {
        slug: "math-focus-school-b",
      });
      const teacherA = await seedStaffWithMembership(t, {
        institutionId: schoolA,
        username: "math-focus-teacher-a",
      });
      const teacherB = await seedStaffWithMembership(t, {
        institutionId: schoolB,
        username: "math-focus-teacher-b",
      });
      const scholarB = await seedScholarInInstitution(t, {
        institutionId: schoolB,
        username: "math-focus-scholar-b",
      });
      const foreignGroup = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId: teacherB,
          institutionId: schoolB,
          name: "Foreign group",
          scholarIds: [scholarB],
        }),
      );
      const asTeacherA = await withUser(t, teacherA);

      await expect(
        asTeacherA.query(api.mathFocus.checkpointForGroup, {
          groupId: foreignGroup,
          target: {
            domain: FRACTION_ARITHMETIC_DOMAIN,
            strand: "comparison",
            grade: "4",
          },
        }),
      ).rejects.toThrow("Forbidden: group is not in your institution");
      await expect(
        asTeacherA.query(api.mathFocus.checkpointModesForScope, {
          groupId: foreignGroup,
        }),
      ).rejects.toThrow("Forbidden: group is not in your institution");
      await expect(
        asTeacherA.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId: foreignGroup,
          domain: FRACTION_ARITHMETIC_DOMAIN,
          strand: "comparison",
          grade: "4",
        }),
      ).rejects.toThrow("Forbidden: group is not in your institution");
      await expect(
        asTeacherA.mutation(api.mathFocus.clearGroupCheckpoint, {
          groupId: foreignGroup,
        }),
      ).rejects.toThrow("Forbidden: group is not in your institution");
    });

    test("filters stale and non-scholar members, rejects set, and still permits clear", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      const target = {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      };
      await seedNode(t, target.domain, target.strand, "valid_member_node", target.grade);
      const missingId = await seedUser(t);
      await t.run((ctx) => ctx.db.delete(missingId));
      const groupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Stale members",
          // This malformed durable row predates current group-write validation.
          scholarIds: [scholarId, missingId, teacherId],
        }),
      );
      const asTeacher = await withUser(t, teacherId);

      await expect(
        asTeacher.query(api.mathFocus.checkpointForGroup, { groupId, target }),
      ).resolves.toMatchObject({
        members: {
          total: 1,
          following: 1,
          keepingOwn: 0,
          none: 0,
          blockedByScope: [],
          blockedByGroup: [],
        },
      });
      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, { groupId, ...target }),
      ).rejects.toThrow("Forbidden: scholar is not in your current context");
      await t.run((ctx) =>
        ctx.db.insert("mathGroupCheckpoint", {
          groupId,
          ...target,
          updatedBy: teacherId,
          updatedAt: Date.now(),
        }),
      );
      await expect(
        asTeacher.mutation(api.mathFocus.clearGroupCheckpoint, { groupId }),
      ).resolves.toEqual({ removed: 1 });
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("mathGroupCheckpoint")
            .withIndex("by_group", (q) => q.eq("groupId", groupId))
            .collect(),
        ),
      ).toHaveLength(0);

      const nonScholarGroupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Non-scholar member",
          scholarIds: [scholarId, teacherId],
        }),
      );
      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId: nonScholarGroupId,
          ...target,
        }),
      ).rejects.toThrow("Group contains an invalid scholar member.");
    });

    test("does not leak an inaccessible member from an otherwise local group preview", async () => {
      const t = convexTest(schema, modules);
      const schoolA = await seedTestInstitution(t, {
        slug: "math-focus-preview-a",
        isPrimary: true,
      });
      const schoolB = await seedTestInstitution(t, {
        slug: "math-focus-preview-b",
      });
      const teacherA = await seedStaffWithMembership(t, {
        institutionId: schoolA,
        username: "math-focus-preview-teacher-a",
      });
      const localScholar = await seedScholarInInstitution(t, {
        institutionId: schoolA,
        username: "math-focus-preview-local",
      });
      const foreignScholar = await seedScholarInInstitution(t, {
        institutionId: schoolB,
        username: "math-focus-preview-foreign",
        name: "Foreign scholar must not leak",
      });
      const groupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId: teacherA,
          institutionId: schoolA,
          name: "Mixed stale group",
          scholarIds: [localScholar, foreignScholar],
        }),
      );
      const asTeacherA = await withUser(t, teacherA);

      const preview = await asTeacherA.query(api.mathFocus.checkpointForGroup, {
        groupId,
      });
      expect(preview.members).toMatchObject({
        total: 1,
        following: 1,
        keepingOwn: 0,
        none: 0,
        blockedByScope: [],
        blockedByGroup: [],
      });
      expect(JSON.stringify(preview)).not.toContain("Foreign scholar must not leak");
      await t.run((ctx) =>
        ctx.db.insert("mathGroupCheckpoint", {
          groupId,
          domain: FRACTION_ARITHMETIC_DOMAIN,
          strand: "comparison",
          grade: "4",
          updatedBy: teacherA,
          updatedAt: Date.now(),
        }),
      );
      await expect(
        asTeacherA.mutation(api.mathFocus.clearGroupCheckpoint, { groupId }),
      ).resolves.toEqual({ removed: 1 });
    });

    test("canonicalizes duplicate math plans while changing checkpoint overrides", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t, "scholar");
      await seedNode(
        t,
        FRACTION_ARITHMETIC_DOMAIN,
        "comparison",
        "compare_fourths",
        "4",
      );
      const asTeacher = await withUser(t, teacherId);
      const limitedScope = {
        kind: "limited" as const,
        domains: [{ domain: FRACTION_ARITHMETIC_DOMAIN }],
      };
      await t.run(async (ctx) => {
        await ctx.db.insert("scholarMathPlans", {
          scholarId,
          practiceScope: { kind: "open" },
          checkpointSuppressed: true,
          updatedBy: teacherId,
          updatedAt: 1,
        });
        await ctx.db.insert("scholarMathPlans", {
          scholarId,
          practiceScope: limitedScope,
          checkpointSuppressed: true,
          updatedBy: teacherId,
          updatedAt: 2,
        });
      });

      await asTeacher.mutation(api.mathFocus.setScholarCheckpointOverride, {
        scholarId,
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      });
      let plans = await t.run((ctx) =>
        ctx.db
          .query("scholarMathPlans")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .collect(),
      );
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        practiceScope: limitedScope,
        checkpointSuppressed: false,
      });

      await t.run((ctx) =>
        ctx.db.insert("scholarMathPlans", {
          scholarId,
          practiceScope: { kind: "open" },
          checkpointSuppressed: true,
          updatedBy: teacherId,
          updatedAt: Date.now() + 10_000,
        }),
      );
      await asTeacher.mutation(api.mathFocus.clearScholarCheckpointOverride, {
        scholarId,
      });
      plans = await t.run((ctx) =>
        ctx.db
          .query("scholarMathPlans")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .collect(),
      );
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        practiceScope: { kind: "open" },
        checkpointSuppressed: false,
      });
    });

    test("derives toward then deeper from strict fluency across the checkpoint band", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      const domain = FRACTION_ARITHMETIC_DOMAIN;
      const strand = "equivalence";
      const grade = "5";
      await seedNode(t, domain, strand, "equivalent_halves", grade);
      await seedNode(t, domain, strand, "equivalent_fourths", grade);
      const groupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Equivalence",
          scholarIds: [scholarId],
        }),
      );
      const asTeacher = await withUser(t, teacherId);
      const asScholar = await withUser(t, scholarId);
      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
        groupId,
        domain,
        strand,
        grade,
      });
      const seedSolid = async (skillKey: string) => {
        const now = Date.now();
        await t.run((ctx) =>
          ctx.db.insert("practiceMastery", {
            scholarId,
            skillKey,
            domain,
            strand,
            repetition: FLUENT_REPS,
            halfLifeDays: 30,
            lastPracticedAt: now,
            frontier: false,
            source: "practice",
            updatedAt: now,
          }),
        );
      };

      await seedSolid("equivalent_halves");
      expect(await asScholar.query(api.mathFocus.myMathCheckpoint, {})).toMatchObject({
        mode: "toward",
        bandSolid: 1,
        bandTotal: 2,
      });
      expect(
        await asTeacher.query(api.mathFocus.checkpointModesForScope, {
          groupId,
        }),
      ).toEqual([
        {
          scholarId,
          domain,
          strand,
          grade,
          mode: "toward",
          bandSolid: 1,
          bandTotal: 2,
        },
      ]);

      await seedSolid("equivalent_fourths");
      expect(await asScholar.query(api.mathFocus.myMathCheckpoint, {})).toMatchObject({
        mode: "deeper",
        bandSolid: 2,
        bandTotal: 2,
      });
      expect(
        await asTeacher.query(api.mathFocus.checkpointModesForScope, {
          groupId,
        }),
      ).toEqual([
        {
          scholarId,
          domain,
          strand,
          grade,
          mode: "deeper",
          bandSolid: 2,
          bandTotal: 2,
        },
      ]);
    });

    test("derives a domain checkpoint across every strand at the target grade", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      const domain = FRACTION_ARITHMETIC_DOMAIN;
      const grade = "3";
      await seedNode(t, domain, "concept", "fraction_parts", grade);
      await seedNode(t, domain, "equivalence", "equivalent_parts", grade);
      await seedNode(t, domain, "comparison", "compare_parts", grade);
      await seedNode(t, domain, "comparison", "compare_fourths", "4");
      const groupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Whole Domain",
          scholarIds: [scholarId],
        }),
      );
      const asTeacher = await withUser(t, teacherId);
      const asScholar = await withUser(t, scholarId);
      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
        groupId,
        domain,
        grade,
      });
      const seedSolid = async (skillKey: string, strand: string) => {
        const now = Date.now();
        await t.run((ctx) =>
          ctx.db.insert("practiceMastery", {
            scholarId,
            skillKey,
            domain,
            strand,
            repetition: FLUENT_REPS,
            halfLifeDays: 30,
            lastPracticedAt: now,
            frontier: false,
            source: "practice",
            updatedAt: now,
          }),
        );
      };

      await seedSolid("fraction_parts", "concept");
      const toward = await asScholar.query(api.mathFocus.myMathCheckpoint, {});
      expect(toward).toMatchObject({
        domain,
        grade,
        strandLabel: "Fractions",
        mode: "toward",
        bandSolid: 1,
        bandTotal: 3,
      });
      expect(toward?.strand).toBeUndefined();
      expect(
        await asTeacher.query(api.mathFocus.checkpointForScholar, {
          scholarId,
        }),
      ).toMatchObject({
        effective: { domain, grade, source: "group" },
        mode: "toward",
        bandSolid: 1,
        bandTotal: 3,
      });

      await seedSolid("equivalent_parts", "equivalence");
      await seedSolid("compare_parts", "comparison");
      expect(
        await asTeacher.query(api.mathFocus.checkpointModesForScope, {
          groupId,
        }),
      ).toEqual([
        {
          scholarId,
          domain,
          grade,
          mode: "deeper",
          bandSolid: 3,
          bandTotal: 3,
        },
      ]);
    });

    test("checkpointOptions includes one whole-domain row per grade", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const domain = FRACTION_ARITHMETIC_DOMAIN;
      await seedNode(t, domain, "concept", "parts_grade_3", "3");
      await seedNode(t, domain, "equivalence", "equivalence_grade_3", "3");
      await seedNode(t, domain, "equivalence", "equivalence_grade_4", "4");
      const asTeacher = await withUser(t, teacherId);

      const options = await asTeacher.query(
        api.mathFocus.checkpointOptions,
        { domain },
      );
      expect(options).toEqual(
        expect.arrayContaining([
          { domain, grade: "3", nodeCount: 2 },
          { domain, grade: "4", nodeCount: 1 },
          {
            domain,
            strand: "concept",
            grade: "3",
            nodeCount: 1,
          },
          {
            domain,
            strand: "equivalence",
            grade: "3",
            nodeCount: 1,
          },
        ]),
      );
    });

    test("validates checkpoint identity and prevents overlapping math groups", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      await seedNode(
        t,
        FRACTION_ARITHMETIC_DOMAIN,
        "comparison",
        "compare_fourths",
        "4",
      );
      const [firstGroup, secondGroup] = await t.run(async (ctx) => [
        await ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Morning Math",
          scholarIds: [scholarId],
        }),
        await ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Afternoon Math",
          scholarIds: [scholarId],
        }),
      ]);
      const asTeacher = await withUser(t, teacherId);

      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId: firstGroup,
          domain: FRACTION_ARITHMETIC_DOMAIN,
          strand: "comparison",
          grade: "7",
        }),
      ).rejects.toThrow("does not exist");

      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
        groupId: firstGroup,
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      });
      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId: secondGroup,
          domain: FRACTION_ARITHMETIC_DOMAIN,
          strand: "comparison",
          grade: "4",
        }),
      ).rejects.toThrow('already in the math group "Morning Math"');
    });

    test("previews full group membership by stored checkpoint precedence", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const followingId = await seedUser(t, "scholar", {
        username: "preview-following",
        name: "Following Scholar",
      });
      const overrideId = await seedUser(t, "scholar", {
        username: "preview-override",
        name: "Override Scholar",
      });
      const suppressedId = await seedUser(t, "scholar", {
        username: "preview-suppressed",
        name: "Suppressed Scholar",
      });
      const target = {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      };
      await seedNode(t, target.domain, target.strand, "preview_compare_fourths", target.grade);
      const groupId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Preview group",
          scholarIds: [followingId, overrideId, suppressedId],
        });
        await ctx.db.insert("scholarCheckpointOverride", {
          scholarId: overrideId,
          ...target,
          source: "teacher",
          updatedBy: teacherId,
          updatedAt: 1,
        });
        await ctx.db.insert("scholarMathPlans", {
          scholarId: suppressedId,
          practiceScope: { kind: "open" },
          checkpointSuppressed: true,
          updatedBy: teacherId,
          updatedAt: 1,
        });
        return id;
      });
      const asTeacher = await withUser(t, teacherId);

      const proposed = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
        target,
      });
      expect(proposed).toMatchObject({
        groupId,
        checkpoint: null,
        duplicateCount: 0,
        members: {
          total: 3,
          following: 1,
          keepingOwn: 1,
          none: 1,
          blockedByScope: [],
          blockedByGroup: [],
        },
      });

      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, { groupId, ...target });
      // Existing callers omit target; they retain the old group checkpoint fields
      // and now receive the same full-membership accounting.
      const current = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
      });
      expect(current).toMatchObject({
        groupId,
        checkpoint: target,
        duplicateCount: 0,
        members: {
          total: 3,
          following: 1,
          keepingOwn: 1,
          none: 1,
          blockedByScope: [],
          blockedByGroup: [],
        },
      });
    });

    test("set rejects stale previews after a checkpoint appears or is cleared, then accepts a fresh preview", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      const firstTarget = {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      };
      const secondTarget = { ...firstTarget, grade: "5" };
      await seedNode(t, firstTarget.domain, firstTarget.strand, "stale_set_fourths", "4");
      await seedNode(t, secondTarget.domain, secondTarget.strand, "stale_set_fifths", "5");
      const groupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Stale set group",
          scholarIds: [scholarId],
        }),
      );
      const asTeacher = await withUser(t, teacherId);

      const emptyPreview = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
        target: firstTarget,
      });
      await t.run((ctx) =>
        ctx.db.insert("mathGroupCheckpoint", {
          groupId,
          ...firstTarget,
          updatedBy: teacherId,
          updatedAt: 10,
        }),
      );
      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId,
          ...secondTarget,
          expectedUpdatedAt: emptyPreview.checkpoint?.updatedAt ?? null,
        }),
      ).rejects.toThrow(
        "Group checkpoint changed while this confirmation was open. Review it and try again.",
      );

      const rowPreview = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
        target: secondTarget,
      });
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("mathGroupCheckpoint")
          .withIndex("by_group", (q) => q.eq("groupId", groupId))
          .unique();
        await ctx.db.delete(row!._id);
      });
      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId,
          ...secondTarget,
          expectedUpdatedAt: rowPreview.checkpoint?.updatedAt ?? null,
        }),
      ).rejects.toThrow(
        "Group checkpoint changed while this confirmation was open. Review it and try again.",
      );

      const freshPreview = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
        target: secondTarget,
      });
      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
        groupId,
        ...secondTarget,
        expectedUpdatedAt: freshPreview.checkpoint?.updatedAt ?? null,
      });
      expect(
        (await asTeacher.query(api.mathFocus.checkpointForGroup, { groupId })).checkpoint,
      ).toMatchObject(secondTarget);
    });

    test("clear rejects a moved checkpoint from a stale preview, then accepts a fresh preview", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t);
      const firstTarget = {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      };
      const secondTarget = { ...firstTarget, grade: "5" };
      await seedNode(t, firstTarget.domain, firstTarget.strand, "stale_clear_fourths", "4");
      await seedNode(t, secondTarget.domain, secondTarget.strand, "stale_clear_fifths", "5");
      const groupId = await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Stale clear group",
          scholarIds: [scholarId],
        }),
      );
      const asTeacher = await withUser(t, teacherId);
      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
        groupId,
        ...firstTarget,
      });

      const preview = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
      });
      await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
        groupId,
        ...secondTarget,
        expectedUpdatedAt: preview.checkpoint?.updatedAt ?? null,
      });
      await expect(
        asTeacher.mutation(api.mathFocus.clearGroupCheckpoint, {
          groupId,
          expectedUpdatedAt: preview.checkpoint?.updatedAt ?? null,
        }),
      ).rejects.toThrow(
        "Group checkpoint changed while this confirmation was open. Review it and try again.",
      );

      const freshPreview = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
      });
      await asTeacher.mutation(api.mathFocus.clearGroupCheckpoint, {
        groupId,
        expectedUpdatedAt: freshPreview.checkpoint?.updatedAt ?? null,
      });
      expect(
        (await asTeacher.query(api.mathFocus.checkpointForGroup, { groupId })).checkpoint,
      ).toBeNull();
    });

    test("previews scope blockers and rejects the same proposed checkpoint", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t, "scholar", {
        username: "scope-blocked",
        name: "Scope Blocked",
      });
      const target = {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      };
      await seedNode(t, target.domain, target.strand, "scope_blocked_node", target.grade);
      const groupId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Scoped group",
          scholarIds: [scholarId],
        });
        await ctx.db.insert("scholarMathPlans", {
          scholarId,
          practiceScope: {
            kind: "limited",
            domains: [{ domain: "whole-number-arithmetic" }],
          },
          updatedBy: teacherId,
          updatedAt: 1,
        });
        return id;
      });
      const asTeacher = await withUser(t, teacherId);

      const preview = await asTeacher.query(api.mathFocus.checkpointForGroup, {
        groupId,
        target,
      });
      expect(preview.members.blockedByScope).toEqual([
        { scholarId, name: "Scope Blocked" },
      ]);
      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, { groupId, ...target }),
      ).rejects.toThrow(
        "Not set: Scope Blocked has a Practice scope that excludes this checkpoint.",
      );
    });

    test("previews conflicting groups and rechecks membership at set time", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const initialMemberId = await seedUser(t, "scholar", {
        username: "initial-member",
      });
      const conflictingMemberId = await seedUser(t, "scholar", {
        username: "conflicting-member",
        name: "Conflicting Scholar",
      });
      const target = {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        strand: "comparison",
        grade: "4",
      };
      await seedNode(t, target.domain, target.strand, "conflicting_group_node", target.grade);
      const { targetGroupId, conflictingGroupId } = await t.run(async (ctx) => {
        const targetGroupId = await ctx.db.insert("scholarGroups", {
          teacherId,
          name: "New math group",
          scholarIds: [initialMemberId],
        });
        const conflictingGroupId = await ctx.db.insert("scholarGroups", {
          teacherId,
          name: "Existing math group",
          scholarIds: [conflictingMemberId],
        });
        await ctx.db.insert("mathGroupCheckpoint", {
          groupId: conflictingGroupId,
          ...target,
          updatedBy: teacherId,
          updatedAt: 1,
        });
        return { targetGroupId, conflictingGroupId };
      });
      const asTeacher = await withUser(t, teacherId);

      const beforeMembershipChange = await asTeacher.query(
        api.mathFocus.checkpointForGroup,
        { groupId: targetGroupId, target },
      );
      expect(beforeMembershipChange.members.blockedByGroup).toEqual([]);

      await t.run((ctx) =>
        ctx.db.patch(targetGroupId, {
          scholarIds: [initialMemberId, conflictingMemberId],
        }),
      );
      const afterMembershipChange = await asTeacher.query(
        api.mathFocus.checkpointForGroup,
        { groupId: targetGroupId, target },
      );
      expect(afterMembershipChange.members.blockedByGroup).toEqual([
        {
          scholarId: conflictingMemberId,
          name: "Conflicting Scholar",
          groupName: "Existing math group",
        },
      ]);
      await expect(
        asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId: targetGroupId,
          ...target,
        }),
      ).rejects.toThrow('already in the math group "Existing math group"');

      expect(await t.run((ctx) => ctx.db.get(conflictingGroupId))).not.toBeNull();
    });

    test("membership writes reject a second checkpoint-bearing math group", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const firstScholar = await seedUser(t, "scholar", { username: "first" });
      const secondScholar = await seedUser(t, "scholar", { username: "second" });
      await seedNode(
        t,
        FRACTION_ARITHMETIC_DOMAIN,
        "comparison",
        "compare_fourths",
        "4",
      );
      const asTeacher = await withUser(t, teacherId);
      const firstGroup = await asTeacher.mutation(api.scholarGroups.create, {
        name: "Morning Math",
        scholarIds: [firstScholar],
      });
      const secondGroup = await asTeacher.mutation(api.scholarGroups.create, {
        name: "Afternoon Math",
        scholarIds: [secondScholar],
      });
      for (const groupId of [firstGroup, secondGroup]) {
        await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId,
          domain: FRACTION_ARITHMETIC_DOMAIN,
          strand: "comparison",
          grade: "4",
        });
      }

      await expect(
        asTeacher.mutation(api.scholarGroups.addScholar, {
          groupId: secondGroup,
          scholarId: firstScholar,
        }),
      ).rejects.toThrow('already in the math group "Morning Math"');
      await expect(
        asTeacher.mutation(api.scholarGroups.setScholars, {
          groupId: secondGroup,
          scholarIds: [secondScholar, firstScholar],
        }),
      ).rejects.toThrow('already in the math group "Morning Math"');
    });

    test("cloning a scholar cannot mirror into a second checkpoint-bearing math group", async () => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const sourceScholar = await seedUser(t, "scholar", {
        username: "clone-source",
      });
      const targetScholar = await seedUser(t, "scholar", {
        username: "clone-target",
        name: "Clone Target",
      });
      await seedNode(
        t,
        FRACTION_ARITHMETIC_DOMAIN,
        "comparison",
        "compare_fourths",
        "4",
      );
      const asTeacher = await withUser(t, teacherId);
      const sourceGroup = await asTeacher.mutation(api.scholarGroups.create, {
        name: "Source Math",
        scholarIds: [sourceScholar],
      });
      const targetGroup = await asTeacher.mutation(api.scholarGroups.create, {
        name: "Target Math",
        scholarIds: [targetScholar],
      });
      for (const groupId of [sourceGroup, targetGroup]) {
        await asTeacher.mutation(api.mathFocus.setGroupCheckpoint, {
          groupId,
          domain: FRACTION_ARITHMETIC_DOMAIN,
          strand: "comparison",
          grade: "4",
        });
      }

      // Mirroring the source's checkpoint-bearing group onto the clone target,
      // who is already in a different checkpoint-bearing group, must be blocked
      // — and because a Convex mutation is one atomic transaction, the throw
      // rolls back the entire clone.
      await expect(
        t.mutation(internal.adminCloneScholar.cloneScholar, {
          sourceUserId: sourceScholar,
          targetUsername: "clone-target",
          targetName: "Clone Target",
        }),
      ).rejects.toThrow('already in the math group "Target Math"');

      const sourceGroupRow = await t.run((ctx) => ctx.db.get(sourceGroup));
      expect(sourceGroupRow?.scholarIds).not.toContain(targetScholar);
    });
});
