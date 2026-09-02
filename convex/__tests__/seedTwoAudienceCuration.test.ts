import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: a seed now carries TWO audience-specific descriptions — the
// teacher diagnostic `rationale` (may name the kid / the gap) and the
// scholar-facing `scholarInvitation` (the 2nd-person hook the kid reads). The
// scholar's own sky must NOT receive the teacher rationale at the wire (the
// redaction boundary), and the teacher map must be able to promote / remove /
// edit a star. These tests pin both.

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  return role === "scholar"
    ? seedScholarInInstitution(t, { institutionId, name: `Test ${username}`, username })
    : seedStaffWithMembership(t, { institutionId, name: `Test ${username}`, username });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function observerSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  fields: { topic: string; rationale: string; scholarInvitation?: string },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "pending",
      topic: fields.topic,
      domain: "Physics",
      suggestionType: "frontier",
      rationale: fields.rationale,
      scholarInvitation: fields.scholarInvitation,
    }),
  );
}

describe("seed two-audience descriptions + redaction boundary", () => {
  test("scholar's own sky shows the invitation as blurb, never the teacher rationale", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    await observerSeed(t, scholar, {
      topic: "Why does pressure determine boiling point?",
      rationale: "Kai holds the oxygen misconception — the key conceptual gap.",
      scholarInvitation: "Why does a kettle boil faster up a mountain?",
    });

    const asKai = await withUser(t, scholar);
    const sky = await asKai.query(api.seeds.skyForSelf, {});
    expect(sky.seeds).toHaveLength(1);
    const star = sky.seeds[0];
    // The kid reads the invitation…
    expect(star.blurb).toBe("Why does a kettle boil faster up a mountain?");
    // …and the diagnostic fields never reach the scholar's payload.
    expect(star.rationale).toBeNull();
    expect(star.scholarInvitation).toBeNull();
    expect(star.origin).toBeNull();
  });

  test("teacher's view of the same sky carries the diagnostic layer", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "ms-lee");
    await observerSeed(t, scholar, {
      topic: "Why does pressure determine boiling point?",
      rationale: "Kai holds the oxygen misconception — the key conceptual gap.",
      scholarInvitation: "Why does a kettle boil faster up a mountain?",
    });

    const asTeacher = await withUser(t, teacher);
    const sky = await asTeacher.query(api.seeds.skyForScholar, {
      scholarId: scholar,
    });
    const star = sky[0];
    expect(star.blurb).toBe("Why does a kettle boil faster up a mountain?");
    expect(star.rationale).toBe(
      "Kai holds the oxygen misconception — the key conceptual gap.",
    );
    expect(star.scholarInvitation).toBe(
      "Why does a kettle boil faster up a mountain?",
    );
    expect(star.origin).toBe("ai");
  });

  test("with no invitation yet, the scholar blurb falls back to the rationale", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    await observerSeed(t, scholar, {
      topic: "Sublimation",
      rationale: "Dry ice skips the liquid phase — a vivid hook.",
    });
    const asKai = await withUser(t, scholar);
    const sky = await asKai.query(api.seeds.skyForSelf, {});
    expect(sky.seeds[0].blurb).toBe("Dry ice skips the liquid phase — a vivid hook.");
    expect(sky.seeds[0].rationale).toBeNull();
  });
});

describe("teacher curation from the map", () => {
  test("promote pins the star; remove drops it from the sky", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "ms-lee");
    const keep = await observerSeed(t, scholar, {
      topic: "Keep me",
      rationale: "why keep",
    });
    const drop = await observerSeed(t, scholar, {
      topic: "Drop me",
      rationale: "why drop",
    });

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.seeds.setStatus, { id: keep, status: "active" });
    await asTeacher.mutation(api.seeds.setStatus, {
      id: drop,
      status: "dismissed",
    });

    const asKai = await withUser(t, scholar);
    const sky = await asKai.query(api.seeds.skyForSelf, {});
    // The dismissed star is gone; the promoted one is pinned.
    expect(sky.seeds.map((s) => s.topic)).toEqual(["Keep me"]);
    expect(sky.seeds[0].pinned).toBe(true);

    // The acting teacher is stamped on both.
    const stamped = await t.run(async (ctx) => {
      const k = await ctx.db.get(keep);
      const d = await ctx.db.get(drop);
      return { keep: k?.teacherId, drop: d?.teacherId };
    });
    expect(stamped.keep).toBe(teacher);
    expect(stamped.drop).toBe(teacher);
  });

  test("update edits the scholar-facing invitation in place", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "ms-lee");
    const seed = await observerSeed(t, scholar, {
      topic: "Boiling",
      rationale: "private note",
      scholarInvitation: "old hook",
    });

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.seeds.update, {
      id: seed,
      scholarInvitation: "a much better hook",
    });

    const asKai = await withUser(t, scholar);
    const sky = await asKai.query(api.seeds.skyForSelf, {});
    expect(sky.seeds[0].blurb).toBe("a much better hook");
  });

  test("a scholar cannot curate a star (teacher gate holds)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const seed = await observerSeed(t, scholar, {
      topic: "Mine",
      rationale: "x",
    });
    const asKai = await withUser(t, scholar);
    await expect(
      asKai.mutation(api.seeds.setStatus, { id: seed, status: "dismissed" }),
    ).rejects.toThrow();
  });
});

describe("listByScholar redaction (self-view must not leak teacher fields)", () => {
  test("a scholar's own listByScholar hides rationale/approachHint/dismissedReason", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholar,
        origin: "ai",
        status: "active",
        topic: "Boiling",
        suggestionType: "frontier",
        rationale: "Kai holds the oxygen misconception — the key gap.",
        scholarInvitation: "Why does a kettle boil faster up a mountain?",
        approachHint: "Hand Kai a phase diagram and ask…",
      }),
    );
    const asKai = await withUser(t, scholar);
    const rows = await asKai.query(api.seeds.listByScholar, { scholarId: scholar });
    expect(rows).toHaveLength(1);
    // The diagnostic rationale is replaced by the scholar invitation…
    expect(rows[0].rationale).toBe("Why does a kettle boil faster up a mountain?");
    // …and the teacher-directed fields are dropped.
    expect(rows[0].approachHint).toBeUndefined();
  });

  test("a teacher's listByScholar still carries the full diagnostic", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "ms-lee");
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholar,
        origin: "ai",
        status: "active",
        topic: "Boiling",
        suggestionType: "frontier",
        rationale: "Kai holds the oxygen misconception — the key gap.",
        scholarInvitation: "Why does a kettle boil faster up a mountain?",
        approachHint: "Hand Kai a phase diagram and ask…",
      }),
    );
    const asTeacher = await withUser(t, teacher);
    const rows = await asTeacher.query(api.seeds.listByScholar, {
      scholarId: scholar,
    });
    expect(rows[0].rationale).toBe(
      "Kai holds the oxygen misconception — the key gap.",
    );
    expect(rows[0].approachHint).toBe("Hand Kai a phase diagram and ask…");
  });
});
