import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  cleanSpottedFlairText,
  spottedFlairCorroborated,
  spottedFlairListedGoals,
} from "../lib/spottedFlair";
import { withSpottedFlair } from "../../shared/spottedFlair";
import { makeWorld } from "./factories/world";
import {
  grantInstitutionMembership,
  grantStaffCapability,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const LINE =
  "Oh, it's like a half note and two quarter notes. Same amount of beats but they look different.";

describe("spottedFlairCorroborated", () => {
  const base = { crossDomainConnections: [], observations: [] };

  test("a student-initiated connection quoting the line corroborates", () => {
    expect(
      spottedFlairCorroborated(
        {
          ...base,
          crossDomainConnections: [
            {
              domains: ["Music", "Mathematics"],
              conceptLabels: ["note values", "equivalent fractions"],
              description: "Linked note values to equivalent fractions.",
              studentInitiated: true,
              transcriptExcerpt: "a half note and two quarter notes",
            },
          ],
        },
        LINE,
      ),
    ).toBe(true);
  });

  test("a tutor-led connection, or one quoting another line, does not", () => {
    const connection = {
      domains: ["Music", "Mathematics"],
      conceptLabels: ["note values"],
      description: "Linked note values to fractions.",
      transcriptExcerpt: "a half note and two quarter notes",
    };
    expect(
      spottedFlairCorroborated(
        { ...base, crossDomainConnections: [{ ...connection, studentInitiated: false }] },
        LINE,
      ),
    ).toBe(false);
    expect(
      spottedFlairCorroborated(
        {
          ...base,
          crossDomainConnections: [
            { ...connection, studentInitiated: true, transcriptExcerpt: "I like pizza a lot" },
          ],
        },
        LINE,
      ),
    ).toBe(false);
  });

  test("an excerpt that elides the middle of the line still corroborates", () => {
    const line =
      "Make it show space as you get higher, and a big sign showing where you are and what type of craft go in this zone. Also add a menu.";
    const connection = (transcriptExcerpt: string) => ({
      domains: ["Earth science", "Game design"],
      conceptLabels: ["atmosphere layers"],
      description: "Brought atmosphere layers into the game.",
      studentInitiated: true,
      transcriptExcerpt,
    });
    expect(
      spottedFlairCorroborated(
        { ...base, crossDomainConnections: [connection("Make it show space ... what type of craft go in this zone.")] },
        line,
      ),
    ).toBe(true);
    expect(
      spottedFlairCorroborated(
        { ...base, crossDomainConnections: [connection("Make it show space ... and a leaderboard")] },
        line,
      ),
    ).toBe(false);
  });

  test("only a direct_demonstration observation corroborates", () => {
    const observation = {
      conceptLabel: "Fraction equivalence",
      domain: "Mathematics",
      masteryLevel: 4,
      confidenceScore: 0.8,
      evidenceSummary: "Unprompted analogy.",
      attemptContext: "conversation",
      studentInitiated: true,
      transcriptExcerpt: "Same amount of beats but they look different",
    };
    expect(
      spottedFlairCorroborated(
        { ...base, observations: [{ ...observation, evidenceType: "direct_demonstration" }] },
        LINE,
      ),
    ).toBe(true);
    expect(
      spottedFlairCorroborated(
        { ...base, observations: [{ ...observation, evidenceType: "indirect_inference" }] },
        LINE,
      ),
    ).toBe(false);
  });
});

describe("cleanSpottedFlairText", () => {
  test("drops trailing punctuation and rejects an over-long label", () => {
    expect(cleanSpottedFlairText({ label: "Notes are fractions!", note: "You saw it." }))
      .toEqual({ label: "Notes are fractions", note: "You saw it." });
    expect(
      cleanSpottedFlairText({ label: "x".repeat(41), note: "You saw it." }),
    ).toBeNull();
    expect(cleanSpottedFlairText({ label: "Notes", note: "  " })).toBeNull();
  });
});

describe("withSpottedFlair", () => {
  test("adds each award as flair plus a criterion carrying its label", () => {
    const merged = withSpottedFlair(
      [{ criterionId: "mission-1", earnedAt: 1 }],
      [{ id: "mission-1", label: "What decides if a launch escapes" }],
      [{ id: "spotted:m9", label: "Thin air grounds the wings", note: "You noticed…", earnedAt: 2 }],
    );
    expect(merged.flairEarned.map((flair) => flair.criterionId)).toEqual([
      "mission-1",
      "spotted:m9",
    ]);
    expect(merged.criteria.at(-1)).toEqual({
      id: "spotted:m9",
      label: "Thin air grounds the wings",
    });
  });

  test("no session awards leaves the strip's inputs as they were", () => {
    const criteria = [{ id: "a", label: "A" }];
    expect(withSpottedFlair(undefined, criteria, undefined)).toEqual({
      flairEarned: [],
      criteria,
    });
  });
});

describe("spottedFlairListedGoals", () => {
  test("an app with no generated criteria still lists its mission", () => {
    expect(
      spottedFlairListedGoals({
        rubric: "",
        buildContract: {
          gate: "Understand how money spent on earners pays itself back.",
          invariants: ["Every upgrade shows its price and its effect."],
        },
      }),
    ).toBe(
      "Mission:\n- Understand how money spent on earners pays itself back.\n- Must be true: Every upgrade shows its price and its effect.",
    );
  });

  test("a rubric alone passes through, and nothing listed is null", () => {
    expect(spottedFlairListedGoals({ rubric: "1. [a] Uses the same whole" })).toBe(
      "1. [a] Uses the same whole",
    );
    expect(spottedFlairListedGoals({ rubric: null, buildContract: null })).toBeNull();
  });
});

async function seed(t: ReturnType<typeof convexTest>, isTestDrive = false) {
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const scholar = world.schools[0].scholars[0];
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId: scholar.id,
      title: "Pizza talk",
      isArchived: false,
      lastMessageAt: Date.now(),
      ...(isTestDrive ? { isTestDrive: true } : {}),
    }),
  );
  return { world, scholar, sessionId };
}

function award(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
  sourceMessageId: string,
) {
  return t.run((ctx) =>
    ctx.runMutation(internal.spottedFlair.award, {
      sessionId,
      sourceMessageId,
      excerpt: LINE,
      label: "Notes are fractions",
      note: "You saw that a half note and two quarter notes fill the same beat.",
    }),
  );
}

describe("spottedFlair.award", () => {
  test("awards once, then the session cap holds", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seed(t);
    expect(await award(t, sessionId, "m1")).toBe("awarded");
    expect(await award(t, sessionId, "m1")).toBe(
      "skipped: already awarded for this turn",
    );
    expect(await award(t, sessionId, "m2")).toBe("skipped: session_cap");
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.spottedFlair).toHaveLength(1);
  });

  test("never awards on a rehearsal", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seed(t, true);
    expect(await award(t, sessionId, "m1")).toBe("skipped: test_drive");
  });

  test("the weekly cap spans the scholar's sessions", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId } = await seed(t);
    const more = await t.run(async (ctx) =>
      Promise.all(
        [1, 2].map(() =>
          ctx.db.insert("sessions", {
            userId: scholar.id,
            title: "Another",
            isArchived: false,
            lastMessageAt: Date.now(),
          }),
        ),
      ),
    );
    expect(await award(t, sessionId, "a")).toBe("awarded");
    expect(await award(t, more[0], "b")).toBe("awarded");
    expect(await award(t, more[1], "c")).toBe("skipped: weekly_cap");
  });

  test("the scholar sees the mark without the evidence; a teacher removes it for good", async () => {
    const t = convexTest(schema, modules);
    const { world, scholar, sessionId } = await seed(t);
    await award(t, sessionId, "m1");

    const asScholar = await world.as.scholar(scholar);
    const mine = await asScholar.query(api.spottedFlair.forSession, { sessionId });
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toHaveProperty("excerpt");

    const asTeacher = await world.as.staffOf(world.schools[0]);
    const seen = await asTeacher.query(api.spottedFlair.forSession, { sessionId });
    expect(seen[0]).toHaveProperty("excerpt", LINE);
    expect(seen[0]).toHaveProperty("canRemove", true);
    expect(mine[0]).not.toHaveProperty("canRemove");

    await asTeacher.mutation(api.spottedFlair.remove, {
      sessionId,
      flairId: "spotted:m1",
    });
    expect(
      await asScholar.query(api.spottedFlair.forSession, { sessionId }),
    ).toEqual([]);
    // The removed moment cannot come back on the observer's next read.
    expect(await award(t, sessionId, "m1")).toBe(
      "skipped: already awarded for this turn",
    );
  });
  test("operations access at another school reads nothing and removes nothing", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const scholar = world.schools[1].scholars[0];
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar.id,
        title: "Pizza talk",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );
    await award(t, sessionId, "m1");
    // A teacher at school 0 who is only operations staff at school 1.
    const teacher = world.schools[0].teacher;
    await grantInstitutionMembership(t, teacher.id, world.schools[1].id, "staff");
    await grantStaffCapability(t, teacher.id, world.schools[1].id, "school:operations");
    const asTeacher = await world.as.staffOf(world.schools[0]);

    expect(await asTeacher.query(api.spottedFlair.forSession, { sessionId })).toEqual([]);
    await expect(
      asTeacher.mutation(api.spottedFlair.remove, { sessionId, flairId: "spotted:m1" }),
    ).rejects.toThrow(/teaching access/);
  });
});

