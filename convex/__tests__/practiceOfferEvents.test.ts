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

async function asUser(t: ReturnType<typeof convexTest>, username: string) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return {
    userId: userId as Id<"users">,
    as: t.withIdentity({
      subject: `${userId}|${sessionId}`,
      issuer: "https://convex.dev",
    }),
  };
}

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("practiceOfferEvents").collect());

describe("practiceOfferEvents", () => {
  test("recordOfferShown is idempotent per clientEventId", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await asUser(t, "offer-a");
    const a = await as.mutation(api.practiceOfferEvents.recordOfferShown, {
      kind: "reprobe",
      clientEventId: "evt-1",
    });
    const b = await as.mutation(api.practiceOfferEvents.recordOfferShown, {
      kind: "reprobe",
      clientEventId: "evt-1",
    });
    expect(b.eventId).toBe(a.eventId);
    const all = await rows(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      scholarId: userId,
      kind: "reprobe",
      outcome: "offered",
    });
  });

  test("is self-only: rows belong to the caller and ids resolve within the caller's own ledger", async () => {
    const t = convexTest(schema, modules);
    const a = await asUser(t, "offer-a");
    const b = await asUser(t, "offer-b");
    await a.as.mutation(api.practiceOfferEvents.recordOfferShown, {
      kind: "tuneup",
      clientEventId: "shared-id",
    });
    const res = await b.as.mutation(api.practiceOfferEvents.recordOfferOutcome, {
      clientEventId: "shared-id",
      outcome: "accepted",
    });
    expect(res.settled).toBe(false);
    const all = await rows(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ scholarId: a.userId, outcome: "offered" });
    await b.as.mutation(api.practiceOfferEvents.recordOfferShown, {
      kind: "tuneup",
      clientEventId: "shared-id",
    });
    expect(await rows(t)).toHaveLength(2);
  });

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.practiceOfferEvents.recordOfferShown, {
        kind: "stretch",
        clientEventId: "x",
      }),
    ).rejects.toThrow();
  });

  test("accepted and declined are terminal; first outcome wins", async () => {
    const t = convexTest(schema, modules);
    const { as } = await asUser(t, "offer-a");
    await as.mutation(api.practiceOfferEvents.recordOfferShown, {
      kind: "reprobe",
      clientEventId: "r1",
    });
    expect(
      await as.mutation(api.practiceOfferEvents.recordOfferOutcome, {
        clientEventId: "r1",
        outcome: "declined",
      }),
    ).toEqual({ settled: true });
    expect(
      await as.mutation(api.practiceOfferEvents.recordOfferOutcome, {
        clientEventId: "r1",
        outcome: "accepted",
      }),
    ).toEqual({ settled: false });
    // A retried render does not reopen a settled offer.
    await as.mutation(api.practiceOfferEvents.recordOfferShown, {
      kind: "reprobe",
      clientEventId: "r1",
    });
    const all = await rows(t);
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe("declined");
    expect(all[0].outcomeAt).toBeTypeOf("number");

    await as.mutation(api.practiceOfferEvents.recordOfferShown, {
      kind: "challenge",
      clientEventId: "c1",
    });
    await as.mutation(api.practiceOfferEvents.recordOfferOutcome, {
      clientEventId: "c1",
      outcome: "accepted",
    });
    await as.mutation(api.practiceOfferEvents.recordOfferOutcome, {
      clientEventId: "c1",
      outcome: "declined",
    });
    const c = (await rows(t)).find((r) => r.clientEventId === "c1")!;
    expect(c.outcome).toBe("accepted");
  });

  test("an outcome for an unknown event is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { as } = await asUser(t, "offer-a");
    expect(
      await as.mutation(api.practiceOfferEvents.recordOfferOutcome, {
        clientEventId: "never-shown",
        outcome: "accepted",
      }),
    ).toEqual({ settled: false });
    expect(await rows(t)).toHaveLength(0);
  });
});
