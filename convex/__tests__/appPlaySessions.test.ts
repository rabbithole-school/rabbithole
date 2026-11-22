import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";
import {
  APP_PLAY_INTERPRETATION,
  readScholarAppPlay,
} from "../lib/scholarReads";
import {
  APP_PLAY_ACTIVE_IDLE_MS,
  APP_PLAY_HEARTBEAT_MS,
  APP_PLAY_RESUME_GAP_MS,
  APP_PLAY_RETENTION_MS,
  APP_PLAY_STALE_GAP_MS,
  APP_PLAY_UNATTENDED_MS,
} from "../../shared/appPlaySession";
import { grantStaffAccessToScholars } from "./institutionTestHelpers";
import {
  readLatestAppPlayForArtifact,
  readLatestAppPlayForSession,
} from "../appPlaySessions";
import { tileSessionLastOpenedAt } from "../lib/tileSessions";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;

const T0 = Date.UTC(2026, 9, 25, 17, 0, 0);
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

function at(ms: number) {
  vi.setSystemTime(T0 + ms);
}

async function seedUser(t: TestCtx, role: Role, username: string) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: username, username, role }),
  );
}

async function withUser(t: TestCtx, userId: Id<"users">) {
  const authSessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 24 * 60 * MINUTE,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedApp(
  t: TestCtx,
  ownerId: Id<"users">,
  options: {
    sessionMode?: "vibecode";
    isTestDrive?: boolean;
    teacherArchivedAt?: number;
    type?: "code" | "text";
    title?: string;
  } = {},
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: ownerId,
      title: options.title ?? "Canine rotation",
      isArchived: false,
      ...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
      ...(options.isTestDrive ? { isTestDrive: true } : {}),
      ...(options.teacherArchivedAt
        ? { teacherArchivedAt: options.teacherArchivedAt }
        : {}),
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: options.title ?? "Canine rotation",
      content: "<canvas></canvas>",
      lastEditedBy: "ai",
      type: options.type ?? "code",
      language: "html",
    });
    return { sessionId, artifactId };
  });
}

type Handle = { playSessionId: Id<"appPlaySessions">; resumes: number };

function endArgs(handle: Handle, endedAt?: number) {
  return {
    playSessionId: handle.playSessionId,
    resumes: handle.resumes,
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

/** On screen from `fromMs` to `toMs` (relative to T0), checking in every
 *  heartbeat like a host would. */
async function checkInThrough(
  owner: Awaited<ReturnType<typeof withUser>>,
  handle: Handle,
  fromMs: number,
  toMs: number,
) {
  for (let ms = fromMs + APP_PLAY_HEARTBEAT_MS; ms <= toMs; ms += APP_PLAY_HEARTBEAT_MS) {
    at(ms);
    await owner.mutation(api.appPlaySessions.heartbeat, {
      playSessionId: handle.playSessionId,
    });
  }
  at(toMs);
}

async function playRows(t: TestCtx) {
  return await t.run((ctx) => ctx.db.query("appPlaySessions").collect());
}

async function setup() {
  const t = convexTest(schema, modules);
  const ownerId = await seedUser(t, "scholar", "hoku");
  const owner = await withUser(t, ownerId);
  const app = await seedApp(t, ownerId);
  return { t, ownerId, owner, app };
}

describe("app play sessions", () => {
  test("start → heartbeats → end records one interval with server times", async () => {
    const { t, owner, app } = await setup();
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    expect(id).not.toBeNull();

    at(APP_PLAY_HEARTBEAT_MS);
    await expect(
      owner.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId }),
    ).resolves.toBe(true);
    // A check-in right after another is accepted but not written.
    at(APP_PLAY_HEARTBEAT_MS + 1_000);
    await owner.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId });
    expect((await playRows(t))[0].lastActiveAt).toBe(T0 + APP_PLAY_HEARTBEAT_MS);

    at(2 * APP_PLAY_HEARTBEAT_MS + 5_000);
    await owner.mutation(api.appPlaySessions.end, endArgs(id!));
    const [row] = await playRows(t);
    expect(row).toMatchObject({
      sessionId: app.sessionId,
      artifactId: app.artifactId,
      surface: "native",
      startedAt: T0,
      endedAt: T0 + 2 * APP_PLAY_HEARTBEAT_MS + 5_000,
    });
    // end() is idempotent and a heartbeat after it reports the interval over.
    await owner.mutation(api.appPlaySessions.end, endArgs(id!));
    await expect(
      owner.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId }),
    ).resolves.toBe(false);
  });

  test("a host that went quiet is closed at its last check-in, never at now", async () => {
    const { t, owner, app } = await setup();
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    at(APP_PLAY_HEARTBEAT_MS);
    await owner.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId });

    // The iPad slept for an hour; its next check-in is stale.
    at(APP_PLAY_HEARTBEAT_MS + 60 * MINUTE);
    await expect(
      owner.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId }),
    ).resolves.toBe(false);
    expect((await playRows(t))[0].endedAt).toBe(T0 + APP_PLAY_HEARTBEAT_MS);

    // So is a late end() on a second, abandoned interval.
    const second = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    expect(second!.playSessionId).not.toBe(id!.playSessionId);
    const secondStartedAt = Date.now();
    at(APP_PLAY_HEARTBEAT_MS + 60 * MINUTE + APP_PLAY_STALE_GAP_MS + 1);
    await owner.mutation(api.appPlaySessions.end, endArgs(second!));
    const row = (await playRows(t)).find(
      (r) => r._id === second!.playSessionId,
    )!;
    expect(row.endedAt).toBe(secondStartedAt);
  });

  test("reopening the same app right away continues the interval", async () => {
    const { t, owner, app } = await setup();
    const first = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    await checkInThrough(owner, first!, 0, 10 * MINUTE);
    await owner.mutation(api.appPlaySessions.end, endArgs(first!));

    // An Edit → Play toggle or a remount: same row, end cleared.
    at(10 * MINUTE + APP_PLAY_RESUME_GAP_MS - 1);
    const resumed = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    expect(resumed).toMatchObject({
      playSessionId: first!.playSessionId,
      resumes: 1,
    });
    expect((await playRows(t))[0].endedAt).toBeUndefined();

    // A second host's start() while it is live also joins it, and the end()
    // of the start it superseded cannot close it.
    const joined = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    expect(joined!.playSessionId).toBe(first!.playSessionId);
    await owner.mutation(api.appPlaySessions.end, endArgs(resumed!));
    expect((await playRows(t))[0].endedAt).toBeUndefined();

    await checkInThrough(owner, joined!, 10 * MINUTE, 20 * MINUTE);
    await owner.mutation(api.appPlaySessions.end, endArgs(joined!));
    at(20 * MINUTE + APP_PLAY_RESUME_GAP_MS + 1);
    const later = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    expect(later!.playSessionId).not.toBe(first!.playSessionId);
    expect(await playRows(t)).toHaveLength(2);
  });

  test("an end() that lands late keeps the host's off-screen time, clamped", async () => {
    const { t, owner, app } = await setup();
    const handle = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    await checkInThrough(owner, handle!, 0, 5 * MINUTE);
    // Backgrounded 20 s after the last check-in; iOS delivers the queued
    // end() two minutes later, on resume.
    const backgroundedAt = T0 + 5 * MINUTE + 20_000;
    at(7 * MINUTE + 20_000);
    await owner.mutation(api.appPlaySessions.end, endArgs(handle!, backgroundedAt));
    expect((await playRows(t))[0].endedAt).toBe(backgroundedAt);

    // A claimed end can never reach past now or before the last check-in.
    const next = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    expect(next!.playSessionId).not.toBe(handle!.playSessionId);
    at(8 * MINUTE);
    await owner.mutation(
      api.appPlaySessions.end,
      endArgs(next!, T0 + 60 * MINUTE),
    );
    const rows = await playRows(t);
    expect(rows.find((r) => r._id === next!.playSessionId)!.endedAt).toBe(
      T0 + 8 * MINUTE,
    );
  });

  test("start() closes a stale open interval before opening a new one", async () => {
    const { t, owner, app } = await setup();
    const first = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    at(APP_PLAY_STALE_GAP_MS + MINUTE);
    const second = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    expect(second!.playSessionId).not.toBe(first!.playSessionId);
    const rows = await playRows(t);
    expect(rows.find((r) => r._id === first!.playSessionId)!.endedAt).toBe(T0);
  });

  test("only the owner's own live app is tracked", async () => {
    const { t, ownerId, owner, app } = await setup();
    const teacherId = await seedUser(t, "teacher", "lehua");
    const teacher = await withUser(t, teacherId);
    const otherScholar = await withUser(
      t,
      await seedUser(t, "scholar", "makani"),
    );

    // Someone else viewing the app: silently untracked, nothing written.
    await expect(
      teacher.mutation(api.appPlaySessions.start, {
        artifactId: app.artifactId,
        surface: "web",
      }),
    ).resolves.toBeNull();
    await expect(
      otherScholar.mutation(api.appPlaySessions.start, {
        artifactId: app.artifactId,
        surface: "web",
      }),
    ).resolves.toBeNull();

    const testDrive = await seedApp(t, ownerId, { isTestDrive: true });
    const archived = await seedApp(t, ownerId, { teacherArchivedAt: T0 - 1 });
    const textDoc = await seedApp(t, ownerId, { type: "text" });
    for (const untracked of [testDrive, archived, textDoc]) {
      await expect(
        owner.mutation(api.appPlaySessions.start, {
          artifactId: untracked.artifactId,
          surface: "web",
        }),
      ).resolves.toBeNull();
    }
    expect(await playRows(t)).toHaveLength(0);

    // Nobody but the owner can extend or close an interval.
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    await expect(
      otherScholar.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      teacher.mutation(api.appPlaySessions.end, endArgs(id!)),
    ).rejects.toThrow("Forbidden");
  });

  test("start() prunes the owner's rows past retention", async () => {
    const { t, ownerId, owner, app } = await setup();
    await t.run(async (ctx) => {
      for (const ageDays of [200, 190, 10]) {
        const startedAt = T0 - ageDays * 24 * 60 * MINUTE;
        await ctx.db.insert("appPlaySessions", {
          userId: ownerId,
          sessionId: app.sessionId,
          artifactId: app.artifactId,
          surface: "web",
          startedAt,
          lastActiveAt: startedAt + MINUTE,
          endedAt: startedAt + MINUTE,
          resumes: 0,
        });
      }
    });
    await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
    });
    const startedAts = (await playRows(t)).map((r) => r.startedAt).sort();
    expect(startedAts).toEqual([
      T0 - 10 * 24 * 60 * MINUTE,
      T0,
    ]);
    expect(Math.min(...startedAts)).toBeGreaterThan(T0 - APP_PLAY_RETENTION_MS);
  });
});

describe("reading play history", () => {
  test("the Portfolio's app rows carry the latest play, saved state or not", async () => {
    const { t, ownerId, owner, app } = await setup();
    const teacherId = await seedUser(t, "teacher", "avery");
    const teacher = await withUser(t, teacherId);
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherId,
      scholarIds: [ownerId],
    });
    // A normal (non-vibecode) session's app that never saves state.
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    await checkInThrough(owner, id!, 0, 25 * MINUTE);
    await owner.mutation(api.appPlaySessions.end, endArgs(id!));
    // A Workshop app that saves but was never played since tracking began.
    const saver = await seedApp(t, ownerId, {
      sessionMode: "vibecode",
      title: "Red light green light",
    });
    await owner.mutation(api.appStates.updateSessionState, {
      artifactId: saver.artifactId,
      patch: { level: 3 },
    });

    const rows = await teacher.query(
      api.appStates.listSessionStatesForScholar,
      { scholarId: ownerId },
    );
    expect(rows).toHaveLength(2);
    const played = rows.find((row) => row.sessionId === app.sessionId)!;
    expect(played).toMatchObject({
      artifactId: app.artifactId,
      version: 0,
      updatedAt: 0,
      latestPlay: {
        startedAt: T0,
        lastActiveAt: T0 + 25 * MINUTE,
        endedAt: T0 + 25 * MINUTE,
        durationMs: 25 * MINUTE,
        surface: "native",
      },
    });
    const saved = rows.find((row) => row.sessionId === saver.sessionId)!;
    expect(saved.version).toBe(1);
    expect(saved.latestPlay).toBeUndefined();

    // Two apps in one session: the row is titled for the saved app, so it
    // carries that app's play, not its sibling's.
    const sibling = await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId: saver.sessionId,
        title: "Parkour",
        content: "<canvas></canvas>",
        lastEditedBy: "ai",
        type: "code",
        language: "html",
      }),
    );
    at(40 * MINUTE);
    const siblingPlay = await owner.mutation(api.appPlaySessions.start, {
      artifactId: sibling,
      surface: "web",
    });
    expect(siblingPlay).not.toBeNull();
    const again = await teacher.query(
      api.appStates.listSessionStatesForScholar,
      { scholarId: ownerId },
    );
    const savedAgain = again.find((row) => row.sessionId === saver.sessionId)!;
    expect(savedAgain.artifactId).toBe(saver.artifactId);
    expect(savedAgain.latestPlay).toBeUndefined();
  });

  test("the aide read resolves local times and never calls a quiet row live", async () => {
    const { t, ownerId, owner, app } = await setup();
    await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        timeZone: "Pacific/Honolulu",
      });
      await ctx.db.patch(ownerId, { institutionId });
    });
    // 7:00 AM HST start, checked in once, then the host went quiet.
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    at(APP_PLAY_HEARTBEAT_MS);
    await owner.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId });

    const read = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + 30 * MINUTE),
    );
    expect(read.timeZone).toBe("Pacific/Honolulu");
    expect(read.intervals).toHaveLength(1);
    expect(read.intervals[0]).toMatchObject({
      app: "Canine rotation",
      surface: "iPad app",
      dayRelation: "today",
      status: "stale_unfinalized",
      activeNow: false,
      onScreenMinutes: 1,
    });
    expect(read.intervals[0].startedAtLocal).toContain("7:00");
    expect(read.intervals[0].lastCheckInLocal).toContain("7:01");

    const live = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + 2 * MINUTE),
    );
    expect(live.intervals[0]).toMatchObject({ status: "active", activeNow: true });
  });
});

describe("app play: active time vs on-screen time", () => {
  /** 7:41 PM HST on the test day, relative to T0 (7:00 AM HST). */
  const EVENING = 12 * 60 * MINUTE + 41 * MINUTE;
  /** 2:24 AM HST the next morning. */
  const SMALL_HOURS = EVENING + 6 * 60 * MINUTE + 43 * MINUTE;

  async function inHonolulu(t: TestCtx, ownerId: Id<"users">) {
    await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        timeZone: "Pacific/Honolulu",
      });
      await ctx.db.patch(ownerId, { institutionId });
    });
  }

  test("an older BunnyPad build that checked in all night is reported as unverified on-screen time, not use", async () => {
    // The overnight report: an app build without interaction tracking, locked
    // into Rabbithole with the folio closed, kept reporting "active" and
    // checking in every minute from 7:41 PM to 2:24 AM.
    const { t, ownerId, owner, app } = await setup();
    await inHonolulu(t, ownerId);
    at(EVENING);
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    await checkInThrough(owner, id!, EVENING, SMALL_HOURS);
    at(SMALL_HOURS + 5 * 60 * MINUTE);
    // Morning: the next check-in finds the gap and closes the row at its
    // last check-in, as before.
    await expect(
      owner.mutation(api.appPlaySessions.heartbeat, { playSessionId: id!.playSessionId }),
    ).resolves.toBe(false);

    const read = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + SMALL_HOURS + 8 * 60 * MINUTE),
    );
    expect(read.intervals).toHaveLength(1);
    expect(read.intervals[0]).toMatchObject({
      measurement: "on_screen_only",
      activeMinutes: null,
      onScreenMinutes: 403,
      lastTouchLocal: null,
      dayRelation: "yesterday",
    });
    expect(read.intervals[0].startedAtLocal).toContain("7:41");
    expect(read.intervals[0].lastCheckInLocal).toContain("2:24");
    expect(read.days).toEqual([
      expect.objectContaining({
        activeMinutes: 0,
        onScreenMinutes: 0,
        onScreenOnlyMinutes: 403,
      }),
    ]);
    // The agent is told what on-screen time cannot show.
    expect(read.interpretation).toBe(APP_PLAY_INTERPRETATION);
    expect(APP_PLAY_INTERPRETATION).toContain("LEAD WITH activeMinutes");
    expect(APP_PLAY_INTERPRETATION).toContain(
      "never shows that the BunnyPad was awake",
    );
    expect(APP_PLAY_INTERPRETATION).toContain("unverified");
  });

  test("an interaction-tracking host: active time first, and the night is not counted", async () => {
    const { t, ownerId, owner, app } = await setup();
    await inHonolulu(t, ownerId);
    at(EVENING);
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
      tracksInteraction: true,
    });
    // Twenty minutes of play, touching every minute.
    for (let m = 1; m <= 20; m++) {
      at(EVENING + m * MINUTE);
      await owner.mutation(api.appPlaySessions.heartbeat, {
        playSessionId: id!.playSessionId,
        activeMs: MINUTE,
        lastInteractionAt: T0 + EVENING + (m - 1) * MINUTE,
      });
    }
    // Folio closed. The host keeps checking in for a while with no touches,
    // then closes the interval as unattended, back at last touch + the
    // active window (APP_PLAY_ACTIVE_IDLE_MS): the last touch still vouches
    // for those minutes, so they are active too.
    const lastTouch = T0 + EVENING + 19 * MINUTE;
    for (let m = 21; m <= 29; m++) {
      at(EVENING + m * MINUTE);
      await owner.mutation(api.appPlaySessions.heartbeat, {
        playSessionId: id!.playSessionId,
        activeMs: MINUTE,
        lastInteractionAt: lastTouch,
      });
    }
    at(EVENING + 19 * MINUTE + APP_PLAY_UNATTENDED_MS);
    await owner.mutation(api.appPlaySessions.end, {
      ...endArgs(id!, lastTouch + APP_PLAY_ACTIVE_IDLE_MS),
      activeMs: 0,
      lastInteractionAt: lastTouch,
    });
    const [row] = await playRows(t);
    expect(row).toMatchObject({
      interactionTracked: true,
      startedAt: T0 + EVENING,
      endedAt: lastTouch + APP_PLAY_ACTIVE_IDLE_MS,
      lastInteractionAt: lastTouch,
      activeMs: 19 * MINUTE + APP_PLAY_ACTIVE_IDLE_MS,
    });

    const read = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + SMALL_HOURS + 8 * 60 * MINUTE),
    );
    expect(read.intervals[0]).toMatchObject({
      measurement: "interaction",
      activeMinutes: 19 + APP_PLAY_ACTIVE_IDLE_MS / MINUTE,
      onScreenMinutes: 19 + APP_PLAY_ACTIVE_IDLE_MS / MINUTE,
      status: "ended",
    });
    expect(read.intervals[0].lastTouchLocal).toContain("8:00");
    expect(read.days[0]).toMatchObject({
      activeMinutes: 19 + APP_PLAY_ACTIVE_IDLE_MS / MINUTE,
      onScreenMinutes: 19 + APP_PLAY_ACTIVE_IDLE_MS / MINUTE,
      onScreenOnlyMinutes: 0,
    });
  });

  test("reports are clamped to the interval's own times", async () => {
    const { t, owner, app } = await setup();
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
      tracksInteraction: true,
    });
    at(APP_PLAY_HEARTBEAT_MS);
    await owner.mutation(api.appPlaySessions.heartbeat, {
      playSessionId: id!.playSessionId,
      activeMs: 60 * MINUTE,
      lastInteractionAt: T0 + 60 * MINUTE,
    });
    let [row] = await playRows(t);
    expect(row.activeMs).toBe(APP_PLAY_HEARTBEAT_MS);
    expect(row.lastInteractionAt).toBe(T0 + APP_PLAY_HEARTBEAT_MS);

    at(2 * APP_PLAY_HEARTBEAT_MS);
    await owner.mutation(api.appPlaySessions.heartbeat, {
      playSessionId: id!.playSessionId,
      activeMs: -5 * MINUTE,
      lastInteractionAt: T0 - 60 * MINUTE,
    });
    [row] = await playRows(t);
    // A negative report adds nothing, and the last touch never moves back.
    expect(row.activeMs).toBe(APP_PLAY_HEARTBEAT_MS);
    expect(row.lastInteractionAt).toBe(T0 + APP_PLAY_HEARTBEAT_MS);

    // end() cannot close before the last reported touch.
    await owner.mutation(api.appPlaySessions.end, endArgs(id!, T0));
    [row] = await playRows(t);
    expect(row.endedAt).toBe(T0 + APP_PLAY_HEARTBEAT_MS);
    expect(row.activeMs).toBe(APP_PLAY_HEARTBEAT_MS);
  });

  test("an older host's report fields are ignored, and its end stays at or after the last check-in", async () => {
    const { t, owner, app } = await setup();
    const id = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    at(2 * APP_PLAY_HEARTBEAT_MS);
    await owner.mutation(api.appPlaySessions.heartbeat, {
      playSessionId: id!.playSessionId,
      activeMs: MINUTE,
      lastInteractionAt: T0 + MINUTE,
    });
    await owner.mutation(api.appPlaySessions.end, endArgs(id!, T0));
    const [row] = await playRows(t);
    expect(row.interactionTracked).toBeUndefined();
    expect(row.activeMs).toBeUndefined();
    expect(row.lastInteractionAt).toBeUndefined();
    expect(row.endedAt).toBe(T0 + 2 * APP_PLAY_HEARTBEAT_MS);
  });

  test("an older host reopening a tracked interval makes it on-screen only", async () => {
    const { t, owner, app } = await setup();
    const first = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "web",
      tracksInteraction: true,
    });
    at(APP_PLAY_HEARTBEAT_MS);
    await owner.mutation(api.appPlaySessions.end, endArgs(first!));
    at(APP_PLAY_HEARTBEAT_MS + APP_PLAY_RESUME_GAP_MS / 2);
    const reopened = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
    });
    expect(reopened!.playSessionId).toBe(first!.playSessionId);
    const [row] = await playRows(t);
    expect(row.interactionTracked).toBeUndefined();
  });

  test("day totals round once per day, not once per stretch", async () => {
    const { t, ownerId, owner, app } = await setup();
    // Four 20-second touched stretches: each rounds to 0 minutes, but they
    // add up to 80 seconds, so the day reads 1 minute, not 0.
    for (let i = 0; i < 4; i++) {
      const base = i * 5 * MINUTE;
      at(base);
      const id = await owner.mutation(api.appPlaySessions.start, {
        artifactId: app.artifactId,
        surface: "web",
        tracksInteraction: true,
      });
      at(base + 20_000);
      await owner.mutation(api.appPlaySessions.end, {
        ...endArgs(id!),
        activeMs: 20_000,
        lastInteractionAt: T0 + base,
      });
    }
    const read = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + 60 * MINUTE),
    );
    expect(read.intervals).toHaveLength(4);
    expect(read.intervals.every((i) => i.activeMinutes === 0)).toBe(true);
    expect(read.days).toEqual([
      expect.objectContaining({
        activeMinutes: 1,
        onScreenMinutes: 1,
        onScreenOnlyMinutes: 0,
      }),
    ]);
  });

  /** Insert a row directly: `touched` sets a last interaction. */
  async function insertPlay(
    t: TestCtx,
    ownerId: Id<"users">,
    app: { sessionId: Id<"sessions">; artifactId: Id<"artifacts"> },
    startMs: number,
    options: { touched: boolean; ended: boolean },
  ) {
    await t.run((ctx) =>
      ctx.db.insert("appPlaySessions", {
        userId: ownerId,
        sessionId: app.sessionId,
        artifactId: app.artifactId,
        surface: "native",
        startedAt: T0 + startMs,
        lastActiveAt: T0 + startMs + MINUTE,
        resumes: 0,
        interactionTracked: true,
        activeMs: options.touched ? MINUTE : 0,
        ...(options.touched ? { lastInteractionAt: T0 + startMs } : {}),
        ...(options.ended ? { endedAt: T0 + startMs + MINUTE } : {}),
      }),
    );
  }

  test("untouched bounces never push real play out of the read", async () => {
    const { t, ownerId, app } = await setup();
    await insertPlay(t, ownerId, app, 0, { touched: true, ended: true });
    // Five untouched foreground bounces after it, newer than the real play.
    for (let i = 1; i <= 5; i++) {
      await insertPlay(t, ownerId, app, i * 60 * MINUTE, { touched: false, ended: true });
    }
    const read = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 3, T0 + 10 * 60 * MINUTE),
    );
    expect(read.intervals).toHaveLength(1);
    expect(read.intervals[0].activeMinutes).toBe(1);
    expect(read.untouchedStretchesOmitted).toBe(5);

    // So do the Portfolio and tile-switcher "latest play" reads.
    const latest = await t.run((ctx) =>
      readLatestAppPlayForArtifact(ctx, app.artifactId),
    );
    expect(latest?.startedAt).toBe(T0);
    const forSession = await t.run((ctx) =>
      readLatestAppPlayForSession(ctx, app.sessionId),
    );
    expect(forSession?.play.startedAt).toBe(T0);
    const opened = await t.run(async (ctx) =>
      tileSessionLastOpenedAt(ctx, (await ctx.db.get(app.sessionId))!),
    );
    expect(opened).toBeLessThan(T0 + 60 * MINUTE);
  });

  test("an untouched row that went stale without closing is left out; a live one stays", async () => {
    const { t, ownerId, app } = await setup();
    await insertPlay(t, ownerId, app, 0, { touched: false, ended: false });
    const live = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + 2 * MINUTE),
    );
    expect(live.intervals).toHaveLength(1);
    expect(live.intervals[0].status).toBe("active");
    const later = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + 60 * MINUTE),
    );
    expect(later.intervals).toHaveLength(0);
    expect(later.untouchedStretchesOmitted).toBe(1);
    expect(later.days).toEqual([]);
  });

  test("a stretch nobody touched is left out of the read and counted", async () => {
    const { t, ownerId, owner, app } = await setup();
    // A locked BunnyPad brought the app forward on its own; nobody touched it.
    const ghost = await owner.mutation(api.appPlaySessions.start, {
      artifactId: app.artifactId,
      surface: "native",
      tracksInteraction: true,
    });
    at(APP_PLAY_UNATTENDED_MS);
    await owner.mutation(api.appPlaySessions.end, {
      ...endArgs(ghost!, T0),
      activeMs: 0,
    });
    expect((await playRows(t))[0]).toMatchObject({ endedAt: T0, activeMs: 0 });

    const read = await t.run((ctx) =>
      readScholarAppPlay(ctx, ownerId, 20, T0 + 60 * MINUTE),
    );
    expect(read.intervals).toHaveLength(0);
    expect(read.untouchedStretchesOmitted).toBe(1);
  });
});
