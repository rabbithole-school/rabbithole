import { describe, expect, test } from "vitest";
import { verifyInstructionContent } from "../instructionVerify";
import {
  AUTHORED_LAUNCHPADS,
  INSTRUCTION_ANCHOR_STRANDS,
} from "../../../seed/instructionSeed";
import { strandInstructionKey } from "../instructionEntries";

// Why this file: the authored seed is the content library that actually reaches
// a child's screen. Every entry must clear the same deterministic gate that
// machine-generated content does, and every DESIGNATED anchor strand must have a
// passing Launchpad — otherwise that strand silently falls back to fully-Socratic.
// This test is the coverage guarantee: it fails loudly if a new anchor is added
// without content, or if authored content drifts past a verifier limit.

describe("authored Launchpad seed — every entry passes the verifier", () => {
  for (const lp of AUTHORED_LAUNCHPADS) {
    test(`${lp.domain}:${lp.strand} passes`, () => {
      const r = verifyInstructionContent({ title: lp.title, subtitle: lp.subtitle, atoms: lp.atoms });
      // Surface the verifier's own report on failure so the fix is obvious.
      expect(r.status, r.report).toBe("passed");
    });
  }
});

describe("authored Launchpad seed — coverage + integrity", () => {
  test("every designated anchor strand has a passing Launchpad", () => {
    const passingKeys = new Set(
      AUTHORED_LAUNCHPADS.filter(
        (lp) => verifyInstructionContent({ title: lp.title, subtitle: lp.subtitle, atoms: lp.atoms }).status === "passed",
      ).map((lp) => strandInstructionKey(lp.domain, lp.strand)),
    );
    const missing = INSTRUCTION_ANCHOR_STRANDS.filter(
      (a) => !passingKeys.has(strandInstructionKey(a.domain, a.strand)),
    ).map((a) => `${a.domain}:${a.strand}`);
    expect(missing, `anchors missing passing content: ${missing.join(", ")}`).toEqual([]);
  });

  test("no duplicate strand keys in the authored set", () => {
    const keys = AUTHORED_LAUNCHPADS.map((lp) => strandInstructionKey(lp.domain, lp.strand));
    expect(keys.length).toBe(new Set(keys).size);
  });

  test("every authored entry has a worked example (Show-me is real)", () => {
    for (const lp of AUTHORED_LAUNCHPADS) {
      expect(
        lp.atoms.some((a) => a.kind === "worked_example"),
        `${lp.domain}:${lp.strand} has no worked_example`,
      ).toBe(true);
    }
  });
});
