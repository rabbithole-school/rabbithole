import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// TRA-499: a scholar sending a reading-level override used to get success with
// the field silently dropped. It now refuses; staff still set it.
describe("sessions.update level overrides", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const scholar = school.scholars[0];
    const id = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar.id,
        title: "Work",
        isArchived: false,
      }),
    );
    return {
      t,
      id,
      asScholar: await world.as.scholar(scholar),
      asTeacher: await world.as.staffOf(school),
    };
  }

  test("a scholar is refused, and nothing changes", async () => {
    const { t, id, asScholar } = await setup();
    await expect(
      asScholar.mutation(api.sessions.update, { id, readingLevelOverride: "K" }),
    ).rejects.toThrow(/Only staff can set a reading-level override/);
    await expect(
      asScholar.mutation(api.sessions.update, { id, readLevelOverride: "listener" }),
    ).rejects.toThrow(/Only staff can set a reading-level override/);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.readingLevelOverride).toBeUndefined();
    expect(row?.readLevelOverride).toBeUndefined();
  });

  test("a scholar can still rename their session", async () => {
    const { id, asScholar } = await setup();
    const row = await asScholar.mutation(api.sessions.update, { id, title: "New" });
    expect(row?.title).toBe("New");
  });

  test("a teacher can set the override", async () => {
    const { id, asTeacher } = await setup();
    const row = await asTeacher.mutation(api.sessions.update, {
      id,
      readingLevelOverride: "K",
    });
    expect(row?.readingLevelOverride).toBe("K");
  });
});
