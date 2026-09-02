// scholars.rosterPulse.practicedToday — the widened batched roster read (spec
// §3.2) that folds a per-cohort "who practised today" presence signal into the
// single roster subscription, replacing the retired per-row cohort frontier
// read. Two things a wrapper can get wrong here are invisible on screen: the
// institution-local DAY boundary (a mastery row from local-yesterday that still
// falls after UTC midnight must NOT count — Fix-wave T5), and the tenancy scope
// (only in-lens scholars appear). Both are pinned below.
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

// Honolulu is a fixed UTC-10 offset (no DST) — deterministic across the year.
const HONOLULU = "Pacific/Honolulu";

async function seedTeacher(t: TC, institutionId: Id<"institutions">) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Teacher", username: "teacher1", role: "teacher" }),
  );
  await grantInstitutionMembership(t, userId, institutionId);
  return userId;
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedMasteryRow(t: TC, scholarId: Id<"users">, updatedAt: number) {
  await t.run(async (ctx) => {
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: "add_within_20",
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      repetition: 1,
      halfLifeDays: 1,
      frontier: false,
      source: "practice",
      updatedAt,
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scholars.rosterPulse — practicedToday (spec §3.2)", () => {
  test("counts a mastery row from LOCAL today, not from LOCAL yesterday", async () => {
    // "Now" = 2026-07-12T12:00:00Z = 2026-07-12 02:00 Honolulu (already the next
    // LOCAL day). One scholar practised at 2026-07-12 01:00 Honolulu (genuinely
    // today); the other at 2026-07-11 22:00 Honolulu (LOCAL yesterday) — which
    // still falls after UTC midnight, the exact case a UTC boundary gets wrong.
    const now = Date.UTC(2026, 6, 12, 12, 0, 0);
    const todayLocal = Date.UTC(2026, 6, 12, 11, 0, 0); // 01:00 Honolulu
    const yesterdayLocal = Date.UTC(2026, 6, 12, 8, 0, 0); // 22:00 Honolulu prev day
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "test-school" });
    await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: HONOLULU }));
    const teacher = await seedTeacher(t, institutionId);
    const practiced = await seedScholarInInstitution(t, {
      institutionId,
      name: "Practiced",
      username: "practiced1",
    });
    const stale = await seedScholarInInstitution(t, {
      institutionId,
      name: "Stale",
      username: "stale1",
    });
    await seedMasteryRow(t, practiced, todayLocal);
    await seedMasteryRow(t, stale, yesterdayLocal);

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.scholars.rosterPulse, {
      institutionScope: "",
    });

    expect(result.practicedToday).toContain(String(practiced));
    expect(result.practicedToday).not.toContain(String(stale));
  });

  test("a scholar with no mastery rows is absent from practicedToday", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "test-school" });
    await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: HONOLULU }));
    const teacher = await seedTeacher(t, institutionId);
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Idle",
      username: "idle1",
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.scholars.rosterPulse, {
      institutionScope: "",
    });

    expect(result.practicedToday).not.toContain(String(scholar));
  });

  test("rolls over at institution-local midnight from the client clock, with no DB write", async () => {
    // The reactive-staleness fix (T11): the dot must flip as the CLIENT clock
    // crosses institution-local midnight, driven by the `now` argument, WITHOUT
    // any database write between the two reads. A scholar practised at 2026-07-11
    // 23:30 Honolulu; the roster is read once just before local midnight (still
    // "today") and once just after (now "yesterday"). Same rows, same query,
    // only `now` changed.
    const beforeMidnight = Date.UTC(2026, 6, 12, 9, 55, 0); // 2026-07-11 23:55 Honolulu
    const afterMidnight = Date.UTC(2026, 6, 12, 10, 5, 0); // 2026-07-12 00:05 Honolulu
    const practicedAt = Date.UTC(2026, 6, 12, 9, 30, 0); // 2026-07-11 23:30 Honolulu

    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "test-school" });
    await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: HONOLULU }));
    const teacher = await seedTeacher(t, institutionId);
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Practiced",
      username: "practiced2",
    });
    await seedMasteryRow(t, scholar, practicedAt);

    const asTeacher = await withUser(t, teacher);

    // Still the same local day as the practice → counted.
    const before = await asTeacher.query(api.scholars.rosterPulse, {
      institutionScope: "",
      now: beforeMidnight,
    });
    expect(before.practicedToday).toContain(String(scholar));

    // Clock crossed local midnight — no DB write — so the practice is now
    // "yesterday" and the dot drops.
    const after = await asTeacher.query(api.scholars.rosterPulse, {
      institutionScope: "",
      now: afterMidnight,
    });
    expect(after.practicedToday).not.toContain(String(scholar));
  });
});
