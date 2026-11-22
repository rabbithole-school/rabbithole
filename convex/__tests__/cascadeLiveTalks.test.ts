import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { deleteInstitutionScopedBatch, purgeUserInner } from "../lib/cascade";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 2,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  const [presenter, listener] = school.scholars.map((s) => s.id);
  const ids = await t.run(async (ctx) => {
    const mkTalk = async (presenterId: typeof presenter, listenerId?: typeof presenter) =>
      ctx.db.insert("liveTalks", {
        presenterId,
        institutionId: school.id,
        kind: "slides",
        mode: "rehearse",
        title: "Talk",
        slideIndex: 0,
        slideCount: 3,
        state: "ended",
        listenerId,
        lastSeenAt: Date.now(),
      });
    const mkRec = async (talkId: Awaited<ReturnType<typeof mkTalk>>, presenterId: typeof presenter, listenerId: typeof presenter) => {
      const storageId = await ctx.storage.store(new Blob(["video"], { type: "video/mp4" }));
      const id = await ctx.db.insert("talkRecordings", {
        talkId,
        presenterId,
        institutionId: school.id,
        takeId: "take-1",
        listenerId,
        status: "ready",
        startedAt: Date.now(),
        storageId,
      });
      return { id, storageId };
    };
    // Talk A: presenter presents, listener listens.
    const talkA = await mkTalk(presenter, listener);
    const recA = await mkRec(talkA, presenter, listener);
    // Talk B: listener presents, presenter listens.
    const talkB = await mkTalk(listener, presenter);
    const recB = await mkRec(talkB, listener, presenter);
    return { talkA, recA, talkB, recB };
  });
  return { t, school, presenter, listener, ...ids };
}

describe("cascades — live talks and recordings", () => {
  test("deleting a presenter removes their talks, recordings and videos; the listener's own talk survives", async () => {
    const { t, school, presenter, talkA, recA, talkB, recB } = await setup();
    expect(await t.run((ctx) => purgeUserInner(ctx, {}, presenter, school.id))).toBe(true);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(talkA)).toBeNull();
      expect(await ctx.db.get(recA.id)).toBeNull();
      expect(await ctx.db.system.get("_storage", recA.storageId)).toBeNull();
      // Talk B is the other scholar's: kept, with the deleted user cleared as listener.
      const b = await ctx.db.get(talkB);
      expect(b).not.toBeNull();
      expect(b!.listenerId).toBeUndefined();
      // The deleted user's own recording of talk B goes; the video goes with it.
      expect(await ctx.db.get(recB.id)).toBeNull();
      expect(await ctx.db.system.get("_storage", recB.storageId)).toBeNull();
    });
  });

  test("deleting a listener keeps the presenter's talk and clears the link", async () => {
    const { t, school, listener, talkA, recA } = await setup();
    expect(await t.run((ctx) => purgeUserInner(ctx, {}, listener, school.id))).toBe(true);
    await t.run(async (ctx) => {
      const a = await ctx.db.get(talkA);
      expect(a).not.toBeNull();
      expect(a!.listenerId).toBeUndefined();
      expect(await ctx.db.get(recA.id)).toBeNull();
      expect(await ctx.db.system.get("_storage", recA.storageId)).toBeNull();
    });
  });

  test("deleting an institution removes all talks, recordings and videos", async () => {
    const { t, school, talkA, recA, talkB, recB } = await setup();
    await t.run(async (ctx) => {
      while ((await deleteInstitutionScopedBatch(ctx, {}, school.id, 100)) > 0) {
        // drain
      }
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("liveTalks").collect()).toEqual([]);
      expect(await ctx.db.query("talkRecordings").collect()).toEqual([]);
      for (const id of [talkA, talkB]) expect(await ctx.db.get(id)).toBeNull();
      for (const r of [recA, recB]) expect(await ctx.db.system.get("_storage", r.storageId)).toBeNull();
    });
  });

  test("deleting a former listener removes their recording even after the talk's listener changed", async () => {
    const { t, school, presenter, listener, talkA, recA } = await setup();
    await t.run(async (ctx) => {
      // Talk A's current listener becomes someone else; the old one's recording stays.
      await ctx.db.patch(talkA, { listenerId: presenter });
    });
    expect(await t.run((ctx) => purgeUserInner(ctx, {}, listener, school.id))).toBe(true);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(talkA)).not.toBeNull();
      expect(await ctx.db.get(recA.id)).toBeNull();
      expect(await ctx.db.system.get("_storage", recA.storageId)).toBeNull();
    });
  });
});
