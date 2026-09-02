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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test-${role}`,
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "Input modality test",
      isArchived: false,
    }),
  );
}

describe("session message input modality", () => {
  test.each(["typed", "spoken"] as const)(
    "persists %s on the user message",
    async (inputModality) => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const sessionId = await seedSession(t, scholarId);
      const scholar = await withUser(t, scholarId);

      await scholar.mutation(api.sessions.sendMessage, {
        sessionId,
        message: "A fictional test message",
        inputModality,
      });

      const userMessage = await t.run(async (ctx) =>
        ctx.db
          .query("messages")
          .withIndex("by_session_role", (q) =>
            q.eq("sessionId", sessionId).eq("role", "user"),
          )
          .unique(),
      );
      expect(userMessage?.inputModality).toBe(inputModality);
    },
  );

  test("keeps older clients and historical messages compatible", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);
    const scholar = await withUser(t, scholarId);

    await scholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "A message from an older client",
    });

    const transcript = await scholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    const userMessage = transcript.messages.find(
      (message) => message.role === "user",
    );

    expect(userMessage?.inputModality).toBeUndefined();
  });
});
