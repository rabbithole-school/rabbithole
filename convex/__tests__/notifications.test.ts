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

// Why this file: notification prefs are a SCAFFOLD (nothing sends yet), but
// the store still has to behave: sensible defaults when unset, upsert that
// preserves untouched fields, phone stored on the user row, and strictly
// per-caller (you can only read/write your OWN prefs).

async function seedUser(t: ReturnType<typeof convexTest>, role: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${role}`, username: role, role: role as Doc<"users">["role"] }),
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

describe("notification prefs scaffold", () => {
  test("defaults apply when no row exists", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent");
    const asParent = await withUser(t, parent);
    const prefs = await asParent.query(api.notifications.getMyPrefs, {});
    expect(prefs).toMatchObject({
      emailEnabled: true,
      smsEnabled: false,
      weeklyDigest: true,
      homeworkReminders: true,
      digestDay: "sunday",
      phone: null,
    });
  });

  test("upsert persists a single field without clobbering others", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent");
    const asParent = await withUser(t, parent);
    await asParent.mutation(api.notifications.updateMyPrefs, { weeklyDigest: false });
    await asParent.mutation(api.notifications.updateMyPrefs, { smsEnabled: true });
    const prefs = await asParent.query(api.notifications.getMyPrefs, {});
    expect(prefs.weeklyDigest).toBe(false);
    expect(prefs.smsEnabled).toBe(true);
    expect(prefs.emailEnabled).toBe(true); // untouched default preserved
    // Exactly one row (upsert, not insert-twice).
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("notificationPrefs")
        .withIndex("by_user", (q) => q.eq("userId", parent))
        .collect(),
    );
    expect(rows.length).toBe(1);
  });

  test("phone + address are stored on the user row (self-service contact)", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent");
    const asParent = await withUser(t, parent);
    await asParent.mutation(api.notifications.updateMyPrefs, {
      phone: "808-555-0123",
      address: " 9 Aloha Way, Hilo HI ",
    });
    const prefs = await asParent.query(api.notifications.getMyPrefs, {});
    expect(prefs.phone).toBe("808-555-0123");
    expect(prefs.address).toBe("9 Aloha Way, Hilo HI"); // trimmed
    const user = await t.run(async (ctx) => ctx.db.get(parent));
    expect(user?.phone).toBe("808-555-0123");
    expect(user?.address).toBe("9 Aloha Way, Hilo HI");
    // Empty string clears the address.
    await asParent.mutation(api.notifications.updateMyPrefs, { address: "" });
    const cleared = await t.run(async (ctx) => ctx.db.get(parent));
    expect(cleared?.address).toBeUndefined();
  });

  test("prefs are strictly per-caller", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "parent");
    const b = await seedUser(t, "scholar");
    const asA = await withUser(t, a);
    const asB = await withUser(t, b);
    await asA.mutation(api.notifications.updateMyPrefs, { weeklyDigest: false });
    // B sees its own defaults, not A's change.
    const bPrefs = await asB.query(api.notifications.getMyPrefs, {});
    expect(bPrefs.weeklyDigest).toBe(true);
  });

  test("requires authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.notifications.getMyPrefs, {})).rejects.toThrow(
      /not authenticated/i,
    );
  });
});
