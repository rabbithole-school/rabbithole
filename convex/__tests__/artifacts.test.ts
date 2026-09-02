import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function makeArtifact(
  t: ReturnType<typeof convexTest>,
  options: {
    content: string;
    revision?: number;
    type?: "map" | "slides";
  },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Artifact Scholar",
      username: `artifact-${Math.random()}`,
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Artifact Session",
      isArchived: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Notes",
      content: options.content,
      lastEditedBy: "scholar",
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      ...(options.type ? { type: options.type } : {}),
    });
    return { userId, sessionId, artifactId };
  });
}

describe("artifact session membership", () => {
  test("AI edit and read refuse an artifact from another session", async () => {
    const t = convexTest(schema, modules);
    const { firstSessionId, secondArtifactId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Avery Stone", username: "avery-artifact-test", role: "scholar",
      });
      const firstSessionId = await ctx.db.insert("sessions", {
        userId, title: "First Session", isArchived: false,
      });
      const secondSessionId = await ctx.db.insert("sessions", {
        userId, title: "Second Session", isArchived: false,
      });
      const secondArtifactId = await ctx.db.insert("artifacts", {
        sessionId: secondSessionId,
        title: "Second Session Notes",
        content: "original text",
        lastEditedBy: "scholar",
      });
      return { firstSessionId, secondArtifactId };
    });

    await expect(t.mutation(internal.artifacts.aiStrReplace, {
      sessionId: firstSessionId, artifactId: secondArtifactId,
      oldStr: "original", newStr: "changed",
    })).rejects.toThrow("Artifact does not belong to session");
    await expect(t.query(internal.artifacts.aiGetContent, {
      sessionId: firstSessionId, artifactId: secondArtifactId,
    })).rejects.toThrow("Artifact does not belong to session");
  });
});

describe("text artifact revisions", () => {
  test("scholarUpdate returns the public CAS contract", async () => {
    const t = convexTest(schema, modules);
    const { userId, artifactId } = await makeArtifact(t, {
      content: "first draft", revision: 0,
    });
    const asScholar = t.withIdentity({ subject: userId });

    expect(await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId, content: "final draft", baseRevision: 0,
    })).toEqual({ ok: true, revision: 1 });
    expect(await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId, content: "stale draft", baseRevision: 0,
    })).toEqual({
      ok: false,
      conflict: true,
      artifact: {
        _id: artifactId,
        title: "Notes",
        content: "final draft",
        revision: 1,
        lastEditedBy: "scholar",
      },
    });
  });

  test("CAS edits increment once and preserve stale content", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeArtifact(t, {
      content: "first draft", revision: 0,
    });
    const success = await t.mutation(internal.artifacts.aiStrReplace, {
      sessionId, artifactId, oldStr: "first", newStr: "final", baseRevision: 0,
    });
    expect(success).toMatchObject({
      kind: "success", artifact: { content: "final draft", revision: 1 },
    });
    const stale = await t.mutation(internal.artifacts.aiStrReplace, {
      sessionId, artifactId, oldStr: "final", newStr: "stale", baseRevision: 0,
    });
    expect(stale).toMatchObject({
      kind: "conflict", artifact: { content: "final draft", revision: 1 },
    });
  });

  test("an omitted revision stamps a legacy row once", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeArtifact(t, { content: "old" });
    expect(await t.mutation(internal.artifacts.aiRename, {
      sessionId, artifactId, title: "Stamped",
    })).toMatchObject({
      kind: "success", artifact: { revision: 1, title: "Stamped" },
    });
    expect(await t.mutation(internal.artifacts.aiRename, {
      sessionId, artifactId, title: "Must conflict",
    })).toMatchObject({ kind: "conflict" });
  });

  test("structured artifacts are excluded and replacement needs one match", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId, artifactId: mapId } = await makeArtifact(t, {
      content: "{}", type: "map",
    });
    const slidesId = await t.run(async (ctx) => ctx.db.insert("artifacts", {
      sessionId,
      title: "Slides",
      content: "{}",
      lastEditedBy: "ai",
      revision: 0,
      type: "slides",
    }));
    const textId = await t.run(async (ctx) => ctx.db.insert("artifacts", {
      sessionId, title: "Text", content: "same same", lastEditedBy: "ai", revision: 0,
    }));
    const listed = await t.query(internal.artifacts.aiGetContent, { sessionId });
    expect(Array.isArray(listed) && listed.map((a) => a._id)).toEqual([textId]);
    expect(await t.mutation(internal.artifacts.aiInsert, {
      sessionId, artifactId: mapId, insertLine: 0, insertText: "no", baseRevision: 0,
    })).toMatchObject({ kind: "refused" });
    expect(await t.mutation(internal.artifacts.aiInsert, {
      sessionId, artifactId: slidesId, insertLine: 0, insertText: "no", baseRevision: 0,
    })).toMatchObject({ kind: "refused" });
    expect(await t.mutation(internal.artifacts.aiStrReplace, {
      sessionId, artifactId: textId, oldStr: "same", newStr: "different", baseRevision: 0,
    })).toMatchObject({ kind: "refused" });
    await expect(
      t.withIdentity({ subject: userId }).mutation(api.artifacts.scholarUpdate, {
        artifactId: mapId, content: "not a map", baseRevision: 0,
      }),
    ).rejects.toThrow("Structured artifacts must be edited with their own tool.");
    await expect(
      t.withIdentity({ subject: userId }).mutation(api.artifacts.scholarUpdate, {
        artifactId: slidesId, content: "not slides", baseRevision: 0,
      }),
    ).rejects.toThrow("Structured artifacts must be edited with their own tool.");
    expect(await t.run(async (ctx) => ctx.db.get(textId))).toMatchObject({
      content: "same same",
    });
  });
});
