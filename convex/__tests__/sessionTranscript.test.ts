import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { Doc, Id } from "../_generated/dataModel";
import {
  classifySessionOrigin,
  readScholarSessions,
  readSessionTranscript,
} from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the curriculum bot was mislabeling a self-started Quest as
// "an assigned project" and couldn't read the actual conversation to judge
// it. classifySessionOrigin is the assigned-vs-self-initiated source of
// truth; readSessionTranscript is the (teacher-only) transcript reader with a
// scope guard. Pin both.

type OriginInput = Pick<
  Doc<"sessions">,
  "assignmentId" | "seedId" | "activityId" | "unitId"
>;
const session = (partial: Partial<OriginInput>): OriginInput =>
  ({
    assignmentId: undefined,
    seedId: undefined,
    activityId: undefined,
    unitId: undefined,
    ...partial,
  }) as OriginInput;

describe("classifySessionOrigin", () => {
  test("a session anchored to an assignment is ASSIGNED", () => {
    const r = classifySessionOrigin(
      session({
        assignmentId: "a1" as Id<"assignments">,
        activityId: "act1" as Id<"activities">,
      }),
      null,
    );
    expect(r.origin).toBe("assigned");
    expect(r.originLabel).toMatch(/assigned/i);
  });

  test("a scholar's own Independent Study unit is SELF-INITIATED", () => {
    const r = classifySessionOrigin(
      session({ unitId: "u1" as Id<"units"> }),
      { authorScholarId: "s1" } as unknown as Doc<"units">,
    );
    expect(r.origin).toBe("selfInitiated");
    expect(r.isIndependentStudyUnit).toBe(true);
    expect(r.originLabel).toMatch(/independent study/i);
  });

  test("an anchorless seed exploration is SELF-INITIATED + fromSeed", () => {
    const r = classifySessionOrigin(session({}), null);
    expect(r.origin).toBe("selfInitiated");
    expect(r.fromSeed).toBe(true);
  });

  test("a seedId session is SELF-INITIATED even when unit-anchored", () => {
    const r = classifySessionOrigin(
      session({ seedId: "seed1" as Id<"seeds">, unitId: "u1" as Id<"units"> }),
      { authorScholarId: undefined } as unknown as Doc<"units">,
    );
    expect(r.origin).toBe("selfInitiated");
    expect(r.fromSeed).toBe(true);
  });

  test("a teacher unit opened WITHOUT an assignment is still SELF-INITIATED", () => {
    const r = classifySessionOrigin(
      session({ unitId: "u1" as Id<"units"> }),
      { authorScholarId: undefined } as unknown as Doc<"units">,
    );
    expect(r.origin).toBe("selfInitiated");
    expect(r.isIndependentStudyUnit).toBe(false);
  });
});

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: "scholar" as Doc<"users">["role"],
    }),
  );
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  fields: Partial<Doc<"sessions">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "LD50 & dose-response",
      isArchived: false,
      ...fields,
    }),
  );
}

async function addMessages(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
  turns: Array<{ role: "user" | "assistant"; content: string }>,
) {
  await t.run(async (ctx) => {
    for (const m of turns) {
      await ctx.db.insert("messages", {
        sessionId,
        role: m.role,
        content: m.content,
        flagged: false,
      });
    }
  });
}

describe("readSessionTranscript", () => {
  test("returns the real conversation + a self-initiated origin", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "oliver");
    const s = await seedSession(t, scholar); // anchorless = self-initiated
    await addMessages(t, s, [
      { role: "assistant", content: "What's an LD50?" },
      { role: "user", content: "the dose that kills half the animals" },
    ]);

    const result = await t.run((ctx) => readSessionTranscript(ctx, scholar, {}));
    expect(result).not.toBeNull();
    expect(result!.origin).toBe("selfInitiated");
    expect(result!.messageCount).toBe(2);
    expect(result!.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(result!.messages[1].content).toMatch(/kills half/);
  });

  test("SCOPE GUARD: a sessionId that isn't this scholar's reads nothing", async () => {
    const t = convexTest(schema, modules);
    const oliver = await seedScholar(t, "oliver");
    const mae = await seedScholar(t, "mae");
    const maesSession = await seedSession(t, mae);
    await addMessages(t, maesSession, [
      { role: "user", content: "secret" },
    ]);

    // Asking for Mae's session id but scoped to Oliver → null (no leak).
    const result = await t.run((ctx) =>
      readSessionTranscript(ctx, oliver, { sessionId: maesSession }),
    );
    expect(result).toBeNull();
  });

  test("default (no sessionId) skips test-drive sessions", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "oliver");
    // A newer test-drive session must NOT be the one returned.
    await seedSession(t, scholar, {
      title: "drive",
      isTestDrive: true,
      lastMessageAt: Date.now() + 1000,
    });
    const real = await seedSession(t, scholar, { title: "real work" });
    await addMessages(t, real, [{ role: "user", content: "hi" }]);

    const result = await t.run((ctx) => readSessionTranscript(ctx, scholar, {}));
    expect(result).not.toBeNull();
    expect(result!.title).toBe("real work");
  });
});

describe("readScholarSessions origin tagging", () => {
  test("tags each session assigned vs self-initiated", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "oliver");
    await seedSession(t, scholar, { title: "self quest" });
    const assignment = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: scholar, // any user id; not read by the origin tag
        title: "Toxicology",
        slug: "tox",
        isActive: true,
      });
      return ctx.db.insert("assignments", {
        teacherId: scholar,
        unitId,
        scholarIds: [scholar],
        startedAt: Date.now(),
      });
    });
    await seedSession(t, scholar, {
      title: "assigned work",
      assignmentId: assignment as Id<"assignments">,
    });

    const rows = await t.run((ctx) => readScholarSessions(ctx, scholar));
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.origin]));
    expect(byTitle["self quest"]).toBe("selfInitiated");
    expect(byTitle["assigned work"]).toBe("assigned");
  });
});
