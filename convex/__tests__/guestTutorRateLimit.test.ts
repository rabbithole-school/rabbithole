/**
 * Guest mode's rate limiter, against a real Convex backend.
 *
 * WHY THIS FILE EXISTS: the first version of guest mode claimed a rate-limit
 * slot only on the OPENING turn of an exchange. Every policy unit test passed,
 * because the pure helpers were all correct — the hole was in which of them the
 * handler called, and when. Against a live deployment, five consecutive
 * off-topic requests from an IP whose exchange quota was already spent all
 * returned 200: an unauthenticated, unbounded LLM proxy.
 *
 * So these tests exercise the MUTATION, not the constants, and the first one
 * is the regression test for exactly that bug: a continuation turn must be
 * charged. If you are here because a test failed after making the limiter
 * cheaper, read `convex/guestTutor.ts`'s header before "fixing" it.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  GUEST_SESSIONS_PER_DAY_GLOBAL,
  GUEST_SESSIONS_PER_IP_PER_HOUR,
  GUEST_TURNS_PER_DAY_GLOBAL,
  GUEST_TURNS_PER_IP_PER_HOUR,
  GUEST_IP_WINDOW_MS,
} from "../lib/guestTutor";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const T0 = 1_800_000_000_000;

function claim(
  t: ReturnType<typeof convexTest>,
  opts: { ipHash?: string; isOpening?: boolean; nowMs?: number } = {},
) {
  return t.mutation(internal.guestTutor.claimGuestTurn, {
    ipHash: opts.ipHash ?? "ip-a",
    topic: "virus",
    isOpening: opts.isOpening ?? false,
    nowMs: opts.nowMs ?? T0,
  });
}

describe("claimGuestTurn", () => {
  test("charges a CONTINUATION turn — the free-proxy regression", async () => {
    const t = convexTest(schema, modules);
    // Never send an opening. Under the original bug this loop was unbounded.
    for (let i = 0; i < GUEST_TURNS_PER_IP_PER_HOUR; i += 1) {
      expect((await claim(t, { isOpening: false })).ok).toBe(true);
    }
    const overflow = await claim(t, { isOpening: false });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toBe("ip_turns");
  });

  test("caps openings per IP while turns still have room", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < GUEST_SESSIONS_PER_IP_PER_HOUR; i += 1) {
      expect((await claim(t, { isOpening: true })).ok).toBe(true);
    }
    const refused = await claim(t, { isOpening: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("ip_exchanges");
    // An exchange already under way is not collateral damage: the visitor who
    // spent their third opening can still finish that conversation.
    expect((await claim(t, { isOpening: false })).ok).toBe(true);
  });

  test("keeps one IP's exhaustion off another IP", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < GUEST_TURNS_PER_IP_PER_HOUR; i += 1) {
      await claim(t, { ipHash: "ip-a" });
    }
    expect((await claim(t, { ipHash: "ip-a" })).ok).toBe(false);
    expect((await claim(t, { ipHash: "ip-b" })).ok).toBe(true);
  });

  test("refills when the hour rolls", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < GUEST_TURNS_PER_IP_PER_HOUR; i += 1) {
      await claim(t, { nowMs: T0 });
    }
    expect((await claim(t, { nowMs: T0 })).ok).toBe(false);
    expect(
      (await claim(t, { nowMs: T0 + GUEST_IP_WINDOW_MS + 1 })).ok,
    ).toBe(true);
  });

  test("charges the global window too", async () => {
    const t = convexTest(schema, modules);
    await claim(t, { ipHash: "ip-a", isOpening: true });
    await claim(t, { ipHash: "ip-b", isOpening: true });
    const global = await t.run(async (ctx) =>
      ctx.db
        .query("guestTutorRateLimits")
        .withIndex("by_scope_window", (q) => q.eq("scope", "global"))
        .first(),
    );
    expect(global?.turns).toBe(2);
    expect(global?.exchanges).toBe(2);
  });

  test("REFUSES on the global cap once many IPs sum past it", async () => {
    // The global cap is the bound that still holds after the per-IP one is
    // defeated by address rotation, which makes it the most important refusal
    // in the file — and the one nothing exercised until this test.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("guestTutorRateLimits", {
        scope: "global",
        windowStartedAt: T0,
        turns: GUEST_TURNS_PER_DAY_GLOBAL - 1,
        exchanges: 0,
      });
    });
    // A brand-new IP, well under its own cap, still gets one turn and then the
    // door: the global counter is what stops it.
    expect((await claim(t, { ipHash: "fresh-ip" })).ok).toBe(true);
    const refused = await claim(t, { ipHash: "another-fresh-ip" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("global_turns");
  });

  test("REFUSES a new opening once the global exchange cap is spent", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("guestTutorRateLimits", {
        scope: "global",
        windowStartedAt: T0,
        turns: 0,
        exchanges: GUEST_SESSIONS_PER_DAY_GLOBAL,
      });
    });
    const refused = await claim(t, { ipHash: "fresh-ip", isOpening: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("global_exchanges");
    // Exchanges already under way still finish — the same courtesy the per-IP
    // cap extends.
    expect((await claim(t, { ipHash: "fresh-ip" })).ok).toBe(true);
  });

  test("stores no message text and no raw IP", async () => {
    const t = convexTest(schema, modules);
    await claim(t, { ipHash: "hashed-bucket", isOpening: true });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("guestTutorRateLimits").collect(),
    );
    // The key set, both directions: an added field fails the first assertion
    // and a removed one fails the second. `topic` is the only optional key
    // (the global row carries none), so it is excluded from the required set
    // rather than from the check entirely.
    //
    // (An earlier version also asserted the row contains no dotted-quad, which
    // could never fail — the mutation is handed an already-hashed scope. That
    // property lives in `hashGuestIp`/`guestClientIp` and is tested there.)
    const allowed = [
      "_creationTime",
      "_id",
      "exchanges",
      "scope",
      "topic",
      "turns",
      "windowStartedAt",
    ];
    const required = allowed.filter((key) => key !== "topic");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const keys = Object.keys(row);
      expect(keys.filter((key) => !allowed.includes(key))).toEqual([]);
      expect(required.filter((key) => !keys.includes(key))).toEqual([]);
    }
  });

  test("purges rows past their window and leaves live ones", async () => {
    const t = convexTest(schema, modules);
    await claim(t, { ipHash: "old", nowMs: T0 });
    await claim(t, { ipHash: "fresh", nowMs: T0 + 40 * 60 * 60 * 1000 });
    const { deleted } = await t.mutation(
      internal.guestTutor.purgeGuestRateLimits,
      { nowMs: T0 + 40 * 60 * 60 * 1000 },
    );
    // Two: the stale IP row AND the stale global row. The second claim was
    // outside the 24 h global window, so it opened a fresh global row rather
    // than extending the old one — which is what leaves an expired global row
    // for the purge to take.
    expect(deleted).toBe(2);
    const left = await t.run(async (ctx) =>
      ctx.db.query("guestTutorRateLimits").collect(),
    );
    expect(left.map((row) => row.scope).sort()).toEqual(["fresh", "global"]);
  });
});
