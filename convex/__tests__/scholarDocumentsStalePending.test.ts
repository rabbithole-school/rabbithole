import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedTestInstitution,
  seedStaffWithMembership,
  seedScholarInInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Regression coverage for the "stuck in pending/extracting/redacting
// forever" bug: extractAndRedact ("use node") only marks a row failed from
// inside its own try/catch, so a hard-killed action (deploy, the 10-minute
// action cap, a crash) leaves the row in an in-progress status with nothing
// to ever re-drive it — there is no retry mutation and no cron for this
// table, only a teacher manually deleting + re-uploading. The fix degrades a
// stale in-progress row to "error" at READ time (scholarDocumentRow / get),
// mirroring portfolio.ts's THUMB_PENDING_STALE_MS, so the UI's existing
// error badge (+ its Delete affordance) appears instead of an eternal
// spinner. The stored row is never touched.

type TestCtx = ReturnType<typeof convexTest>;

async function seedWorld(t: TestCtx) {
  const institutionId = await seedTestInstitution(t, {
    slug: `fixture-school-${Math.random().toString(36).slice(2)}`,
  });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    role: "teacher",
  });
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  return { teacherId, scholarId };
}

async function withUser(t: TestCtx, userId: Id<"users">) {
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

async function seedDocument(
  t: TestCtx,
  scholarId: Id<"users">,
  uploaderId: Id<"users">,
  overrides: Partial<Doc<"scholarDocuments">> = {},
) {
  return await t.run(async (ctx) => {
    const fileStorageId = await ctx.storage.store(
      new Blob(["fake assessment pdf"], { type: "application/pdf" }),
    );
    return await ctx.db.insert("scholarDocuments", {
      scholarId,
      kind: "assessment",
      format: "file",
      title: "Confidential assessment",
      fileStorageId,
      fileMimeType: "application/pdf",
      fileSizeBytes: 19,
      uploadedBy: uploaderId,
      processingStatus: "pending",
      ...overrides,
    });
  });
}

describe("scholarDocuments stale-pending degrade", () => {
  test("a fresh pending document reads as pending (still in flight)", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedWorld(t);
    const documentId = await seedDocument(t, scholarId, teacherId);

    const asTeacher = await withUser(t, teacherId);
    const list = await asTeacher.query(api.scholarDocuments.listForScholar, {
      scholarId,
    });
    expect(list).toHaveLength(1);
    expect(list[0].processingStatus).toBe("pending");
    expect(list[0].processingError).toBeUndefined();

    const single = await asTeacher.query(api.scholarDocuments.get, {
      documentId,
    });
    expect(single?.processingStatus).toBe("pending");
  });

  test("a document stuck extracting/redacting past the 10-min action cap degrades to error", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedWorld(t);
    // No pendingSince — a fresh insert, so _creationTime is the anchor, and
    // it's already old enough to be past the 10-minute cap.
    const documentId = await seedDocument(t, scholarId, teacherId, {
      processingStatus: "redacting",
    });
    // convex-test stamps _creationTime at insert (now); jump the clock
    // forward past the stale bound instead of back-dating the row, so we
    // exercise the same "time has passed" path a real deploy-kill would.
    const future = Date.now() + 11 * 60_000;
    const realNow = Date.now;
    Date.now = () => future;
    try {
      const asTeacher = await withUser(t, teacherId);
      const list = await asTeacher.query(
        api.scholarDocuments.listForScholar,
        { scholarId },
      );
      expect(list[0].processingStatus).toBe("error");
      expect(list[0].processingError).toMatch(/did not finish/i);

      const single = await asTeacher.query(api.scholarDocuments.get, {
        documentId,
      });
      expect(single?.processingStatus).toBe("error");
      expect(single?.processingError).toMatch(/did not finish/i);
    } finally {
      Date.now = realNow;
    }

    // The stored row itself is untouched — this is a read-time projection,
    // not a write, so a hypothetical late completion would still win.
    const raw = await t.run((ctx) => ctx.db.get(documentId));
    expect(raw?.processingStatus).toBe("redacting");
    expect(raw?.processingError).toBeUndefined();
  });

  test("a re-triggered document (updateTextReport) uses pendingSince, not the row's original _creationTime", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedWorld(t);
    const asTeacher = await withUser(t, teacherId);

    const { documentId } = await asTeacher.mutation(
      api.scholarDocuments.createTextReport,
      { scholarId, title: "Progress note", bodyText: "Original body." },
    );

    await t.run((ctx) => ctx.db.patch(documentId, { processingStatus: "ready" }));

    // Advance the clock past the stale bound relative to the row's real
    // (recent) _creationTime, then re-trigger processing at that later
    // "now" — as if an old report were reopened and re-saved. If the read
    // side ever regressed to falling back on _creationTime instead of the
    // freshly-stamped pendingSince, this would misread the just-started
    // attempt as stale.
    const future = Date.now() + 20 * 60_000;
    const realNow = Date.now;
    Date.now = () => future;
    try {
      await asTeacher.mutation(api.scholarDocuments.updateTextReport, {
        documentId,
        bodyText: "Updated body.",
      });

      const single = await asTeacher.query(api.scholarDocuments.get, {
        documentId,
      });
      // Freshly re-triggered — must NOT be misread as stale just because
      // the row's original _creationTime is now more than 10 minutes old.
      expect(single?.processingStatus).toBe("pending");
      expect(single?.processingError).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  test("re-arming a failed report clears the failed attempt's error", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedWorld(t);
    const asTeacher = await withUser(t, teacherId);
    const { documentId } = await asTeacher.mutation(
      api.scholarDocuments.createTextReport,
      { scholarId, title: "Progress note", bodyText: "Original body." },
    );
    await t.run((ctx) =>
      ctx.db.patch(documentId, {
        processingStatus: "error",
        processingError: "Redaction failed.",
      }),
    );
    await asTeacher.mutation(api.scholarDocuments.updateTextReport, {
      documentId,
      bodyText: "Edited body.",
    });
    const single = await asTeacher.query(api.scholarDocuments.get, { documentId });
    expect(single?.processingStatus).toBe("pending");
    expect(single?.processingError).toBeUndefined();
  });
});
