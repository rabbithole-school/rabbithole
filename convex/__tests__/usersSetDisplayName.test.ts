import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

test("setDisplayName trims and rejects an empty name", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "avery", username: "avery", role: "teacher" }),
  );
  expect(
    await t.mutation(internal.users.setDisplayName, { userId, name: "  Avery Stone " }),
  ).toEqual({ previous: "avery", name: "Avery Stone" });
  expect((await t.run((ctx) => ctx.db.get(userId)))?.name).toBe("Avery Stone");
  await expect(
    t.mutation(internal.users.setDisplayName, { userId, name: "   " }),
  ).rejects.toThrow(/empty/);
});
