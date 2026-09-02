import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (p: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * Compatibility with iPad builds already installed on scholars' devices.
 *
 * Merging a native change does NOT put it on an iPad — only a signed build
 * pushed through MDM does. So every server change has to keep working for the
 * app version a kid is holding right now, which may be several releases behind. The
 * practice-machine work adds `scopeKey`/`dayKey`, a richer breaker episode, and
 * a new snapshot-key query; an installed client sends none of the new arguments
 * and reads none of the new fields.
 *
 * These tests pin the shape from the OLD client's side: submit with the minimal
 * argument set an older build sends, and assert the retained response surface is
 * intact. They exist because the repo had no such test — the existing coverage
 * asserts current-client behavior, which would stay green while a deployed iPad
 * silently lost its recovery path.
 */

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return seedScholarInInstitution(t, {
    institutionId: await seedTestInstitution(t),
    name: "Legacy Client Scholar",
    username: "legacyclient",
  });
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("installed-native compatibility", () => {
  test("submitAnswer works with the minimal old-client argument set", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    const session = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
    });
    const item = session.items[0]!;
    const truth = gradeTemplateItem(item.itemId, "0");

    // Exactly what an older build sends: no clientEventId, no
    // prepareBreakerRepair, no suppressBreaker, no replay.
    const res = await as.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item.itemId,
      answer: truth!.correctAnswer,
    });

    expect(res.correct).toBe(true);
    expect(res.skillKey).toBe(item.skillKey);
    expect(res.repetition).toBeGreaterThanOrEqual(1);
  });

  test("an old client that ignores scopeKey/dayKey still gets a usable run", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    const session = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 3,
    });
    // The new fields are additive: present for new clients, ignorable by old
    // ones. What an installed build actually reads must be unchanged.
    expect(session.items.length).toBeGreaterThan(0);
    expect(session.segments.length).toBeGreaterThan(0);
    expect(session.items[0]).toHaveProperty("itemId");
    expect(session.items[0]).toHaveProperty("skillKey");
  });

  test("the legacy backOff recovery hint survives for clients that use it", async () => {
    // Deployed builds predating the server-owned recovery mutations still read
    // `backOff.recoverySkillKey`/`recoveryDomain` to pick their own easier item.
    // Newer clients ignore both in favour of breakerEasyFinishSession, but
    // dropping them would strand an installed iPad with no recovery at all.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);

    let sawBackOff = false;
    // Three consecutive misses in a counted lane is the breaker threshold.
    for (let i = 0; i < 4; i += 1) {
      const session = await as.query(api.practiceSkills.practiceSession, {
        scholarId: scholar,
        seed: 100 + i,
      });
      const item = session.items[0];
      if (!item) break;
      const res = await as.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: item.itemId,
        answer: "999999",
      });
      if (res.backOff) {
        sawBackOff = true;
        // The shape an old client destructures. `recoverySkillKey` is optional
        // (there may be no runnable easier skill yet), but when the server does
        // offer one it must still carry its domain alongside.
        expect(res.backOff).toHaveProperty("missStreak");
        if (res.backOff.recoverySkillKey !== undefined) {
          expect(typeof res.backOff.recoverySkillKey).toBe("string");
          expect(typeof res.backOff.recoveryDomain).toBe("string");
        }
        break;
      }
    }
    expect(sawBackOff).toBe(true);
  });

  test("recordBreakerOutcome still accepts the pre-v2 legacy payload", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    const session = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 11,
    });
    const item = session.items[0]!;
    await as.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item.itemId,
      answer: "999999",
    });

    // The binary-offer telemetry endpoint older builds still call.
    const res = await as.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      itemId: item.itemId,
      streak: 3,
      offer: "declined",
      recovery: "skipped",
    });
    expect(res).toHaveProperty("recorded");
  });

  test("practiceSession still accepts the inert allowOutsideFocus argument", async () => {
    // Retained purely so an installed build that still sends it doesn't fail
    // argument validation. It intentionally does nothing.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    const session = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 5,
      allowOutsideFocus: true,
    });
    expect(session.items.length).toBeGreaterThan(0);
  });
});
