import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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

// ── Standard fixtures (copied verbatim from testDriveViewAs.test.ts) ──────────

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const name = overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`);
  const username = overrides.username ?? (role === "scholar" ? "testscholar" : `test${role}`);
  if (role === "platform_admin") return t.run((ctx) => ctx.db.insert("users", { name, username, role }));
  const institutionId = await seedTestInstitution(t);
  const userId = role === "scholar"
    ? await seedScholarInInstitution(t, { institutionId, name, username })
    : await seedStaffWithMembership(t, { institutionId, name, username });
  await t.run((ctx) => ctx.db.patch(userId, { readingLevel: overrides.readingLevel, image: overrides.image }));
  return userId;
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

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

// ── Local helpers ─────────────────────────────────────────────────────────────

/** A bare independent-study session (no assignment/unit/activity) — the
 *  anchorless "origin: is" plate row. `n` disambiguates the title. */
async function seedBareSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  n: number,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: `Quest ${n}`,
      isArchived: false,
      lastMessageAt: Date.now() - n * 1000,
    }),
  );
}

/** A scholar-authored ACTIVE quest unit with one online activity (the shape of
 *  a "Drawing Comics" IS unit). Returns the unit + its online activity id so a
 *  caller can optionally hang a live session off it. */
async function seedScholarQuest(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  title: string,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Activity",
      kind: "online",
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, activityId };
  });
}

/** Plant a teacher OFFER — a non-terminal (active) seed pointing at `unitId`
 *  for the scholar. This is the fact that flips a scholar-authored quest to the
 *  `offered` state (and makes it a "Suggested by your teacher" card). */
async function seedTeacherOffer(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  teacherId: Id<"users">,
  overrides: { scholarInvitation?: string; rationale?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "teacher" as const,
      status: "active" as const,
      suggestionType: "teacher_suggestion" as const,
      topic: "A quest",
      rationale: overrides.rationale ?? "because",
      scholarInvitation: overrides.scholarInvitation,
      unitId,
      teacherId,
    }),
  );
}

describe("scholarPlate.homeForScholar — teacher Home mirror", () => {
  test("is teacher-gated: a scholar cannot read it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.scholarPlate.homeForScholar, { scholarId }),
    ).rejects.toThrow();
  });

  test("returns an empty snapshot for a non-scholar target", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const otherTeacherId = await seedUser(t, "teacher", {
      username: "otherteacher",
    });
    const asTeacher = await withUser(t, teacherId);
    const home = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId: otherTeacherId,
    });
    expect(home.rows).toEqual([]);
    expect(home.onboarding).toBeNull();
    expect(home.focusLock).toBeNull();
    expect(home.suggested).toEqual([]);
  });

  test("row parity with activeForMe for the same scholar", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    for (let i = 1; i <= 2; i++) await seedBareSession(t, scholarId, i);

    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    // The scholar's OWN plate, called with the same options the mirror uses.
    const own = await asScholar.query(api.scholarPlate.activeForMe, {
      isLimit: 0,
      includeWebActivities: true,
    });
    const mirror = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });

    const shape = (r: { sessionId: Id<"sessions"> | null; title: string; origin: string }) => ({
      sessionId: r.sessionId,
      title: r.title,
      origin: r.origin,
    });
    expect(mirror.rows.map(shape)).toEqual(own.rows.map(shape));
    expect(mirror.rows.length).toBe(2);
  });

  test("IS lane is uncapped by default; an explicit isLimit still slices", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    for (let i = 1; i <= 5; i++) await seedBareSession(t, scholarId, i);

    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    // The scholar's own plate is now UNCAPPED by default — overflow is managed
    // by archiving, not by hiding rows behind a "show more".
    const own = await asScholar.query(api.scholarPlate.activeForMe, {
      includeWebActivities: true,
    });
    expect(own.rows.filter((r) => r.origin === "is").length).toBe(5);
    expect(own.isTotalCount).toBe(5);

    // An explicit positive isLimit still slices, for any caller that wants it.
    const capped = await asScholar.query(api.scholarPlate.activeForMe, {
      isLimit: 3,
      includeWebActivities: true,
    });
    expect(capped.rows.filter((r) => r.origin === "is").length).toBe(3);
    expect(capped.isTotalCount).toBe(5);

    // The teacher mirror shows every one of them too.
    const mirror = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });
    expect(mirror.rows.filter((r) => r.origin === "is").length).toBe(5);
  });

  test("rows carry per-unit provenance: unitIsActive + unitIsDraft", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    // A scholar-authored quest unit (structurally incomplete → still Draft),
    // with a live session in it.
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: scholarId,
        authorScholarId: scholarId,
        title: "My Quest",
        isActive: true,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        title: "My Quest work",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    const mirror = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });
    const row = mirror.rows.find((r) => String(r.unitId) === String(unitId));
    expect(row).toBeTruthy();
    expect(row?.unitIsActive).toBe(true);
    expect(row?.unitIsDraft).toBe(true); // no Big Idea / EQs / lessons → Draft
  });

  test("an offered quest appears in suggested; a dormant scholar quest does NOT", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    // OFFERED = an ACTIVE scholar-authored unit WITH a live teacher offer and no
    // session yet — the "Suggested by your teacher" card the scholar sees.
    const { unitId: offeredUnitId } = await seedScholarQuest(
      t,
      scholarId,
      "Drawing Comics",
    );
    await seedTeacherOffer(t, scholarId, offeredUnitId, teacherId, {
      scholarInvitation: "Want to make a comic?",
    });

    // DORMANT = an ACTIVE scholar-authored unit with NO offer and no session.
    // It shows in ScholarQuestsCard, NOT in the mirror's suggested cards.
    const { unitId: dormantUnitId } = await seedScholarQuest(
      t,
      scholarId,
      "Idle Quest",
    );

    const asTeacher = await withUser(t, teacherId);
    const home = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });

    const offered = home.suggested.find(
      (s) => String(s.unitId) === String(offeredUnitId),
    );
    expect(offered).toBeTruthy();
    expect(offered?.title).toBe("Drawing Comics");
    expect(offered?.teacherName).toBe("Test teacher");
    // Invitation copy joins from the seed (scholarInvitation) by unitId.
    expect(offered?.body).toBe("Want to make a comic?");
    expect(offered?.activityCount).toBe(1);
    // A scholar-authored quest → isAuthored true (drives the Retract verb).
    expect(offered?.isAuthored).toBe(true);

    // The dormant quest is NOT mirrored here…
    expect(
      home.suggested.some((s) => String(s.unitId) === String(dormantUnitId)),
    ).toBe(false);
    // …and the offered quest isn't a plate row either (it has no session).
    expect(
      home.rows.some((r) => String(r.unitId) === String(offeredUnitId)),
    ).toBe(false);
  });

  test("a scholar-authored quest WITH a live session is a plate row, not a suggested entry", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedScholarQuest(
      t,
      scholarId,
      "Started Quest",
    );
    // A live teacher offer that the scholar has STARTED — the session is stamped
    // with that seed's id, which is exactly what drops it from the suggested
    // cards (started ⇒ it's on the in-progress plate now, not an offer).
    const seedId = await seedTeacherOffer(t, scholarId, unitId, teacherId);
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        activityId,
        seedId,
        title: "Started Quest work",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    const home = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });

    // Surfaces as a plate row…
    expect(
      home.rows.some((r) => String(r.unitId) === String(unitId)),
    ).toBe(true);
    // …and is NOT double-counted in the suggested cards.
    expect(
      home.suggested.some((s) => String(s.unitId) === String(unitId)),
    ).toBe(false);
  });

  test("a teacher offer on a CATALOG unit appears in suggested (isAuthored false), and drops once started", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    // A CATALOG unit — teacher-authored, NO authorScholarId — offered to the
    // scholar. questsForScholar has NO row for it (no authored unit, no session),
    // yet the scholar's home DOES show it as a "Suggested by your teacher" card,
    // so the seed-derived mirror must include it too.
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const seedId = await seedTeacherOffer(t, scholarId, unitId, teacherId, {
      scholarInvitation: "Try this one?",
    });

    const asTeacher = await withUser(t, teacherId);
    const before = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });
    const card = before.suggested.find(
      (s) => String(s.unitId) === String(unitId),
    );
    expect(card).toBeTruthy();
    expect(card?.isAuthored).toBe(false); // catalog unit → Remove suggestion verb
    expect(card?.seedId).toBe(seedId);
    expect(card?.activityCount).toBe(1);

    // Once the scholar starts it (a session stamped with that seedId), it drops
    // out of the suggested cards.
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        activityId,
        seedId,
        title: "Catalog work",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );
    const after = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });
    expect(
      after.suggested.some((s) => String(s.unitId) === String(unitId)),
    ).toBe(false);
  });

  test("retracting a quest removes it from suggested", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId } = await seedScholarQuest(t, scholarId, "Retract From Home");
    await seedTeacherOffer(t, scholarId, unitId, teacherId);

    const asTeacher = await withUser(t, teacherId);

    const before = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });
    expect(
      before.suggested.some((s) => String(s.unitId) === String(unitId)),
    ).toBe(true);

    await asTeacher.mutation(api.quests.retract, { unitId });

    const after = await asTeacher.query(api.scholarPlate.homeForScholar, {
      scholarId,
    });
    expect(
      after.suggested.some((s) => String(s.unitId) === String(unitId)),
    ).toBe(false);
  });
});

describe("quests.retract — one-call cascade", () => {
  test("deactivates the unit, dismisses seeds, and archives sessions", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: scholarId,
        authorScholarId: scholarId,
        title: "Retract Me",
        isActive: true,
      }),
    );

    // Two active/pending seeds pointing at the unit (both should dismiss) + one
    // seed for a different unit (must be untouched).
    const otherUnitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: scholarId,
        authorScholarId: scholarId,
        title: "Keep Me",
        isActive: true,
      }),
    );
    const seedIds = await t.run(async (ctx) => {
      const mk = (status: "active" | "pending", uid: Id<"units">) =>
        ctx.db.insert("seeds", {
          scholarId,
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

    // Three sessions in the unit: two live, one already archived.
    const sessionIds = await t.run(async (ctx) => {
      const mk = (title: string, isArchived: boolean) =>
        ctx.db.insert("sessions", {
          userId: scholarId,
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

    const asTeacher = await withUser(t, teacherId);
    const res = await asTeacher.mutation(api.quests.retract, {
      unitId,
    });

    expect(res).toEqual({
      unitDeactivated: true,
      seedsDismissed: 2,
      sessionsArchived: 2,
      state: "retracted",
    });

    // Unit deactivated.
    const unit = await t.run(async (ctx) => ctx.db.get(unitId));
    expect(unit?.isActive).toBe(false);

    // Seeds → dismissed (only the two pointing at this unit).
    const active = await t.run(async (ctx) => ctx.db.get(seedIds.active));
    const pending = await t.run(async (ctx) => ctx.db.get(seedIds.pending));
    const other = await t.run(async (ctx) => ctx.db.get(seedIds.other));
    expect(active?.status).toBe("dismissed");
    expect(pending?.status).toBe("dismissed");
    expect(other?.status).toBe("active");

    // Sessions → the two live ones archived; the already-archived one unchanged.
    const a = await t.run(async (ctx) => ctx.db.get(sessionIds.a));
    const b = await t.run(async (ctx) => ctx.db.get(sessionIds.b));
    expect(a?.isArchived).toBe(true);
    expect(b?.isArchived).toBe(true);
  });

  test("rejects a non-scholar-authored unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { unitId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.mutation(api.quests.retract, { unitId }),
    ).rejects.toThrow(/scholar-authored/);
  });

  test("is teacher-gated: a scholar cannot retract", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: scholarId,
        authorScholarId: scholarId,
        title: "Mine",
        isActive: true,
      }),
    );
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.quests.retract, { unitId }),
    ).rejects.toThrow();
  });
});
