import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isCharmModelScript } from "../lib/charmModelCode";
import { seedTestInstitution } from "./institutionTestHelpers";

// The model writer is the only network seam; everything after it (the
// sandbox, the cache, the session copy) runs for real.
vi.mock("../lib/openaiResponses", () => ({ openaiRespond: vi.fn() }));
import { openaiRespond } from "../lib/openaiResponses";
const mockRespond = vi.mocked(openaiRespond);

// Pre-load the "use node" action so the first call doesn't pay for it.
import "../charmModelActions";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/** A contract-following model whose single part is named `tag`. */
function model(tag: string, height = 1): string {
  return `function build(THREE) {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, ${height}, 0.8), new THREE.MeshStandardMaterial({ flatShading: true }));
  m.name = ${JSON.stringify(tag)};
  m.position.y = ${height / 2};
  root.add(m);
  return root;
}`;
}

function reply(code: string) {
  return {
    text: code,
    usage: { input_tokens: 400, output_tokens: 2000 },
    model: "gpt-6-astra" as const,
  };
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  name: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name,
      username: name.toLowerCase().replace(/\s+/g, "-"),
      role: "scholar",
      ...(institutionId ? { institutionId } : {}),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Chimp lab",
      isArchived: false,
      ...(institutionId ? { institutionId } : {}),
    });
    return { userId, sessionId };
  });
}

function prepare(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
  requests: Array<{ name: string; change?: string }>,
  maxNewGenerations = 3,
) {
  return t.action(internal.charmModelActions.prepareForSession, {
    sessionId,
    requests,
    maxNewGenerations,
    role: "scholar",
    usageSource: "charm-model",
  });
}

async function sessionScripts(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
) {
  return await t.run(async (ctx) => {
    const session = await ctx.db.get(sessionId);
    return await Promise.all(
      (session?.appAssetIds ?? []).map(async (id: Id<"_storage">) => {
        const blob = await ctx.storage.get(id);
        return new TextDecoder().decode(new Uint8Array(await blob!.arrayBuffer()));
      }),
    );
  });
}

beforeEach(() => {
  mockRespond.mockReset();
});

describe("charm model cache", () => {
  test("a miss generates, caches, and gives the session its own script", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedSession(t, "Hoku Makani");
    mockRespond.mockResolvedValueOnce(reply(model("body")));

    const { outcomes, generationsUsed } = await prepare(t, sessionId, [
      { name: "Chimpanzee " },
    ]);

    expect(generationsUsed).toBe(1);
    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "ready",
        key: "chimpanzee",
        cached: false,
        parts: ["body"],
      }),
    ]);
    const rows = await t.run((ctx) => ctx.db.query("charmModels").collect());
    expect(rows).toEqual([
      expect.objectContaining({ label: "chimpanzee", status: "ready", code: model("body") }),
    ]);
    const [script] = await sessionScripts(t, sessionId);
    expect(isCharmModelScript(new TextEncoder().encode(script))).toBe(true);
    expect(script).toContain('models["chimpanzee"] = build;');
    // The session holds a copy; the shared cache never hands out its own blob.
    if (outcomes[0].status === "ready") {
      expect(outcomes[0].reference).toMatch(/^\/app-assets\//);
    }
  });

  test("a second scholar asking for the same subject is a hit with no model call", async () => {
    const t = convexTest(schema, modules);
    const first = await seedSession(t, "Hoku Makani");
    const second = await seedSession(t, "Lehua Torres");
    mockRespond.mockResolvedValueOnce(reply(model("body")));
    await prepare(t, first.sessionId, [{ name: "chimpanzee" }]);

    const { outcomes, generationsUsed } = await prepare(t, second.sessionId, [
      { name: "CHIMPANZEE" },
    ]);

    expect(mockRespond).toHaveBeenCalledTimes(1);
    expect(generationsUsed).toBe(0);
    expect(outcomes[0]).toMatchObject({ status: "ready", cached: true });
    expect(await sessionScripts(t, second.sessionId)).toHaveLength(1);
  });

  test("the cache is shared across schools: a scholar at another institution gets a hit", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedTestInstitution(t, { name: "Moli School", slug: "moli" });
    const schoolB = await seedTestInstitution(t, { name: "Kapa School", slug: "kapa" });
    const first = await seedSession(t, "Hoku Makani", schoolA);
    const second = await seedSession(t, "Lehua Torres", schoolB);
    mockRespond.mockResolvedValueOnce(reply(model("body")));
    await prepare(t, first.sessionId, [{ name: "capybara" }]);

    const { outcomes } = await prepare(t, second.sessionId, [{ name: "capybara" }]);

    expect(mockRespond).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({ status: "ready", cached: true });
    // Each school's app still holds its own copy, never the other's blob.
    const [a] = await t.run((ctx) => ctx.db.get(first.sessionId)).then((s) => s!.appAssetIds!);
    const [b] = await t.run((ctx) => ctx.db.get(second.sessionId)).then((s) => s!.appAssetIds!);
    expect(a).not.toBe(b);
  });

  test("a failed check retries once with the problem, then succeeds", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedSession(t, "Hoku Makani");
    mockRespond
      .mockResolvedValueOnce(reply(model("body", 6)))
      .mockResolvedValueOnce(reply(model("body")));

    const { outcomes } = await prepare(t, sessionId, [{ name: "crate" }]);

    expect(outcomes[0]).toMatchObject({ status: "ready" });
    expect(mockRespond).toHaveBeenCalledTimes(2);
    expect(mockRespond.mock.calls[1][1]).toMatch(/largest dimension is 6/);
  });

  test("two failed checks refuse plainly and cache nothing usable", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedSession(t, "Hoku Makani");
    mockRespond.mockResolvedValue(reply("function build(THREE) { while (true) {} }"));

    const { outcomes } = await prepare(t, sessionId, [{ name: "crate" }]);

    expect(mockRespond).toHaveBeenCalledTimes(2);
    expect(outcomes[0]).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/could not be made: building it took longer/),
    });
    const rows = await t.run((ctx) => ctx.db.query("charmModels").collect());
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(await sessionScripts(t, sessionId)).toHaveLength(0);
  });

  test("a hidden subject is refused without a model call", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedSession(t, "Hoku Makani");
    await t.run((ctx) =>
      ctx.db.insert("charmModels", {
        label: "crate",
        displayLabel: "crate",
        status: "ready",
        code: model("body"),
        hidden: true,
        createdAt: 1,
      }),
    );

    const { outcomes } = await prepare(t, sessionId, [{ name: "crate" }]);

    expect(mockRespond).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "refused" });
  });
});

describe("charm model remix", () => {
  test("a remix starts from the cached code and stays out of the shared cache", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedSession(t, "Hoku Makani");
    mockRespond
      .mockResolvedValueOnce(reply(model("body")))
      .mockResolvedValueOnce(reply(model("labCoat")));

    const { outcomes, generationsUsed } = await prepare(t, sessionId, [
      { name: "chimpanzee" },
      { name: "chimpanzee", change: "Wearing a white lab coat" },
    ]);

    // One base generation shared by both requests, plus the remix.
    expect(generationsUsed).toBe(2);
    expect(mockRespond).toHaveBeenCalledTimes(2);
    expect(mockRespond.mock.calls[1][1]).toContain(model("body"));
    expect(outcomes.map((o) => o.status === "ready" && o.key)).toEqual([
      "chimpanzee",
      "chimpanzee + wearing a white lab coat",
    ]);
    const rows = await t.run((ctx) => ctx.db.query("charmModels").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe(model("body"));
    const scripts = await sessionScripts(t, sessionId);
    expect(scripts.some((s) => s.includes('"labCoat"'))).toBe(true);
  });
});

describe("charm model generation budget", () => {
  test("new generations beyond the budget are refused; cache hits still serve", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedSession(t, "Hoku Makani");
    await t.run((ctx) =>
      ctx.db.insert("charmModels", {
        label: "crate",
        displayLabel: "crate",
        status: "ready",
        code: model("body"),
        createdAt: 1,
      }),
    );
    mockRespond.mockResolvedValue(reply(model("body")));

    const { outcomes, generationsUsed } = await prepare(
      t,
      sessionId,
      [{ name: "chimpanzee" }, { name: "lab freezer" }, { name: "crate" }],
      1,
    );

    expect(generationsUsed).toBe(1);
    expect(mockRespond).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status)).toEqual(["ready", "refused", "ready"]);
    expect(outcomes[1]).toMatchObject({
      message: expect.stringMatching(/budget for new 3D models is used up/),
    });
  });
});
