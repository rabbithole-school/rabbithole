import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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
  role: "scholar" | "teacher",
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  return role === "teacher"
    ? seedStaffWithMembership(t, { institutionId, name: "Ms. Rivera", username })
    : seedScholarInInstitution(t, { institutionId, name: "Kai", username });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedHomework(
  t: ReturnType<typeof convexTest>,
  {
    teacherId,
    scholarIds,
    kind = "offline",
    mode = "homework",
    setAt = Date.now() - 60_000,
    planned = false,
    endsAt,
    entryScholarIds,
    scholarDescription = "Read pages 4–5.\n\nShow each step.",
  }: {
    teacherId: Id<"users">;
    scholarIds: Id<"users">[];
    kind?: Doc<"activities">["kind"];
    mode?: "homework" | "classFocus";
    setAt?: number | undefined;
    planned?: boolean;
    endsAt?: number;
    entryScholarIds?: Id<"users">[];
    scholarDescription?: string;
  },
) {
  return t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Ocean systems",
      emoji: "🌊",
      isActive: true,
    } as Doc<"units">);
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Tides",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Moon phases worksheet",
      scholarDescription,
      kind,
      order: 0,
    } as Doc<"activities">);
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      startedAt: Date.now() - 60_000,
      activitySchedule: [
        {
          activityId,
          mode,
          ...(planned ? {} : { setAt }),
          endsAt,
          dueAt: Date.UTC(2026, 7, 9, 20, 34),
          scholarIds: entryScholarIds,
        },
      ],
    });
    return { unitId, lessonId, activityId, assignmentId };
  });
}

describe("sessions.openOfflineHomework", () => {
  test("opens targeted live homework idempotently without completion, then scanner materialization reuses it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "rivera");
    const scholarId = await seedUser(t, "scholar", "kai");
    const { unitId, activityId, assignmentId } = await seedHomework(t, {
      teacherId,
      scholarIds: [scholarId],
      entryScholarIds: [scholarId],
    });
    const asScholar = await withUser(t, scholarId);

    const first = await asScholar.mutation(api.sessions.openOfflineHomework, {
      activityId,
      assignmentId,
    });
    const second = await asScholar.mutation(api.sessions.openOfflineHomework, {
      activityId,
      assignmentId,
    });
    expect(second.id).toBe(first.id);
    const session = await t.run((ctx) => ctx.db.get(first.id));
    expect(session).toMatchObject({
      userId: scholarId,
      activityId,
      assignmentId,
      unitId,
      isOffline: true,
    });
    expect(
      await t.run((ctx) => ctx.db.query("activityCompletions").collect()),
    ).toHaveLength(0);
    const asTeacher = await withUser(t, teacherId);
    const sessionSignals = await asTeacher.query(
      api.activitySessions.getForUnit,
      { unitId },
    );
    expect(sessionSignals.activities[String(activityId)].activeCount).toBe(0);
    const maturity = await asTeacher.query(
      api.unitMaturity.getNodeStatuses,
      { unitId },
    );
    expect(maturity.activitiesAssigned[String(activityId)]).not.toBe(true);

    const itemId = await t.run((ctx) =>
      ctx.db.insert("portfolioItems", {
        scholarId,
        title: "worksheet.pdf",
        source: "manual",
        matchStatus: "confirmed",
        assignmentId,
        assignmentStatus: "confirmed",
        activityId,
        processingStatus: "ready",
      } as Doc<"portfolioItems">),
    );
    // Calling setActivity runs materialization, which must reuse the session
    // already opened from homework rather than creating a sibling container.
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });
    const deliverable = await t.run((ctx) =>
      ctx.db.query("deliverables").first(),
    );
    expect(deliverable?.sessionId).toBe(first.id);

    await asTeacher.mutation(api.portfolio.setActivity, { itemId });
    expect(await t.run((ctx) => ctx.db.get(first.id))).not.toBeNull();
    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("activityCompletions").collect()),
    ).toHaveLength(0);
  });

  test.each([
    ["a non-offline activity", { kind: "online" as const }],
    ["a class-focus entry", { mode: "classFocus" as const }],
    ["a planned entry", { planned: true }],
    ["an expired entry", { endsAt: Date.now() - 1 }],
  ])("rejects %s", async (_label, overrides) => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", `teacher-${_label}`);
    const scholarId = await seedUser(t, "scholar", `scholar-${_label}`);
    const { activityId, assignmentId } = await seedHomework(t, {
      teacherId,
      scholarIds: [scholarId],
      ...overrides,
    });
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.sessions.openOfflineHomework, {
        activityId,
        assignmentId,
      }),
    ).rejects.toThrow();
  });

  test("rejects a scholar outside the assignment or per-entry target", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "rivera");
    const includedScholar = await seedUser(t, "scholar", "kai");
    const excludedScholar = await seedUser(t, "scholar", "zoe");
    const assignmentMismatch = await seedHomework(t, {
      teacherId,
      scholarIds: [includedScholar],
    });
    const asExcluded = await withUser(t, excludedScholar);
    await expect(
      asExcluded.mutation(api.sessions.openOfflineHomework, {
        activityId: assignmentMismatch.activityId,
        assignmentId: assignmentMismatch.assignmentId,
      }),
    ).rejects.toThrow(/does not include scholar/i);

    const perEntryMismatch = await seedHomework(t, {
      teacherId,
      scholarIds: [includedScholar, excludedScholar],
      entryScholarIds: [includedScholar],
    });
    await expect(
      asExcluded.mutation(api.sessions.openOfflineHomework, {
        activityId: perEntryMismatch.activityId,
        assignmentId: perEntryMismatch.assignmentId,
      }),
    ).rejects.toThrow(/not live for scholar/i);
    expect(await asExcluded.query(api.assignments.homeworkForMe, {})).toEqual(
      [],
    );

    const descriptionlessTargetedElsewhere = await seedHomework(t, {
      teacherId,
      scholarIds: [includedScholar, excludedScholar],
      entryScholarIds: [includedScholar],
      scholarDescription: "   ",
    });
    await expect(
      asExcluded.mutation(api.sessions.openOfflineHomework, {
        activityId: descriptionlessTargetedElsewhere.activityId,
        assignmentId: descriptionlessTargetedElsewhere.assignmentId,
      }),
    ).rejects.toThrow(/not live for scholar/i);
  });

  test("does not list or open scholarDescription-less offline homework", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "rivera");
    const scholarId = await seedUser(t, "scholar", "kai");
    const { activityId, assignmentId } = await seedHomework(t, {
      teacherId,
      scholarIds: [scholarId],
      scholarDescription: "   ",
    });
    const asScholar = await withUser(t, scholarId);

    await expect(asScholar.query(api.assignments.homeworkForMe, {})).resolves.toEqual(
      [],
    );
    await expect(
      asScholar.mutation(api.sessions.openOfflineHomework, {
        activityId,
        assignmentId,
      }),
    ).rejects.toThrow(/needs instructions or materials/i);
    expect(
      await t.run((ctx) => ctx.db.query("sessions").collect()),
    ).toHaveLength(0);
  });

  test("allows an empty offline activity as teacher-run class focus", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "rivera-class-focus");
    const scholarId = await seedUser(t, "scholar", "kai-class-focus");
    const { activityId, assignmentId } = await seedHomework(t, {
      teacherId,
      scholarIds: [scholarId],
      mode: "classFocus",
      scholarDescription: "   ",
    });
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.assignments.pushActivity, {
        assignmentId,
        activityId,
        mode: "classFocus",
      }),
    ).resolves.toBeNull();
  });

  test.each(["direct", "referenced"] as const)(
    "lists and opens material-only offline homework with %s resources",
    async (resourcePlacement) => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher", `rivera-${resourcePlacement}`);
      const scholarId = await seedUser(t, "scholar", `kai-${resourcePlacement}`);
      const { activityId, assignmentId, lessonId } = await seedHomework(t, {
        teacherId,
        scholarIds: [scholarId],
        scholarDescription: "   ",
      });
      await t.run(async (ctx) => {
        const resourceActivityId =
          resourcePlacement === "direct"
            ? activityId
            : await ctx.db.insert("activities", {
                lessonId,
                title: "Shared materials",
                kind: "offline",
                order: 1,
              });
        const resourceId = await ctx.db.insert("activityResources", {
          activityId: resourceActivityId,
          title: "Field guide",
          source: { kind: "link", url: "https://example.com/field-guide" },
          order: 0,
          uploadedBy: teacherId,
        });
        if (resourcePlacement === "referenced") {
          await ctx.db.patch(activityId, { referencedResourceIds: [resourceId] });
        }
      });
      const asScholar = await withUser(t, scholarId);

      await expect(asScholar.query(api.assignments.homeworkForMe, {})).resolves.toMatchObject([
        { activityId, activityKind: "offline" },
      ]);
      const { id: sessionId } = await asScholar.mutation(
        api.sessions.openOfflineHomework,
        { activityId, assignmentId },
      );
      await expect(
        asScholar.query(api.portfolio.offlineSessionView, { sessionId }),
      ).resolves.toMatchObject({
        description: null,
        resources: [
          {
            title: "Field guide",
            kind: "link",
            url: "https://example.com/field-guide",
          },
        ],
      });
    },
  );
});
