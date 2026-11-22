/**
 * The Sky hook in `sessions.sendMessage` (TRA-699) can never cost a kid their
 * turn: when it throws, the turn is saved anyway and the error is logged
 * without the kid's words. The hook is replaced here by one that always fails.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

vi.mock("../lib/skyRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/skyRefresh")>()),
  noteSkyTurn: async () => {
    throw new Error("a read failed inside the Sky hook");
  },
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

afterEach(() => {
  vi.restoreAllMocks();
});

async function scholarWithSeedChat(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Scholar A",
      username: "scholar-a",
      role: "scholar",
    });
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "active",
      suggestionType: "frontier",
      topic: "Volcanoes",
      rationale: "",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      seedId,
      title: "Volcanoes",
      isArchived: false,
    });
    const authSessionId = await ctx.db.insert("authSessions", {
      userId: scholarId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    });
    return { scholarId, sessionId, authSessionId };
  });
}

describe("sendMessage with a failing Sky hook", () => {
  test("the turn is saved, and the log carries no words of the kid's", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId, authSessionId } = await scholarWithSeedChat(t);
    const asScholar = t.withIdentity({
      subject: `${scholarId}|${authSessionId}`,
      issuer: "https://convex.dev",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId: sessionId as Id<"sessions">,
      message: "why do volcanoes explode",
      inputModality: "typed",
    });
    expect(result.streamId).toBeTruthy();

    const turns = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session_role", (q) => q.eq("sessionId", sessionId).eq("role", "user"))
        .collect(),
    );
    expect(turns.map((turn) => turn.content)).toEqual(["why do volcanoes explode"]);

    const skyLogs = logged.mock.calls.filter((call) => String(call[0]).includes("Sky star hook"));
    expect(skyLogs).toHaveLength(1);
    expect(JSON.stringify(skyLogs)).not.toContain("volcanoes");
  });
});
