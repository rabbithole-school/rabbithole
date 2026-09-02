// The file-URL resolvers are the choke point between "holds an opaque storage
// id" and "holds a servable URL". Both public resolvers require auth; these
// tests lock that in so a future media surface can't quietly reintroduce the
// unauthenticated URL-minting pattern getUrl shipped with.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholarAndBlob(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Kai Kahale",
      username: "kai-files-test",
      role: "scholar",
    });
    const storageId = await ctx.storage.store(new Blob(["png-bytes"]));
    return { scholarId, storageId };
  });
}

describe("file URL resolvers require auth", () => {
  test("anonymous getUrl is rejected", async () => {
    const t = convexTest(schema, modules);
    const { storageId } = await seedScholarAndBlob(t);
    await expect(t.query(api.files.getUrl, { storageId })).rejects.toThrow();
  });

  test("anonymous getUrls is rejected", async () => {
    const t = convexTest(schema, modules);
    const { storageId } = await seedScholarAndBlob(t);
    await expect(
      t.query(api.files.getUrls, { storageIds: [storageId] }),
    ).rejects.toThrow();
  });

  test("a signed-in user resolves a URL through getUrl", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, storageId } = await seedScholarAndBlob(t);
    const url = await t
      .withIdentity({ subject: scholarId })
      .query(api.files.getUrl, { storageId });
    expect(url).toEqual(expect.any(String));
  });
});
