// Fix-wave T4: `users.listScholars.lastActive` must reflect the scholar's
// real latest activity clock, not just the newest tutor session's
// `_creationTime`. Before the fix it ignored (a) later messages sent within
// that session and (b) `practiceAttempts` entirely (check-in/playlist/
// placement lanes never touch `sessions`/`messages`), so the teacher roster
// showed a stale "last active" even on a day the scholar practiced (see
// FIX_WAVE_PLAN.md T4 / FINDINGS_SYNTHESIS.md T4).
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function seedTeacher(t: TC) {
  return seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Teacher", username: "teacher1" });
}

async function seedScholar(t: TC) {
  return seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "Scholar", username: "scholar1" });
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("users.listScholars — lastActive (T4)", () => {
  test("lastActive advances past the session's creation time when a LATER message is sent in it", async () => {
    const t0 = Date.UTC(2026, 6, 12, 9, 0, 0);
    const t1 = t0 + 6 * 60 * 60 * 1000; // 6 hours later, same session

    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t);

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", { userId: scholar, title: "Session", isArchived: false }),
    );

    vi.setSystemTime(t1);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "still working on this",
        flagged: false,
      });

    });

    const asTeacher = await withUser(t, teacher);
    const roster = await asTeacher.query(api.users.listScholars, {});
    const row = roster.find((r) => r._id === scholar);
    expect(row).toBeDefined();
    // Old (buggy) behavior would report t0 (the session's _creationTime).
    expect(row!.lastActive).toBeGreaterThanOrEqual(t1);
  });

  describe("users.listScholars — enrollment standing", () => {
    test("ordinary rosters exclude program guests unless the caller opts in", async () => {
      const t = convexTest(schema, modules);
      const institutionId = await seedTestInstitution(t);
      const teacher = await seedStaffWithMembership(t, {
        institutionId,
        name: "Teacher",
        username: "teacher-roster",
      });
      const enrolled = await seedScholarInInstitution(t, {
        institutionId,
        name: "Enrolled Scholar",
        username: "enrolled-scholar",
      });
      const guest = await seedScholarInInstitution(t, {
        institutionId,
        name: "Robotics Guest",
        username: "robotics-guest",
      });
      await t.run((ctx) =>
        ctx.db.patch(guest, { enrollmentStanding: "program_guest" }),
      );

      const asTeacher = await withUser(t, teacher);
      const ordinaryRoster = await asTeacher.query(api.users.listScholars, {});
      expect(ordinaryRoster.map((scholar) => scholar._id)).toContain(enrolled);
      expect(ordinaryRoster.map((scholar) => scholar._id)).not.toContain(guest);

      const programRoster = await asTeacher.query(api.users.listScholars, {
        includeProgramGuests: true,
      });
      expect(programRoster.map((scholar) => scholar._id)).toEqual(
        expect.arrayContaining([enrolled, guest]),
      );
      expect(
        programRoster.find((scholar) => scholar._id === guest)?.enrollmentStanding,
      ).toBe("program_guest");
    });
  });

  test("a practice-only day (no session/message activity) still advances lastActive", async () => {
    const t0 = Date.UTC(2026, 6, 12, 9, 0, 0);
    const t1 = t0 + 3 * 60 * 60 * 1000;

    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t);
    // No session/message at all — a scholar's account creation is the only
    // pre-existing timestamp.

    vi.setSystemTime(t1);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "add_within_20",
        correct: true,
        lane: "placement",
        createdAt: t1,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const roster = await asTeacher.query(api.users.listScholars, {});
    const row = roster.find((r) => r._id === scholar);
    expect(row).toBeDefined();
    // Old (buggy) behavior would report the scholar's own `_creationTime`
    // (t0), never seeing the practice attempt at all.
    expect(row!.lastActive).toBeGreaterThanOrEqual(t1);
  });

  test("a stale session with a recent practice attempt reports the practice time (max, not session-only)", async () => {
    const t0 = Date.UTC(2026, 6, 10, 9, 0, 0); // two days ago
    const t1 = Date.UTC(2026, 6, 12, 9, 0, 0); // today

    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t);
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        title: "Old Session",
        isArchived: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "hi",
        flagged: false,
      });
    });

    vi.setSystemTime(t1);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "add_within_20",
        correct: true,
        lane: "review",
        createdAt: t1,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const roster = await asTeacher.query(api.users.listScholars, {});
    const row = roster.find((r) => r._id === scholar);
    expect(row).toBeDefined();
    expect(row!.lastActive).toBeGreaterThanOrEqual(t1);
  });
});
