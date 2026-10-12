import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { readAloudLabel } from "../lib/projectStreamMessages";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// A beginner's read-aloud of their "your turn" line (TRA-504): the line is
// taken from the previous tutor reply on the server, never from the client,
// and the tutor sees a word-by-word check of the reading.

async function setup(previousReply: string) {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Test scholar", username: "testscholar", role: "scholar" }),
  );
  const authSessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  const sessionId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("sessions", {
      userId,
      title: "Read aloud test",
      isArchived: false,
    });
    await ctx.db.insert("messages", {
      sessionId: id,
      role: "assistant",
      content: previousReply,
      flagged: false,
    });
    return id;
  });
  const scholar = t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
  return { t, scholar, sessionId };
}

async function lastUserMessage(
  t: Awaited<ReturnType<typeof setup>>["t"],
  sessionId: Id<"sessions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_session_role", (q) => q.eq("sessionId", sessionId).eq("role", "user"))
      .order("desc")
      .first(),
  );
}

describe("sendMessage — reading the your-turn line aloud", () => {
  test("stamps the line from the previous reply on a spoken read-aloud", async () => {
    const { t, scholar, sessionId } = await setup(
      "Foxes dig dens.\n<your-turn>Can a pig dig?</your-turn>",
    );
    await scholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "can a big dig",
      inputModality: "spoken",
      readingYourTurn: true,
    });
    expect((await lastUserMessage(t, sessionId))?.readAloudOf).toBe("Can a pig dig?");
  });

  test("a line the child can't decode is not a reading to check", async () => {
    const { t, scholar, sessionId } = await setup(
      "<your-turn>A shark with lava!</your-turn>",
    );
    await scholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "a shark with lava",
      inputModality: "spoken",
      readingYourTurn: true,
    });
    expect((await lastUserMessage(t, sessionId))?.readAloudOf).toBeUndefined();
  });

  test("no line in the previous reply, or a typed turn → nothing stamped", async () => {
    const a = await setup("Foxes dig dens.");
    await a.scholar.mutation(api.sessions.sendMessage, {
      sessionId: a.sessionId,
      message: "pig",
      inputModality: "spoken",
      readingYourTurn: true,
    });
    expect((await lastUserMessage(a.t, a.sessionId))?.readAloudOf).toBeUndefined();

    const b = await setup("<your-turn>Can a pig dig?</your-turn>");
    await b.scholar.mutation(api.sessions.sendMessage, {
      sessionId: b.sessionId,
      message: "can a pig dig",
      inputModality: "typed",
      readingYourTurn: true,
    });
    expect((await lastUserMessage(b.t, b.sessionId))?.readAloudOf).toBeUndefined();
  });
});

describe("readAloudLabel", () => {
  test("carries the line and the word check", () => {
    expect(readAloudLabel("Can a pig dig?", "can a pig dig")).toContain(
      "Word check: all 4 words matched",
    );
    expect(readAloudLabel("Can a pig dig?", "can a big dig")).toContain(
      '3 of 4 words matched; "pig" came out as "big"',
    );
    expect(readAloudLabel("Kits nap.", "kits")).toContain('"nap" was not heard');
  });

  test("a refusal is a non-attempt, never praised as matched words", () => {
    const label = readAloudLabel("Can I sip it?", "um I can't read that");
    expect(label).toContain("no real attempt");
    expect(label).not.toContain("matched");
  });
});
