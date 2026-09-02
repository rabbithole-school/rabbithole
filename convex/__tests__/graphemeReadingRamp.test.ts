import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  shouldAnnotateGraphemes,
  nonGraduatedTeams,
  normalizeInventoryTeams,
  type GraphemeInventoryTeam,
} from "../lib/graphemeAnnotate";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
) {
  const name = role === "scholar" ? "Test Scholar" : `Test ${role}`;
  const username = role === "scholar" ? "testscholar" : `test${role}`;
  const institutionId = await seedTestInstitution(t);
  if (role === "teacher") {
    return seedStaffWithMembership(t, { institutionId, name, username });
  }
  if (role === "scholar") {
    return seedScholarInInstitution(t, { institutionId, name, username });
  }
  return t.run((ctx) => ctx.db.insert("users", { name, username, role }));
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

// ─── Pure: the annotation gate + inventory normalization ─────────────────────

describe("shouldAnnotateGraphemes — the pre-stream gate", () => {
  const active: GraphemeInventoryTeam[] = [{ team: "sh", stage: "training" }];

  test("pre-reader + an active (training) team → true", () => {
    expect(shouldAnnotateGraphemes("pre-reader", active)).toBe(true);
  });

  test("pre-reader + an active (fading) team → true", () => {
    expect(
      shouldAnnotateGraphemes("pre-reader", [{ team: "ea", stage: "fading" }]),
    ).toBe(true);
  });

  test("pre-reader but every team graduated → false", () => {
    expect(
      shouldAnnotateGraphemes("pre-reader", [
        { team: "sh", stage: "graduated" },
        { team: "th", stage: "graduated" },
      ]),
    ).toBe(false);
  });

  test("pre-reader + empty inventory → false", () => {
    expect(shouldAnnotateGraphemes("pre-reader", [])).toBe(false);
  });

  test("non-pre-reader (grade band) never annotates, even with active teams", () => {
    expect(shouldAnnotateGraphemes("K", active)).toBe(false);
    expect(shouldAnnotateGraphemes("3", active)).toBe(false);
    expect(shouldAnnotateGraphemes("college", active)).toBe(false);
  });

  test("null / undefined reading level → false", () => {
    expect(shouldAnnotateGraphemes(null, active)).toBe(false);
    expect(shouldAnnotateGraphemes(undefined, active)).toBe(false);
  });
});

describe("nonGraduatedTeams / normalizeInventoryTeams", () => {
  test("nonGraduatedTeams drops graduated, normalizes + dedupes the rest", () => {
    expect(
      nonGraduatedTeams([
        { team: "SH", stage: "training" },
        { team: "th", stage: "fading" },
        { team: "ea", stage: "graduated" },
        { team: "sh", stage: "training" }, // dup after lowercase
        { team: "x", stage: "training" }, // too short → dropped
      ]),
    ).toEqual(["sh", "th"]);
  });

  test("normalizeInventoryTeams lowercases, drops junk, keeps first stage", () => {
    expect(
      normalizeInventoryTeams([
        { team: " Sh ", stage: "fading" },
        { team: "sh", stage: "training" }, // dup → first (fading) wins
        { team: "1", stage: "training" }, // non-letter → dropped
        { team: "th", stage: "graduated" },
      ]),
    ).toEqual([
      { team: "sh", stage: "fading" },
      { team: "th", stage: "graduated" },
    ]);
  });
});

// ─── convexTest: inventory functions ─────────────────────────────────────────

describe("graphemeInventory — auth gate + round-trip", () => {
  test("upsert is teacher-gated: a scholar caller is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.graphemeInventory.upsert, {
        scholarId: scholar,
        teams: [{ team: "sh", stage: "training" }],
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("upsert round-trips; mine / getForScholar / internal read it back", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);
    const asScholar = await withUser(t, scholar);

    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [
        { team: "sh", stage: "training" },
        { team: "th", stage: "fading" },
      ],
    });

    // The scholar's own view (session UI reads this for stages).
    const mine = await asScholar.query(api.graphemeInventory.mine, {});
    expect(mine).toEqual([
      { team: "sh", stage: "training" },
      { team: "th", stage: "fading" },
    ]);

    // The teacher surface sees the full row.
    const forScholar = await asTeacher.query(
      api.graphemeInventory.getForScholar,
      { scholarId: scholar },
    );
    expect(forScholar?.teams).toEqual(mine);
    expect(typeof forScholar?.updatedAt).toBe("number");

    // The internal (streaming-path) read returns the team list.
    const internalTeams = await t.run(async (ctx) =>
      ctx.runQuery(internal.graphemeInventory.internalGetForScholar, {
        scholarId: scholar,
      }),
    );
    expect(internalTeams).toEqual(mine);
  });

  test("mine returns [] when the caller has no inventory", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);
    expect(await asScholar.query(api.graphemeInventory.mine, {})).toEqual([]);
  });

  test("upsert replaces the row (single row per scholar) and re-stamps updatedAt", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [{ team: "sh", stage: "training" }],
    });
    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [{ team: "ea", stage: "graduated" }],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("graphemeInventories")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].teams).toEqual([{ team: "ea", stage: "graduated" }]);
  });

  test("a bad stage string is rejected by argument validation", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.graphemeInventory.upsert, {
        scholarId: scholar,
        teams: [{ team: "sh", stage: "bogus" as any }],
      }),
    ).rejects.toThrow();
  });
});

// ─── convexTest: the message-patch internal mutation (idempotent write) ──────

describe("storeGraphemeSpans — writes spans exactly once", () => {
  async function seedMessage(t: ReturnType<typeof convexTest>) {
    const userId = await seedUser(t);
    return await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId,
        title: "T",
        isArchived: false,
      });
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "The ship is near the shore.",
        flagged: false,
      });
      return messageId;
    });
  }

  test("first write patches spans; getMessageForGraphemeAnnotation flips alreadyAnnotated", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedMessage(t);

    const before = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getMessageForGraphemeAnnotation, {
        messageId,
      }),
    );
    expect(before?.alreadyAnnotated).toBe(false);

    const spans = [{ start: 4, end: 6, team: "sh" }];
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.storeGraphemeSpans, {
        messageId,
        spans,
      }),
    );

    const msg = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(msg?.graphemeSpans).toEqual(spans);

    const after = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getMessageForGraphemeAnnotation, {
        messageId,
      }),
    );
    expect(after?.alreadyAnnotated).toBe(true);
  });

  test("second write is a no-op (idempotent) — existing spans are never clobbered", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedMessage(t);

    const original = [{ start: 4, end: 6, team: "sh" }];
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.storeGraphemeSpans, {
        messageId,
        spans: original,
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.storeGraphemeSpans, {
        messageId,
        spans: [{ start: 0, end: 3, team: "th" }],
      }),
    );

    const msg = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(msg?.graphemeSpans).toEqual(original);
  });

  test("empty spans is a valid, stored result (arms the idempotency guard)", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedMessage(t);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.storeGraphemeSpans, {
        messageId,
        spans: [],
      }),
    );

    const msg = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(msg?.graphemeSpans).toEqual([]);

    const after = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getMessageForGraphemeAnnotation, {
        messageId,
      }),
    );
    expect(after?.alreadyAnnotated).toBe(true);
  });
});

// ─── convexTest: upsert → graphemeHistory (the durable fade arc) ─────────────

// The schema-aware tester type — so helpers that `.query(...).withIndex(...)` a
// user table resolve its custom indexes (the bare `ReturnType<typeof convexTest>`
// is the schema-less default, where only system tables/indexes are known). We
// infer it from an actual `convexTest(schema, …)` call so the generic resolves.
function makeTester() {
  return convexTest(schema, modules);
}
type Tester = ReturnType<typeof makeTester>;

describe("upsert records the fade-stage arc in graphemeHistory", () => {
  async function historyFor(t: Tester, scholarId: Id<"users">) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("graphemeHistory")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .order("asc")
        .collect(),
    );
  }

  test("a new team writes one row per team; unchanged teams write nothing", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);

    // First save: two brand-new teams → two rows (the arc starts).
    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [
        { team: "sh", stage: "training" },
        { team: "th", stage: "training" },
      ],
    });
    let rows = await historyFor(t, scholar);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.stage === "training")).toBe(true);
    expect(rows.every((r) => r.changedBy === teacher)).toBe(true);

    // Second save: sh promoted (training → fading), th unchanged → exactly ONE
    // new row (the changed team only), none for the unchanged team.
    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [
        { team: "sh", stage: "fading" },
        { team: "th", stage: "training" },
      ],
    });
    rows = await historyFor(t, scholar);
    expect(rows).toHaveLength(3);
    const shRows = rows.filter((r) => r.team === "sh").map((r) => r.stage);
    const thRows = rows.filter((r) => r.team === "th").map((r) => r.stage);
    expect(shRows).toEqual(["training", "fading"]);
    expect(thRows).toEqual(["training"]); // unchanged → no second row
  });

  test("a re-save with identical stages writes no history rows", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);

    const teams = [{ team: "ea", stage: "fading" as const }];
    await asTeacher.mutation(api.graphemeInventory.upsert, { scholarId: scholar, teams });
    await asTeacher.mutation(api.graphemeInventory.upsert, { scholarId: scholar, teams });

    const rows = await historyFor(t, scholar);
    expect(rows).toHaveLength(1); // only the initial appearance
  });

  test("graduation is detected and recorded (any non-graduated → graduated)", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [{ team: "sh", stage: "fading" }],
    });
    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [{ team: "sh", stage: "graduated" }],
    });

    const rows = await historyFor(t, scholar);
    const graduated = rows.filter((r) => r.stage === "graduated");
    expect(graduated).toHaveLength(1);
    expect(graduated[0].team).toBe("sh");
  });

  test("removing a team writes no history row (the arc just stops)", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [{ team: "sh", stage: "training" }],
    });
    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [], // removed sh
    });

    const rows = await historyFor(t, scholar);
    expect(rows).toHaveLength(1); // only the appearance; removal logs nothing
  });

  test("getGraphemeHistory returns newest-first and is teacher-gated", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);
    const asScholar = await withUser(t, scholar);

    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [{ team: "sh", stage: "training" }],
    });
    await asTeacher.mutation(api.graphemeInventory.upsert, {
      scholarId: scholar,
      teams: [{ team: "sh", stage: "fading" }],
    });

    const history = await asTeacher.query(api.graphemeInventory.getGraphemeHistory, {
      scholarId: scholar,
    });
    expect(history.map((h) => h.stage)).toEqual(["fading", "training"]); // desc

    await expect(
      asScholar.query(api.graphemeInventory.getGraphemeHistory, { scholarId: scholar }),
    ).rejects.toThrow(/Forbidden/);
  });
});

// ─── convexTest: teamExposureCounts (DB-derived promotion nudge) ─────────────

describe("teamExposureCounts — bounded per-team exposure from message spans", () => {
  async function seedScholarWithMessages(t: Tester) {
    const scholarId = await seedUser(t, "scholar");
    return await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "S",
        isArchived: false,
      });
      // msg1: two "sh" spans → sh counted ONCE (message cardinality).
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "The ship is near the shore.",
        flagged: false,
        graphemeSpans: [
          { start: 4, end: 6, team: "sh" },
          { start: 22, end: 24, team: "sh" },
        ],
      });
      // msg2: one "sh" + one "th" → sh +1, th +1.
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "The shell.",
        flagged: false,
        graphemeSpans: [
          { start: 0, end: 2, team: "th" },
          { start: 4, end: 6, team: "sh" },
        ],
      });
      // msg3: empty spans (annotated, nothing to color) → not tallied.
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Hello there.",
        flagged: false,
        graphemeSpans: [],
      });
      // msg4: a scholar message with no spans → not tallied.
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "the ship",
        flagged: false,
      });
      return scholarId;
    });
  }

  test("counts messages per team (deduped within a message); skips unannotated", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const scholar = await seedScholarWithMessages(t);

    const result = await asTeacher.query(api.graphemeInventory.teamExposureCounts, {
      scholarId: scholar,
    });
    expect(result.counts).toEqual({ sh: 2, th: 1 });
    expect(result.sampled).toBe(2); // msg1 + msg2 (msg3 empty, msg4 no spans)
    expect(result.capped).toBe(false);
  });

  test("returns empty counts for a scholar with no annotated messages", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);

    const result = await asTeacher.query(api.graphemeInventory.teamExposureCounts, {
      scholarId: scholar,
    });
    expect(result.counts).toEqual({});
    expect(result.sampled).toBe(0);
    expect(result.capped).toBe(false);
  });

  test("is teacher-gated: a scholar caller is Forbidden", async () => {
    const t = makeTester();
    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.query(api.graphemeInventory.teamExposureCounts, { scholarId: scholar }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("flags capped when a single session's messages are truncated", async () => {
    const t = makeTester();
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);

    // One session with more annotated messages than the per-session take cap
    // (100). The scan truncates it, so the count must be reported approximate.
    const scholar = await seedUser(t, "scholar");
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        title: "S",
        isArchived: false,
      });
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("messages", {
          sessionId,
          role: "assistant",
          content: "The ship.",
          flagged: false,
          graphemeSpans: [{ start: 4, end: 6, team: "sh" }],
        });
      }
    });

    const result = await asTeacher.query(api.graphemeInventory.teamExposureCounts, {
      scholarId: scholar,
    });
    expect(result.capped).toBe(true);
    expect(result.sampled).toBe(100); // only the 100 most recent were scanned
    expect(result.counts.sh).toBe(100);
  });
});
