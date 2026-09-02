import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Why this file: institution cascade-delete is the most destructive operation
// in the product and is IRREVERSIBLE, so these tests pin the whole safety
// model: the primary institution is undeletable, type-to-confirm is enforced,
// a school_admin can't delete another school, multi-institution users survive
// (only the one membership is removed), a single-institution scholar and every
// row they own is gone, globally shared data is untouched, the batched delete
// is idempotent when re-run, and the durable audit row survives.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function withUser(t: T, userId: Id<"users">) {
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

async function seedInstitutions(t: T) {
  return await t.run(async (ctx) => ({
    moli: await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    }),
    kona: await ctx.db.insert("institutions", {
      name: "Kona Tutoring",
      slug: "kona-tutoring",
      kind: "school",
    }),
    guests: await ctx.db.insert("institutions", {
      name: "Guests",
      slug: "guests",
      kind: "guest",
    }),
  }));
}

/** A scholar with a session + message + artifact + practice + health record. */
async function seedScholarWithData(
  t: T,
  institutionId: Id<"institutions">,
  username: string,
) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: `Scholar ${username}`,
      username,
      role: "scholar",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: scholarId,
      role: "scholar",
      institutionId,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: `${username} session`,
      isArchived: false,
    });
    const messageId = await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "hello world",
      flagged: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Artifact",
      content: "artifact",
      lastEditedBy: "scholar",
    });
    const masteryId = await ctx.db.insert("practiceMastery", {
      scholarId,
      domain: "math",
      skillKey: "add_1",
      strand: "arith",
      repetition: 0,
      halfLifeDays: 1,
      frontier: true,
      source: "practice",
      updatedAt: Date.now(),
    });
    const healthId = await ctx.db.insert("healthRecordFiles", {
      scholarId,
      uploadedBy: scholarId,
      kind: "immunization_record",
      createdAt: Date.now(),
    });
    return { scholarId, sessionId, messageId, artifactId, masteryId, healthId };
  });
}

async function driveToCompletion(t: T, jobId: Id<"institutionDeletions">) {
  for (let i = 0; i < 2000; i++) {
    const res = await t.mutation(internal.institutionDeletion.deletionStep, {
      jobId,
    });
    if (res.done) return i + 1;
  }
  throw new Error("deletion did not finish");
}

describe("institution cascade-delete — safety gates", () => {
  test("the PRIMARY institution can never be deleted (hard server refusal)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);
    await expect(
      as.mutation(api.institutionDeletion.requestDeletion, {
        institutionId: moli,
        typedName: "Moli School",
      }),
    ).rejects.toThrow(/primary institution cannot be deleted/i);

    // Preview also reports it as undeletable rather than throwing.
    const preview = await as.query(api.institutionDeletion.previewDeletion, {
      institutionId: moli,
    });
    expect(preview.isPrimary).toBe(true);
    expect(preview.canDelete).toBe(false);
  });

  test("a wrong typed name is refused", async () => {
    const t = convexTest(schema, modules);
    const { kona } = await seedInstitutions(t);
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);
    await expect(
      as.mutation(api.institutionDeletion.requestDeletion, {
        institutionId: kona,
        typedName: "Kona",
      }),
    ).rejects.toThrow(/typed name does not match/i);
    // Nothing scheduled / no job created.
    const jobs = await t.run((ctx) =>
      ctx.db.query("institutionDeletions").collect(),
    );
    expect(jobs.length).toBe(0);
  });

  test("a school_admin cannot delete another institution", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    // school_admin of MOLI tries to delete KONA
    const moliAdminId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "moli-admin",
        role: "school_admin",
        institutionId: moli,
      });
      await ctx.db.insert("memberships", {
        userId: id,
        role: "school_admin",
        institutionId: moli,
      });
      return id;
    });
    const as = await withUser(t, moliAdminId);
    await expect(
      as.mutation(api.institutionDeletion.requestDeletion, {
        institutionId: kona,
        typedName: "Kona Tutoring",
      }),
    ).rejects.toThrow(/only delete a school you administer/i);
    // But the school_admin of KONA can.
    const konaAdminId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "kona-admin",
        role: "school_admin",
        institutionId: kona,
      });
      await ctx.db.insert("memberships", {
        userId: id,
        role: "school_admin",
        institutionId: kona,
      });
      return id;
    });
    const asKona = await withUser(t, konaAdminId);
    const res = await asKona.mutation(
      api.institutionDeletion.requestDeletion,
      { institutionId: kona, typedName: "Kona Tutoring" },
    );
    expect(res.jobId).toBeDefined();
    expect(res.deletingSelf).toBe(true); // the kona admin deletes their own school
  });

  test("a school_admin cannot preview another school's footprint", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const konaAdminId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "kona-admin",
        role: "school_admin",
        institutionId: kona,
      });
      await ctx.db.insert("memberships", {
        userId: id,
        role: "school_admin",
        institutionId: kona,
      });
      return id;
    });
    const as = await withUser(t, konaAdminId);
    // Their own school: allowed.
    const own = await as.query(api.institutionDeletion.previewDeletion, {
      institutionId: kona,
    });
    expect(own.canDelete).toBe(true);
    // Another school (incl. the primary): forbidden — no footprint leak.
    await expect(
      as.query(api.institutionDeletion.previewDeletion, { institutionId: moli }),
    ).rejects.toThrow(/not your institution/i);
  });

  test("a user with a global (curriculum_designer) membership survives", async () => {
    const t = convexTest(schema, modules);
    const { kona } = await seedInstitutions(t);
    // A user tied to the target as a scholar, but ALSO holding a global
    // curriculum_designer membership (no institutionId) → must NOT be deleted;
    // only their target membership is removed.
    const designerId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "designer",
        role: "scholar",
        institutionId: kona,
      });
      await ctx.db.insert("memberships", { userId: id, role: "scholar", institutionId: kona });
      await ctx.db.insert("memberships", { userId: id, role: "curriculum_designer" });
      return id;
    });
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);
    const { jobId } = await as.mutation(api.institutionDeletion.requestDeletion, {
      institutionId: kona,
      typedName: "Kona Tutoring",
    });
    await driveToCompletion(t, jobId);
    const after = await t.run(async (ctx) => ({
      designer: await ctx.db.get(designerId),
      memberships: await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", designerId))
        .collect(),
    }));
    expect(after.designer).not.toBeNull(); // survived
    expect(after.memberships.length).toBe(1);
    expect(after.memberships[0].role).toBe("curriculum_designer");
  });

  test("an authoritative global users.role survives even without a global membership", async () => {
    const t = convexTest(schema, modules);
    const { kona } = await seedInstitutions(t);
    // A lifelong_learner (authoritative users.role) who ALSO holds a target
    // membership but NO membership carrying the global role → must survive.
    const learnerId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "learner",
        role: "lifelong_learner",
        institutionId: kona,
      });
      await ctx.db.insert("memberships", { userId: id, role: "scholar", institutionId: kona });
      return id;
    });
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);
    const { jobId } = await as.mutation(api.institutionDeletion.requestDeletion, {
      institutionId: kona,
      typedName: "Kona Tutoring",
    });
    await driveToCompletion(t, jobId);
    const learner = await t.run((ctx) => ctx.db.get(learnerId));
    expect(learner).not.toBeNull(); // survived on authoritative role
  });

  test("a scholar whose home is another school survives a stray target membership", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    // Home = Moli, but a stray membership at Kona (the target) → survives; only
    // the Kona membership is removed, the Moli home is untouched.
    const scholarId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "moli-home",
        role: "scholar",
        institutionId: moli,
      });
      await ctx.db.insert("memberships", { userId: id, role: "scholar", institutionId: moli });
      await ctx.db.insert("memberships", { userId: id, role: "scholar", institutionId: kona });
      return id;
    });
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);
    const { jobId } = await as.mutation(api.institutionDeletion.requestDeletion, {
      institutionId: kona,
      typedName: "Kona Tutoring",
    });
    await driveToCompletion(t, jobId);
    const after = await t.run(async (ctx) => ({
      scholar: await ctx.db.get(scholarId),
      memberships: await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .collect(),
    }));
    expect(after.scholar).not.toBeNull();
    expect(after.scholar!.institutionId).toBe(moli); // home untouched
    expect(after.memberships.length).toBe(1);
    expect(after.memberships[0].institutionId).toBe(moli); // only Kona membership removed
  });

  test("a parent survives while their deleted community's learning record is purged", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const { parentId, sessionId } = await t.run(async (ctx) => {
      const childId = await ctx.db.insert("users", {
        username: "parent-child",
        role: "scholar",
        institutionId: moli,
      });
      await ctx.db.insert("memberships", {
        userId: childId,
        role: "scholar",
        institutionId: moli,
      });
      const parentId = await ctx.db.insert("users", {
        username: "community-parent",
        role: "parent",
      });
      await ctx.db.insert("memberships", {
        userId: parentId,
        role: "parent",
      });
      await ctx.db.insert("memberships", {
        userId: parentId,
        role: "scholar",
        institutionId: kona,
      });
      await ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: childId,
        createdBy: parentId,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: parentId,
        institutionId: kona,
        title: "Community learning",
        isArchived: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "A learning question",
        flagged: false,
      });
      return { parentId, sessionId };
    });
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const asAdmin = await withUser(t, adminId);
    const preview = await asAdmin.query(
      api.institutionDeletion.previewDeletion,
      { institutionId: kona },
    );
    expect(preview.footprint.sessions).toBe(1);

    const { jobId } = await asAdmin.mutation(
      api.institutionDeletion.requestDeletion,
      {
        institutionId: kona,
        typedName: "Kona Tutoring",
      },
    );
    await driveToCompletion(t, jobId);

    const after = await t.run(async (ctx) => ({
      parent: await ctx.db.get(parentId),
      session: await ctx.db.get(sessionId),
      memberships: await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", parentId))
        .collect(),
    }));
    expect(after.parent).not.toBeNull();
    expect(after.session).toBeNull();
    expect(after.memberships.map((membership) => membership.role)).toEqual([
      "parent",
    ]);
  });

  test("OAuth codes are deleted only for the purged user", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const { targetUserId, controlUserId, targetCodeId, controlCodeId } =
      await t.run(async (ctx) => {
        const targetUserId = await ctx.db.insert("users", {
          username: "kona-oauth-user",
          role: "scholar",
          institutionId: kona,
        });
        await ctx.db.insert("memberships", {
          userId: targetUserId,
          role: "scholar",
          institutionId: kona,
        });
        const controlUserId = await ctx.db.insert("users", {
          username: "moli-oauth-user",
          role: "scholar",
          institutionId: moli,
        });
        await ctx.db.insert("memberships", {
          userId: controlUserId,
          role: "scholar",
          institutionId: moli,
        });
        const code = {
          clientId: "oauth-client",
          redirectUri: "https://example.com/callback",
          codeChallenge: "challenge",
          expiresAt: Date.now() + 60_000,
        };
        const targetCodeId = await ctx.db.insert("mcpOauthCodes", {
          ...code,
          codeHash: "target-code",
          userId: targetUserId,
        });
        const controlCodeId = await ctx.db.insert("mcpOauthCodes", {
          ...code,
          codeHash: "control-code",
          userId: controlUserId,
        });
        return { targetUserId, controlUserId, targetCodeId, controlCodeId };
      });
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);

    const { jobId } = await as.mutation(api.institutionDeletion.requestDeletion, {
      institutionId: kona,
      typedName: "Kona Tutoring",
    });
    await driveToCompletion(t, jobId);

    const after = await t.run(async (ctx) => ({
      targetUser: await ctx.db.get(targetUserId),
      controlUser: await ctx.db.get(controlUserId),
      targetCode: await ctx.db.get(targetCodeId),
      controlCode: await ctx.db.get(controlCodeId),
      controlCodes: await ctx.db
        .query("mcpOauthCodes")
        .withIndex("by_user", (q) => q.eq("userId", controlUserId))
        .collect(),
    }));
    expect(after.targetUser).toBeNull();
    expect(after.targetCode).toBeNull();
    expect(after.controlUser).not.toBeNull();
    expect(after.controlCode).not.toBeNull();
    expect(after.controlCodes).toHaveLength(1);
    expect(after.controlCodes[0]._id).toBe(controlCodeId);
  });

  test("a single heavy user (many sessions) purges across multiple steps", async () => {
    const t = convexTest(schema, modules);
    const { kona } = await seedInstitutions(t);
    // One scholar with MORE sessions than SESSION_CHUNK (4) so their purge
    // cannot finish in a single step — it must resume.
    const scholarId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "heavy",
        role: "scholar",
        institutionId: kona,
      });
      await ctx.db.insert("memberships", { userId: id, role: "scholar", institutionId: kona });
      for (let i = 0; i < 11; i++) {
        const s = await ctx.db.insert("sessions", { userId: id, title: `s${i}`, isArchived: false });
        await ctx.db.insert("messages", { sessionId: s, role: "user", content: "hi", flagged: false });
      }
      return id;
    });
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);
    const { jobId } = await as.mutation(api.institutionDeletion.requestDeletion, {
      institutionId: kona,
      typedName: "Kona Tutoring",
    });

    // First step drains only SESSION_CHUNK sessions — the scholar is NOT deleted
    // yet (their sessions remain), proving per-user resumability.
    const first = await t.mutation(internal.institutionDeletion.deletionStep, { jobId });
    expect(first.done).toBe(false);
    const mid = await t.run(async (ctx) => ({
      scholar: await ctx.db.get(scholarId),
      remainingSessions: (
        await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", scholarId)).collect()
      ).length,
    }));
    expect(mid.scholar).not.toBeNull(); // still present — purge not finished
    expect(mid.remainingSessions).toBeGreaterThan(0);
    expect(mid.remainingSessions).toBeLessThan(11);

    await driveToCompletion(t, jobId);
    const done = await t.run(async (ctx) => ({
      scholar: await ctx.db.get(scholarId),
      sessions: (
        await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", scholarId)).collect()
      ).length,
      messages: (await ctx.db.query("messages").collect()).length,
      institution: await ctx.db.get(kona),
    }));
    expect(done.scholar).toBeNull();
    expect(done.sessions).toBe(0);
    expect(done.messages).toBe(0);
    expect(done.institution).toBeNull();
  });
});

describe("institution cascade-delete — blast radius", () => {
  test("scholars + all owned rows gone; multi-institution user survives; global + other school untouched; audit written; idempotent", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona, guests } = await seedInstitutions(t);
    void guests;

    // Globally shared rows that must NEVER be touched.
    const globalIds = await t.run(async (ctx) => {
      const doc = await ctx.db.insert("standardsDocuments", {
        asnDocumentId: "D1",
        title: "CCSS",
        subject: "math",
        jurisdiction: "US",
      });
      const std = await ctx.db.insert("standards", {
        asnId: "S1",
        description: "add",
        gradeLevels: ["1"],
        subject: "math",
        statementLabel: "1.OA.1",
        isLeaf: true,
        documentId: doc,
      });
      const node = await ctx.db.insert("knowledgeNodes", {
        nodeKey: "addition",
        label: "Addition",
        domain: "math",
      });
      const item = await ctx.db.insert("practiceItems", {
        skillKey: "add_1",
        domain: "math",
        stem: "1+1",
        answerType: "integer",
        answerCanonical: "2",
        source: "generated",
        verifiedAt: Date.now(),
      });
      return { doc, std, node, item };
    });

    // A Kona scholar with a full data footprint → DELETE.
    const konaScholar = await seedScholarWithData(t, kona, "kona-kid");
    // A Moli scholar (control) → UNTOUCHED.
    const moliScholar = await seedScholarWithData(t, moli, "moli-kid");

    // A Kona teacher (single-institution) authoring a Kona unit + assignment.
    const konaTeacher = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "kona-teacher",
        role: "teacher",
        institutionId: kona,
      });
      await ctx.db.insert("memberships", {
        userId: id,
        role: "teacher",
        institutionId: kona,
      });
      const unit = await ctx.db.insert("units", {
        title: "Kona Unit",
        teacherId: id,
        institutionId: kona,
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", { unitId: unit, title: "L1", order: 0 });
      const activity = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "A1",
        kind: "online",
        order: 0,
      });
      const assignment = await ctx.db.insert("assignments", {
        teacherId: id,
        unitId: unit,
        scholarIds: [konaScholar.scholarId],
        startedAt: Date.now(),
      });
      return { id, unit, lesson, activity, assignment };
    });

    // A MULTI-institution teacher: memberships at BOTH kona and moli, home = kona.
    const multiTeacher = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "multi-teacher",
        role: "teacher",
        institutionId: kona,
      });
      await ctx.db.insert("memberships", { userId: id, role: "teacher", institutionId: kona });
      await ctx.db.insert("memberships", { userId: id, role: "teacher", institutionId: moli });
      return id;
    });

    // A parent (global) guarding the Kona scholar AND the Moli scholar.
    const parent = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { username: "parent", role: "parent" });
      await ctx.db.insert("guardianships", {
        parentUserId: id,
        scholarUserId: konaScholar.scholarId,
        createdBy: id,
      });
      await ctx.db.insert("guardianships", {
        parentUserId: id,
        scholarUserId: moliScholar.scholarId,
        createdBy: id,
      });
      return id;
    });

    // An ORPHAN parent (global) guarding ONLY the Kona scholar → should be
    // deleted once their sole child is gone.
    const orphanParent = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { username: "orphan-parent", role: "parent" });
      await ctx.db.insert("guardianships", {
        parentUserId: id,
        scholarUserId: konaScholar.scholarId,
        createdBy: id,
      });
      return id;
    });

    // A class digest hanging off the Kona teacher's assignment → must be
    // cascaded with the assignment, not orphaned.
    const digestId = await t.run((ctx) =>
      ctx.db.insert("classDigests", {
        scope: "cohort",
        assignmentId: konaTeacher.assignment,
        status: "ready",
      }),
    );

    // Usage events, generated Flair, and an invite scoped to Kona.
    const flair = await t.run(async (ctx) => {
      await ctx.db.insert("usageEvents", {
        source: "tutor",
        institutionId: kona,
        model: "x",
        inputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("institutionInvites", {
        code: "abc",
        kind: "join_institution",
        institutionId: kona,
        createdBy: konaTeacher.id,
        createdAt: Date.now(),
        usedCount: 0,
      });
      const imageStorageId = await ctx.storage.store(
        new Blob(["flair"], { type: "image/png" }),
      );
      const rowId = await ctx.db.insert("flairArt", {
        institutionId: kona,
        artKey: "bold-v1:kona",
        sourceLabel: "Careful observation",
        status: "ready",
        imageStorageId,
        attemptCount: 1,
        lastAttemptAt: Date.now(),
        createdAt: Date.now(),
      });
      return { imageStorageId, rowId };
    });

    // Institution-owned improvement-loop state must not survive the school.
    await t.run(async (ctx) => {
      const now = Date.now();
      const periodId = await ctx.db.insert("reportingPeriods", {
        institutionId: kona,
        label: "Current",
        startsAt: now - 86_400_000,
        endsAt: now + 86_400_000,
        status: "writing",
      });
      await ctx.db.insert("improvementTraces", {
        institutionId: kona,
        policy: "rounds",
        lifecycle: "discovered",
        createdBy: konaTeacher.id,
        evidenceRefs: [],
        createdAt: now,
        updatedAt: now,
      });
      const meetingId = await ctx.db.insert("scholarReviewMeetings", {
        institutionId: kona,
        periodId,
        weekKey: "2026-08-17",
        createdBy: konaTeacher.id,
        status: "open",
        createdAt: now,
      });
      await ctx.db.insert("scholarReviewEntries", {
        institutionId: kona,
        meetingId,
        scholarId: konaScholar.scholarId,
        note: "Team note from the week.",
        discussedAt: now,
        discussedBy: konaTeacher.id,
      });
      await ctx.db.insert("sweepFindings", {
        institutionId: kona,
        scan: "lifecycle_state",
        stateRef: {
          table: "sessionSignals",
          field: "frustration_without_disposition:v1",
        },
        consequence: "bucket:frustration_no_disposition;grade:grade_a",
        affectedKind: "scholar",
        affectedUserId: konaScholar.scholarId,
        severity: "misleading",
        representationGap: "no_alert",
        observedAt: now,
        disposition: "needs_decision",
        dedupKey: "institution-delete-coherence",
        firstSeenAt: now,
        lastSeenAt: now,
      });
      await ctx.db.insert("coherenceScanStates", {
        institutionId: kona,
        scholarCursor: "test-cursor",
        updatedAt: now,
      });
    });

    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);

    // Preview shows real counts.
    const preview = await as.query(api.institutionDeletion.previewDeletion, {
      institutionId: kona,
    });
    expect(preview.canDelete).toBe(true);
    expect(preview.deletingSelf).toBe(false); // platform admin isn't deleted
    expect(preview.footprint.scholars).toBe(1);
    expect(preview.footprint.staff).toBe(1); // konaTeacher (multiTeacher survives)
    expect(preview.footprint.survivingAccounts).toBe(1); // multiTeacher
    expect(preview.footprint.sessions).toBe(1);
    expect(preview.footprint.messages).toBe(1);
    expect(preview.footprint.units).toBe(1);
    expect(preview.footprint.guardianships).toBe(2); // both parents' links to the kona scholar
    expect(preview.footprint.invites).toBe(1);
    expect(preview.footprint.usageEvents).toBe(1);

    const { jobId } = await as.mutation(
      api.institutionDeletion.requestDeletion,
      { institutionId: kona, typedName: "Kona Tutoring" },
    );
    await driveToCompletion(t, jobId);

    // ── The institution + its scholars/staff/rows are gone ──
    const after = await t.run(async (ctx) => {
      return {
        institution: await ctx.db.get(kona),
        scholar: await ctx.db.get(konaScholar.scholarId),
        session: await ctx.db.get(konaScholar.sessionId),
        message: await ctx.db.get(konaScholar.messageId),
        artifact: await ctx.db.get(konaScholar.artifactId),
        mastery: await ctx.db.get(konaScholar.masteryId),
        health: await ctx.db.get(konaScholar.healthId),
        teacher: await ctx.db.get(konaTeacher.id),
        unit: await ctx.db.get(konaTeacher.unit),
        lesson: await ctx.db.get(konaTeacher.lesson),
        activity: await ctx.db.get(konaTeacher.activity),
        assignment: await ctx.db.get(konaTeacher.assignment),
        usage: await ctx.db.query("usageEvents").collect(),
        invites: await ctx.db.query("institutionInvites").collect(),
        flairRow: await ctx.db.get(flair.rowId),
        flairBlobExists:
          (await ctx.storage.get(flair.imageStorageId)) !== null,
        improvementRows: {
          traces: await ctx.db.query("improvementTraces").collect(),
          meetings: await ctx.db.query("scholarReviewMeetings").collect(),
          entries: await ctx.db.query("scholarReviewEntries").collect(),
          findings: await ctx.db.query("sweepFindings").collect(),
          scanStates: await ctx.db.query("coherenceScanStates").collect(),
        },
        // multi-institution teacher SURVIVES
        multiTeacher: await ctx.db.get(multiTeacher),
        multiTeacherMemberships: await ctx.db
          .query("memberships")
          .withIndex("by_user", (q) => q.eq("userId", multiTeacher))
          .collect(),
        // parent survives; link to kona scholar gone, link to moli scholar kept
        parent: await ctx.db.get(parent),
        parentLinks: await ctx.db
          .query("guardianships")
          .withIndex("by_parent", (q) => q.eq("parentUserId", parent))
          .collect(),
        // orphan parent (guarded only the deleted scholar) → deleted
        orphanParent: await ctx.db.get(orphanParent),
        // class digest on a deleted assignment → cascaded
        digest: await ctx.db.get(digestId),
        // Moli control intact
        moliScholar: await ctx.db.get(moliScholar.scholarId),
        moliSession: await ctx.db.get(moliScholar.sessionId),
        // global untouched
        global: {
          doc: await ctx.db.get(globalIds.doc),
          std: await ctx.db.get(globalIds.std),
          node: await ctx.db.get(globalIds.node),
          item: await ctx.db.get(globalIds.item),
        },
        job: await ctx.db.get(jobId),
        auditRows: await ctx.db
          .query("auditLog")
          .withIndex("by_action", (q) => q.eq("action", "institution.delete"))
          .collect(),
      };
    });

    expect(after.institution).toBeNull();
    expect(after.scholar).toBeNull();
    expect(after.session).toBeNull();
    expect(after.message).toBeNull();
    expect(after.artifact).toBeNull();
    expect(after.mastery).toBeNull();
    expect(after.health).toBeNull();
    expect(after.teacher).toBeNull();
    expect(after.unit).toBeNull();
    expect(after.lesson).toBeNull();
    expect(after.activity).toBeNull();
    expect(after.assignment).toBeNull();
    expect(after.usage.length).toBe(0);
    expect(after.invites.length).toBe(0);
    expect(after.flairRow).toBeNull();
    expect(after.flairBlobExists).toBe(false);
    expect(after.improvementRows).toEqual({
      traces: [],
      meetings: [],
      entries: [],
      findings: [],
      scanStates: [],
    });

    // Multi-institution teacher survived, with ONLY the moli membership left.
    expect(after.multiTeacher).not.toBeNull();
    expect(after.multiTeacherMemberships.length).toBe(1);
    expect(after.multiTeacherMemberships[0].institutionId).toBe(moli);
    expect(after.multiTeacher!.institutionId).toBe(moli); // home repointed off kona

    // Parent survived; its kona link is gone but the moli link remains.
    expect(after.parent).not.toBeNull();
    expect(after.parentLinks.length).toBe(1);
    expect(after.parentLinks[0].scholarUserId).toBe(moliScholar.scholarId);

    // Orphan parent (sole child deleted) was purged; the dependent digest
    // were cascaded, not orphaned.
    expect(after.orphanParent).toBeNull();
    expect(after.digest).toBeNull();

    // Moli untouched.
    expect(after.moliScholar).not.toBeNull();
    expect(after.moliSession).not.toBeNull();

    // Globally shared untouched.
    expect(after.global.doc).not.toBeNull();
    expect(after.global.std).not.toBeNull();
    expect(after.global.node).not.toBeNull();
    expect(after.global.item).not.toBeNull();

    // Audit: durable job row completed with a real tally; global audit mirrored.
    expect(after.job).not.toBeNull();
    expect(after.job!.status).toBe("completed");
    expect(after.job!.counts!.users).toBeGreaterThanOrEqual(2); // scholar + teacher
    expect(after.job!.counts!.institutions).toBe(1);
    expect(after.auditRows.length).toBe(1);
    expect(after.auditRows[0].actorUserId).toBe(adminId);

    // ── Idempotent: re-running the step machine is a safe no-op ──
    const stepsAgain = await driveToCompletion(t, jobId);
    expect(stepsAgain).toBe(1); // already completed → immediately done
    const konaStillGone = await t.run((ctx) => ctx.db.get(kona));
    expect(konaStillGone).toBeNull();
  });

  test("resumable: a partial run followed by a fresh run converges", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    void moli;
    // Seed MORE scholars than USERS_PER_STEP (20) so more than one user-step is
    // required — a single step cannot finish, proving mid-run resumability.
    const SCHOLARS = 25;
    await t.run(async (ctx) => {
      for (let i = 0; i < SCHOLARS; i++) {
        const id = await ctx.db.insert("users", {
          username: `kona-${i}`,
          role: "scholar",
          institutionId: kona,
        });
        await ctx.db.insert("memberships", {
          userId: id,
          role: "scholar",
          institutionId: kona,
        });
      }
    });
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", { username: "pa", role: "platform_admin" }),
    );
    const as = await withUser(t, adminId);
    const { jobId } = await as.mutation(
      api.institutionDeletion.requestDeletion,
      { institutionId: kona, typedName: "Kona Tutoring" },
    );

    // Run a SINGLE step (a PARTIAL delete): it processes one bounded batch of
    // users and returns not-done, so the job is still running and some — but
    // not all — scholars remain.
    const first = await t.mutation(internal.institutionDeletion.deletionStep, {
      jobId,
    });
    expect(first.done).toBe(false);
    const mid = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      institution: await ctx.db.get(kona),
      remaining: (
        await ctx.db
          .query("users")
          .withIndex("by_institution", (q) => q.eq("institutionId", kona))
          .collect()
      ).length,
    }));
    expect(mid.job!.status).toBe("running");
    expect(mid.institution).not.toBeNull(); // not finalized yet
    expect(mid.remaining).toBeGreaterThan(0); // partial
    expect(mid.remaining).toBeLessThan(SCHOLARS);

    // A fresh driver finishes the job cleanly (resumes from the checkpoint).
    await driveToCompletion(t, jobId);
    const done = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      institution: await ctx.db.get(kona),
      remainingScholars: (
        await ctx.db
          .query("users")
          .withIndex("by_institution", (q) => q.eq("institutionId", kona))
          .collect()
      ).length,
    }));
    expect(done.job!.status).toBe("completed");
    expect(done.institution).toBeNull();
    expect(done.remainingScholars).toBe(0);
  });
});
