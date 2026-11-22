import { convexTest } from "convex-test";
import { insertAssignmentWithSchedule, withDefaultSchools } from "./scheduleFixtures";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Pin the wall clock to noon at the school (DEFAULT_TIMEZONE, Pacific/Honolulu).
// These tests stamp pushes `now - 2h`, and a push only shows on the
// institution day it was set. Between 00:00 and 02:00 local, `now - 2h` falls
// on yesterday, so the overrun-focus row legitimately disappears. The merge
// gate hit exactly that when it ran #4057 just after midnight (2026-09-28).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T22:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

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
    const t = await withDefaultSchools(convexTest(schema, modules));
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
      const assignment = await insertAssignmentWithSchedule(ctx, {
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
    const t = await withDefaultSchools(convexTest(schema, modules));
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
    const t = await withDefaultSchools(convexTest(schema, modules));
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
      await insertAssignmentWithSchedule(ctx, {
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
    const t = await withDefaultSchools(convexTest(schema, modules));
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
      await insertAssignmentWithSchedule(ctx, {
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
    const t = await withDefaultSchools(convexTest(schema, modules));
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
      await insertAssignmentWithSchedule(ctx, {
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

  // 2026-11-04: a teacher re-pushed an activity to one classmate, which
  // narrowed the entry to that classmate, and every other scholar's started
  // work on it vanished from Home AND Archived.
  async function seedStartedWork(
    t: ReturnType<typeof convexTest>,
    entryFor: "otherScholarOnly" | "cleared",
    opts: {
      onRoster?: boolean;
      started?: boolean;
      archivedAssignment?: boolean;
      archivedSession?: boolean;
      noDocument?: boolean;
    } = {},
  ) {
    const now = Date.now();
    const __mirrored = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "Avery Stone",
        username: "avery",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "Hoku Makani",
        username: "hoku",
        role: "scholar",
      });
      const classmate = await ctx.db.insert("users", {
        name: "Lehua Torres",
        username: "lehua",
        role: "scholar",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Build a Civilization",
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "L1",
        order: 0,
      });
      const activity = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "Flags and coins",
        order: 0,
        kind: "online",
      });
      const assignment = await insertAssignmentWithSchedule(ctx, {
        teacherId: teacher,
        unitId: unit,
        scholarIds:
          opts.onRoster === false ? [classmate] : [scholar, classmate],
        startedAt: now - 7 * 86_400_000,
        archivedAt: opts.archivedAssignment ? now - 86_400_000 : undefined,
        activitySchedule:
          entryFor === "otherScholarOnly"
            ? [
                {
                  activityId: activity,
                  mode: "classFocus",
                  setAt: now - 2 * 86_400_000,
                  startsAt: now - 2 * 86_400_000,
                  scholarIds: [classmate],
                },
              ]
            : [],
      });
      if (opts.started !== false) {
        const session = await ctx.db.insert("sessions", {
          userId: scholar,
          unitId: unit,
          activityId: activity,
          assignmentId: assignment,
          title: "Flags and coins",
          isArchived: opts.archivedSession === true,
          lastMessageAt: now - 3 * 86_400_000,
        });
        // A real document, so the Archived list keeps the row.
        if (!opts.noDocument) {
          await ctx.db.insert("artifacts", {
            sessionId: session,
            title: "My flag",
            content: "A red flag with two coins",
            lastEditedBy: "scholar",
          });
        }
        return { scholar, session };
      }
      return { scholar, session: null };
    });
    return __mirrored;
  }

  test("started work stays on Home after the activity is re-pushed to a classmate only", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const { scholar } = await seedStartedWork(t, "otherScholarOnly");
    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => r.title === "Flags and coins");
    expect(row?.origin).toBe("classFocus");
    expect(row?.sessionId).not.toBeNull();
  });

  test("started work on an activity whose class focus ended and was cleared leaves Home", async () => {
    // autoClearActivity removes the entry when a timed focus ends; that is
    // the normal end of class, and those sessions deliberately leave Home.
    const t = await withDefaultSchools(convexTest(schema, modules));
    const { scholar } = await seedStartedWork(t, "cleared");
    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
  });

  test("a cleared activity the scholar never started gets no row", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const { scholar } = await seedStartedWork(t, "cleared", { started: false });
    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
  });

  test("work on an assignment the scholar was taken off still leaves Home", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const { scholar } = await seedStartedWork(t, "otherScholarOnly", {
      onRoster: false,
    });
    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
  });
  test("work on an archived assignment still leaves Home", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const { scholar } = await seedStartedWork(t, "otherScholarOnly", {
      archivedAssignment: true,
    });
    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
  });

  test("the Archived list files re-pushed work under the same tab as Home", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const { scholar } = await seedStartedWork(t, "otherScholarOnly", {
      archivedSession: true,
    });
    const asScholar = await asUser(t, scholar);
    const rows = await asScholar.query(api.sessions.finishedForScholar, {});
    const row = rows.find((r) => r.title === "Flags and coins");
    expect(row?.origin).toBe("classFocus");
  });
  describe("unfinished work whose activity ended lives in Archived", () => {
    test("it is listed as ended, under class work, not complete", async () => {
      const t = await withDefaultSchools(convexTest(schema, modules));
      const { scholar } = await seedStartedWork(t, "cleared");
      const asScholar = await asUser(t, scholar);
      const rows = await asScholar.query(api.sessions.finishedForScholar, {});
      const row = rows.find((r) => r.title === "Flags and coins");
      expect(row?.finishedKind).toBe("ended");
      expect(row?.origin).toBe("classFocus");
      expect(row?.isComplete).toBe(false);
    });

    test("a session holding no document stays out", async () => {
      const t = await withDefaultSchools(convexTest(schema, modules));
      const { scholar } = await seedStartedWork(t, "cleared", { noDocument: true });
      const asScholar = await asUser(t, scholar);
      const rows = await asScholar.query(api.sessions.finishedForScholar, {});
      expect(rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
    });

    test("work still on Home is not listed as ended", async () => {
      const t = await withDefaultSchools(convexTest(schema, modules));
      const { scholar } = await seedStartedWork(t, "otherScholarOnly");
      const asScholar = await asUser(t, scholar);
      const rows = await asScholar.query(api.sessions.finishedForScholar, {});
      expect(rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
    });

    test("an archived assignment's work is not listed as ended", async () => {
      const t = await withDefaultSchools(convexTest(schema, modules));
      const { scholar } = await seedStartedWork(t, "cleared", {
        archivedAssignment: true,
      });
      const asScholar = await asUser(t, scholar);
      const rows = await asScholar.query(api.sessions.finishedForScholar, {});
      expect(rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
    });

    test("keep working brings it back to Home for the day, out of Archived", async () => {
      const t = await withDefaultSchools(convexTest(schema, modules));
      const { scholar, session } = await seedStartedWork(t, "cleared");
      const asScholar = await asUser(t, scholar);
      await asScholar.mutation(api.sessions.reopen, { id: session! });

      const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
      const row = rows.find((r) => r.title === "Flags and coins");
      expect(row?.origin).toBe("classFocus");
      expect(row?.sessionId).toBe(session);
      const archived = await asScholar.query(api.sessions.finishedForScholar, {});
      expect(archived.find((r) => r.title === "Flags and coins")).toBeUndefined();

      // The next day it goes back to Archived.
      vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000));
      const next = await asScholar.query(api.scholarPlate.activeForMe, {});
      expect(next.rows.find((r) => r.title === "Flags and coins")).toBeUndefined();
      const archivedNext = await asScholar.query(api.sessions.finishedForScholar, {});
      expect(
        archivedNext.find((r) => r.title === "Flags and coins")?.finishedKind,
      ).toBe("ended");
    });
  });
});
