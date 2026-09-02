import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  suffix = "",
) {
  const name = role === "scholar" ? `Scholar ${suffix}` : `Test ${role}`;
  const username = role === "scholar" ? `scholar${suffix}` : `test${role}${suffix}`;
  const institutionId = await seedTestInstitution(t);
  if (role === "teacher") {
    return seedStaffWithMembership(t, { institutionId, name, username });
  }
  if (role === "scholar") {
    return seedScholarInInstitution(t, { institutionId, name, username });
  }
  return t.run((ctx) => ctx.db.insert("users", { name, username, role }));
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedLiveSessionWithMessages(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  opts: { isTestDrive?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "My session",
      isArchived: false,
      ...(opts.isTestDrive ? { isTestDrive: true } : {}),
    });
    const userMsg = await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "is 2 + 2 = 5?",
      flagged: false,
    });
    const assistantMsg1 = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "Yes, 2 + 2 = 5.",
      flagged: false,
    });
    const assistantMsg2 = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "Let's keep going.",
      flagged: false,
    });
    return { sessionId, userMsg, assistantMsg1, assistantMsg2 };
  });
}

describe("messageFlags.toggle — scholar 'got this wrong' control", () => {
  test("scholar can flag a tutor message in their own live session", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const r = await asScholar.mutation(api.messageFlags.toggle, {
      messageId: assistantMsg1,
    });
    expect(r.flagged).toBe(true);

    const flags = await t.run(async (ctx) =>
      ctx.db
        .query("messageFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .collect(),
    );
    expect(flags.length).toBe(1);
    expect(flags[0].scholarId).toBe(scholarId);
  });

  test("clicking again toggles the flag off (reversible)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.messageFlags.toggle, {
      messageId: assistantMsg1,
    });
    const second = await asScholar.mutation(api.messageFlags.toggle, {
      messageId: assistantMsg1,
    });
    expect(second.flagged).toBe(false);

    const flags = await t.run(async (ctx) =>
      ctx.db
        .query("messageFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .collect(),
    );
    expect(flags.length).toBe(0);
  });

  test("an optional reason is stored", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.messageFlags.toggle, {
      messageId: assistantMsg1,
      reason: "2 + 2 is 4, not 5",
    });
    const flag = await t.run(async (ctx) =>
      ctx.db
        .query("messageFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .first(),
    );
    expect(flag?.reason).toBe("2 + 2 is 4, not 5");
  });

  test("a different scholar cannot flag someone else's session (Forbidden)", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "scholar", "owner");
    const otherId = await seedUser(t, "scholar", "other");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, ownerId);
    const asOther = await withUser(t, otherId);

    await expect(
      asOther.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("test-drive sessions reject the scholar flag", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId, {
      isTestDrive: true,
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 }),
    ).rejects.toThrow(/live scholar/);
  });

  test("user-role messages cannot be flagged (only the tutor's output)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { userMsg } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.messageFlags.toggle, { messageId: userMsg }),
    ).rejects.toThrow(/tutor/);
  });
});

describe("messageFlags.toggle — scholar feedback raises a non-urgent alert", () => {
  test("a new flag records an info alert to #rabbithole-alerts", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.messageFlags.toggle, {
      messageId: assistantMsg1,
      reason: "2 + 2 is 4, not 5",
    });

    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("scholar_feedback");
    expect(alerts[0].severity).toBe("info");
    expect(alerts[0].scholarId).toBe(scholarId);
    expect(alerts[0].body).toContain("Yes, 2 + 2 = 5.");
    expect(alerts[0].body).toContain("My session");
    expect(alerts[0].body).toContain("2 + 2 is 4, not 5");
  });

  test("toggling the flag OFF does not raise another alert", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 });
    await asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 });

    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
  });

  test("re-flagging the same message is deduped (no double-post)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    // flag → unflag → flag again, all within the dedup window.
    await asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 });
    await asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 });
    await asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 });

    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
  });

  test("flagging two different messages raises two distinct alerts", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1, assistantMsg2 } =
      await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg1 });
    await asScholar.mutation(api.messageFlags.toggle, { messageId: assistantMsg2 });

    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(2);
  });
});

describe("sessions.getWithMessages — gotItWrong enrichment", () => {
  test("flagged tutor messages carry gotItWrong; others do not", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { sessionId, assistantMsg1, assistantMsg2 } =
      await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.messageFlags.toggle, {
      messageId: assistantMsg1,
      reason: "wrong arithmetic",
    });

    const result = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    const flagged = result.messages.find((m) => m.id === assistantMsg1);
    const notFlagged = result.messages.find((m) => m.id === assistantMsg2);
    expect(flagged?.gotItWrong).toBe(true);
    expect(flagged?.gotItWrongReason).toBe("wrong arithmetic");
    expect(notFlagged?.gotItWrong).toBe(false);
  });
});

describe("messageFlags.listForScholar — teacher surface", () => {
  test("returns count + recent catches with a snippet", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedLiveSessionWithMessages(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    await asScholar.mutation(api.messageFlags.toggle, {
      messageId: assistantMsg1,
    });

    const summary = await asTeacher.query(api.messageFlags.listForScholar, {
      scholarId,
    });
    expect(summary.count).toBe(1);
    expect(summary.recent.length).toBe(1);
    expect(summary.recent[0].snippet).toContain("2 + 2 = 5");
    expect(summary.recent[0].sessionTitle).toBe("My session");
  });

  test("a scholar cannot read the teacher surface", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.messageFlags.listForScholar, { scholarId }),
    ).rejects.toThrow();
  });
});
