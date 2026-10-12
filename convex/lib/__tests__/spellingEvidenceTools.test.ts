import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { ROLES } from "../roles";
import {
  SPELLING_EVIDENCE_GUIDE,
  SPELLING_EVIDENCE_TOOL_NAME,
  makeSpellingEvidenceTools,
} from "../spellingEvidenceTools";

const callerUserId = "caller" as Id<"users">;
const scholarId = "scholar_pip" as Id<"users">;

const evidence = {
  window: { days: 90, since: "2026-07-13", until: "2026-10-11" },
  counts: {
    typed: 2,
    unknownModality: 0,
    excludedSpoken: 1,
    excludedApp: 0,
    capped: false,
  },
  samples: [
    { date: "2026-09-01", sessionTitle: "Rain journal", modality: "typed", text: "she sed it was rainning" },
    { date: "2026-10-02", sessionTitle: "Rain journal", modality: "typed", text: "she said it" },
  ],
};

function stubCtx() {
  const runQuery = vi.fn(async (ref: unknown, _args: unknown) => {
    const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
    if (name.includes("listScholarsInternal")) {
      return {
        scholars: [{ id: scholarId, name: "Pip Fixture", username: "pip" }],
        extendedEducationOmitted: 0,
      };
    }
    return evidence;
  });
  return { ctx: { runQuery } as unknown as ActionCtx, runQuery };
}

describe("makeSpellingEvidenceTools", () => {
  test("exposed to scholar-admin roles only", async () => {
    for (const role of [ROLES.TEACHER, ROLES.SCHOOL_ADMIN, ROLES.PLATFORM_ADMIN]) {
      const tools = await makeSpellingEvidenceTools(stubCtx().ctx, () => {}, {
        role,
        callerUserId,
      });
      expect(tools.map((t) => t.name)).toEqual([SPELLING_EVIDENCE_TOOL_NAME]);
    }
    for (const role of [
      ROLES.PARENT,
      ROLES.SCHOLAR,
      ROLES.LIFELONG_LEARNER,
      ROLES.CURRICULUM_DESIGNER,
      ROLES.STAFF,
      null,
      undefined,
    ]) {
      expect(
        await makeSpellingEvidenceTools(stubCtx().ctx, () => {}, {
          role,
          callerUserId,
          }),
      ).toEqual([]);
    }
  });

  test("resolves the scholar, pass the caller + bounds, and return samples with the reading guide", async () => {
    const { ctx, runQuery } = stubCtx();
    const emit = vi.fn();
    const [tool] = await makeSpellingEvidenceTools(ctx, emit, {
      role: ROLES.TEACHER,
      callerUserId,
    });
    const raw = await tool.run({ scholarName: "Pip", days: 30, limit: 50 });
    if (typeof raw !== "string") throw new Error("Expected text");
    const out = JSON.parse(raw);
    expect(out.scholar).toBe("Pip Fixture");
    expect(out.howToRead).toBe(SPELLING_EVIDENCE_GUIDE);
    expect(out.samples).toHaveLength(2);
    expect(out.counts.excludedSpoken).toBe(1);
    const call = runQuery.mock.calls.find(([ref]) =>
      getFunctionName(ref as Parameters<typeof getFunctionName>[0]).includes(
        "getTypedSamplesForAide",
      ),
    );
    expect(call?.[1]).toEqual({
      callerUserId,
      scholarId,
      days: 30,
      limit: 50,
    });
    // The trace carries a count, never the child's words.
    expect(JSON.stringify(emit.mock.calls)).not.toContain("sed it");
  });

  test("an out-of-lens scholar name resolves to not-found without reading", async () => {
    const runQuery = vi.fn(async () => ({
      scholars: [{ id: scholarId, name: "Pip Fixture", username: "pip" }],
      extendedEducationOmitted: 0,
    }));
    const [tool] = await makeSpellingEvidenceTools(
      { runQuery } as unknown as ActionCtx,
      () => {},
      {
        role: ROLES.TEACHER,
        callerUserId,
        allowedScholarIds: new Set(["someone_else" as Id<"users">]),
      },
    );
    expect(await tool.run({ scholarName: "Pip" })).toMatch(/No scholar found/);
    expect(runQuery).toHaveBeenCalledTimes(1); // roster lookup only
  });
});
