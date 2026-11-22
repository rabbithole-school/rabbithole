import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  isRetractedQuestSession,
  questStateForPair,
} from "../lib/questLifecycle";
import {
  isTeacherArchived,
  TEACHER_ARCHIVE_COPY,
} from "../../shared/teacherArchive";
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

// ── Standard fixtures (verbatim from questLifecycle.test.ts) ──────────────

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  if (role === "platform_admin") {
    return t.run((ctx) =>
      ctx.db.insert("users", {
        name: overrides.name ?? `Test ${role}`,
        username: overrides.username ?? `test${role}`,
        role,
      }),
    );
  }
  const institutionId = await seedTestInstitution(t);
  const options = {
    institutionId,
    name: overrides.name ?? `Test ${role}`,
    username: overrides.username ?? `test${role}`,
  };
  return role === "scholar"
    ? seedScholarInInstitution(t, options)
    : seedStaffWithMembership(t, options);
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

// ── Local builders for quest shapes (verbatim from questLifecycle.test.ts) ──

async function seedOnlineActivity(
  t: ReturnType<typeof convexTest>,
  unitId: Id<"units">,
  order = 0,
) {
  return await t.run(async (ctx) => {
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: `Lesson ${order}`,
      order,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: `Activity ${order}`,
      kind: "online",
      systemPrompt: "You are a tutor.",
      order,
    });
    return { lessonId, activityId };
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    unitId: Id<"units">;
    activityId?: Id<"activities">;
    title?: string;
    lastMessageAt?: number;
    isArchived?: boolean;
    isTestDrive?: boolean;
    isOffline?: boolean;
    reopenedAt?: number;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: args.userId,
      unitId: args.unitId,
      activityId: args.activityId,
      title: args.title ?? "Session",
      isArchived: args.isArchived ?? false,
      isTestDrive: args.isTestDrive,
      isOffline: args.isOffline,
      reopenedAt: args.reopenedAt,
      lastMessageAt: args.lastMessageAt,
    }),
  );
}

async function seedBadge(
  t: ReturnType<typeof convexTest>,
  args: { scholarId: Id<"users">; unitId: Id<"units"> },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("scholarUnitBadges", {
      scholarId: args.scholarId,
      unitId: args.unitId,
      earnedAt: Date.now(),
      badgeSnapshot: { title: "Badge" },
    }),
  );
}

async function seedSeedOffer(
  t: ReturnType<typeof convexTest>,
  args: {
    scholarId: Id<"users">;
    unitId: Id<"units">;
    status?: "pending" | "active" | "dismissed" | "completed";
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId: args.scholarId,
      origin: "teacher",
      status: args.status ?? "pending",
      topic: "An offered quest",
      suggestionType: "teacher_suggestion",
      rationale: "Because it's interesting",
      unitId: args.unitId,
    }),
  );
}

// A scholar-owned quest unit (authorScholarId = scholar, teacherId = scholar),
// matching how scholar quests are minted.
async function seedScholarQuestUnit(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  args: { title?: string; isActive?: boolean } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title: args.title ?? "Scholar Quest",
      isActive: args.isActive ?? true,
    }),
  );
}

// ── offer ────────────────────────────────────────────────────────────────

describe("quests.offer", () => {
  test("plants a non-terminal seed → state offered; idempotent (one seed)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "off1" });
    const unitId = await seedScholarQuestUnit(t, scholar, { title: "Offer Me" });

    const asTeacher = await withUser(t, teacher);
    const first = await asTeacher.mutation(api.quests.offer, {
      scholarId: scholar,
      unitId,
    });

    expect(first.existed).toBe(false);
    expect(first.state).toBe("offered");

    // Re-offering returns the SAME seed (idempotent) — no duplicate.
    const second = await asTeacher.mutation(api.quests.offer, {
      scholarId: scholar,
      unitId,
    });
    expect(second.existed).toBe(true);
    expect(String(second.seedId)).toBe(String(first.seedId));

    const openSeeds = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    const nonTerminal = openSeeds.filter(
      (s) =>
        String(s.unitId ?? "") === String(unitId) &&
        (s.status === "pending" || s.status === "active"),
    );
    expect(nonTerminal).toHaveLength(1);
  });

  test("is teacher-gated: a scholar cannot offer", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "off2" });
    const unitId = await seedScholarQuestUnit(t, scholar);

    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.quests.offer, { scholarId: scholar, unitId }),
    ).rejects.toThrow();

    // Sanity: the teacher CAN.
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.quests.offer, { scholarId: scholar, unitId }),
    ).resolves.toBeTruthy();
  });
});

describe("quests.aideOfferScholarQuest", () => {
  test("re-checks teacher role and scholar access", async () => {
    const t = convexTest(schema, modules);
    const homeInstitutionId = await seedTestInstitution(t, {
      slug: "quest-offer-home",
    });
    const otherInstitutionId = await seedTestInstitution(t, {
      slug: "quest-offer-other",
    });
    const teacher = await seedStaffWithMembership(t, {
      institutionId: homeInstitutionId,
      username: "offer-home-teacher",
    });
    const outOfScopeTeacher = await seedStaffWithMembership(t, {
      institutionId: otherInstitutionId,
      username: "offer-other-teacher",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId: homeInstitutionId,
      username: "offer-aide-scholar",
    });
    const unitId = await seedScholarQuestUnit(t, scholar);

    await expect(
      t.mutation(internal.quests.aideOfferScholarQuest, {
        callerUserId: scholar,
        scholarId: scholar,
        unitId,
      }),
    ).rejects.toThrow(/teacher\/admin only/i);
    await expect(
      t.mutation(internal.quests.aideOfferScholarQuest, {
        callerUserId: outOfScopeTeacher,
        scholarId: scholar,
        unitId,
      }),
    ).rejects.toThrow(/current context/i);

    await expect(
      t.mutation(internal.quests.aideOfferScholarQuest, {
        callerUserId: teacher,
        scholarId: scholar,
        unitId,
      }),
    ).resolves.toMatchObject({ existed: false, state: "offered" });
  });

  test("is idempotent and returns the existing invitation star", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "off-aide" });
    const unitId = await seedScholarQuestUnit(t, scholar);

    const first = await t.mutation(internal.quests.aideOfferScholarQuest, {
      callerUserId: teacher,
      scholarId: scholar,
      unitId,
    });
    const second = await t.mutation(internal.quests.aideOfferScholarQuest, {
      callerUserId: teacher,
      scholarId: scholar,
      unitId,
    });

    expect(first).toMatchObject({ existed: false, state: "offered" });
    expect(second).toMatchObject({ existed: true, state: "offered" });
    expect(second.seedId).toBe(first.seedId);
    const seeds = await t.run((ctx) => ctx.db.query("seeds").collect());
    expect(seeds).toHaveLength(1);
  });
});

// ── start ──────────────────────────────────────────────────────────────

describe("quests.start", () => {
  test("accepting an offer creates a session and flips state to active", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "start1" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    await seedOnlineActivity(t, unitId);
    await seedSeedOffer(t, { scholarId: scholar, unitId, status: "active" });

    // Before start: offered (an open seed, no session).
    const before = await t.run((ctx) =>
      questStateForPair(ctx, scholar, unitId),
    );
    expect(before).toBe("offered");

    const asScholar = await withUser(t, scholar);
    const res = await asScholar.mutation(api.quests.start, { unitId });
    expect(res.sessionId).toBeTruthy();
    expect(res.state).toBe("active");

    // A real session now exists on the pair, anchored to the unit + activity.
    const session = await t.run((ctx) => ctx.db.get(res.sessionId));
    expect(session?.userId).toBe(scholar);
    expect(String(session?.unitId)).toBe(String(unitId));
    expect(session?.activityId).toBeTruthy();
  });

  test("rejects when there is no open offer for the unit", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "start2" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    await seedOnlineActivity(t, unitId);

    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.quests.start, { unitId }),
    ).rejects.toThrow(/no open offer/i);
  });

  test("is scholar-self: another scholar can't start your offer", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "start3" });
    const other = await seedUser(t, "scholar", { username: "start3b" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    await seedOnlineActivity(t, unitId);
    await seedSeedOffer(t, { scholarId: scholar, unitId, status: "active" });

    // `other` has no offer for this unit → nothing to start.
    const asOther = await withUser(t, other);
    await expect(
      asOther.mutation(api.quests.start, { unitId }),
    ).rejects.toThrow(/no open offer/i);
  });
});

// ── finish (no-op validation) ─────────────────────────────────────────────

describe("quests.finish", () => {
  test("returns finished when the badge is already earned (earned, not stamped)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "fin1" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    await seedOnlineActivity(t, unitId);
    await seedBadge(t, { scholarId: scholar, unitId });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.mutation(api.quests.finish, {
      scholarId: scholar,
      unitId,
    });
    expect(res.state).toBe("finished");
  });

  test("throws when the quest is not finished (no force-finish)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "fin2" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    const { activityId } = await seedOnlineActivity(t, unitId);
    // A live (incomplete) session → state active, NOT finished.
    await seedSession(t, { userId: scholar, unitId, activityId });

    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.quests.finish, { scholarId: scholar, unitId }),
    ).rejects.toThrow(/not finished/i);
  });

  test("is teacher-gated: a scholar cannot finish", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "fin3" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    await seedOnlineActivity(t, unitId);
    await seedBadge(t, { scholarId: scholar, unitId });

    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.quests.finish, { scholarId: scholar, unitId }),
    ).rejects.toThrow();
  });
});

// ── retract ────────────────────────────────────────────────────────────

describe("quests.retract", () => {
  test("flips the pair to retracted; archives sessions + dismisses seeds", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "ret1" });
    const unitId = await seedScholarQuestUnit(t, scholar);

    // Two non-terminal seeds on the unit (both dismiss) + one on another unit.
    const otherUnitId = await seedScholarQuestUnit(t, scholar, {
      title: "Keep Me",
    });
    const seedIds = await t.run(async (ctx) => {
      const mk = (status: "active" | "pending", uid: Id<"units">) =>
        ctx.db.insert("seeds", {
          scholarId: scholar,
          origin: "teacher" as const,
          status,
          suggestionType: "teacher_suggestion" as const,
          topic: "A quest",
          rationale: "because",
          unitId: uid,
        });
      return {
        active: await mk("active", unitId),
        pending: await mk("pending", unitId),
        other: await mk("active", otherUnitId),
      };
    });

    // Two live sessions + one already-archived.
    const sessionIds = await t.run(async (ctx) => {
      const mk = (title: string, isArchived: boolean) =>
        ctx.db.insert("sessions", {
          userId: scholar,
          unitId,
          title,
          isArchived,
          lastMessageAt: Date.now(),
        });
      return {
        a: await mk("Session A", false),
        b: await mk("Session B", false),
        archived: await mk("Session C", true),
      };
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.mutation(api.quests.retract, { unitId });
    expect(res).toEqual({
      unitDeactivated: true,
      seedsDismissed: 2,
      sessionsArchived: 2,
      state: "retracted",
    });

    // Unit deactivated.
    const unit = await t.run(async (ctx) => ctx.db.get(unitId));
    expect(unit?.isActive).toBe(false);

    // Only the two seeds on this unit dismissed; the other untouched.
    const active = await t.run(async (ctx) => ctx.db.get(seedIds.active));
    const pending = await t.run(async (ctx) => ctx.db.get(seedIds.pending));
    const other = await t.run(async (ctx) => ctx.db.get(seedIds.other));
    expect(active?.status).toBe("dismissed");
    expect(pending?.status).toBe("dismissed");
    expect(other?.status).toBe("active");

    // The two live sessions archived; the already-archived one still archived.
    const a = await t.run(async (ctx) => ctx.db.get(sessionIds.a));
    const b = await t.run(async (ctx) => ctx.db.get(sessionIds.b));
    expect(a?.isArchived).toBe(true);
    expect(b?.isArchived).toBe(true);

    // Canonical derivation agrees: the pair is retracted.
    const state = await t.run((ctx) => questStateForPair(ctx, scholar, unitId));
    expect(state).toBe("retracted");
  });

  test("rejects a non-scholar-authored unit", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    // A general (teacher-authored, no authorScholarId) unit.
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: teacher,
        title: "General Unit",
        isActive: true,
      }),
    );
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.quests.retract, { unitId }),
    ).rejects.toThrow(/scholar-authored/);
  });

  test("is teacher-gated: a scholar cannot retract", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "ret3" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.quests.retract, { unitId }),
    ).rejects.toThrow();
  });
});

// ── reopen ─────────────────────────────────────────────────────────────

describe("quests.reopen", () => {
  test("restores active: reactivates the unit + unarchives its sessions", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "reo1" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    const { activityId } = await seedOnlineActivity(t, unitId);
    await seedSession(t, { userId: scholar, unitId, activityId });

    const asTeacher = await withUser(t, teacher);
    // Retract first.
    await asTeacher.mutation(api.quests.retract, { unitId });
    expect(
      await t.run((ctx) => questStateForPair(ctx, scholar, unitId)),
    ).toBe("retracted");

    // Reopen → unit active again, session unarchived, an incomplete activity
    // makes it live → active.
    const res = await asTeacher.mutation(api.quests.reopen, { unitId });
    expect(res.unitReactivated).toBe(true);
    expect(res.sessionsUnarchived).toBe(1);
    expect(res.state).toBe("active");

    const unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.isActive).toBe(true);
  });

  test("restores dormant: a bare unit (no sessions) reopens to dormant", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "reo2" });
    const unitId = await seedScholarQuestUnit(t, scholar, { isActive: false });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.mutation(api.quests.reopen, { unitId });
    expect(res.unitReactivated).toBe(true);
    expect(res.sessionsUnarchived).toBe(0);
    // No session, no offer (seeds stay dismissed), no badge → dormant.
    expect(res.state).toBe("dormant");
  });

  test("leaves seeds dismissed (offer must be re-planted)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "reo3" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    const seedId = await seedSeedOffer(t, {
      scholarId: scholar,
      unitId,
      status: "active",
    });

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.quests.retract, { unitId });
    await asTeacher.mutation(api.quests.reopen, { unitId });

    // The offer seed stays dismissed after reopen.
    const seed = await t.run((ctx) => ctx.db.get(seedId));
    expect(seed?.status).toBe("dismissed");
  });

  test("is teacher-gated: a scholar cannot reopen", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "reo4" });
    const unitId = await seedScholarQuestUnit(t, scholar, { isActive: false });
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.quests.reopen, { unitId }),
    ).rejects.toThrow();
  });
});

// ── listForScholar (scholar-detail Quests section) ────────────────────────

describe("quests.listForScholar", () => {
  test("a teacher gets the scholar's canonical quest rows", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "lfs1" });
    const unitId = await seedScholarQuestUnit(t, scholar, { title: "List Me" });
    await seedOnlineActivity(t, unitId);
    // An open offer with no session → the pair derives to `offered`.
    await seedSeedOffer(t, { scholarId: scholar, unitId, status: "active" });

    const asTeacher = await withUser(t, teacher);
    const rows = await asTeacher.query(api.quests.listForScholar, {
      scholarId: scholar,
    });
    expect(rows).toHaveLength(1);
    expect(String(rows[0].unitId)).toBe(String(unitId));
    expect(rows[0].title).toBe("List Me");
    expect(rows[0].state).toBe("offered");
    expect(rows[0].source).toBe("teacher");
  });

  test("is teacher-gated: a scholar caller is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "lfs2" });
    const unitId = await seedScholarQuestUnit(t, scholar);
    await seedOnlineActivity(t, unitId);

    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.query(api.quests.listForScholar, { scholarId: scholar }),
    ).rejects.toThrow();
  });
});

// ── a retracted quest stays put away ─────────────────────────────────────
//
// A scholar's Workshop report (2026-11-11): a teacher retracted a quest, the
// scholar tapped it in Archived ("Keep working on this"), which un-archived the
// session while the unit stayed retracted. Home drops a retracted quest and
// Archived lists only archived sessions, so the work then showed up nowhere.

describe("a retracted quest stays put away from its scholar", () => {
  async function retractedQuest(username: string) {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username });
    const unitId = await seedScholarQuestUnit(t, scholar, {
      title: "Creature Stories",
    });
    // A quest's planning chat: no activity, like the report's session.
    const sessionId = await seedSession(t, {
      userId: scholar,
      unitId,
      title: "Creature Stories",
      lastMessageAt: Date.now(),
    });
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.quests.retract, { unitId });
    const asScholar = await withUser(t, scholar);
    const archivedRow = async () =>
      (await asScholar.query(api.sessions.finishedForScholar, {})).find(
        (r) => String(r._id) === String(sessionId),
      );
    const onHome = async () =>
      (await asScholar.query(api.scholarPlate.activeForMe, {})).rows.some(
        (r) => String(r.sessionId ?? "") === String(sessionId),
      );
    return { t, unitId, sessionId, asTeacher, asScholar, archivedRow, onHome };
  }

  test("Archived shows it as put away by the teacher; Keep working and Unarchive refuse", async () => {
    const { t, unitId, sessionId, asScholar, archivedRow, onHome } =
      await retractedQuest("retracted1");

    const row = await archivedRow();
    expect(row?.finishedKind).toBe("archived");
    expect(row?.questRetracted).toBe(true);
    expect(row && isTeacherArchived(row)).toBe(true);

    // The refusal's data is the sentence itself, the only shape web and the
    // iPad show (serverErrorMessage / serverRefusal read string data only).
    for (const attempt of [
      asScholar.mutation(api.sessions.reopen, { id: sessionId }),
      asScholar.mutation(api.sessions.unarchive, { id: sessionId }),
    ]) {
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<string>).data).toBe(
        TEACHER_ARCHIVE_COPY.scholarExplain,
      );
    }
    // The badge's "Keep working" has nothing to offer.
    expect(
      await asScholar.query(api.sessions.reopenableForUnit, { unitId }),
    ).toBeNull();

    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.isArchived).toBe(true);
    expect(session?.reopenedAt).toBeUndefined();
    expect(await onHome()).toBe(false);
    expect(await archivedRow()).toBeTruthy();
  });

  test("work un-archived before the guard still lists in Archived", async () => {
    const { t, sessionId, archivedRow, onHome } =
      await retractedQuest("retracted2");
    // The state the report left behind: session live, unit still retracted.
    await t.run((ctx) =>
      ctx.db.patch(sessionId, { isArchived: false, reopenedAt: Date.now() }),
    );

    expect(await onHome()).toBe(false);
    const row = await archivedRow();
    expect(row?.questRetracted).toBe(true);
  });

  test("the teacher's reopen brings it back to Home and out of Archived", async () => {
    const { unitId, asTeacher, archivedRow, onHome } =
      await retractedQuest("retracted3");

    await asTeacher.mutation(api.quests.reopen, { unitId });

    expect(await onHome()).toBe(true);
    expect(await archivedRow()).toBeUndefined();
  });

  test("only unassigned work on an inactive scholar-authored unit counts as retracted", () => {
    const unitId = "u" as Id<"units">;
    const assignmentId = "a" as Id<"assignments">;
    const authorScholarId = "s" as Id<"users">;
    const retracted = { isActive: false, authorScholarId };
    expect(isRetractedQuestSession({ unitId }, retracted)).toBe(true);
    expect(
      isRetractedQuestSession({ unitId }, { isActive: true, authorScholarId }),
    ).toBe(false);
    expect(isRetractedQuestSession({ unitId, assignmentId }, retracted)).toBe(
      false,
    );
    expect(isRetractedQuestSession({}, retracted)).toBe(false);
    expect(isRetractedQuestSession({ unitId }, null)).toBe(false);
    // An archived catalog unit is retired curriculum, not a retracted quest.
    expect(isRetractedQuestSession({ unitId }, { isActive: false })).toBe(false);
  });

  test("work on an archived catalog unit can still be reopened", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "catalog1" });
    const unitId = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: teacher,
        title: "Retired Catalog Unit",
        isActive: false,
      }),
    );
    const sessionId = await seedSession(t, {
      userId: scholar,
      unitId,
      isArchived: true,
      lastMessageAt: Date.now(),
    });
    const asScholar = await withUser(t, scholar);

    const row = (
      await asScholar.query(api.sessions.finishedForScholar, {})
    ).find((r) => String(r._id) === String(sessionId));
    expect(row?.questRetracted).toBe(false);
    await asScholar.mutation(api.sessions.reopen, { id: sessionId });
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.isArchived).toBe(
      false,
    );
  });
});
