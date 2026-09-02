import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { classifyOEmbedResponse } from "../instructionVideoHealth";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const KEY = "strand:whole-number-arithmetic:multiply";
const DEAD_VIDEO_ID = "deadClip001";

const videoAtom = {
  kind: "video" as const,
  provider: "youtube" as const,
  videoId: DEAD_VIDEO_ID,
  startSec: 15,
  endSec: 75,
  captionText: "Watch how the partial products line up.",
  sourceLabel: "Khan Academy",
  sourceUrl: `https://www.youtube.com/watch?v=${DEAD_VIDEO_ID}`,
};
const textAtom = {
  kind: "micro_explain" as const,
  text: "Break apart one factor, then add the partial products.",
};

async function seedContent(
  t: ReturnType<typeof convexTest>,
  unavailableVideoIds?: string[],
): Promise<Id<"instructionContent">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("instructionContent", {
      key: KEY,
      domain: "whole-number-arithmetic",
      strand: "multiply",
      version: 1,
      title: "Multiply with partial products",
      atoms: [videoAtom, textAtom],
      provenance: "authored",
      verifyStatus: "passed",
      unavailableVideoIds,
      platforms: ["web", "native"],
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}

async function seedScholar(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Nova Example",
      username: "nova-video-health",
      role: "scholar",
    }),
  );
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return {
    userId,
    client: t.withIdentity({
      subject: `${userId}|${sessionId}`,
      issuer: "https://convex.dev",
    }),
  };
}

describe("classifyOEmbedResponse", () => {
  test("only a valid 200 embed is alive, explicit unavailable statuses are dead", () => {
    expect(classifyOEmbedResponse(200, { html: "<iframe></iframe>" })).toBe("alive");
    expect(classifyOEmbedResponse(404, undefined)).toBe("dead");
    expect(classifyOEmbedResponse(200, { title: "missing embed html" })).toBe("unknown");
    expect(classifyOEmbedResponse(429, undefined)).toBe("unknown");
    expect(classifyOEmbedResponse(503, undefined)).toBe("unknown");
  });

  /**
   * Probed against the live endpoint 2026-08-07: a well-formed-but-nonexistent
   * 11-char id returns **400**, not 404. Without this the whole job was inert —
   * an unresolvable clip read "unknown", nothing was ever marked, and the daily
   * run reported clean while a child saw a dead frame. Pinned so a future tidy-up
   * of the status list can't quietly restore that.
   */
  test("400 is dead — YouTube's actual answer for a nonexistent video", () => {
    expect(classifyOEmbedResponse(400, undefined)).toBe("dead");
  });
});

describe("instructional video health persistence and serving", () => {
  test("filters a dead video while preserving the entry's other atoms", async () => {
    const t = convexTest(schema, modules);
    const contentId = await seedContent(t);
    const { userId, client } = await seedScholar(t);

    await t.mutation(internal.instruction.recordVideoHealthResults, {
      contentId,
      checkedAt: 50,
      results: [{ videoId: DEAD_VIDEO_ID, status: "dead" }],
    });
    const content = await client.query(api.instruction.instructionContentForKey, {
      scholarId: userId,
      key: KEY,
      platform: "native",
    });

    expect(content?.atoms).toEqual([textAtom]);
  });

  test("UNKNOWN neither sets nor clears availability", async () => {
    const t = convexTest(schema, modules);
    const neverMarkedId = await seedContent(t);
    const previouslyDeadId = await seedContent(t, [DEAD_VIDEO_ID]);

    await t.mutation(internal.instruction.recordVideoHealthResults, {
      contentId: neverMarkedId,
      checkedAt: 100,
      results: [{ videoId: DEAD_VIDEO_ID, status: "unknown" }],
    });
    await t.mutation(internal.instruction.recordVideoHealthResults, {
      contentId: previouslyDeadId,
      checkedAt: 100,
      results: [{ videoId: DEAD_VIDEO_ID, status: "unknown" }],
    });

    const [neverMarked, previouslyDead] = await t.run(async (ctx) =>
      Promise.all([ctx.db.get(neverMarkedId), ctx.db.get(previouslyDeadId)]),
    );
    expect(neverMarked?.unavailableVideoIds).toBeUndefined();
    expect(previouslyDead?.unavailableVideoIds).toEqual([DEAD_VIDEO_ID]);
    expect(neverMarked?.videosCheckedAt).toBe(100);
    expect(previouslyDead?.videosCheckedAt).toBe(100);
  });

  test("removes a previously-dead id when the clip is alive again", async () => {
    const t = convexTest(schema, modules);
    const contentId = await seedContent(t, [DEAD_VIDEO_ID]);

    await t.mutation(internal.instruction.recordVideoHealthResults, {
      contentId,
      checkedAt: 200,
      results: [{ videoId: DEAD_VIDEO_ID, status: "alive" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(contentId));
    expect(row?.unavailableVideoIds).toEqual([]);
    expect(row?.videosCheckedAt).toBe(200);
  });
});
