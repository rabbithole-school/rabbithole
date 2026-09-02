import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const DOMAIN = "test-arithmetic";

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedAccessContext(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Test School",
      slug: `test-${Math.random().toString(36).slice(2, 8)}`,
      kind: "school",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Test Teacher",
      username: `teacher-${Math.random().toString(36).slice(2, 8)}`,
      role: "teacher",
      institutionId,
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Test Scholar",
      username: `scholar-${Math.random().toString(36).slice(2, 8)}`,
      role: "scholar",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: scholarId,
      role: "scholar",
      institutionId,
    });
    return { teacherId, scholarId };
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Knowledge-state test",
      isArchived: false,
    }),
  );
}

function observationArgs(
  scholarId: Id<"users">,
  sessionId: Id<"sessions">,
  conceptLabel: string,
) {
  return {
    scholarId,
    sessionId,
    conceptLabel,
    domain: DOMAIN,
    transcriptExcerpt: "test evidence",
    masteryLevel: 3,
    confidenceScore: 0.9,
    evidenceSummary: "Demonstrated in a test.",
    evidenceType: "direct_demonstration",
    attemptContext: "conversation",
    studentInitiated: true,
  };
}

describe("knowledgeState", () => {
  test("observer and teacher writes stamp confident matches and leave unknown concepts unjoined", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedAccessContext(t);
    const sessionId = await seedSession(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "equivalent_fractions",
        label: "Equivalent fractions",
        normalizedLabel: "equivalent fractions",
        domain: DOMAIN,
        strand: "equivalence",
        matchKeywords: ["fair trades"],
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "fraction_number_line",
        label: "Fractions on a number line",
        domain: DOMAIN,
        strand: "concept",
      });
    });

    const exactId = await t.mutation(
      internal.masteryObservations.record,
      observationArgs(scholarId, sessionId, "Equivalent fractions"),
    );
    const keywordId = await t.mutation(
      internal.masteryObservations.record,
      observationArgs(scholarId, sessionId, "Explains fair trades with visual models"),
    );
    const fuzzyId = await t.mutation(
      internal.masteryObservations.record,
      observationArgs(scholarId, sessionId, "Number line models"),
    );
    const ambiguousId = await t.mutation(
      internal.masteryObservations.record,
      observationArgs(scholarId, sessionId, "Fractions"),
    );
    const asTeacher = await withUser(t, teacherId);
    const teacherFlagId = await asTeacher.mutation(
      api.masteryObservations.flagMisconception,
      {
        scholarId,
        conceptLabel: "Equivalent fractions",
        domain: DOMAIN,
      },
    );

    const [exact, keyword, fuzzy, ambiguous, teacherFlag] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(exactId),
        ctx.db.get(keywordId),
        ctx.db.get(fuzzyId),
        ctx.db.get(ambiguousId),
        ctx.db.get(teacherFlagId),
      ]),
    );
    expect(exact?.nodeKey).toBe("equivalent_fractions");
    expect(keyword?.nodeKey).toBe("equivalent_fractions");
    expect(fuzzy?.nodeKey).toBe("fraction_number_line");
    expect(ambiguous?.nodeKey).toBeUndefined();
    expect(teacherFlag?.nodeKey).toBe("equivalent_fractions");
  });

  test("forScholarNode composes practice, observer, and teacher override readings", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedAccessContext(t);
    const sessionId = await seedSession(t, scholarId);
    const now = Date.now();
    const observationId = await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: "addition_facts",
        domain: DOMAIN,
        strand: "add-subtract",
        repetition: 3,
        halfLifeDays: 30,
        lastPracticedAt: now,
        frontier: false,
        source: "practice",
        updatedAt: now,
        becameFluentAt: now - DAY_MS,
      });
      const id = await ctx.db.insert("masteryObservations", {
        scholarId,
        nodeKey: "addition_facts",
        conceptLabel: "Addition facts",
        domain: "Mathematics",
        observedAt: now,
        sessionId,
        transcriptExcerpt: "6 + 7 is 13",
        masteryLevel: 3.5,
        confidenceScore: 0.95,
        evidenceSummary: "Used a make-ten strategy.",
        evidenceType: "direct_demonstration",
        attemptContext: "conversation",
        studentInitiated: true,
        isSuperseded: false,
        fluencyLevel: 2,
      });
      await ctx.db.insert("teacherMasteryOverrides", {
        scholarId,
        observationId: id,
        teacherId,
        masteryLevel: 4,
        notes: "Confirmed in class.",
      });
      return id;
    });

    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.knowledgeState.forScholarNode, {
      scholarId,
      nodeKey: "addition_facts",
    });

    expect(result.practice).toMatchObject({
      band: "fluent",
      repetition: 3,
      due: false,
      source: "practice",
      becameFluentAt: now - DAY_MS,
    });
    expect(result.observer).toEqual({
      masteryLevel: 3.5,
      confidenceScore: 0.95,
      evidenceCount: 1,
      fluencyLevel: 2,
      latestAt: now,
    });
    expect(result.teacherOverride).toMatchObject({
      observationId,
      masteryLevel: 4,
      notes: "Confirmed in class.",
    });
  });

  test("subjectRollup summarizes strands and groups recurring errors per node", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedAccessContext(t);
    const sessionId = await seedSession(t, scholarId);
    const now = Date.now();

    await t.run(async (ctx) => {
      const nodes = [
        {
          nodeKey: "addition_facts",
          label: "Addition facts",
          strand: "add-subtract",
          order: 0,
        },
        {
          nodeKey: "subtraction_facts",
          label: "Subtraction facts",
          strand: "add-subtract",
          order: 1,
        },
        {
          nodeKey: "regrouping",
          label: "Regrouping",
          strand: "add-subtract",
          order: 2,
        },
        {
          nodeKey: "multiplication_facts",
          label: "Multiplication facts",
          strand: "mult-divide",
          order: 3,
        },
      ];
      for (const node of nodes) {
        await ctx.db.insert("knowledgeNodes", { ...node, domain: DOMAIN });
      }

      const mastery: Array<
        Pick<
          Doc<"practiceMastery">,
          | "skillKey"
          | "strand"
          | "repetition"
          | "halfLifeDays"
          | "lastPracticedAt"
          | "frontier"
          | "source"
        >
      > = [
        {
          skillKey: "addition_facts",
          strand: "add-subtract",
          repetition: 3,
          halfLifeDays: 30,
          lastPracticedAt: now,
          frontier: false,
          source: "practice",
        },
        {
          skillKey: "subtraction_facts",
          strand: "add-subtract",
          repetition: 0,
          halfLifeDays: 0,
          frontier: true,
          source: "placement",
        },
        {
          skillKey: "regrouping",
          strand: "add-subtract",
          repetition: 3,
          halfLifeDays: 1,
          lastPracticedAt: now - 20 * DAY_MS,
          frontier: false,
          source: "practice",
        },
        {
          skillKey: "multiplication_facts",
          strand: "mult-divide",
          repetition: 3,
          halfLifeDays: 4,
          lastPracticedAt: now,
          frontier: false,
          source: "placement",
        },
      ];
      for (const row of mastery) {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          domain: DOMAIN,
          updatedAt: now,
          ...row,
        });
      }

      await ctx.db.insert("masteryObservations", {
        scholarId,
        nodeKey: "addition_facts",
        conceptLabel: "Fast addition facts",
        domain: "Mathematics",
        observedAt: now,
        sessionId,
        transcriptExcerpt: "9 + 8 is 17",
        masteryLevel: 3,
        confidenceScore: 0.85,
        evidenceSummary: "Used known facts.",
        evidenceType: "direct_demonstration",
        attemptContext: "conversation",
        studentInitiated: true,
        isSuperseded: false,
      });

      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("practiceErrorEvents", {
          scholarId,
          nodeKey: "regrouping",
          domain: DOMAIN,
          pattern: "DROPPED_CARRY",
          itemId: `regroup-${i}`,
          createdAt: now - i * DAY_MS,
        });
      }
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("practiceErrorEvents", {
          scholarId,
          nodeKey: "multiplication_facts",
          domain: DOMAIN,
          pattern: "DROPPED_CARRY",
          itemId: `multiply-${i}`,
          createdAt: now - i * DAY_MS,
        });
      }
      await ctx.db.insert("practiceErrorEvents", {
        scholarId,
        nodeKey: "multiplication_facts",
        domain: DOMAIN,
        pattern: "DROPPED_CARRY",
        itemId: "multiply-stale",
        createdAt: now - 15 * DAY_MS,
      });
    });

    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.knowledgeState.subjectRollup, {
      scholarId,
      domain: DOMAIN,
    });

    expect(result.strands.find((strand) => strand.strand === "add-subtract")).toEqual({
      strand: "add-subtract",
      strandHeadline: "Addition & Subtraction",
      frontierSkill: { key: "subtraction_facts", label: "Subtraction facts" },
      fluentCount: 1,
      totalCount: 3,
      dueCount: 1,
      confirmingCount: 0,
    });
    expect(result.strands.find((strand) => strand.strand === "mult-divide")).toEqual({
      strand: "mult-divide",
      strandHeadline: "Multiplication & Division",
      frontierSkill: null,
      fluentCount: 0,
      totalCount: 1,
      dueCount: 0,
      confirmingCount: 1,
    });
    expect(result.openMisconceptions).toHaveLength(1);
    expect(result.openMisconceptions[0]).toMatchObject({
      nodeKey: "regrouping",
      skillLabel: "Regrouping",
      pattern: "DROPPED_CARRY",
      count14d: 3,
    });
    expect(result.openMisconceptions[0].phrasing).toContain("carry");
    expect(result.observerHighlights).toEqual([
      {
        conceptLabel: "Fast addition facts",
        nodeKey: "addition_facts",
        masteryLevel: 3,
        latestAt: now,
      },
    ]);
  });

  test("teacher queries reject scholar callers", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedAccessContext(t);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asTeacher.query(api.knowledgeState.subjectRollup, {
        scholarId,
        domain: DOMAIN,
      }),
    ).resolves.toMatchObject({ strands: [] });
    await expect(
      asScholar.query(api.knowledgeState.subjectRollup, {
        scholarId,
        domain: DOMAIN,
      }),
    ).rejects.toThrow();
  });
});
