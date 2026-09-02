import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the parent aide's session storage is parent-only and its
// context (used to scope the aide's tools) must list ONLY the parent's own
// children. These pin the gating + the scoping source-of-truth.

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: string,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: role as Doc<"users">["role"],
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

describe("parentChat — parent-only session storage", () => {
  test("sendMessage creates a user row + an empty assistant placeholder", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent", "p");
    const asParent = await withUser(t, parent);
    const { assistantMsgId, streamId } = await asParent.mutation(
      api.parentChat.sendMessage,
      { content: "How is my kid doing?" },
    );
    expect(streamId).toMatch(/^[0-9a-f]{32}$/);
    const msgs = await asParent.query(api.parentChat.listMessages, {});
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.find((m) => m._id === assistantMsgId)?.content).toBe("");
  });

  test("a non-guardian cannot send, and listMessages returns []", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.parentChat.sendMessage, { content: "hi" }),
    ).rejects.toThrow(/not a guardian/i);
    expect(await asTeacher.query(api.parentChat.listMessages, {})).toEqual([]);
  });

  test("messages are strictly per-parent", async () => {
    const t = convexTest(schema, modules);
    const p1 = await seedUser(t, "parent", "p1");
    const p2 = await seedUser(t, "parent", "p2");
    await (await withUser(t, p1)).mutation(api.parentChat.sendMessage, {
      content: "p1 secret",
    });
    const p2msgs = await (await withUser(t, p2)).query(
      api.parentChat.listMessages,
      {},
    );
    expect(p2msgs).toEqual([]);
  });

  test("getMessageOwner identifies the owning parent (stream-handler ownership gate)", async () => {
    const t = convexTest(schema, modules);
    const p1 = await seedUser(t, "parent", "p1");
    const p2 = await seedUser(t, "parent", "p2");
    const { assistantMsgId } = await (await withUser(t, p1)).mutation(
      api.parentChat.sendMessage,
      { content: "hi" },
    );
    const owner = await t.run(async (ctx) =>
      ctx.runQuery(internal.parentChat.getMessageOwner, {
        messageId: assistantMsgId,
      }),
    );
    // Owner is p1, NOT p2 — so the handler's `ownerId !== callerUserId`
    // check rejects p2 trying to stream into p1's row.
    expect(owner).toBe(p1);
    expect(owner).not.toBe(p2);
  });

  test("getContext lists ONLY the parent's own children", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani"); // another family's kid
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.parentChat.getContext, { parentUserId: parentId }),
    );
    expect(context?.children.map((c) => c.id)).toEqual([kai]);
    expect(context?.children.map((c) => c.id)).not.toContain(lani);
  });
});
