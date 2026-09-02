import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: a skip-if-exists seed never backfills a newly-added field
// onto already-seeded rows — which is how `test-teacher-001` came to NOT exist
// as a username on deployments seeded before usernames were added, while the
// docs promised it did. `seedAll` now reconciles `username = externalId` on
// EVERY run (before the skip-guard). Pin that so the regression can't return.

describe("seed reconciles devLogin usernames every run", () => {
  test("backfills username=externalId on an already-seeded deployment", async () => {
    const t = convexTest(schema, modules);

    // Simulate a deployment seeded BEFORE usernames existed: a test user with
    // an externalId but no username, and a persona already present (so the bulk
    // seed hits its skip-guard — we're proving the reconcile runs ANYWAY).
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        name: "Test Teacher",
        externalId: "test-teacher-001",
        role: "teacher",
        // NOTE: no username — the pre-#82 state.
      });
      await ctx.db.insert("personas", {
        teacherId: id,
        emoji: "🧪",
        title: "Seeded",
        isActive: true,
      });
      return id;
    });

    // Re-run the seed (what `pnpm db:seed` does).
    await t.run(async (ctx) => ctx.runMutation(internal.seedData.seedAll, {}));

    const after = await t.run(async (ctx) => ctx.db.get(userId));
    expect(after?.username).toBe("test-teacher-001"); // backfilled
  });

  test("does not clobber a username that's already set", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        name: "Custom",
        externalId: "test-scholar-001",
        username: "already-chosen",
        role: "scholar",
      });
      await ctx.db.insert("personas", { teacherId: id, emoji: "🧪", title: "Seeded", isActive: true });
      return id;
    });
    await t.run(async (ctx) => ctx.runMutation(internal.seedData.seedAll, {}));
    const after = await t.run(async (ctx) => ctx.db.get(userId));
    expect(after?.username).toBe("already-chosen"); // untouched
  });
});

// The query that powers the self-describing index / bad-username error. Its
// whole value is the gate: it must reveal usernames ONLY to a caller with the
// dev secret (and never on prod), so an unauthenticated page can't enumerate
// users without it.
describe("listDevLoginUsers — secret-gated", () => {
  const prevSecret = process.env.DEV_TEST_LOGIN_SECRET;
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.DEV_TEST_LOGIN_SECRET;
    else process.env.DEV_TEST_LOGIN_SECRET = prevSecret;
  });

  async function seedUsers(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { name: "T", username: "the-teacher", role: "teacher" });
      await ctx.db.insert("users", { name: "S", username: "a-scholar", role: "scholar" });
      // A user with NO username is not devLogin-able and must be omitted.
      await ctx.db.insert("users", { name: "Ghost", role: "scholar" });
    });
  }

  test("returns the username'd users for the right secret", async () => {
    process.env.DEV_TEST_LOGIN_SECRET = "s3cret";
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const list = await t.query(api.users.listDevLoginUsers, { secret: "s3cret" });
    // Both username'd users, with their roles; the username-less "Ghost" is
    // excluded (not devLogin-able). Display ordering is the page's concern.
    expect(list.map((u) => `${u.username}:${u.role}`).sort()).toEqual([
      "a-scholar:scholar",
      "the-teacher:teacher",
    ]);
  });

  test("returns [] for a wrong secret", async () => {
    process.env.DEV_TEST_LOGIN_SECRET = "s3cret";
    const t = convexTest(schema, modules);
    await seedUsers(t);
    expect(await t.query(api.users.listDevLoginUsers, { secret: "nope" })).toEqual([]);
  });

  test("returns [] when the deployment has no dev secret (e.g. prod)", async () => {
    delete process.env.DEV_TEST_LOGIN_SECRET;
    const t = convexTest(schema, modules);
    await seedUsers(t);
    expect(await t.query(api.users.listDevLoginUsers, { secret: "anything" })).toEqual([]);
  });
});
