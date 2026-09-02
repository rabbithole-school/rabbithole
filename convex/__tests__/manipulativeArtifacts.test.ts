import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { parseStoredManipulativeArtifact } from "../../lib/manipulative/validate";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedSession(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Test Scholar",
      username: `manip-${Math.random()}`,
      role: "scholar",
    });
    return await ctx.db.insert("sessions", {
      userId,
      title: "Manipulative Session",
      isArchived: false,
    });
  });
}

async function readRow(
  t: ReturnType<typeof convexTest>,
  artifactId: Id<"artifacts">,
) {
  return await t.run(async (ctx) => ctx.db.get(artifactId));
}

async function countRows(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
) {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("artifacts").collect()).filter(
      (r) => r.sessionId === sessionId,
    );
    return rows.length;
  });
}

const rekenrekSpec = {
  kind: "rekenrek",
  concept: "Number bonds",
  prompt: "Push beads into two groups. Which pairs make 10?",
  total: 10,
};

describe("aiCreateManipulativeArtifact", () => {
  test("stores a manipulative row with the {v,spec} envelope + injected id", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    const result = await t.mutation(
      internal.artifacts.aiCreateManipulativeArtifact,
      { sessionId, specJson: JSON.stringify(rekenrekSpec) },
    );
    expect("artifactId" in result).toBe(true);
    const artifactId = (result as { artifactId: Id<"artifacts"> }).artifactId;

    const row = await readRow(t, artifactId);
    expect(row?.type).toBe("manipulative");
    expect(row?.lastEditedBy).toBe("ai");
    expect(row?.revision).toBe(0);
    // Title falls back to the spec's concept.
    expect(row?.title).toBe("Number bonds");

    const stored = parseStoredManipulativeArtifact(row!.content);
    expect(stored?.v).toBe(1);
    expect(stored?.spec.kind).toBe("rekenrek");
    // An id is injected when the model omits one.
    expect(stored?.spec.id).toMatch(/^manip-/);
  });

  test("an invalid spec returns { error } and stores nothing", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    // A groupOf target above the bead total is ungradable.
    const result = await t.mutation(
      internal.artifacts.aiCreateManipulativeArtifact,
      {
        sessionId,
        specJson: JSON.stringify({
          ...rekenrekSpec,
          total: 5,
          goal: { type: "groupOf", value: 99 },
        }),
      },
    );
    expect("error" in result).toBe(true);
    expect(await countRows(t, sessionId)).toBe(0);
  });

  test("an answer-bearing spec is refused (typed answers belong to serve_practice_problem)", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    const result = await t.mutation(
      internal.artifacts.aiCreateManipulativeArtifact,
      {
        sessionId,
        specJson: JSON.stringify({
          kind: "rekenrek",
          concept: "Number bonds",
          prompt: "How many beads make ten?",
          total: 10,
          answer: { value: 10, prompt: "How many?" },
        }),
      },
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("serve_practice_problem");
    }
    expect(await countRows(t, sessionId)).toBe(0);
  });

  test("a geoLocate spec is refused (maps belong to show_map)", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    const result = await t.mutation(
      internal.artifacts.aiCreateManipulativeArtifact,
      {
        sessionId,
        specJson: JSON.stringify({
          kind: "geoLocate",
          concept: "Geography",
          prompt: "Find Oʻahu.",
          map: {},
        }),
      },
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("show_map");
    expect(await countRows(t, sessionId)).toBe(0);
  });

  test("two creates yield two rows (no one-per-session rule)", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    await t.mutation(internal.artifacts.aiCreateManipulativeArtifact, {
      sessionId,
      specJson: JSON.stringify(rekenrekSpec),
    });
    await t.mutation(internal.artifacts.aiCreateManipulativeArtifact, {
      sessionId,
      specJson: JSON.stringify({
        kind: "array",
        concept: "Multiplication",
        prompt: "Build a 3 by 4 array.",
        rows: 3,
        cols: 4,
      }),
    });

    expect(await countRows(t, sessionId)).toBe(2);
  });
});
