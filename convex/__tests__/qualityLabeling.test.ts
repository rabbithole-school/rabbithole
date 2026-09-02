import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Standard fixtures (copied verbatim from the test-drive suites — see
//    .claude/rules/rabbithole-testing.md) ──────────────────────────────
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: {
    name?: string;
    username?: string;
    readingLevel?: string;
    image?: string;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role: role as never,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

// ── Local helpers ────────────────────────────────────────────────────
async function seedSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  overrides: { title?: string; isTestDrive?: boolean; unitId?: Id<"units"> } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: overrides.title ?? "Photosynthesis chat",
      isArchived: false,
      ...(overrides.isTestDrive ? { isTestDrive: true } : {}),
      ...(overrides.unitId ? { unitId: overrides.unitId } : {}),
    }),
  );
}

async function seedMessage(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", { sessionId, role, content, flagged: false }),
  );
}

/** A session with a few turns; returns the assistant (tutor) message ids. */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  const sessionId = await seedSession(t, scholarId);
  await seedMessage(t, sessionId, "system", "you are a tutor"); // excluded
  await seedMessage(t, sessionId, "user", "why is the sky blue?");
  const t1 = await seedMessage(t, sessionId, "assistant", "What do you already know about light?");
  await seedMessage(t, sessionId, "user", "it has colors");
  const t2 = await seedMessage(t, sessionId, "assistant", "Which color scatters most?");
  return { sessionId, tutorIds: [t1, t2] };
}

describe("gates — only teacher-equivalent roles pass", () => {
  test("scholar is rejected on every function", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const owner = await seedUser(t, "scholar", { username: "owner" });
    const { sessionId, tutorIds } = await seedConversation(t, owner);
    const asScholar = await withUser(t, scholar);

    await expect(asScholar.query(api.qualityLabeling.listQueue, {})).rejects.toThrow();
    await expect(
      asScholar.query(api.qualityLabeling.addRecentCandidates, {}),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.qualityLabeling.addToQueue, { sessionId }),
    ).rejects.toThrow();
    await expect(
      asScholar.query(api.qualityLabeling.getLabelingSession, { sessionId }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.qualityLabeling.saveTurnLabel, {
        sessionId,
        messageId: tutorIds[0],
        dims: { socratic: 4 },
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.qualityLabeling.saveTranscriptLabel, {
        sessionId,
        overall: 4,
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.query(api.qualityLabeling.agreementReport, {}),
    ).rejects.toThrow();
  });

  test("staff (operations-staff successor of the retired registrar role, not teacher-equivalent) is rejected", async () => {
    const t = convexTest(schema, modules);
    const opsStaff = await seedUser(t, "staff");
    const asOpsStaff = await withUser(t, opsStaff);
    await expect(
      asOpsStaff.query(api.qualityLabeling.listQueue, {}),
    ).rejects.toThrow();
  });

  test("teacher passes", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    await expect(asTeacher.query(api.qualityLabeling.listQueue, {})).resolves.toEqual([]);
  });

  test("platform_admin passes (admins pass the teacher gate)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    const asAdmin = await withUser(t, admin);
    await expect(asAdmin.query(api.qualityLabeling.listQueue, {})).resolves.toEqual([]);
  });
});

describe("queue", () => {
  test("addToQueue is idempotent and orders; removeFromQueue deletes", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asTeacher = await withUser(t, teacher);
    const { sessionId } = await seedConversation(t, scholar);

    const q1 = await asTeacher.mutation(api.qualityLabeling.addToQueue, { sessionId });
    const q2 = await asTeacher.mutation(api.qualityLabeling.addToQueue, { sessionId });
    expect(q1).toBe(q2); // idempotent — same row

    const rows = await t.run(async (ctx) =>
      ctx.db.query("qualityLabelQueue").collect(),
    );
    expect(rows).toHaveLength(1);

    await asTeacher.mutation(api.qualityLabeling.removeFromQueue, { queueId: q1 });
    const after = await t.run(async (ctx) =>
      ctx.db.query("qualityLabelQueue").collect(),
    );
    expect(after).toHaveLength(0);
  });

  test("listQueue reports this rater's progress", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asTeacher = await withUser(t, teacher);
    const { sessionId, tutorIds } = await seedConversation(t, scholar);
    await asTeacher.mutation(api.qualityLabeling.addToQueue, { sessionId });

    let queue = await asTeacher.query(api.qualityLabeling.listQueue, {});
    expect(queue).toHaveLength(1);
    expect(queue[0].totalTurns).toBe(2);
    expect(queue[0].labeledTurns).toBe(0);

    await asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId,
      messageId: tutorIds[0],
      dims: { socratic: 5 },
    });
    queue = await asTeacher.query(api.qualityLabeling.listQueue, {});
    expect(queue[0].labeledTurns).toBe(1);
  });

  test("addRecentCandidates excludes test-drive + thin sessions, hides names", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "sch", name: "Real Name" });
    const asTeacher = await withUser(t, teacher);

    // Real session with enough messages → candidate.
    await seedConversation(t, scholar); // 4 shown messages < 6? seedConversation has 5 rows
    // Add one more message to clear the >=6 bar.
    const { sessionId } = await seedConversation(t, scholar);
    await seedMessage(t, sessionId, "user", "extra");

    // Test-drive session → excluded even if long.
    const td = await seedSession(t, teacher, { isTestDrive: true, title: "Drive" });
    for (let i = 0; i < 8; i++) await seedMessage(t, td, "assistant", "x");

    const candidates = await asTeacher.query(api.qualityLabeling.addRecentCandidates, {});
    expect(candidates.some((c) => c.title === "Drive")).toBe(false);
    // No scholar identity leaks into the candidate shape.
    for (const c of candidates) {
      expect(Object.keys(c)).not.toContain("userId");
      expect(JSON.stringify(c)).not.toContain("Real Name");
    }
  });
});

describe("saveTurnLabel", () => {
  test("upserts on (rater, message) — one row, latest wins", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asTeacher = await withUser(t, teacher);
    const { sessionId, tutorIds } = await seedConversation(t, scholar);

    await asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId,
      messageId: tutorIds[0],
      dims: { socratic: 3 },
    });
    await asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId,
      messageId: tutorIds[0],
      dims: { socratic: 5, sycophancy: 2 },
      note: "revised",
      cantJudge: ["safetyPosture"],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("qualityGoldLabels").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dims).toEqual({ socratic: 5, sycophancy: 2 });
    expect(rows[0].note).toBe("revised");
    expect(rows[0].cantJudge).toEqual(["safetyPosture"]);
  });

  test("rejects out-of-range score, unknown dim, and non-tutor turn", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asTeacher = await withUser(t, teacher);
    const sessionId = await seedSession(t, scholar);
    const userMsg = await seedMessage(t, sessionId, "user", "hi");
    const tutorMsg = await seedMessage(t, sessionId, "assistant", "hello");

    await expect(
      asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
        sessionId,
        messageId: tutorMsg,
        dims: { socratic: 6 },
      }),
    ).rejects.toThrow();
    await expect(
      asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
        sessionId,
        messageId: tutorMsg,
        dims: { notADim: 3 },
      }),
    ).rejects.toThrow();
    await expect(
      asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
        sessionId,
        messageId: userMsg, // user turns aren't labelable
        dims: { socratic: 3 },
      }),
    ).rejects.toThrow();
  });
});

describe("saveTranscriptLabel", () => {
  test("upserts on (rater, session) and validates overall range", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asTeacher = await withUser(t, teacher);
    const { sessionId } = await seedConversation(t, scholar);

    await asTeacher.mutation(api.qualityLabeling.saveTranscriptLabel, {
      sessionId,
      overall: 3,
    });
    await asTeacher.mutation(api.qualityLabeling.saveTranscriptLabel, {
      sessionId,
      overall: 5,
      note: "good overall",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("qualityGoldTranscriptLabels").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].overall).toBe(5);

    await expect(
      asTeacher.mutation(api.qualityLabeling.saveTranscriptLabel, {
        sessionId,
        overall: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("getLabelingSession — blind + stripped", () => {
  test("never returns other raters' labels; returns only role+content", async () => {
    const t = convexTest(schema, modules);
    const raterA = await seedUser(t, "teacher", { username: "a" });
    const raterB = await seedUser(t, "teacher", { username: "b" });
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asA = await withUser(t, raterA);
    const asB = await withUser(t, raterB);
    const { sessionId, tutorIds } = await seedConversation(t, scholar);

    // Rater A scores a turn.
    await asA.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId,
      messageId: tutorIds[0],
      dims: { socratic: 2 },
    });

    // Rater B must NOT see A's label.
    const bView = await asB.query(api.qualityLabeling.getLabelingSession, { sessionId });
    expect(Object.keys(bView.myTurnLabels)).toHaveLength(0);

    // Rater A sees their own.
    const aView = await asA.query(api.qualityLabeling.getLabelingSession, { sessionId });
    expect(aView.myTurnLabels[String(tutorIds[0])].dims).toEqual({ socratic: 2 });

    // System/tool messages are excluded; entries carry only id/role/content.
    expect(aView.messages.every((m) => m.role !== "system" && m.role !== "tool")).toBe(true);
    expect(aView.tutorTurnCount).toBe(2);
    for (const m of aView.messages) {
      expect(Object.keys(m).sort()).toEqual(["content", "id", "role"]);
    }
  });
});

describe("agreementReport", () => {
  test("computes per-cell disagreement + flags spread >= 2, maps raters", async () => {
    const t = convexTest(schema, modules);
    const raterA = await seedUser(t, "teacher", { username: "alice" });
    const raterB = await seedUser(t, "teacher", { username: "bob" });
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asA = await withUser(t, raterA);
    const asB = await withUser(t, raterB);
    const { sessionId, tutorIds } = await seedConversation(t, scholar);

    // Disagree on socratic (2 vs 5 → spread 3), agree on sycophancy (4 vs 4).
    await asA.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId,
      messageId: tutorIds[0],
      dims: { socratic: 2, sycophancy: 4 },
    });
    await asB.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId,
      messageId: tutorIds[0],
      dims: { socratic: 5, sycophancy: 4 },
    });
    await asA.mutation(api.qualityLabeling.saveTranscriptLabel, { sessionId, overall: 2 });
    await asB.mutation(api.qualityLabeling.saveTranscriptLabel, { sessionId, overall: 5 });

    const report = await asA.query(api.qualityLabeling.agreementReport, { sessionId });
    expect(report.sessions).toHaveLength(1);
    const s = report.sessions[0];

    const socratic = s.matrix.cells.find((c) => c.dimKey === "socratic")!;
    expect(socratic.mean).toBe(3.5);
    expect(socratic.spread).toBe(3);
    expect(socratic.flagged).toBe(true);
    expect(socratic.turnIndex).toBe(0);

    const syco = s.matrix.cells.find((c) => c.dimKey === "sycophancy")!;
    expect(syco.flagged).toBe(false);

    expect(s.matrix.flaggedCells.map((c) => c.dimKey)).toEqual(["socratic"]);

    // Transcript overall disagreement.
    expect(s.transcript.mean).toBe(3.5);
    expect(s.transcript.spread).toBe(3);
    expect(s.transcript.flagged).toBe(true);

    // Rater id → username mapping present + used by export.
    expect(new Set(Object.values(report.raters))).toEqual(new Set(["alice", "bob"]));
    expect(report.exportJson.sessions[0].turnLabels).toHaveLength(2);
    expect(report.exportJson.raters).toEqual(report.raters);
  });

  test("aggregates across all labeled sessions when sessionId omitted", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t" });
    const scholar = await seedUser(t, "scholar", { username: "sch" });
    const asTeacher = await withUser(t, teacher);
    const c1 = await seedConversation(t, scholar);
    const c2 = await seedConversation(t, scholar);

    await asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId: c1.sessionId,
      messageId: c1.tutorIds[0],
      dims: { socratic: 4 },
    });
    await asTeacher.mutation(api.qualityLabeling.saveTurnLabel, {
      sessionId: c2.sessionId,
      messageId: c2.tutorIds[0],
      dims: { socratic: 3 },
    });

    const report = await asTeacher.query(api.qualityLabeling.agreementReport, {});
    expect(report.sessions).toHaveLength(2);
  });
});
