import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The scholar-record write tools (convex/lib/scholarWriteTools.ts) call these
 * internal teacherAide mutations with a VERIFIED callerUserId (the aide has no
 * ctx.user). These tests cover the write behavior + the validation each
 * mutation does, mirroring the actions a teacher takes on the scholar page.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}${Math.random()}`,
      role,
    }),
  );
}

/**
 * Drain any background action a mutation scheduled with `runAfter(0)`
 * (addScholarReport → extractAndRedact, addPortfolioItem → extractAndMatch —
 * both "use node" actions that `console.log` on start). Without this, that log
 * fires from convex-test's `setTimeout(0)` AFTER the test body returns, racing
 * vitest's worker teardown and throwing the flaky
 *   EnvironmentTeardownError: [vitest-worker]: Closing rpc while
 *   "onUserConsoleLog" was pending
 * that reddened otherwise-all-green CI runs (originating in this file). Yield
 * one macrotask so the scheduled `setTimeout` fires and registers its in-flight
 * promise (convex-test calls `scheduler.add` synchronously in that callback),
 * then await it to completion — so the log lands inside the test lifecycle.
 * Call this LAST in a scheduling test: the drained action patches the document
 * to `processingStatus: "error"` (no ANTHROPIC_API_KEY in CI), so any assertion
 * on the pre-drain "pending" snapshot must run before it.
 */
async function drainScheduled(t: ReturnType<typeof convexTest>) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.finishInProgressScheduledFunctions();
}

describe("teacherAide scholar-record writes", () => {
  test("addScholarObservation inserts an observation", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");

    const { observationId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.addScholarObservation, {
        teacherId: teacher,
        scholarId: scholar,
        note: "Strong fraction reasoning today",
        type: "praise",
      }),
    );
    const obs = await t.run(async (ctx) => ctx.db.get(observationId));
    expect(obs?.note).toBe("Strong fraction reasoning today");
    expect(obs?.type).toBe("praise");
    expect(obs?.scholarId).toBe(scholar);
    expect(obs?.teacherId).toBe(teacher);
  });

  test("addScholarObservation rejects an empty note", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.teacherAide.addScholarObservation, {
          teacherId: teacher,
          scholarId: scholar,
          note: "   ",
          type: "concern",
        }),
      ),
    ).rejects.toThrow(/non-empty/);
  });

  test("addScholarObservation records a neutral Whole Child category", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const periodId = await t.run((ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Writing",
        startsAt: Date.now() - 10_000,
        endsAt: Date.now() - 1_000,
        status: "writing",
      }),
    );

    const { observationId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.addScholarObservation, {
        teacherId: teacher,
        scholarId: scholar,
        note: "Started the long task without prompting.",
        type: "note",
        category: "execFunction",
        periodId,
      }),
    );
    expect(await t.run((ctx) => ctx.db.get(observationId))).toMatchObject({
      teacherId: teacher,
      scholarId: scholar,
      note: "Started the long task without prompting.",
      type: "note",
      category: "execFunction",
      periodId,
    });
  });

  test("addScholarReport creates a teacher_report text document (no raw-text dossier append)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");

    const { documentId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.addScholarReport, {
        teacherId: teacher,
        scholarId: scholar,
        title: "Q2 Progress",
        content: "Made real gains in number sense.",
      }),
    );
    const doc = await t.run(async (ctx) => ctx.db.get(documentId));
    expect(doc?.kind).toBe("teacher_report");
    expect(doc?.format).toBe("text");
    expect(doc?.title).toBe("Q2 Progress");
    expect(doc?.bodyText).toBe("Made real gains in number sense.");
    // Seeded for the redaction pass (extractAndRedact is scheduled).
    expect(doc?.extractedText).toBe("Made real gains in number sense.");
    expect(doc?.processingStatus).toBe("pending");
    expect(doc?.feedsTutor).toBe(true);
    expect(doc?.uploadedBy).toBe(teacher);

    // Access-audited like every scholarDocuments write.
    const log = await t.run(async (ctx) =>
      ctx.db
        .query("documentAccessLog")
        .withIndex("by_document", (q) => q.eq("documentId", documentId))
        .collect(),
    );
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("upload");
    expect(log[0].userId).toBe(teacher);

    // The old reports→dossier raw-text auto-append is retired: the tutor gets
    // the REDACTED variant via the documents pipeline, never the raw body.
    const dossier = await t.run(async (ctx) =>
      ctx.db
        .query("scholarDossiers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .first(),
    );
    expect(dossier).toBeNull();

    await drainScheduled(t);
  });

  test("updateScholarDossier appends, then replaces", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.updateScholarDossier, {
        scholarId: scholar,
        content: "First note",
        mode: "append",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.updateScholarDossier, {
        scholarId: scholar,
        content: "Second note",
        mode: "append",
      }),
    );
    let dossier = await t.run(async (ctx) =>
      ctx.db
        .query("scholarDossiers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .first(),
    );
    expect(dossier?.content).toContain("First note");
    expect(dossier?.content).toContain("Second note");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.updateScholarDossier, {
        scholarId: scholar,
        content: "Clean slate",
        mode: "replace",
      }),
    );
    dossier = await t.run(async (ctx) =>
      ctx.db
        .query("scholarDossiers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .first(),
    );
    expect(dossier?.content).toBe("Clean slate");
    expect(dossier?.content).not.toContain("First note");
  });

  test("setScholarReadingLevel sets a valid level + records history; null clears", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.setScholarReadingLevel, {
        callerUserId: teacher,
        scholarId: scholar,
        readingLevel: "5.4",
      }),
    );
    let s = await t.run(async (ctx) => ctx.db.get(scholar));
    expect(s?.readingLevel).toBe("5.4");
    const history = await t.run(async (ctx) =>
      ctx.db
        .query("readingLevelHistory")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(history).toHaveLength(1);
    expect(history[0].source).toBe("teacher");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.setScholarReadingLevel, {
        callerUserId: teacher,
        scholarId: scholar,
        readingLevel: null,
      }),
    );
    s = await t.run(async (ctx) => ctx.db.get(scholar));
    expect(s?.readingLevel).toBeUndefined();
  });

  test("setScholarReadingLevel rejects an invalid level", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.teacherAide.setScholarReadingLevel, {
          callerUserId: teacher,
          scholarId: scholar,
          readingLevel: "banana",
        }),
      ),
    ).rejects.toThrow(/Invalid reading level/);
  });

  test("updateScholarProfile patches name + dob; rejects a blank name", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { name: "Old Name" });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.updateScholarProfile, {
        scholarId: scholar,
        name: "New Name",
        dateOfBirth: "2016-04-01",
      }),
    );
    const s = await t.run(async (ctx) => ctx.db.get(scholar));
    expect(s?.name).toBe("New Name");
    expect(s?.dateOfBirth).toBe("2016-04-01");

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.teacherAide.updateScholarProfile, {
          scholarId: scholar,
          name: "   ",
        }),
      ),
    ).rejects.toThrow(/Name cannot be empty/);
  });

  test("resetScholarPasskeys removes every passkey for the scholar", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await t.run(async (ctx) => {
      for (const cid of ["a", "b"]) {
        await ctx.db.insert("passkeys", {
          userId: scholar,
          credentialId: cid,
          publicKey: "pk",
          counter: 0,
          createdAt: Date.now(),
        });
      }
    });
    const { removed } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.resetScholarPasskeys, {
        scholarId: scholar,
      }),
    );
    expect(removed).toBe(2);
    const left = await t.run(async (ctx) =>
      ctx.db
        .query("passkeys")
        .withIndex("by_user", (q) => q.eq("userId", scholar))
        .collect(),
    );
    expect(left).toHaveLength(0);
  });

  test("addPortfolioItem inserts a confirmed manual portfolio item", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["hello"], { type: "image/png" })),
    );

    const { itemId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.addPortfolioItem, {
        callerUserId: teacher,
        scholarId: scholar,
        title: "Tide pool sketch",
        fileStorageId: storageId as Id<"_storage">,
        fileMimeType: "image/png",
        fileSizeBytes: 5,
      }),
    );
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item?.title).toBe("Tide pool sketch");
    expect(item?.source).toBe("manual");
    expect(item?.matchStatus).toBe("confirmed");
    expect(item?.scholarId).toBe(scholar);

    await drainScheduled(t);
  });

  test("deleteScholar removes the scholar + cascades; refuses self-deletion", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    const scholar = await seedUser(t, "scholar");
    // Give them an observation to confirm the cascade reaches it.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.addScholarObservation, {
        teacherId: admin,
        scholarId: scholar,
        note: "note",
        type: "praise",
      }),
    );

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.deleteScholar, {
        callerUserId: admin,
        scholarId: scholar,
      }),
    );
    expect(res.deleted).toBe(true);
    const gone = await t.run(async (ctx) => ctx.db.get(scholar));
    expect(gone).toBeNull();
    const obs = await t.run(async (ctx) =>
      ctx.db
        .query("observations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(obs).toHaveLength(0);

    // Self-deletion is refused.
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.teacherAide.deleteScholar, {
          callerUserId: admin,
          scholarId: admin,
        }),
      ),
    ).rejects.toThrow(/Scholar not found/);
  });

  test("addScholarObservation + addScholarReport + updateScholarDossier refuse a non-scholar target", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.teacherAide.addScholarObservation, {
          teacherId: teacher,
          scholarId: teacher, // not a scholar
          note: "n",
          type: "praise",
        }),
      ),
    ).rejects.toThrow(/Scholar not found/);
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.teacherAide.addScholarReport, {
          teacherId: teacher,
          scholarId: teacher, // not a scholar
          title: "x",
          content: "y",
        }),
      ),
    ).rejects.toThrow(/Scholar not found/);
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.teacherAide.updateScholarDossier, {
          scholarId: teacher, // not a scholar
          content: "y",
          mode: "append",
        }),
      ),
    ).rejects.toThrow(/Scholar not found/);
  });
});
