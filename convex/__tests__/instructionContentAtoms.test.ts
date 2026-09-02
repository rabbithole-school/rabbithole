import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { strandInstructionKey } from "../lib/practice/instructionEntries";

// Lane 2 — the schema widen + the production pipeline. These route the two new
// interactive kinds through the REAL store path (`storeInstructionContent` →
// verify → upsert), not a raw `ctx.db.insert`, so they prove the atoms clear
// the validator (schema union), the verifier (instructionVerify), and the
// manipulative gradability/renderability gate — the same gate served items use.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const STRAND = "multiply";
const KEY = strandInstructionKey(DOMAIN, STRAND);

const PARTITION_SPEC = JSON.stringify({
  kind: "partition",
  id: "lp-partition",
  concept: "Equivalent fractions",
  prompt: "Shade one half.",
  discs: [{ parts: 4, shaded: 1 }],
  adjustable: ["parts", "shaded"],
  goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
});

async function contentByKey(t: ReturnType<typeof convexTest>, key: string) {
  return await t.run(async (ctx) => {
    const rows: Doc<"instructionContent">[] = await ctx.db
      .query("instructionContent")
      .filter((q) => q.eq(q.field("key"), key))
      .collect();
    return rows.sort((a, b) => b.version - a.version)[0] ?? null;
  });
}

describe("instructionContent pipeline — new interactive kinds pass verify→store", () => {
  test("try_it + manipulative store as PASSED and round-trip through the real path", async () => {
    const t = convexTest(schema, modules);

    const atoms = [
      { kind: "micro_explain" as const, text: "Break the number apart, multiply each part." },
      {
        kind: "worked_example" as const,
        strategyLabel: "Partial products",
        steps: ["20 x 7 = 140", "3 x 7 = 21", "140 + 21"],
        examplePrompt: "23 x 7 = ?",
        exampleAnswer: "161",
      },
      {
        kind: "try_it" as const,
        strategyLabel: "Partial products",
        steps: ["30 x 6 = 180", "4 x 6 = 24", "180 + 24"],
        examplePrompt: "34 x 6 = ?",
        exampleAnswer: "204",
        answerType: "integer" as const,
      },
      { kind: "manipulative" as const, spec: PARTITION_SPEC },
    ];

    const result = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND,
      title: "Multiplying by breaking apart",
      atoms,
      provenance: "authored",
    });
    expect(result.status).toBe("passed");

    const row = await contentByKey(t, KEY);
    expect(row).not.toBeNull();
    expect(row!.verifyStatus).toBe("passed");
    expect(row!.atoms.map((a) => a.kind)).toEqual([
      "micro_explain",
      "worked_example",
      "try_it",
      "manipulative",
    ]);
    const tryIt = row!.atoms.find((a) => a.kind === "try_it");
    expect(tryIt).toMatchObject({ exampleAnswer: "204", answerType: "integer" });
    const manip = row!.atoms.find((a) => a.kind === "manipulative");
    expect(manip && manip.kind === "manipulative" && JSON.parse(manip.spec).kind).toBe("partition");
  });

  test("a manipulative atom with an unparseable spec is stored FAILED (auditable, never served)", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND,
      title: "Broken manipulative",
      atoms: [{ kind: "manipulative", spec: "{not valid json" }],
      provenance: "generated",
    });
    expect(result.status).toBe("failed");
    const row = await contentByKey(t, KEY);
    expect(row!.verifyStatus).toBe("failed");
    expect(row!.verifyReport).toMatch(/ManipulativeSpec JSON|manipulative/i);
  });

  test("a try_it whose answer the shared grader can't parse is stored FAILED", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND,
      title: "Bad try_it answer",
      atoms: [
        {
          kind: "try_it",
          strategyLabel: "Add",
          steps: ["1 + 1 = ?"],
          examplePrompt: "1 + 1 = ?",
          exampleAnswer: "not-a-number",
          answerType: "integer",
        },
      ],
      provenance: "generated",
    });
    expect(result.status).toBe("failed");
    const row = await contentByKey(t, KEY);
    expect(row!.verifyReport).toMatch(/shared grader/i);
  });
});
