/**
 * A skill with several curated manipulatives must rotate through them across
 * sessions, not serve the same board every time. Until 2026-11 the guarantee
 * loop in `serveItems` wrote every resolved manipulative into the skill's slot
 * in turn, so the LAST one won; with recent history the unseen-first ordering
 * puts a SEEN board last, and the scholar got that board again every session.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../../lib/manipulative/practiceContract";
import { SESSION_POLICY, serveItems } from "../practice/serve";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const SKILL = "count_to_10";

function board(target: number) {
  return {
    kind: "numberline",
    id: `rotation-place-${target}`,
    concept: "Whole numbers",
    prompt: `Put the knob on ${target}.`,
    min: 0,
    max: 10,
    tickStep: 1,
    snap: 1,
    start: 0,
    goal: { type: "placeAt", value: target },
  };
}

describe("manipulative rotation across sessions", () => {
  test("a skill with 4 manipulatives shows 4 different boards before any repeats", async () => {
    const t = convexTest(schema, modules);
    const ids: Id<"practiceItems">[] = await t.run(async (ctx) =>
      Promise.all(
        [3, 5, 7, 9].map((target) =>
          ctx.db.insert("practiceItems", {
            skillKey: SKILL,
            domain: DOMAIN,
            stem: board(target).prompt,
            answerType: MANIPULATIVE_ANSWER_TYPE,
            answerCanonical: "",
            verifierKind: MANIPULATIVE_VERIFIER_KIND,
            manipulativeSpec: JSON.stringify(board(target)),
            source: "generated",
            verifiedAt: 0,
          }),
        ),
      ),
    );

    // The scholar answers each session's board; its identity (`gen#<id>`)
    // then counts as recently seen for the next session.
    const recent = new Set<string>();
    const shown: string[] = [];
    for (let session = 0; session < 4; session++) {
      const served = await t.run((ctx) =>
        serveItems(
          ctx,
          {
            entries: [{ key: SKILL, domain: DOMAIN }],
            labelByKey: new Map([[SKILL, "Count to 10"]]),
            masteryByKey: new Map(),
            laneByKey: new Map(),
            seed: 1000 + session,
            stampDomain: false,
            firstPostPlacementBlock: false,
            calibrationSkillKeys: [],
            recentIdentities: recent,
          },
          SESSION_POLICY,
        ),
      );
      const boards = served.filter((it) => it.answerType === MANIPULATIVE_ANSWER_TYPE);
      expect(boards, `session ${session}: exactly one board for the skill`).toHaveLength(1);
      shown.push(boards[0].itemId);
      recent.add(boards[0].itemId);
    }

    // With no history the first board is the first one authored.
    expect(shown[0]).toBe(`gen#${ids[0]}`);
    expect(new Set(shown).size, shown.join(" ")).toBe(4);
  });
});
