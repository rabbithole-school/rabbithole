import { convexTest } from "convex-test";
import type { ActivityKind } from "../../lib/activityKinds";
import { describe, expect, test } from "vitest";
import {
  buildClassDigestSystemPrompt,
  normalizeClassDigestToolInput,
} from "../classDigestActions";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { SCHOLAR_PRONOUN_GUIDANCE } from "../lib/scholarPronouns";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

test("class digest prompt uses the shared scholar-pronoun fallback", () => {
  expect(buildClassDigestSystemPrompt("cohort")).toContain(
    SCHOLAR_PRONOUN_GUIDANCE,
  );
});

// ── fixtures (copied verbatim from the other test files) ──
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test-${role}-${Math.random()}`,
      role,
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

async function seedAssignmentWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  scholarIds: Id<"users">[],
  kind: ActivityKind = "online",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "L",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "A",
      kind,
      order: 0,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      startedAt: Date.now(),
    });
    return { unitId, lessonId, activityId, assignmentId };
  });
}

const auto = (
  t: ReturnType<typeof convexTest>,
  args: {
    scope: "activity" | "cohort";
    assignmentId: Id<"assignments">;
    activityId?: Id<"activities">;
  },
) => t.run((ctx) => ctx.runMutation(internal.classDigests.maybeAutoGenerate, args));

describe("normalizeClassDigestToolInput", () => {
  test("coerces malformed LLM array fields to empty arrays", () => {
    const scholarId = "scholar" as Id<"users">;
    const sessionId = "session" as Id<"sessions">;
    const roster = new Map([
      [String(scholarId), { scholarId, name: "Test Scholar", sessionId }],
    ]);

    const digest = normalizeClassDigestToolInput(
      {
        headline: "Class landed on a shared insight",
        summary: "The cohort clustered around one idea.",
        themes: { title: "Not an array" },
        moments: { scholarId, kind: "insight", headline: "Not an array" },
        discussionPrompts: "What should we discuss?",
      },
      roster,
    );

    expect(digest).toEqual({
      headline: "Class landed on a shared insight",
      summary: "The cohort clustered around one idea.",
      themes: [],
      moments: [],
      discussionPrompts: [],
    });
  });

  test("drops malformed moment entries and coerces invalid kinds", () => {
    const scholarId = "scholar" as Id<"users">;
    const sessionId = "session" as Id<"sessions">;
    const roster = new Map([
      [String(scholarId), { scholarId, name: "Test Scholar", sessionId }],
    ]);

    const digest = normalizeClassDigestToolInput(
      {
        headline: "A".repeat(250),
        summary: "Useful summary",
        themes: [{ title: "Shared move", body: "Everyone tried it." }, null],
        moments: [
          null,
          { scholarId: "missing", kind: "breakthrough", headline: "No roster" },
          {
            scholarId,
            kind: "surprise",
            headline: "A".repeat(200),
            detail: "B".repeat(300),
          },
        ],
        discussionPrompts: ["How did this move work?", 42, null],
      },
      roster,
    );

    expect(digest.headline).toHaveLength(200);
    expect(digest.themes).toEqual([
      { title: "Shared move", body: "Everyone tried it." },
    ]);
    expect(digest.moments).toEqual([
      {
        kind: "insight",
        scholarId,
        scholarName: "Test Scholar",
        sessionId,
        headline: "A".repeat(160),
        detail: "B".repeat(280),
      },
    ]);
    expect(digest.discussionPrompts).toEqual(["How did this move work?"]);
  });
});

describe("classDigests.maybeAutoGenerate", () => {
  test("does not schedule when there is no cohort material", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      teacher,
      [scholar],
    );
    const res = await auto(t, { scope: "activity", assignmentId, activityId });
    expect(res.scheduled).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("classDigests").collect());
    expect(rows).toHaveLength(0);
  });

  test("schedules + writes a pending row once there is a completion", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId, lessonId, unitId } =
      await seedAssignmentWithActivity(t, teacher, [scholar]);
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId,
        lessonId,
        unitId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );
    const res = await auto(t, { scope: "activity", assignmentId, activityId });
    expect(res.scheduled).toBe(true);
    const rows = await t.run((ctx) => ctx.db.query("classDigests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].sourceSnapshot?.completedCount).toBe(1);
  });

  test("skips Share Back and web activities", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    for (const kind of ["shareBack", "web"] as const) {
      const { assignmentId, activityId, lessonId, unitId } =
        await seedAssignmentWithActivity(t, teacher, [scholar], kind);
      await t.run((ctx) =>
        ctx.db.insert("activityCompletions", {
          scholarId: scholar,
          activityId,
          lessonId,
          unitId,
          assignmentId,
          completedAt: Date.now(),
        }),
      );
      const res = await auto(t, { scope: "activity", assignmentId, activityId });
      expect(res.scheduled).toBe(false);
    }
  });

  test("debounces: a fresh ready digest is not regenerated", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId, lessonId, unitId } =
      await seedAssignmentWithActivity(t, teacher, [scholar]);
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId,
        lessonId,
        unitId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );
    // A ready digest generated just now, snapshot matches current counts.
    await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "activity",
        assignmentId,
        activityId,
        status: "ready",
        generatedAt: Date.now(),
        sourceSnapshot: {
          completedCount: 1,
          startedCount: 1,
          deliverableCount: 0,
        },
      }),
    );
    const res = await auto(t, { scope: "activity", assignmentId, activityId });
    expect(res.scheduled).toBe(false);
  });

  test("regenerates a stale digest once past the debounce window", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const a = await seedUser(t, "scholar");
    const b = await seedUser(t, "scholar");
    const { assignmentId, activityId, lessonId, unitId } =
      await seedAssignmentWithActivity(t, teacher, [a, b]);
    for (const s of [a, b]) {
      await t.run((ctx) =>
        ctx.db.insert("activityCompletions", {
          scholarId: s,
          activityId,
          lessonId,
          unitId,
          assignmentId,
          completedAt: Date.now(),
        }),
      );
    }
    // Old ready digest whose snapshot saw only 1 completion (now there are 2).
    await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "activity",
        assignmentId,
        activityId,
        status: "ready",
        generatedAt: Date.now() - 6 * 60_000,
        sourceSnapshot: {
          completedCount: 1,
          startedCount: 1,
          deliverableCount: 0,
        },
      }),
    );
    const res = await auto(t, { scope: "activity", assignmentId, activityId });
    expect(res.scheduled).toBe(true);
    const row = await t.run((ctx) =>
      ctx.db.query("classDigests").first(),
    );
    expect(row?.status).toBe("pending");
  });
});

describe("classDigests read gates", () => {
  test("getActivityDigest returns null for a non-owner teacher", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      owner,
      [scholar],
    );
    const asOther = await withUser(t, other);
    const res = await asOther.query(api.classDigests.getActivityDigest, {
      assignmentId,
      activityId,
    });
    expect(res).toBeNull();
  });
});

describe("classDigests.createDebriefFromDigest", () => {
  async function readyDigest(
    t: ReturnType<typeof convexTest>,
    assignmentId: Id<"assignments">,
    activityId: Id<"activities">,
  ) {
    await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "activity",
        assignmentId,
        activityId,
        status: "ready",
        generatedAt: Date.now(),
        summary: "A clear split in craft.",
        themes: [{ title: "Sensory detail", body: "..." }],
      }),
    );
  }

  test("creates a Share Back debrief from a ready digest, idempotently", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      teacher,
      [scholar],
    );
    await readyDigest(t, assignmentId, activityId);
    const asTeacher = await withUser(t, teacher);

    const first = await asTeacher.mutation(
      api.classDigests.createDebriefFromDigest,
      { assignmentId, activityId },
    );
    expect(first.reused).toBe(false);

    const sb = await t.run((ctx) => ctx.db.get(first.shareBackActivityId));
    expect(sb?.kind).toBe("shareBack");
    expect(sb?.shareBackRecipe).toBe("custom");
    expect(sb?.sourceActivityIds).toContain(activityId);
    // facilitation focus carries the digest's summary + theme titles
    expect(sb?.facilitationFocus).toContain("clear split in craft");

    // A pending Share Back digest was queued for the new debrief.
    const sbDigest = await t.run((ctx) =>
      ctx.db
        .query("shareBackDigests")
        .withIndex("by_activity", (q) =>
          q.eq("activityId", first.shareBackActivityId),
        )
        .first(),
    );
    expect(sbDigest?.status).toBe("pending");

    // Second call reuses the same debrief — no duplicate.
    const second = await asTeacher.mutation(
      api.classDigests.createDebriefFromDigest,
      { assignmentId, activityId },
    );
    expect(second.reused).toBe(true);
    expect(second.shareBackActivityId).toBe(first.shareBackActivityId);
  });

  test("throws when no ready digest exists yet", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      teacher,
      [scholar],
    );
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.classDigests.createDebriefFromDigest, {
        assignmentId,
        activityId,
      }),
    ).rejects.toThrow();
  });

  test("forbids a non-owner teacher", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      owner,
      [scholar],
    );
    await readyDigest(t, assignmentId, activityId);
    const asOther = await withUser(t, other);
    await expect(
      asOther.mutation(api.classDigests.createDebriefFromDigest, {
        assignmentId,
        activityId,
      }),
    ).rejects.toThrow();
  });
});

// ── institution-lens scoping (design 2: scope roster rows, keep staleness
//    full-cohort) ────────────────────────────────────────────────────────
describe("classDigests reads honor the institution lens", () => {
  async function seedInstitution(
    t: ReturnType<typeof convexTest>,
    slug: string,
    opts: { isPrimary?: boolean; kind?: "school" | "guest" } = {},
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: slug,
        slug,
        kind: opts.kind ?? "school",
        isPrimary: opts.isPrimary,
      }),
    );
  }

  async function addMembership(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    role: string,
    institutionId?: Id<"institutions">,
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("memberships", { userId, role, institutionId }),
    );
  }

  async function setInstitution(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    institutionId: Id<"institutions">,
  ) {
    await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  }

  async function completeActivity(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    activityId: Id<"activities">,
    lessonId: Id<"lessons">,
    unitId: Id<"units">,
    assignmentId: Id<"assignments">,
  ) {
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );
  }

  function moment(scholarId: Id<"users">, name: string) {
    return {
      kind: "insight" as const,
      scholarId,
      scholarName: name,
      headline: `${name} had an insight`,
      detail: "…",
    };
  }

  async function insertReadyActivityDigest(
    t: ReturnType<typeof convexTest>,
    args: {
      assignmentId: Id<"assignments">;
      activityId: Id<"activities">;
      snapshotCompleted: number;
      moments: ReturnType<typeof moment>[];
    },
  ) {
    await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "activity",
        assignmentId: args.assignmentId,
        activityId: args.activityId,
        status: "ready",
        generatedAt: Date.now(),
        headline: "How it landed",
        summary: "Full-cohort synthesis.",
        sourceSnapshot: {
          completedCount: args.snapshotCompleted,
          startedCount: args.snapshotCompleted,
          deliverableCount: 0,
        },
        moments: args.moments,
      }),
    );
  }

  // A teacher @ Moli, a Moli scholar, and a Guests scholar in ONE cohort — so
  // the Moli lens narrows the cohort.
  async function mixedWorld(t: ReturnType<typeof convexTest>) {
    const moli = await seedInstitution(t, "moli", { isPrimary: true });
    const guests = await seedInstitution(t, "guests", { kind: "guest" });
    const teacher = await seedUser(t, "teacher", { name: "Teach" });
    await addMembership(t, teacher, "teacher", moli);
    const inLens = await seedUser(t, "scholar", { name: "Ada" });
    const outLens = await seedUser(t, "scholar", { name: "Cyrus" });
    await setInstitution(t, inLens, moli);
    await setInstitution(t, outLens, guests);
    const seeded = await seedAssignmentWithActivity(t, teacher, [
      inLens,
      outLens,
    ]);
    return { teacher, inLens, outLens, ...seeded };
  }

  test("narrowing lens hides out-of-lens rows; staleness stays full-cohort (never false/negative)", async () => {
    const t = convexTest(schema, modules);
    const { teacher, inLens, outLens, assignmentId, activityId, lessonId, unitId } =
      await mixedWorld(t);
    // Full-cohort: BOTH scholars completed → completedCount = 2, matching the
    // digest snapshot, so there is genuinely nothing new.
    await completeActivity(t, inLens, activityId, lessonId, unitId, assignmentId);
    await completeActivity(t, outLens, activityId, lessonId, unitId, assignmentId);
    await insertReadyActivityDigest(t, {
      assignmentId,
      activityId,
      snapshotCompleted: 2,
      moments: [moment(inLens, "Ada"), moment(outLens, "Cyrus")],
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.classDigests.getActivityDigest, {
      assignmentId,
      activityId,
      scope: "", // home lens → Moli
    });

    expect(res).not.toBeNull();
    expect(res!.lensNarrowed).toBe(true);
    // Roster rows scoped to the lens — Cyrus (Guests) is hidden.
    expect(res!.digest!.moments).toHaveLength(1);
    expect(res!.digest!.moments![0].scholarId).toBe(inLens);
    // Counts stay full-cohort (2 done, not the lens-scoped 1).
    expect(res!.current.completedCount).toBe(2);
    // Staleness computed full-cohort vs the full-cohort snapshot: NOT stale,
    // and NOT a false/negative "N new since" (a lens-scoped count of 1 minus
    // the snapshot of 2 would have gone negative).
    expect(res!.digest!.stale).toBe(false);
    expect(res!.digest!.newSince).toBe(0);
  });

  test("narrowing lens still reports honest full-cohort staleness when work truly grew", async () => {
    const t = convexTest(schema, modules);
    const { teacher, inLens, outLens, assignmentId, activityId, lessonId, unitId } =
      await mixedWorld(t);
    await completeActivity(t, inLens, activityId, lessonId, unitId, assignmentId);
    await completeActivity(t, outLens, activityId, lessonId, unitId, assignmentId);
    // Snapshot saw only 1 completion; full cohort now has 2 → genuinely stale.
    await insertReadyActivityDigest(t, {
      assignmentId,
      activityId,
      snapshotCompleted: 1,
      moments: [moment(inLens, "Ada"), moment(outLens, "Cyrus")],
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.classDigests.getActivityDigest, {
      assignmentId,
      activityId,
      scope: "",
    });

    expect(res!.lensNarrowed).toBe(true);
    expect(res!.digest!.moments).toHaveLength(1);
    expect(res!.digest!.stale).toBe(true);
    expect(res!.digest!.newSince).toBe(1); // full-cohort delta, honest
  });

  test("no scope arg → identical to today (roster rows untouched)", async () => {
    const t = convexTest(schema, modules);
    const { teacher, inLens, outLens, assignmentId, activityId } =
      await mixedWorld(t);
    await insertReadyActivityDigest(t, {
      assignmentId,
      activityId,
      snapshotCompleted: 0,
      moments: [moment(inLens, "Ada"), moment(outLens, "Cyrus")],
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.classDigests.getActivityDigest, {
      assignmentId,
      activityId,
      // no scope → no lens resolution at all
    });

    expect(res!.lensNarrowed).toBe(false);
    expect(res!.digest!.moments).toHaveLength(2);
  });

  test("scope present but lens does NOT narrow → no-op (all rows shown)", async () => {
    const t = convexTest(schema, modules);
    const moli = await seedInstitution(t, "moli", { isPrimary: true });
    const teacher = await seedUser(t, "teacher", { name: "Teach" });
    await addMembership(t, teacher, "teacher", moli);
    const a = await seedUser(t, "scholar", { name: "Ada" });
    const b = await seedUser(t, "scholar", { name: "Bo" });
    await setInstitution(t, a, moli);
    await setInstitution(t, b, moli);
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      teacher,
      [a, b],
    );
    await insertReadyActivityDigest(t, {
      assignmentId,
      activityId,
      snapshotCompleted: 0,
      moments: [moment(a, "Ada"), moment(b, "Bo")],
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.classDigests.getActivityDigest, {
      assignmentId,
      activityId,
      scope: "",
    });

    expect(res!.lensNarrowed).toBe(false);
    expect(res!.digest!.moments).toHaveLength(2);
  });

  test("cohort digest: narrowing lens hides out-of-lens rows, staleness stays honest", async () => {
    const t = convexTest(schema, modules);
    const { teacher, inLens, outLens, assignmentId, activityId, lessonId, unitId } =
      await mixedWorld(t);
    // cohortCounts.completedCount = total completions across the cohort.
    await completeActivity(t, inLens, activityId, lessonId, unitId, assignmentId);
    await completeActivity(t, outLens, activityId, lessonId, unitId, assignmentId);
    await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "cohort",
        assignmentId,
        status: "ready",
        generatedAt: Date.now(),
        headline: "Today's read",
        summary: "Full-cohort synthesis.",
        sourceSnapshot: { completedCount: 2, startedCount: 2, deliverableCount: 0 },
        moments: [moment(inLens, "Ada"), moment(outLens, "Cyrus")],
      }),
    );

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.classDigests.getCohortDigest, {
      assignmentId,
      scope: "",
    });

    expect(res!.lensNarrowed).toBe(true);
    expect(res!.digest!.moments).toHaveLength(1);
    expect(res!.digest!.moments![0].scholarId).toBe(inLens);
    expect(res!.current.completedCount).toBe(2); // full-cohort
    expect(res!.digest!.stale).toBe(false);
    expect(res!.digest!.newSince).toBe(0);
  });
});

// ── source watermark staleness (analyses / messages, not just counts) ────
//   A digest generated mid-session must go stale + regenerate once a later
//   observer analysis lands, even when completion/deliverable counts never
//   move (the Leilani "cut off" vs. "resolved" case — see
//   review/pilotT1/invest/dayend-coherence.md §B).
describe("classDigests source-watermark staleness", () => {
  async function seedCohortSession(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    activityId: Id<"activities">,
    assignmentId: Id<"assignments">,
    lastMessageAt: number,
  ) {
    return t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId,
        activityId,
        assignmentId,
        title: "Session",
        isArchived: false,
        lastMessageAt,
      }),
    );
  }

  test("getCohortDigest reads stale when a newer analysis lands with unchanged counts", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      teacher,
      [scholar],
    );
    const msgAt = Date.now() - 60 * 60 * 1000;
    const sessionId = await seedCohortSession(
      t,
      scholar,
      activityId,
      assignmentId,
      msgAt,
    );
    // The analysis the digest was generated from ("cut off").
    const firstAnalysisAt = await t.run(async (ctx) => {
      const id = await ctx.db.insert("analyses", {
        sessionId,
        summary: "session cut off before resolution",
      });
      return (await ctx.db.get(id))!._creationTime;
    });
    await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "cohort",
        assignmentId,
        status: "ready",
        generatedAt: Date.now() - 6 * 60_000,
        headline: "session cut off before resolution",
        sourceSnapshot: {
          completedCount: 0,
          startedCount: 1,
          deliverableCount: 0,
          latestAnalysisAt: firstAnalysisAt,
          latestMessageAt: msgAt,
        },
      }),
    );
    // A later observer analysis resolves it — counts unchanged.
    await t.run((ctx) =>
      ctx.db.insert("analyses", {
        sessionId,
        summary: "resolved with a drawing",
      }),
    );

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.classDigests.getCohortDigest, {
      assignmentId,
    });
    expect(res!.digest!.stale).toBe(true);
    expect(res!.digest!.newSince).toBe(0); // watermark advance has no cardinality
    expect(res!.current.completedCount).toBe(0); // counts never moved

    // …and it becomes eligible for auto-regeneration (past the debounce window).
    const scheduled = await auto(t, { scope: "cohort", assignmentId });
    expect(scheduled.scheduled).toBe(true);
    const row = await t.run((ctx) => ctx.db.query("classDigests").first());
    expect(row?.status).toBe("pending");
  });

  test("a legacy digest without watermark fields is unaffected by newer analyses", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { assignmentId, activityId } = await seedAssignmentWithActivity(
      t,
      teacher,
      [scholar],
    );
    const sessionId = await seedCohortSession(
      t,
      scholar,
      activityId,
      assignmentId,
      Date.now() - 60 * 60 * 1000,
    );
    // Old-shape snapshot: counts only, no watermark fields.
    await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "cohort",
        assignmentId,
        status: "ready",
        generatedAt: Date.now() - 6 * 60_000,
        headline: "legacy digest",
        sourceSnapshot: {
          completedCount: 0,
          startedCount: 1,
          deliverableCount: 0,
        },
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("analyses", { sessionId, summary: "a new analysis" }),
    );

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.classDigests.getCohortDigest, {
      assignmentId,
    });
    expect(res!.digest!.stale).toBe(false); // absent watermark == no check
    const scheduled = await auto(t, { scope: "cohort", assignmentId });
    expect(scheduled.scheduled).toBe(false); // not regenerated on watermark
  });
});
