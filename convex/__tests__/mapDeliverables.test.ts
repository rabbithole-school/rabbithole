import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { StoredMapArtifact } from "../../lib/geomap/types";
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

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) =>
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

function mapContent(pinId: string, lng: number): string {
  return JSON.stringify({
    v: 1,
    spec: {
      v: 1,
      id: "food-journey",
      title: "Food journey",
      camera: { center: [-157.9, 21.3], zoom: 4 },
      base: "political",
      task: {
        kind: "locate",
        prompt: "Place the origin.",
        target: [lng, 21.3],
        toleranceKm: 10,
      },
    },
    scholarPins: [{ id: pinId, lngLat: [lng, 21.3] }],
  } satisfies StoredMapArtifact);
}

async function seedFixture(t: ReturnType<typeof convexTest>) {
  const institutionId = await seedTestInstitution(t, {
    slug: `map-school-${Math.random().toString(36).slice(2, 8)}`,
  });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    role: "teacher",
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
  });
  const parentId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Fixture parent",
      username: `fixture-parent-${Math.random().toString(36).slice(2, 8)}`,
      role: "parent",
    }),
  );
  const { activityId, sessionId, artifactId } = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Food systems",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Food journeys",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Trace a food journey",
      kind: "online",
      systemPrompt: "Open a map and ask the scholar to place the origin.",
      order: 0,
      deliverable: {
        kind: "map",
        prompt: "Show where this food came from.",
        mode: "manual",
        criteria: [{ id: "origin", label: "A plausible origin" }],
      },
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      activityId,
      title: "Food journey",
      isArchived: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "My food journey",
      type: "map",
      content: mapContent("first", -157.8),
      lastEditedBy: "scholar",
    });
    await ctx.db.insert("guardianships", {
      parentUserId: parentId,
      scholarUserId: scholarId,
      createdBy: teacherId,
    });
    return { activityId, sessionId, artifactId };
  });
  return {
    institutionId,
    teacherId,
    scholarId,
    parentId,
    activityId,
    sessionId,
    artifactId,
  };
}

describe("map deliverables", () => {
  test("Send accepts a no-rubric map and records the handoff", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedFixture(t);
    await t.run((ctx) =>
      ctx.db.patch(fixture.activityId, {
        deliverable: {
          kind: "map",
          prompt: "Show where this food came from.",
          mode: "none",
          criteria: [],
        },
      }),
    );
    const asScholar = await withUser(t, fixture.scholarId);

    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId: fixture.activityId,
      sessionId: fixture.sessionId,
      artifactId: fixture.artifactId,
      intent: "send",
    });

    const row = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(row?.lastAction).toBe("send");
    expect(JSON.parse(row!.mapContent!).scholarPins[0].id).toBe("first");
  });

  test("Check stores a structured checkpoint and scholar reads stay redacted", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedFixture(t);
    const asScholar = await withUser(t, fixture.scholarId);

    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId: fixture.activityId,
      sessionId: fixture.sessionId,
      artifactId: fixture.artifactId,
      intent: "check",
    });

    const row = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(row?.lastAction).toBe("check");
    expect(row?.textContent).toBeUndefined();
    expect(JSON.parse(row!.mapContent!).scholarPins[0].id).toBe("first");

    const scholarRead = await asScholar.query(
      api.deliverables.getForSessionActivity,
      {
        sessionId: fixture.sessionId,
        activityId: fixture.activityId,
        artifactId: fixture.artifactId,
      },
    );
    expect(JSON.parse(scholarRead!.mapContent!).spec.task.target).toEqual([
      0, 0,
    ]);

    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId: fixture.sessionId,
      artifactId: fixture.artifactId,
      preserveSubmittedSnapshot: true,
      verdicts: [{ criterionId: "origin", level: "full" }],
    });
    const scored = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(scored?.rubricPassed).toBe(true);
    expect(scored?.flairEarned?.map((flair) => flair.criterionId)).toEqual([
      "origin",
    ]);
    expect(JSON.parse(scored!.mapContent!).scholarPins[0].id).toBe("first");
  });

  test("family publication freezes one revision until a teacher shares again", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedFixture(t);
    const asScholar = await withUser(t, fixture.scholarId);
    const asTeacher = await withUser(t, fixture.teacherId);
    const asParent = await withUser(t, fixture.parentId);

    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId: fixture.activityId,
      sessionId: fixture.sessionId,
      artifactId: fixture.artifactId,
      intent: "check",
    });
    await asTeacher.mutation(api.deliverables.setFamilyVisibility, {
      deliverableId,
      familyVisibility: "attributed_families",
    });

    await t.run((ctx) =>
      ctx.db.patch(fixture.artifactId, {
        content: mapContent("second", -122.4),
      }),
    );
    await asScholar.mutation(api.deliverables.submit, {
      activityId: fixture.activityId,
      sessionId: fixture.sessionId,
      artifactId: fixture.artifactId,
      intent: "check",
    });

    const beforeReshare = await asParent.query(api.portfolio.listForGuardian, {
      scholarId: fixture.scholarId,
    });
    expect(beforeReshare).toHaveLength(1);
    const firstPublication = beforeReshare[0];
    expect(firstPublication.kind).toBe("map");
    if (firstPublication.kind !== "map") {
      throw new Error("Expected a published map");
    }
    expect(JSON.parse(firstPublication.content).scholarPins[0].id).toBe("first");
    expect(JSON.parse(firstPublication.content).spec.task.target).toEqual([0, 0]);

    await asTeacher.mutation(api.deliverables.setFamilyVisibility, {
      deliverableId,
      familyVisibility: "attributed_families",
    });
    const afterReshare = await asParent.query(api.portfolio.listForGuardian, {
      scholarId: fixture.scholarId,
    });
    const secondPublication = afterReshare[0];
    if (secondPublication.kind !== "map") {
      throw new Error("Expected a published map");
    }
    expect(JSON.parse(secondPublication.content).scholarPins[0].id).toBe("second");

    await asTeacher.mutation(api.deliverables.setFamilyVisibility, {
      deliverableId,
      familyVisibility: "staff_only",
    });
    await expect(
      asParent.query(api.portfolio.listForGuardian, {
        scholarId: fixture.scholarId,
      }),
    ).resolves.toEqual([]);
  });

  test("documents use the same explicit frozen-publication path", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedFixture(t);
    const { activityId, sessionId, artifactId } = await t.run(async (ctx) => {
      const mapActivity = await ctx.db.get(fixture.activityId);
      if (!mapActivity) throw new Error("Fixture activity not found");
      const activityId = await ctx.db.insert("activities", {
        lessonId: mapActivity.lessonId,
        title: "Write the journey",
        kind: "online",
        systemPrompt: "Help the scholar explain the route.",
        order: 1,
        deliverable: {
          kind: "text",
          prompt: "Explain the route.",
          mode: "manual",
          criteria: [{ id: "route", label: "A clear route" }],
        },
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: fixture.scholarId,
        activityId,
        title: "Route explanation",
        isArchived: false,
      });
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId,
        title: "My route",
        type: "text",
        content: "First draft",
        lastEditedBy: "scholar",
      });
      return { activityId, sessionId, artifactId };
    });
    const asScholar = await withUser(t, fixture.scholarId);
    const asTeacher = await withUser(t, fixture.teacherId);
    const asParent = await withUser(t, fixture.parentId);

    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
      intent: "check",
    });
    await asTeacher.mutation(api.deliverables.setFamilyVisibility, {
      deliverableId,
      familyVisibility: "attributed_families",
    });
    await t.run((ctx) =>
      ctx.db.patch(artifactId, { content: "A later revision" }),
    );
    await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
      intent: "check",
    });

    const portfolio = await asParent.query(api.portfolio.listForGuardian, {
      scholarId: fixture.scholarId,
    });
    const document = portfolio.find((item) => item.kind === "text");
    expect(document?.kind).toBe("text");
    if (!document || document.kind !== "text") {
      throw new Error("Expected a published document");
    }
    expect(document.content).toBe("First draft");
  });

  test("family eligibility gates publication and hides a snapshot if eligibility changes", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedFixture(t);
    const asScholar = await withUser(t, fixture.scholarId);
    const asTeacher = await withUser(t, fixture.teacherId);
    const asParent = await withUser(t, fixture.parentId);
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId: fixture.activityId,
      sessionId: fixture.sessionId,
      artifactId: fixture.artifactId,
      intent: "check",
    });

    await asTeacher.mutation(api.deliverables.setFamilyVisibility, {
      deliverableId,
      familyVisibility: "attributed_families",
    });
    await t.run((ctx) =>
      ctx.db.patch(fixture.scholarId, {
        enrollmentStanding: "program_guest",
      }),
    );

    await expect(
      asParent.query(api.portfolio.listForGuardian, {
        scholarId: fixture.scholarId,
      }),
    ).resolves.toEqual([]);
    await asTeacher.mutation(api.deliverables.setFamilyVisibility, {
      deliverableId,
      familyVisibility: "staff_only",
    });
    await expect(
      asTeacher.mutation(api.deliverables.setFamilyVisibility, {
        deliverableId,
        familyVisibility: "attributed_families",
      }),
    ).rejects.toThrow("visiting-student form");
  });

  test("a teacher from another institution cannot publish the checkpoint", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedFixture(t);
    const asScholar = await withUser(t, fixture.scholarId);
    const deliverableId = await asScholar.mutation(
      api.deliverables.submit,
      {
        activityId: fixture.activityId,
        sessionId: fixture.sessionId,
        artifactId: fixture.artifactId,
        intent: "check",
      },
    );
    const otherInstitutionId = await seedTestInstitution(t, {
      slug: `other-school-${Math.random().toString(36).slice(2, 8)}`,
    });
    const otherTeacherId = await seedStaffWithMembership(t, {
      institutionId: otherInstitutionId,
      role: "teacher",
    });
    const asOtherTeacher = await withUser(t, otherTeacherId);

    await expect(
      asOtherTeacher.mutation(api.deliverables.setFamilyVisibility, {
        deliverableId,
        familyVisibility: "attributed_families",
      }),
    ).rejects.toThrow();
  });
});
