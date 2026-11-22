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
import { appendNotebookEntry } from "../simulatorBenches";
import {
  seedOperationsStaff,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

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

// TRA-651: the roster collected every message of every session of every
// scholar, so its reads grew with the school's whole chat history until prod
// hit Convex's 32,000-document limit and the Scholars tab crashed for
// everyone. One message query per session would only have moved the wall to
// the 4,096 index-range limit. convex-test enforces both limits when asked;
// low ceilings with more history than the ceiling prove message reads and
// index ranges per scholar stay bounded. Session documents are still read
// one each, so that part grows with the number of sessions.
describe("users.listScholars — message reads and index ranges stay bounded (TRA-651)", () => {
  const READ_CEILING = 300;

  type MessageRole = "user" | "assistant" | "tool";
  async function insertMessages(
    t: TC,
    sessionId: Id<"sessions">,
    count: number,
    role: (i: number) => MessageRole,
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("messages", {
          sessionId,
          role: role(i),
          content: `row ${i}`,
          flagged: false,
        });
      }
    });
  }

  async function insertMessage(
    t: TC,
    sessionId: Id<"sessions">,
    role: MessageRole,
    content: string,
  ) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", { sessionId, role, content, flagged: false });
      return (await ctx.db.get(id))!._creationTime;
    });
  }

  async function insertSession(
    t: TC,
    scholar: Id<"users">,
    institutionId: Id<"institutions">,
    title: string,
    extra: { isArchived?: boolean; lastMessageAt?: number } = {},
  ) {
    return t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        title,
        isArchived: extra.isArchived ?? false,
        institutionId,
        ...(extra.lastMessageAt !== undefined ? { lastMessageAt: extra.lastMessageAt } : {}),
      }),
    );
  }

  /** An older session, then a newest session with more messages than the
   *  read ceiling on its own, ending in a scholar turn followed by 60 tutor
   *  and tool rows. The latest message overall then lands in the older one. */
  async function seedChattyScholar(t: TC, institutionId: Id<"institutions">) {
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Chatty Scholar",
      username: "chatty-scholar",
    });
    const olderSession = await insertSession(t, scholar, institutionId, "Older session");
    const newestSession = await insertSession(t, scholar, institutionId, "Newest session");
    await insertMessages(t, olderSession, 20, (i) => (i % 2 === 0 ? "user" : "assistant"));
    await insertMessages(t, newestSession, READ_CEILING + 50, (i) => (i % 2 === 0 ? "user" : "assistant"));
    const lastUserTurnAt = await insertMessage(t, newestSession, "user", "my last turn");
    await insertMessages(t, newestSession, 60, (i) => (i % 3 === 0 ? "tool" : "assistant"));
    const latestAt = await insertMessage(t, olderSession, "user", "back to the older thread");
    return { scholar, latestAt, lastUserTurnAt };
  }

  test("a teacher's roster loads past the read ceiling with exact lastActive and lastMessage", async () => {
    const t = convexTest({ schema, modules, transactionLimits: { documentsRead: READ_CEILING } });
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Teacher",
      username: "teacher-read-budget",
    });
    const { scholar, latestAt, lastUserTurnAt } = await seedChattyScholar(t, institutionId);

    const roster = await (await withUser(t, teacher)).query(api.users.listScholars, {});
    const row = roster.find((r) => r._id === scholar);
    expect(row).toBeDefined();
    // Latest message across ALL sessions, not just the newest one.
    expect(row!.lastActive).toBe(latestAt);
    expect(row!.lastSessionTitle).toBe("Newest session");
    // The scholar's last turn, even with 60 tutor/tool rows after it.
    expect(row!.lastMessage).toBe("my last turn");
    expect(row!.lastMessageAt).toBe(lastUserTurnAt);
  });

  test("an operations staffer's roster (the TRA-651 reporter's path) loads past the read ceiling", async () => {
    const t = convexTest({ schema, modules, transactionLimits: { documentsRead: READ_CEILING } });
    const institutionId = await seedTestInstitution(t);
    const opsStaff = await seedOperationsStaff(t, {
      institutionId,
      name: "Sloane Kahale",
      username: "sloane-read-budget",
      health: true,
    });
    const { scholar, latestAt } = await seedChattyScholar(t, institutionId);

    const roster = await (await withUser(t, opsStaff)).query(api.users.listScholars, {});
    const row = roster.find((r) => r._id === scholar);
    expect(row).toBeDefined();
    expect(row!.lastActive).toBe(latestAt);
    // Operations staff never see transcript snippets.
    expect(row!.lastMessage).toBeNull();
    expect(row!.lastMessageAt).toBeNull();
  });

  test("index ranges stay flat as a scholar's sessions pile up, and an old session's stamp still counts", async () => {
    const SESSIONS = 80;
    const QUERY_CEILING = 55;
    const t = convexTest({ schema, modules, transactionLimits: { databaseQueries: QUERY_CEILING } });
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Teacher",
      username: "teacher-query-budget",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Busy Scholar",
      username: "busy-scholar",
    });
    // The oldest session is far outside the newest few, but the scholar's
    // latest send landed there, which stamps lastMessageAt as
    // sessions.sendMessage does.
    const stampedAt = Date.now() + 60 * 60 * 1000;
    await insertSession(t, scholar, institutionId, "Reopened old session", { lastMessageAt: stampedAt });
    for (let i = 1; i < SESSIONS; i++) {
      const sessionId = await insertSession(t, scholar, institutionId, `Session ${i}`);
      await insertMessages(t, sessionId, 2, (j) => (j === 0 ? "user" : "assistant"));
    }

    const roster = await (await withUser(t, teacher)).query(api.users.listScholars, {});
    const row = roster.find((r) => r._id === scholar);
    expect(row).toBeDefined();
    expect(row!.lastActive).toBe(stampedAt);
    expect(row!.lastSessionTitle).toBe(`Session ${SESSIONS - 1}`);
  });

  test("a newest session that was archived still counts as activity", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Teacher",
      username: "teacher-archived",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Tidy Scholar",
      username: "tidy-scholar",
    });
    const older = await insertSession(t, scholar, institutionId, "Kept session");
    await insertMessage(t, older, "user", "hello");
    const archived = await insertSession(t, scholar, institutionId, "Started then archived", {
      isArchived: true,
    });
    const archivedCreatedAt = await t.run(async (ctx) => (await ctx.db.get(archived))!._creationTime);

    const roster = await (await withUser(t, teacher)).query(api.users.listScholars, {});
    const row = roster.find((r) => r._id === scholar);
    expect(row).toBeDefined();
    expect(row!.lastActive).toBe(archivedCreatedAt);
    // Preview fields still come from the newest NON-archived session.
    expect(row!.lastSessionTitle).toBe("Kept session");
  });

  test("a Workbench notebook entry counts, through the real writer that doesn't stamp lastMessageAt", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Teacher",
      username: "teacher-notebook",
    });
    const opsStaff = await seedOperationsStaff(t, {
      institutionId,
      name: "Sloane Kahale",
      username: "sloane-notebook",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Bench Scholar",
      username: "bench-scholar",
    });
    // The Workbench session is the oldest of twelve, so only the exact
    // newest-message reads (not a newest-session shortcut) can see it.
    const benchSession = await insertSession(t, scholar, institutionId, "Old Workbench");
    for (let i = 1; i < 12; i++) {
      const sessionId = await insertSession(t, scholar, institutionId, `Session ${i}`);
      await insertMessages(t, sessionId, 2, (j) => (j === 0 ? "user" : "assistant"));
    }
    const noteAt = await t.run(async (ctx) => {
      const { messageId } = await appendNotebookEntry(ctx, {
        sessionId: benchSession,
        entry: { kind: "note", text: "the pendulum slows when the string is longer" },
      });
      return (await ctx.db.get(messageId))!._creationTime;
    });
    // The writer leaves lastMessageAt alone on purpose (see listScholars).
    const bench = await t.run((ctx) => ctx.db.get(benchSession));
    expect(bench!.lastMessageAt).toBeUndefined();

    for (const caller of [teacher, opsStaff]) {
      const roster = await (await withUser(t, caller)).query(api.users.listScholars, {});
      const row = roster.find((r) => r._id === scholar);
      expect(row).toBeDefined();
      expect(row!.lastActive).toBe(noteAt);
    }
  });
});
