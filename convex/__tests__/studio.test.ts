import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import {
  STUDIO_FIXER_SYSTEM_PROMPT,
  buildStudioFixerUserMessage,
  sourceParses,
  verifyStudioFixOutput,
} from "../studioFixer";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// _generated/api.d.ts may be stale for this worktree (no `npx convex dev` run
// here) — `api` itself is a runtime Proxy (`anyApi`) that resolves any path
// regardless of codegen, so the cast only works around the STATIC type not
// yet knowing about `studio.ts`. Same pattern as mathPlans.test.ts.
const studio = (api as any).studio;

async function identity(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

describe("Studio persistence", () => {
  test("saveProgram upserts rather than duplicates", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const asScholar = await identity(t, scholarId);

    await asScholar.mutation(studio.saveProgram, { levelId: "rung1-hallway", source: "forward()" });
    await asScholar.mutation(studio.saveProgram, {
      levelId: "rung1-hallway",
      source: "forward()\nforward()",
    });

    const mine = await asScholar.query(studio.myPrograms, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      levelId: "rung1-hallway",
      source: "forward()\nforward()",
    });
  });

  test("a scholar cannot read another scholar's saved programs", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarAId = await seedScholarInInstitution(t, {
      institutionId,
      username: "scholar-a",
    });
    const scholarBId = await seedScholarInInstitution(t, {
      institutionId,
      username: "scholar-b",
    });
    const asScholarA = await identity(t, scholarAId);
    const asScholarB = await identity(t, scholarBId);

    await asScholarA.mutation(studio.saveProgram, { levelId: "rung1-hallway", source: "// A's work" });
    await asScholarB.mutation(studio.saveProgram, { levelId: "rung1-hallway", source: "// B's work" });

    const mineAsA = await asScholarA.query(studio.myPrograms, {});
    expect(mineAsA).toHaveLength(1);
    expect(mineAsA[0].source).toBe("// A's work");
    expect(mineAsA.some((p: { scholarId: string }) => p.scholarId === scholarBId)).toBe(false);
  });

  test("recordRun sets solved on a win and keeps the best (fewest) step count", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const asScholar = await identity(t, scholarId);

    await asScholar.mutation(studio.recordRun, {
      levelId: "rung1-hallway",
      status: "win",
      steps: 10,
      message: "You reached the pad!",
    });
    let mine = await asScholar.query(studio.myPrograms, {});
    expect(mine[0]).toMatchObject({ solved: true, bestSteps: 10 });

    // A better run lowers bestSteps.
    await asScholar.mutation(studio.recordRun, {
      levelId: "rung1-hallway",
      status: "win",
      steps: 4,
      message: "You reached the pad!",
    });
    mine = await asScholar.query(studio.myPrograms, {});
    expect(mine[0]).toMatchObject({ solved: true, bestSteps: 4 });

    // A later loss (a scholar tinkering) never un-solves the level, and never
    // overwrites the best step count with a worse run.
    await asScholar.mutation(studio.recordRun, {
      levelId: "rung1-hallway",
      status: "error",
      steps: 20,
      message: "The robot hit a wall.",
      line: 2,
    });
    mine = await asScholar.query(studio.myPrograms, {});
    expect(mine[0]).toMatchObject({ solved: true, bestSteps: 4 });
  });

  test("recordRun before any save still creates a row (empty source)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const asScholar = await identity(t, scholarId);

    await asScholar.mutation(studio.recordRun, {
      levelId: "rung1-hallway",
      status: "short",
      steps: 2,
      message: "Not quite there yet.",
    });
    const mine = await asScholar.query(studio.myPrograms, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source: "", solved: false });
    expect(mine[0].bestSteps).toBeUndefined();
  });

  test("saveProgram rejects a source over the length cap", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const asScholar = await identity(t, scholarId);

    const hugeSource = "x".repeat(20_001);
    await expect(
      asScholar.mutation(studio.saveProgram, { levelId: "rung1-hallway", source: hugeSource }),
    ).rejects.toThrow();
  });

  test("roomProgress is institution-scoped — a teacher never sees another school's scholars", async () => {
    const t = convexTest(schema, modules);
    const institutionA = await seedTestInstitution(t, { slug: "studio-fixture-school-a" });
    const institutionB = await seedTestInstitution(t, { slug: "studio-fixture-school-b" });

    const teacherAId = await seedStaffWithMembership(t, {
      institutionId: institutionA,
      username: "studio-teacher-a",
    });
    const scholarAId = await seedScholarInInstitution(t, {
      institutionId: institutionA,
      username: "studio-scholar-a",
      name: "Scholar A",
    });
    const scholarBId = await seedScholarInInstitution(t, {
      institutionId: institutionB,
      username: "studio-scholar-b",
      name: "Scholar B",
    });

    const asScholarA = await identity(t, scholarAId);
    const asScholarB = await identity(t, scholarBId);
    await asScholarA.mutation(studio.recordRun, {
      levelId: "rung1-hallway",
      status: "win",
      steps: 6,
      message: "You reached the pad!",
    });
    await asScholarB.mutation(studio.recordRun, {
      levelId: "rung1-hallway",
      status: "win",
      steps: 3,
      message: "You reached the pad!",
    });

    const asTeacherA = await identity(t, teacherAId);
    const room = await asTeacherA.query(studio.roomProgress, {});

    // The critical assertion: teacher A's room contains their own scholar and
    // does NOT contain the other institution's scholar — a cross-tenant leak
    // would show up here as scholarB appearing in teacherA's room.
    expect(room.some((r: { scholarId: string }) => r.scholarId === scholarAId)).toBe(true);
    expect(room.some((r: { scholarId: string }) => r.scholarId === scholarBId)).toBe(false);
  });

  test("roomProgress returns nothing for a teacher with no resolvable institution context", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    await seedScholarInInstitution(t, { institutionId });
    const noAccessTeacherId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "No access teacher",
        username: "studio-no-access-teacher",
        role: "teacher",
      }),
    );
    const asNoAccessTeacher = await identity(t, noAccessTeacherId);
    const room = await asNoAccessTeacher.query(studio.roomProgress, {});
    expect(room).toEqual([]);
  });
});

// ── The fixer's pure logic — no network, no Convex ctx ──────────────────────

describe("studioFixer pure logic", () => {
  test("sourceParses accepts valid JS and rejects broken JS", () => {
    expect(sourceParses("forward();\nforward();")).toBe(true);
    expect(sourceParses("forward(")).toBe(false);
    expect(sourceParses("if (true) {")).toBe(false);
  });

  test("verifyStudioFixOutput accepts a well-formed, parseable repair", () => {
    const result = verifyStudioFixOutput("Forward()", {
      source: "forward()",
      fixes: [
        { line: 1, was: "Forward()", now: "forward()", note: "JavaScript is fussy about capital letters." },
      ],
    });
    expect(result).toEqual({
      ok: true,
      source: "forward()",
      fixes: [
        { line: 1, was: "Forward()", now: "forward()", note: "JavaScript is fussy about capital letters." },
      ],
    });
  });

  test("verifyStudioFixOutput degrades to the original on a malformed shape", () => {
    const original = "Forward(";
    expect(verifyStudioFixOutput(original, null)).toEqual({ source: original, fixes: [], ok: false });
    expect(verifyStudioFixOutput(original, { source: 42, fixes: [] })).toEqual({
      source: original,
      fixes: [],
      ok: false,
    });
    expect(verifyStudioFixOutput(original, { source: "forward()" })).toEqual({
      source: original,
      fixes: [],
      ok: false,
    });
    expect(
      verifyStudioFixOutput(original, {
        source: "forward()",
        fixes: [{ line: 1, was: "Forward(", now: "forward()" /* missing note */ }],
      }),
    ).toEqual({ source: original, fixes: [], ok: false });
  });

  test("verifyStudioFixOutput degrades when the 'repaired' source still doesn't parse", () => {
    const original = "Forward(";
    const result = verifyStudioFixOutput(original, {
      source: "still broken(",
      fixes: [{ line: 1, was: "Forward(", now: "still broken(", note: "Oops." }],
    });
    expect(result).toEqual({ source: original, fixes: [], ok: false });
  });

  test("verifyStudioFixOutput rejects a silent, undisclosed rewrite", () => {
    const original = "forward()";
    // Source changed but no fixes were reported — exactly the untrustworthy
    // shape this validator exists to catch.
    const result = verifyStudioFixOutput(original, { source: "forward()\nleft()", fixes: [] });
    expect(result).toEqual({ source: original, fixes: [], ok: false });
  });

  test("verifyStudioFixOutput caps a runaway number of claimed fixes", () => {
    const original = "forward()";
    const manyFixes = Array.from({ length: 25 }, (_, i) => ({
      line: i + 1,
      was: "x",
      now: "y",
      note: "A tiny fix.",
    }));
    const result = verifyStudioFixOutput(original, { source: "forward()", fixes: manyFixes });
    expect(result).toEqual({ source: original, fixes: [], ok: false });
  });

  test("buildStudioFixerUserMessage includes the source, the error, and the line when given", () => {
    const message = buildStudioFixerUserMessage({
      source: "forward(",
      error: "Unexpected end of input",
      line: 3,
    });
    expect(message).toContain("forward(");
    expect(message).toContain("Unexpected end of input");
    expect(message).toContain("line 3");
  });

  test("the system prompt forbids algorithm changes and only allows syntax repair", () => {
    expect(STUDIO_FIXER_SYSTEM_PROMPT).toMatch(/SYNTAX ONLY/);
    expect(STUDIO_FIXER_SYSTEM_PROMPT).toMatch(/must NOT change the scholar's ALGORITHM/);
    expect(STUDIO_FIXER_SYSTEM_PROMPT).toContain("forward");
  });
});
