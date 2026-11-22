import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function seedUser(t: T, role: "scholar" | "platform_admin") {
  const institutionId = await seedTestInstitution(t);
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `test${role}`,
      role,
      institutionId,
    }),
  );
}

async function withUser(t: T, userId: Id<"users">) {
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

async function linkChannels(t: T) {
  const admin = await seedUser(t, "platform_admin");
  // A catchall alongside platform-ops proves the post picks platform-ops only.
  await t.mutation(internal.alerts.linkAlertsChannel, {
    callerUserId: admin,
    slackChannelId: "C_CATCHALL",
    unlink: false,
  });
  await t.mutation(internal.alerts.linkAlertsChannel, {
    callerUserId: admin,
    slackChannelId: "C_OPS",
    unlink: false,
    role: "platform-ops",
  });
}

async function scheduledPosts(t: T) {
  const rows = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return rows.map((row) => row.args[0] as { channelId: string; text: string; scholarId?: string });
}

describe("alerts.reportBlockedLink", () => {
  test("posts the two hosts to platform-ops only, never a path, query or scholar", async () => {
    const t = convexTest(schema, modules);
    await linkChannels(t);
    const scholar = await withUser(t, await seedUser(t, "scholar"));

    await scholar.mutation(api.alerts.reportBlockedLink, {
      fromUrl: "https://docs.example.com/d/doc-id-secret/view?usp=sharing&token=secret#p2",
      toUrl: "https://other.example.org/users/scholar-name?code=12345",
    });

    const posts = await scheduledPosts(t);
    expect(posts).toHaveLength(1);
    expect(posts[0].channelId).toBe("C_OPS");
    expect(posts[0].scholarId).toBeUndefined();
    expect(posts[0].text).toBe(
      "🔗 **BunnyPad link viewer blocked a tap**\n" +
        "From: docs.example.com\n" +
        "To: other.example.org",
    );
    expect(posts[0].text).not.toContain("secret");
    expect(posts[0].text).not.toContain("scholar-name");
    expect(posts[0].text).not.toContain("12345");
    await t.finishAllScheduledFunctions(() => {});
  });

  test("the same pair of sites posts once per dedup window", async () => {
    const t = convexTest(schema, modules);
    await linkChannels(t);
    const scholar = await withUser(t, await seedUser(t, "scholar"));

    for (const toUrl of [
      "https://other.example.org/a",
      "https://www.other.example.org/b",
    ]) {
      await scholar.mutation(api.alerts.reportBlockedLink, {
        fromUrl: "https://example.com/start",
        toUrl,
      });
    }
    await scholar.mutation(api.alerts.reportBlockedLink, {
      fromUrl: "https://example.com/start",
      toUrl: "https://third.example.net/c",
    });

    const posts = await scheduledPosts(t);
    expect(posts.map((p) => p.text.split("\nTo: ")[1])).toEqual([
      "other.example.org",
      "third.example.net",
    ]);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("ignores a destination that is not an http(s) link", async () => {
    const t = convexTest(schema, modules);
    await linkChannels(t);
    const scholar = await withUser(t, await seedUser(t, "scholar"));

    await scholar.mutation(api.alerts.reportBlockedLink, {
      fromUrl: "https://example.com/start",
      toUrl: "mailto:someone@example.com",
    });

    expect(await scheduledPosts(t)).toHaveLength(0);
    const alerts = await t.run((ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(0);
  });

  test("requires a signed-in caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.alerts.reportBlockedLink, {
        fromUrl: "https://example.com/start",
        toUrl: "https://other.example.org/a",
      }),
    ).rejects.toThrow();
  });
});
