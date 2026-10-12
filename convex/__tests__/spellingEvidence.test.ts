// TRA-505: spelling evidence read — typed-only filter, window, cap, and the
// staff-only / cross-institution boundary. Fixtures are fictional.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function addSession(
  t: T,
  userId: Id<"users">,
  extra: Record<string, unknown> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "Rain journal",
      isArchived: false,
      ...extra,
    } as never),
  );
}

async function addMessage(
  t: T,
  sessionId: Id<"sessions">,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content,
      flagged: false,
      ...extra,
    } as never),
  );
}

async function setup() {
  const t = convexTest(schema, modules);
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, { institutionId });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Pip Fixture",
  });
  return { t, institutionId, teacherId, scholarId };
}

const read = (
  t: T,
  callerUserId: Id<"users">,
  scholarId: Id<"users">,
  extra: { days?: number; limit?: number } = {},
) =>
  t.query(internal.spellingEvidence.getTypedSamplesForAide, {
    callerUserId,
    scholarId,
    ...extra,
  });

describe("getTypedSamplesForAide", () => {
  test("returns only typed text; spoken and app are excluded and counted; missing modality is included but marked", async () => {
    const { t, teacherId, scholarId } = await setup();
    const s = await addSession(t, scholarId);
    await addMessage(t, s, "she sed it was rainning", { inputModality: "typed" });
    await addMessage(t, s, "I said it was raining today.", {
      inputModality: "spoken",
    });
    await addMessage(t, s, "Option B", { inputModality: "app" });
    await addMessage(t, s, "hav a lik", {}); // legacy row, no modality
    // Tutor-authored text is never the child's.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId: s,
        role: "assistant",
        content: "What did she say?",
        flagged: false,
      } as never),
    );

    const res = await read(t, teacherId, scholarId);
    expect(res.samples.map((x) => [x.text, x.modality])).toEqual([
      ["she sed it was rainning", "typed"],
      ["hav a lik", "unknown"],
    ]);
    expect(res.samples[0].sessionTitle).toBe("Rain journal");
    expect(res.counts).toMatchObject({
      typed: 1,
      unknownModality: 1,
      excludedSpoken: 1,
      excludedApp: 1,
      capped: false,
    });
  });

  test("skips test-drive and offline sessions", async () => {
    const { t, teacherId, scholarId } = await setup();
    const drive = await addSession(t, scholarId, { isTestDrive: true });
    const offline = await addSession(t, scholarId, { isOffline: true });
    await addMessage(t, drive, "typed in a drive", { inputModality: "typed" });
    await addMessage(t, offline, "typed offline", { inputModality: "typed" });
    const res = await read(t, teacherId, scholarId);
    expect(res.samples).toEqual([]);
  });

  test("window drops older messages and defaults to 90 days, max 365", async () => {
    const real = Date.now();
    // convex-test's creation clock is monotonic, so run the whole fixture
    // (setup included) from the oldest moment forward.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(real - 200 * DAY);
    const { t, teacherId, scholarId } = await setup();
    const s = await addSession(t, scholarId);
    await addMessage(t, s, "old one", { inputModality: "typed" });
    vi.setSystemTime(real - 30 * DAY);
    await addMessage(t, s, "recent one", { inputModality: "typed" });
    vi.setSystemTime(real);
    // Session activity must fall in the window for it to be scanned at all.
    await t.run((ctx) => ctx.db.patch(s, { lastMessageAt: real }));

    const d90 = await read(t, teacherId, scholarId);
    expect(d90.window.days).toBe(90);
    expect(d90.samples.map((x) => x.text)).toEqual(["recent one"]);

    const d365 = await read(t, teacherId, scholarId, { days: 9999 });
    expect(d365.window.days).toBe(365);
    expect(d365.samples.map((x) => x.text)).toEqual(["old one", "recent one"]);
  });

  test("row cap keeps the newest, returns oldest-first, and flags capped", async () => {
    const { t, teacherId, scholarId } = await setup();
    const s = await addSession(t, scholarId);
    for (const w of ["one", "two", "three", "four"]) {
      await addMessage(t, s, w, { inputModality: "typed" });
    }
    const res = await read(t, teacherId, scholarId, { limit: 3 });
    expect(res.samples.map((x) => x.text)).toEqual(["two", "three", "four"]);
    expect(res.counts.capped).toBe(true);
  });

  test("excluded spoken turns do not eat the budget: typed turns older than a dictation run are still returned", async () => {
    const { t, teacherId, scholarId } = await setup();
    const s = await addSession(t, scholarId);
    await addMessage(t, s, "I hav a sed", { inputModality: "typed" });
    for (let i = 0; i < 5; i++) {
      await addMessage(t, s, `dictated ${i}`, { inputModality: "spoken" });
    }
    const res = await read(t, teacherId, scholarId, { limit: 2 });
    expect(res.samples.map((x) => x.text)).toEqual(["I hav a sed"]);
    expect(res.counts.excludedSpoken).toBe(5);
    expect(res.counts.capped).toBe(false);
  });

  test("a school admin of the same school may read", async () => {
    const { t, institutionId, scholarId } = await setup();
    const adminId = await seedStaffWithMembership(t, {
      institutionId,
      role: "school_admin",
    });
    const s = await addSession(t, scholarId);
    await addMessage(t, s, "hello", { inputModality: "typed" });
    expect((await read(t, adminId, scholarId)).samples).toHaveLength(1);
  });

  test("refuses a parent, a scholar (even reading themselves), and non-teaching staff", async () => {
    const { t, institutionId, scholarId } = await setup();
    const s = await addSession(t, scholarId);
    await addMessage(t, s, "hello", { inputModality: "typed" });
    const parentId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Fixture Parent", role: "parent" } as never),
    );
    await t.run((ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: scholarId,
        createdBy: scholarId,
      } as never),
    );
    const staffId = await seedStaffWithMembership(t, {
      institutionId,
      role: "staff",
    });
    const designerId = await seedStaffWithMembership(t, {
      institutionId,
      role: "curriculum_designer",
    });
    for (const caller of [parentId, scholarId, staffId, designerId]) {
      await expect(read(t, caller, scholarId)).rejects.toThrow(/Forbidden/);
    }
  });

  test("refuses a teacher from another institution", async () => {
    const { t, scholarId } = await setup();
    const otherSchool = await seedTestInstitution(t, {
      slug: "other-school",
      name: "Other School",
    });
    const outsider = await seedStaffWithMembership(t, {
      institutionId: otherSchool,
    });
    const s = await addSession(t, scholarId);
    await addMessage(t, s, "hello", { inputModality: "typed" });
    await expect(read(t, outsider, scholarId)).rejects.toThrow(/Forbidden/);
  });
});
