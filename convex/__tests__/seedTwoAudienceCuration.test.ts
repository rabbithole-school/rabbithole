import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
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

// An observer seed written before the two-field split has no scholar-facing
// text at all. Every read a scholar's own client can call must return none
// of the rationale for it.
const RATIONALE_ONLY = "Kai still thinks bubbles are air — the key gap.";

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

  test("with no invitation yet, the scholar sky shows no text, never the rationale", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    await observerSeed(t, scholar, {
      topic: "Sublimation",
      rationale: RATIONALE_ONLY,
    });
    const asKai = await withUser(t, scholar);
    const sky = await asKai.query(api.seeds.skyForSelf, {});
    expect(sky.seeds[0].blurb).toBe("");
    expect(sky.seeds[0].rationale).toBeNull();
    expect(JSON.stringify(sky)).not.toContain(RATIONALE_ONLY);
  });
});

describe("which seeds with no invitation show a scholar any text (seedScholarText)", () => {
  const TRAIL_LINE =
    "Inspired by the “Trail” badge Bea earned — chase the same trail and make it your own.";

  async function rationaleOnlySeed(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    fields: { topic: string; origin: "ai" | "teacher" | "badge_follow"; withUnit?: boolean },
  ) {
    return await t.run(async (ctx) => {
      const unitId = fields.withUnit
        ? await ctx.db.insert("units", { teacherId: scholarId, title: fields.topic, isActive: true })
        : undefined;
      return await ctx.db.insert("seeds", {
        scholarId,
        origin: fields.origin,
        status: "active",
        topic: fields.topic,
        suggestionType: fields.origin === "teacher" ? "teacher_suggestion" : "extension",
        rationale: `${fields.topic}: ROW_RATIONALE`,
        // plantBadgeFollowSeed records the inspirer's name here.
        ...(fields.origin === "badge_follow" ? { connectionTo: "Bea" } : {}),
        ...(unitId ? { unitId } : {}),
      });
    });
  }

  test("an older badge-follow star gets its rebuilt trail line; quest offers, hand-planted teacher seeds and observer seeds show nothing; no rationale reaches the scholar", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    await rationaleOnlySeed(t, scholar, { topic: "Trail", origin: "badge_follow" });
    await rationaleOnlySeed(t, scholar, { topic: "Offer", origin: "teacher", withUnit: true });
    await rationaleOnlySeed(t, scholar, { topic: "Note", origin: "teacher" });
    await rationaleOnlySeed(t, scholar, { topic: "Observer", origin: "ai" });

    const asKai = await withUser(t, scholar);
    const sky = await asKai.query(api.seeds.skyForSelf, {});
    const blurbOf = (topic: string) => sky.seeds.find((s) => s.topic === topic)?.blurb;
    expect(blurbOf("Trail")).toBe(TRAIL_LINE);
    expect(blurbOf("Offer")).toBe("");
    expect(blurbOf("Note")).toBe("");
    expect(blurbOf("Observer")).toBe("");

    const rows = await asKai.query(api.seeds.listByScholar, { scholarId: scholar });
    const rowText = (topic: string) => rows.find((s) => s.topic === topic)?.rationale;
    expect(rowText("Trail")).toBe(TRAIL_LINE);
    expect(rowText("Offer")).toBe("");
    expect(rowText("Note")).toBe("");
    expect(rowText("Observer")).toBe("");
    expect(JSON.stringify([sky, rows])).not.toContain("ROW_RATIONALE");
  });

  test("a badge-follow seed whose rationale a teacher edited shows the rebuilt line, never the note", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "ms-lee");
    const asKai = await withUser(t, scholar);
    const trail = await asKai.mutation(api.seeds.followBadgeSelf, {
      topic: "Trail",
      inspiredByName: "Bea",
    });
    const privateNote = "Kai copies Bea instead of thinking — private note.";
    const asTeacher = await withUser(t, teacher);
    // The teacher rewrites the rationale and clears the invitation, which
    // would re-arm a rationale fallback if the helper had one.
    await asTeacher.mutation(api.seeds.update, {
      id: trail.id,
      rationale: privateNote,
      scholarInvitation: "",
    });

    const sky = await asKai.query(api.seeds.skyForSelf, {});
    const star = sky.seeds.find((s) => s._id === trail.id);
    expect(star?.blurb).toBe(TRAIL_LINE);
    const rows = await asKai.query(api.seeds.listByScholar, { scholarId: scholar });
    const field = await asKai.query(api.concepts.skyFieldForScholar, { scholarId: scholar });
    const info = await asKai.query(api.seeds.getBakeLaunchInfo, { seedId: trail.id });
    expect(JSON.stringify([sky, rows, field, info])).not.toContain(privateNote);
  });

  test("a new badge-follow star writes its trail copy as the scholar invitation", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const asKai = await withUser(t, scholar);
    const trail = await asKai.mutation(api.seeds.followBadgeSelf, {
      topic: "Game Theory",
      inspiredByName: "Bea",
    });
    const trailRow = await t.run((ctx) => ctx.db.get(trail.id));
    expect(trailRow?.scholarInvitation).toBe(trailRow?.rationale);
  });

  test("a new quest offer shows the scholar description, or the kid-voiced default, never the teacher description", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "ms-lee");
    const teacherDescription = "Kai needs a push on persistence — teacher note.";
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.units.createAndOfferQuestForScholar, {
      scholarId: scholar,
      title: "Comics",
      description: teacherDescription,
      scholarDescription: "Make your own comic strip.",
    });
    await asTeacher.mutation(api.units.createAndOfferQuestForScholar, {
      scholarId: scholar,
      title: "Volcanoes",
      description: teacherDescription,
    });

    const asKai = await withUser(t, scholar);
    const sky = await asKai.query(api.seeds.skyForSelf, {});
    const blurbOf = (topic: string) => sky.seeds.find((s) => s.topic === topic)?.blurb;
    expect(blurbOf("Comics")).toBe("Make your own comic strip.");
    expect(blurbOf("Volcanoes")).toBe(
      "A quest your teacher set up for you to explore — fly here when you're ready.",
    );
    expect(JSON.stringify(sky)).not.toContain(teacherDescription);
  });
});

describe("an observer seed with only a rationale reaches no scholar-facing read", () => {
  test("skyFieldForScholar (the Sky map) gives the star an empty blurb", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const seedId = await observerSeed(t, scholar, {
      topic: "Sublimation",
      rationale: RATIONALE_ONLY,
    });
    const asKai = await withUser(t, scholar);
    const field = await asKai.query(api.concepts.skyFieldForScholar, {
      scholarId: scholar,
    });
    const meta = Object.values(field.seedMeta).find(
      (m) => m.seedId === String(seedId),
    );
    expect(meta?.blurb).toBe("");
    expect(JSON.stringify(field)).not.toContain(RATIONALE_ONLY);
  });

  test("listByScholar (self-view) blanks the rationale", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    await observerSeed(t, scholar, {
      topic: "Sublimation",
      rationale: RATIONALE_ONLY,
    });
    const asKai = await withUser(t, scholar);
    const rows = await asKai.query(api.seeds.listByScholar, { scholarId: scholar });
    expect(rows).toHaveLength(1);
    expect(rows[0].rationale).toBe("");
    expect(JSON.stringify(rows)).not.toContain(RATIONALE_ONLY);
  });

  test("getBakeLaunchInfo sends the invitation, or null, never the rationale", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const bare = await observerSeed(t, scholar, {
      topic: "Sublimation",
      rationale: RATIONALE_ONLY,
    });
    const withInvite = await observerSeed(t, scholar, {
      topic: "Boiling",
      rationale: RATIONALE_ONLY,
      scholarInvitation: "Why does a kettle boil sooner on a mountaintop?",
    });
    const asKai = await withUser(t, scholar);
    const bareInfo = await asKai.query(api.seeds.getBakeLaunchInfo, { seedId: bare });
    expect(bareInfo?.rationale).toBeNull();
    const inviteInfo = await asKai.query(api.seeds.getBakeLaunchInfo, {
      seedId: withInvite,
    });
    expect(inviteInfo?.rationale).toBe(
      "Why does a kettle boil sooner on a mountaintop?",
    );
    expect(JSON.stringify([bareInfo, inviteInfo])).not.toContain(RATIONALE_ONLY);
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

// TRA-665: the parent dashboard and the connector read seeds through
// readScholarSeeds, which used to hand every caller the raw rationale.
describe("parent and connector seed reads never carry the teacher rationale", () => {
  const OBSERVER_NOTE = "Kai still thinks bubbles are air — observer note.";
  const TEACHER_NOTE = "Kai rushes the hard ones — private teacher note.";
  const INVITATION = "Why does a kettle boil faster up a mountain?";

  async function seedFamily(t: ReturnType<typeof convexTest>) {
    const scholar = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "ms-lee");
    const parent = await t.run(async (ctx) => {
      const parent = await ctx.db.insert("users", {
        name: "Test parent",
        username: "kai-parent",
        role: "parent",
      });
      await ctx.db.insert("guardianships", {
        parentUserId: parent,
        scholarUserId: scholar,
        createdBy: teacher,
      });
      return parent;
    });
    await t.run(async (ctx) => {
      // A pending observer seed with an invitation, one with none, and a
      // teacher's hand-planted seed whose only text is the private note.
      await ctx.db.insert("seeds", {
        scholarId: scholar,
        origin: "ai",
        status: "pending",
        topic: "Boiling",
        suggestionType: "frontier",
        rationale: OBSERVER_NOTE,
        scholarInvitation: INVITATION,
      });
      await ctx.db.insert("seeds", {
        scholarId: scholar,
        origin: "ai",
        status: "pending",
        topic: "Sublimation",
        suggestionType: "frontier",
        rationale: OBSERVER_NOTE,
      });
      await ctx.db.insert("seeds", {
        scholarId: scholar,
        origin: "teacher",
        status: "active",
        topic: "Persistence",
        suggestionType: "teacher_suggestion",
        rationale: TEACHER_NOTE,
        teacherId: teacher,
      });
    });
    return { scholar, teacher, parent };
  }

  test("the parent dashboard gets the scholar's own seed line, or an empty string", async () => {
    const t = convexTest(schema, modules);
    const { scholar, parent } = await seedFamily(t);
    const asParent = await withUser(t, parent);
    const rows = await asParent.query(api.parents.childSeeds, { scholarId: scholar });
    const textOf = (topic: string) => rows.find((s) => s.topic === topic)?.rationale;
    // Same live set the scholar's Sky shows, pending observer seeds included.
    expect(rows).toHaveLength(3);
    expect(textOf("Boiling")).toBe(INVITATION);
    expect(textOf("Sublimation")).toBe("");
    expect(textOf("Persistence")).toBe("");
    expect(JSON.stringify(rows)).not.toContain(OBSERVER_NOTE);
    expect(JSON.stringify(rows)).not.toContain(TEACHER_NOTE);
  });

  test("a teacher's 'View as parent' preview sees what the parent sees", async () => {
    const t = convexTest(schema, modules);
    const { scholar, teacher } = await seedFamily(t);
    const asTeacher = await withUser(t, teacher);
    const rows = await asTeacher.query(api.parents.childSeeds, { scholarId: scholar });
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(OBSERVER_NOTE);
    expect(JSON.stringify(rows)).not.toContain(TEACHER_NOTE);
  });

  test("the connector gives a scholar and a parent no rationale, and a teacher the full note", async () => {
    const t = convexTest(schema, modules);
    const { scholar, teacher, parent } = await seedFamily(t);

    const asKai = await withUser(t, scholar);
    const own = await asKai.query(api.mcp.getScholarSeeds, { scholarName: "kai" });
    expect(own?.seeds).toHaveLength(3);
    expect(own?.seeds.find((s) => s.topic === "Boiling")?.rationale).toBe(INVITATION);
    expect(JSON.stringify(own)).not.toContain(OBSERVER_NOTE);
    expect(JSON.stringify(own)).not.toContain(TEACHER_NOTE);

    const asParent = await withUser(t, parent);
    const child = await asParent.query(api.mcp.getScholarSeeds, { scholarName: "kai" });
    expect(child?.seeds).toHaveLength(3);
    expect(JSON.stringify(child)).not.toContain(OBSERVER_NOTE);
    expect(JSON.stringify(child)).not.toContain(TEACHER_NOTE);

    const asTeacher = await withUser(t, teacher);
    const staff = await asTeacher.query(api.mcp.getScholarSeeds, { scholarName: "kai" });
    expect(staff?.seeds.find((s) => s.topic === "Boiling")?.rationale).toBe(OBSERVER_NOTE);
    expect(staff?.seeds.find((s) => s.topic === "Persistence")?.rationale).toBe(TEACHER_NOTE);
  });

  test("the aide's seed read is tiered by the caller's role", async () => {
    const t = convexTest(schema, modules);
    const { scholar } = await seedFamily(t);
    for (const role of ["parent", "scholar", undefined]) {
      const rows = await t.query(internal.curriculumAssistant.getScholarSeeds, {
        scholarId: scholar,
        role,
      });
      expect(JSON.stringify(rows)).not.toContain(OBSERVER_NOTE);
      expect(JSON.stringify(rows)).not.toContain(TEACHER_NOTE);
    }
    const staff = await t.query(internal.curriculumAssistant.getScholarSeeds, {
      scholarId: scholar,
      role: "teacher",
    });
    expect(JSON.stringify(staff)).toContain(OBSERVER_NOTE);
    expect(JSON.stringify(staff)).toContain(TEACHER_NOTE);
  });
});
