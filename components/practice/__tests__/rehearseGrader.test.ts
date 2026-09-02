import { describe, it, expect, vi } from "vitest";
import { createRehearseGrader } from "../rehearseGrader";
import {
  gradeSubmission,
  PRACTICE_POLICY,
  type ServableItem,
} from "@/convex/lib/practice/servable";

// Guard: the rehearse grader path calls NO mutation, and its verdict equals the
// server drill's. `createRehearseGrader` is handed a single READ capability
// (runRehearseQuery); there is no mutation in scope, so the only thing it can do
// is read the answer oracle and grade on the client with the shared grader.

const ITEM: ServableItem = {
  kind: "template",
  itemId: "skill#1",
  skillKey: "skill",
  skillLabel: "Skill",
  domain: "whole-number-arithmetic",
  prompt: { stem: "6/8 in lowest terms?", answerType: "fraction" },
  tutorContext: { type: "text", stem: "6/8 in lowest terms?" },
  ref: { skillKey: "skill", seed: 1 },
  verifier: { kind: "template", answerType: "fraction", answer: { type: "fraction", num: 3, den: 4 } },
};

describe("createRehearseGrader", () => {
  it("reads the answer oracle exactly once (a query — its only capability)", async () => {
    const runRehearseQuery = vi.fn(
      async (args: { itemId: string; domain?: string }) => {
        void args;
        return ITEM;
      },
    );

    const grade = createRehearseGrader((args) => runRehearseQuery(args));

    const verdict = await grade({
      itemId: "skill#1",
      domain: "whole-number-arithmetic",
      submission: { kind: "typed", raw: "6/8" },
    });

    // The grader's ONLY backend capability is the injected read query; it is
    // structurally incapable of a mutation. (The zero-write reachability of the
    // whole submit path is proven in rehearseZeroWrite.test.ts, with live-mode
    // positive controls so the assertions can genuinely fail.)
    expect(runRehearseQuery).toHaveBeenCalledTimes(1);
    expect(runRehearseQuery).toHaveBeenCalledWith({
      itemId: "skill#1",
      domain: "whole-number-arithmetic",
    });
    expect(verdict.correct).toBe(true);
    expect(verdict.isDontKnow).toBe(false);
  });

  it("matches the server drill verdict for the same submission", async () => {
    const grade = createRehearseGrader(async () => ITEM);
    for (const raw of ["6/8", "3/4", "2/4", "1/2"]) {
      const verdict = await grade({ itemId: "skill#1", submission: { kind: "typed", raw } });
      const server = gradeSubmission(ITEM, { kind: "typed", raw }, PRACTICE_POLICY);
      expect(verdict.correct).toBe(server.correct);
    }
  });
});
