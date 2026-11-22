import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (import.meta as ImportMeta & {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.ts");

async function setup(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Avery Stone", username: "avery", role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId, title: "Test session", isArchived: false,
    });
    const otherSessionId = await ctx.db.insert("sessions", {
      userId: scholarId, title: "Other session", isArchived: false,
    });
    return { scholarId, sessionId, otherSessionId };
  });
}

type Ids = Awaited<ReturnType<typeof setup>>;

const connection = (
  ids: Ids,
  domains: string[],
  description: string,
  sessionId = ids.sessionId,
) => ({
  scholarId: ids.scholarId,
  sessionId,
  domains,
  conceptLabels: domains.map((d) => `${d} idea`),
  description,
  studentInitiated: true,
});

describe("crossDomainConnections.record", () => {
  test("a restated connection refreshes the first row instead of adding one", async () => {
    const t = convexTest(schema, modules);
    const ids = await setup(t);
    const [first, restated, reordered] = await t.run(async (ctx) => [
      await ctx.runMutation(internal.crossDomainConnections.record,
        connection(ids, ["Social Studies", "Game Design"], "first reading")),
      await ctx.runMutation(internal.crossDomainConnections.record,
        connection(ids, ["Social Studies", "Game Design"], "latest reading")),
      await ctx.runMutation(internal.crossDomainConnections.record,
        connection(ids, ["game design", "social studies"], "reordered reading")),
    ]);
    expect(restated).toBe(first);
    expect(reordered).toBe(first);
    const rows = await t.run((ctx) => ctx.db.query("crossDomainConnections").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("reordered reading");
  });

  test("distinct domain sets and sessions stay separate", async () => {
    const t = convexTest(schema, modules);
    const ids = await setup(t);
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.crossDomainConnections.record,
        connection(ids, ["Math", "Music"], "a"));
      await ctx.runMutation(internal.crossDomainConnections.record,
        connection(ids, ["Math", "Art"], "b"));
      await ctx.runMutation(internal.crossDomainConnections.record,
        connection(ids, ["Math", "Music"], "c", ids.otherSessionId));
    });
    const rows = await t.run((ctx) => ctx.db.query("crossDomainConnections").collect());
    expect(rows).toHaveLength(3);
  });

  test("keeps the oldest of pre-existing duplicates so the date stays at first sighting", async () => {
    const t = convexTest(schema, modules);
    const ids = await setup(t);
    const [oldestId] = await t.run(async (ctx) => [
      await ctx.db.insert("crossDomainConnections", connection(ids, ["Math", "Music"], "old")),
      await ctx.db.insert("crossDomainConnections", connection(ids, ["Math", "Music"], "newer")),
    ]);
    const returned = await t.run((ctx) =>
      ctx.runMutation(internal.crossDomainConnections.record,
        connection(ids, ["Music", "Math"], "latest")));
    expect(returned).toBe(oldestId);
    const rows = await t.run((ctx) => ctx.db.query("crossDomainConnections").collect());
    expect(rows.map((r) => r._id)).toEqual([oldestId]);
    expect(rows[0].description).toBe("latest");
  });

  test("still ignores a single-domain connection", async () => {
    const t = convexTest(schema, modules);
    const ids = await setup(t);
    const result = await t.run((ctx) =>
      ctx.runMutation(internal.crossDomainConnections.record, connection(ids, ["Math"], "x")));
    expect(result).toBeNull();
  });
});

describe("crossDomainConnections.repairDuplicates", () => {
  test("dry run reports, real run deletes all but the oldest per session and domain set", async () => {
    const t = convexTest(schema, modules);
    const ids = await setup(t);
    const [oldId, dupA, dupB, otherId] = await t.run(async (ctx) => [
      await ctx.db.insert("crossDomainConnections", connection(ids, ["Math", "Music"], "old")),
      await ctx.db.insert("crossDomainConnections", connection(ids, ["music", "math"], "dup a")),
      await ctx.db.insert("crossDomainConnections", connection(ids, ["Math", "Music"], "dup b")),
      await ctx.db.insert("crossDomainConnections",
        connection(ids, ["Math", "Music"], "other session", ids.otherSessionId)),
    ]);

    const dry = await t.run((ctx) =>
      ctx.runMutation(internal.crossDomainConnections.repairDuplicates, {}));
    expect(dry.dryRun).toBe(true);
    expect(dry.totalRows).toBe(4);
    expect(dry.duplicateRows).toBe(2);
    expect(dry.candidates).toHaveLength(1);
    expect(dry.candidates[0].keepId).toBe(oldId);
    expect(dry.candidates[0].duplicateIds).toEqual([dupA, dupB]);
    expect(await t.run((ctx) => ctx.db.query("crossDomainConnections").collect())).toHaveLength(4);

    await t.run((ctx) =>
      ctx.runMutation(internal.crossDomainConnections.repairDuplicates, { dryRun: false }));
    const remaining = await t.run((ctx) => ctx.db.query("crossDomainConnections").collect());
    expect(remaining.map((r) => r._id).sort()).toEqual([oldId, otherId].sort());
  });
});
