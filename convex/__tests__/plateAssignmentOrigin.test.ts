import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("scholar plate — assignment origin", () => {
  test("a class session whose window CLOSED stays classFocus, never a Quest", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { scholar } = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: "t",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "S",
        username: "s",
        role: "scholar",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Small Moments",
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "L1",
        order: 0,
      });
      const activity = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "Tell me a story",
        order: 0,
        kind: "online",
      });
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: now - 3 * 86_400_000,
        // classFocus window opened 2h ago and ENDED 1h ago (expired).
        activitySchedule: [
          {
            activityId: activity,
            mode: "classFocus",
            setAt: now - 2 * 3_600_000,
            endsAt: now - 3_600_000,
          },
        ],
      });
      // The scholar's started-but-unfinished session for that class activity.
      await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        activityId: activity,
        assignmentId: assignment,
        title: "Tell me a story",
        isArchived: false,
        lastMessageAt: now - 90 * 60_000,
      });
      return { scholar };
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => r.title === "Tell me a story");
    expect(row).toBeDefined();
    // The fix: it must NOT fall into the "is"/Quest bucket just because the
    // class-focus window closed.
    expect(row?.origin).toBe("classFocus");
  });

  test("an anchorless (no-assignment) session is still a Quest", async () => {
    const t = convexTest(schema, modules);
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "S", username: "s", role: "scholar" }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId: scholar,
        title: "Why is the sky blue?",
        isArchived: false,
        lastMessageAt: Date.now() - 60_000,
      });
    });
    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => r.title === "Why is the sky blue?");
    expect(row?.origin).toBe("is");
  });

  test("a live simulator assignment appears as startable scholar work", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { scholar } = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: "t-simulator",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "S",
        username: "s-simulator",
        role: "scholar",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Systems & Agents",
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "First Automaton",
        order: 0,
      });
      const activity = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "The ebbing tide",
        order: 0,
        kind: "simulator",
      });
      await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: now,
        activitySchedule: [
          {
            activityId: activity,
            mode: "homework",
            setAt: now,
          },
        ],
      });
      return { scholar };
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((candidate) => candidate.title === "The ebbing tide");

    expect(row).toMatchObject({
      activityKind: "simulator",
      notStarted: true,
      origin: "homework",
      sessionId: null,
    });
  });

  test("a live vibecode assignment appears as startable scholar work", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { scholar } = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: "t-vibecode",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "S",
        username: "s-vibecode",
        role: "scholar",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Systems & Agents",
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "First Automaton",
        order: 0,
      });
      const activity = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "The rising tide",
        order: 0,
        kind: "vibecode",
      });
      await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: now,
        activitySchedule: [
          {
            activityId: activity,
            mode: "homework",
            setAt: now,
          },
        ],
      });
      return { scholar };
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((candidate) => candidate.title === "The rising tide");

    expect(row).toMatchObject({
      activityKind: "vibecode",
      notStarted: true,
      origin: "homework",
      sessionId: null,
    });
  });

  test("an overrun class focus the scholar never opened still gets a row", async () => {
    // The iPad matches focus items back to plate rows and silently drops the
    // unmatched, where the web falls back to a synthetic card. So a focus with
    // no row is not merely missing a card — it is present on one surface and
    // absent on the other, for the same scholar, on the same work.
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { scholar } = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: "t-overrun",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "S",
        username: "s-overrun",
        role: "scholar",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Tide Pools",
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "Zonation",
        order: 0,
      });
      const focus = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "Pizza talk",
        order: 0,
        kind: "online",
      });
      const homework = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "Withdrawn reading",
        order: 1,
        kind: "online",
      });
      await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: now - 3 * 60 * 60 * 1000,
        activitySchedule: [
          // Running long: the window shut, but no teacher has wrapped it.
          {
            activityId: focus,
            mode: "classFocus" as const,
            setAt: now - 2 * 60 * 60 * 1000,
            endsAt: now - 60 * 60 * 1000,
          },
          // Ended homework, for contrast: `endsAt` on homework means WITHDRAWN,
          // and withdrawn work must not come back.
          {
            activityId: homework,
            mode: "homework" as const,
            setAt: now - 2 * 60 * 60 * 1000,
            endsAt: now - 60 * 60 * 1000,
          },
        ],
      });
      return { scholar };
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(rows.find((r) => r.title === "Pizza talk")).toMatchObject({
      notStarted: true,
      origin: "classFocus",
      sessionId: null,
    });
    expect(rows.find((r) => r.title === "Withdrawn reading")).toBeUndefined();
  });

});
