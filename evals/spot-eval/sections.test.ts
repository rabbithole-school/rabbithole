import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import * as PROMPTS from "../../convex/prompts";
import {
  armsIdentical,
  describeArm,
  extractGuidelines,
  renderAppendedSections,
  resolveArm,
  type SectionDeps,
} from "./sections";

// The deterministic half of run.ts's section overrides (TRA-498): no git, no
// model call. Proves the Guidelines block still extracts from the real
// prompts.ts and that per-arm overrides resolve the way the README says.

const PROMPTS_TS = readFileSync(
  resolve(__dirname, "../../convex/prompts.ts"),
  "utf-8",
);

const deps = (files: Record<string, string> = {}): SectionDeps => ({
  readFile: (path) => {
    if (!(path in files)) throw new Error(`no fixture file ${path}`);
    return files[path];
  },
  builders: PROMPTS as unknown as Record<string, unknown>,
});

describe("extractGuidelines", () => {
  test("finds the Guidelines block in the real convex/prompts.ts", () => {
    const g = extractGuidelines(PROMPTS_TS);
    expect(g.startsWith("Guidelines:\n")).toBe(true);
    expect(g).not.toContain("${startBullet}");
    expect(g.length).toBeGreaterThan(200);
  });

  test("throws when the block is missing", () => {
    expect(() => extractGuidelines("no block here")).toThrow(/Guidelines block/);
  });
});

describe("resolveArm", () => {
  const BASE = "Guidelines:\n- base";

  test("no overrides is the default arm: base Guidelines, nothing appended", () => {
    const arm = resolveArm(BASE, undefined, deps());
    expect(arm).toEqual({ guidelines: BASE, sections: [] });
    expect(renderAppendedSections(arm)).toBe("");
  });

  test("a builder section calls the live exported prompt function", () => {
    const arm = resolveArm(
      BASE,
      { sections: [{ name: "preReader", builder: "buildPreReaderSection" }] },
      deps(),
    );
    expect(arm.sections[0].text).toBe(PROMPTS.buildPreReaderSection());
    expect(renderAppendedSections(arm)).toMatch(/^\n\nPRE-READER MODE/);
  });

  test("builder args are passed through", () => {
    const arm = resolveArm(
      BASE,
      {
        sections: [
          { name: "earlyReader", builder: "buildEarlyReaderSection", args: ["1"] },
        ],
      },
      deps(),
    );
    expect(arm.sections[0].text).toBe(PROMPTS.buildEarlyReaderSection("1"));
  });

  test("file and text sections append in order, one blank line apart", () => {
    const arm = resolveArm(
      BASE,
      {
        sections: [
          { name: "a", file: "old.txt" },
          { name: "b", text: "\n\n\nSECOND" },
        ],
      },
      deps({ "old.txt": "FIRST" }),
    );
    expect(renderAppendedSections(arm)).toBe("\n\nFIRST\n\nSECOND");
  });

  test("a section named guidelines replaces the git-derived block", () => {
    const arm = resolveArm(
      BASE,
      { sections: [{ name: "guidelines", text: "Guidelines:\n- swapped" }] },
      deps(),
    );
    expect(arm.guidelines).toBe("Guidelines:\n- swapped");
    expect(arm.sections).toEqual([]);
    expect(describeArm(arm, { sections: [{ name: "guidelines", text: "" }] }, "HEAD"))
      .toBe("guidelines (override)");
  });

  test("rejects ambiguous or broken overrides", () => {
    const run = (sections: Parameters<typeof resolveArm>[1]) => () =>
      resolveArm(BASE, sections, deps());
    expect(run({ sections: [{ name: "x" }] })).toThrow(/exactly one/);
    expect(run({ sections: [{ name: "x", text: "a", builder: "b" }] })).toThrow(
      /exactly one/,
    );
    expect(run({ sections: [{ name: "x", text: "a", args: [1] }] })).toThrow(
      /args only apply/,
    );
    expect(run({ sections: [{ name: "x", builder: "notAThing" }] })).toThrow(
      /no exported function/,
    );
    expect(
      run({ sections: [{ name: "x", text: "a" }, { name: "x", text: "b" }] }),
    ).toThrow(/listed twice/);
  });
});

describe("armsIdentical", () => {
  test("a section-only change counts as a difference even with equal Guidelines", () => {
    const old = resolveArm("G", { sections: [{ name: "p", text: "old" }] }, deps());
    const neu = resolveArm(
      "G",
      { sections: [{ name: "p", builder: "buildPreReaderSection" }] },
      deps(),
    );
    expect(armsIdentical(old, neu)).toBe(false);
    expect(armsIdentical(old, resolveArm("G", { sections: [{ name: "p", text: "old" }] }, deps()))).toBe(true);
    expect(describeArm(neu, undefined, "HEAD")).toBe("guidelines (HEAD) + p");
  });
});
