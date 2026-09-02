import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { buildSystemPrompt } from "../sessionHelpers";
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

/**
 * Guidance (the `teacherDirectives` table) can now be time-boxed. These tests
 * pin the two things that matter:
 *
 *  1. the four verbs the weekly meeting needs, all of them `setExpiry`;
 *  2. that adding the field changed NOTHING for guidance that never expires —
 *     the tutor prompt has to stay byte-identical, because it is eval-sensitive.
 */

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

async function seedWorld(t: ReturnType<typeof convexTest>) {
  const institutionId = await seedTestInstitution(t);
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    name: "Teacher",
    username: "teacher",
  });
  const scholar = await seedScholarInInstitution(t, {
    institutionId,
    name: "Ada",
    username: "ada",
  });
  return { institutionId, teacher, scholar };
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Session",
      isArchived: false,
    }),
  );
}

const HOUR = 60 * 60 * 1000;

describe("guidance expiry — the meeting's four verbs", () => {
  test("upsert by label updates in place rather than stacking a duplicate", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const staff = await withUser(t, world.teacher);

    const created = await staff.mutation(api.teacherDirectives.upsertByTeacher, {
      scholarId: world.scholar,
      label: "Pacing",
      content: "Slow down on fractions.",
    });
    expect(created.action).toBe("created");

    // Same label, different casing, different words, now time-boxed.
    const updated = await staff.mutation(api.teacherDirectives.upsertByTeacher, {
      scholarId: world.scholar,
      label: "pacing",
      content: "Let her run ahead this week.",
      expiresAt: Date.now() + 7 * 24 * HOUR,
    });
    expect(updated.action).toBe("updated");
    expect(updated.id).toBe(created.id);
    // Label casing of the original row is preserved, not reformatted.
    expect(updated.label).toBe("Pacing");

    const rows = await staff.query(api.teacherDirectives.listByScholar, {
      scholarId: world.scholar,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("Let her run ahead this week.");
    expect(rows[0].expiresAt).toBeGreaterThan(Date.now());
  });

  test("omitting expiresAt on a re-write leaves an existing expiry alone", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const staff = await withUser(t, world.teacher);

    const expiresAt = Date.now() + 3 * 24 * HOUR;
    await staff.mutation(api.teacherDirectives.upsertByTeacher, {
      scholarId: world.scholar,
      label: "Pacing",
      content: "One week only.",
      expiresAt,
    });
    await staff.mutation(api.teacherDirectives.upsertByTeacher, {
      scholarId: world.scholar,
      label: "Pacing",
      content: "Reworded, same window.",
    });

    const rows = await staff.query(api.teacherDirectives.listByScholar, {
      scholarId: world.scholar,
    });
    expect(rows[0].expiresAt).toBe(expiresAt);
  });

  test("keep another week · make it standing · end now · bring it back", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const staff = await withUser(t, world.teacher);

    const { id } = await staff.mutation(api.teacherDirectives.upsertByTeacher, {
      scholarId: world.scholar,
      label: "Pacing",
      content: "Slow down on fractions.",
    });

    // Standing to begin with — the shape every pre-existing row has.
    let row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.expiresAt).toBeUndefined();

    // Keep another week.
    const weekOut = Date.now() + 7 * 24 * HOUR;
    await staff.mutation(api.teacherDirectives.setExpiry, {
      id,
      expiresAt: weekOut,
    });
    row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.expiresAt).toBe(weekOut);

    // Make it standing.
    await staff.mutation(api.teacherDirectives.setExpiry, {
      id,
      expiresAt: null,
    });
    row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.expiresAt).toBeUndefined();

    // End now.
    await staff.mutation(api.teacherDirectives.setExpiry, {
      id,
      expiresAt: Date.now() - 1,
    });
    row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.expiresAt!).toBeLessThan(Date.now() + 1);

    // Bring it back — and it revives a row that had been switched off, because
    // otherwise the verb would be a silent no-op.
    await staff.mutation(api.teacherDirectives.setActive, { id, isActive: false });
    await staff.mutation(api.teacherDirectives.setExpiry, {
      id,
      expiresAt: weekOut,
    });
    row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.isActive).toBe(true);
    expect(row?.expiresAt).toBe(weekOut);
  });

  test("ending guidance does not reactivate a switched-off row", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const staff = await withUser(t, world.teacher);

    const { id } = await staff.mutation(api.teacherDirectives.upsertByTeacher, {
      scholarId: world.scholar,
      label: "Pacing",
      content: "Slow down on fractions.",
    });
    await staff.mutation(api.teacherDirectives.setActive, { id, isActive: false });
    await staff.mutation(api.teacherDirectives.setExpiry, {
      id,
      expiresAt: Date.now() - 1,
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.isActive).toBe(false);
  });

  test("a meeting may only be stamped on a scholar actually on its agenda", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const other = await seedScholarInInstitution(t, {
      institutionId: world.institutionId,
      name: "Grace",
      username: "grace",
    });
    const staff = await withUser(t, world.teacher);

    const periodId = await t.run(async (ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Current",
        startsAt: Date.now() - 10 * 86_400_000,
        endsAt: Date.now() + 10 * 86_400_000,
        status: "writing",
      }),
    );
    const meetingId = await t.run(async (ctx) =>
      ctx.db.insert("scholarReviewMeetings", {
        weekKey: "2026-08-17",
        periodId,
        institutionId: world.institutionId,
        status: "open",
        createdAt: Date.now(),
        createdBy: world.teacher,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("scholarReviewEntries", {
        meetingId,
        institutionId: world.institutionId,
        scholarId: world.scholar,
      }),
    );

    const ok = await staff.mutation(api.teacherDirectives.upsertByTeacher, {
      scholarId: world.scholar,
      label: "Pacing",
      content: "From the meeting.",
      sourceMeetingId: meetingId,
    });
    const row = await t.run(async (ctx) => ctx.db.get(ok.id));
    expect(row?.sourceMeetingId).toBe(meetingId);

    await expect(
      staff.mutation(api.teacherDirectives.upsertByTeacher, {
        scholarId: other,
        label: "Pacing",
        content: "Not on that agenda.",
        sourceMeetingId: meetingId,
      }),
    ).rejects.toThrow(/not on this Rounds agenda/i);
  });
});

describe("expired guidance and the tutor prompt", () => {
  test("lapsed guidance stops being injected; standing guidance never lapses", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const sessionId = await seedSession(t, world.scholar);

    await t.run(async (ctx) => {
      await ctx.db.insert("teacherDirectives", {
        scholarId: world.scholar,
        label: "Standing",
        content: "Always ask for her reasoning.",
        authorId: world.teacher,
        isActive: true,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("teacherDirectives", {
        scholarId: world.scholar,
        label: "Live",
        content: "This week, push on estimation.",
        authorId: world.teacher,
        isActive: true,
        updatedAt: Date.now(),
        expiresAt: Date.now() + HOUR,
      });
      await ctx.db.insert("teacherDirectives", {
        scholarId: world.scholar,
        label: "Lapsed",
        content: "Last week, go easy on speed.",
        authorId: world.teacher,
        isActive: true,
        updatedAt: Date.now(),
        expiresAt: Date.now() - HOUR,
      });
    });

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    const labels = (context!.teacherDirectives ?? []).map((d) => d.label);
    expect(labels).toEqual(["Standing", "Live"]);
  });

  test("a scholar with no expiring guidance renders a byte-identical prompt", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const sessionId = await seedSession(t, world.scholar);

    await t.run(async (ctx) => {
      await ctx.db.insert("teacherDirectives", {
        scholarId: world.scholar,
        label: "Pacing",
        content: "Slow down on fractions.",
        authorId: world.teacher,
        isActive: true,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("teacherDirectives", {
        scholarId: world.scholar,
        label: "Reasoning",
        content: "Always ask for her reasoning.",
        authorId: world.teacher,
        isActive: true,
        updatedAt: Date.now(),
      });
    });

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });

    // The pre-change semantics: every active row, unfiltered, oldest first.
    const unfiltered = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("teacherDirectives")
        .withIndex("by_scholar_active", (q) =>
          q.eq("scholarId", world.scholar).eq("isActive", true),
        )
        .collect();
      rows.sort((a, b) => a._creationTime - b._creationTime);
      return rows.map((d) => ({ label: d.label, content: d.content }));
    });

    expect(context!.teacherDirectives).toEqual(unfiltered);

    const build = (directives: { label: string; content: string }[] | null) =>
      buildSystemPrompt(
        null,
        null,
        "Ada",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        directives,
      );

    expect(build(context!.teacherDirectives)).toBe(build(unfiltered));
    expect(build(context!.teacherDirectives)).toContain(
      "Slow down on fractions.",
    );
  });
});
