import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  HEADING_ONLY_PROMPT,
  SEGMENTS_PROMPT,
  SINGLE_PROMPT,
} from "../portfolioActions";
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

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function storedFile(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) =>
    ctx.storage.store(new Blob(["scan"], { type: "image/jpeg" })),
  );
}

async function headingJobs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
      (job as { name?: string }).name?.includes(
        "portfolioActions:extractHeadingOnly",
      ),
    ),
  );
}

describe("portfolio document headings", () => {
  test("all extraction prompts distinguish document names from section headings", () => {
    for (const prompt of [
      SINGLE_PROMPT,
      SEGMENTS_PROMPT,
      HEADING_ONLY_PROMPT,
    ]) {
      const normalizedPrompt = prompt.replace(/\s+/g, " ");
      expect(normalizedPrompt).toContain("I. Strengths and Interests");
      expect(normalizedPrompt).toContain("Part B: Reflection");
      expect(normalizedPrompt.toLowerCase()).toContain("prefer null over a guess");
      expect(normalizedPrompt).toContain("page/template code");
    }
  });

  test("insert, extraction patch, and public scholar list preserve the heading", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Heading teacher",
      username: "heading-teacher",
    });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Heading scholar",
      username: "heading-scholar",
    });
    const fileStorageId = await storedFile(t);

    const itemId = await t.mutation(internal.portfolio.insertSegment, {
      source: "upload",
      title: "scan-1.jpg",
      fileStorageId,
      fileMimeType: "image/jpeg",
      documentHeading: "  Learning Print  ",
      scholarId,
      matchStatus: "matched",
      assignmentStatus: "none",
      institutionId,
    });
    expect((await t.run((ctx) => ctx.db.get(itemId)))?.documentHeading).toBe(
      "Learning Print",
    );

    await t.mutation(internal.portfolio.aiPatchExtraction, {
      itemId,
      documentHeading: "  Weekly Reading Log  ",
    });
    expect((await t.run((ctx) => ctx.db.get(itemId)))?.documentHeading).toBe(
      "Weekly Reading Log",
    );

    const asTeacher = await withUser(t, teacherId);
    const rows = await asTeacher.query(api.portfolio.listForScholar, {
      scholarId,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        _id: itemId,
        documentHeading: "Weekly Reading Log",
      }),
    ]);
  });

  test("sweep selects only ready files never checked for a heading", async () => {
    const t = convexTest(schema, modules);
    const fileStorageId = await storedFile(t);
    const { missingItemId, emptyItemId } = await t.run(async (ctx) => {
      const base = {
        title: "Scan",
        source: "upload" as const,
        matchStatus: "unmatched" as const,
        assignmentStatus: "none" as const,
        processingStatus: "ready" as const,
      };
      const missingItemId = await ctx.db.insert("portfolioItems", {
        ...base,
        fileStorageId,
      });
      const emptyItemId = await ctx.db.insert("portfolioItems", {
        ...base,
        fileStorageId,
      });
      await ctx.db.insert("portfolioItems", {
        ...base,
        fileStorageId,
        documentHeading: "Exit Ticket",
      });
      await ctx.db.insert("portfolioItems", base);
      await ctx.db.insert("portfolioItems", {
        ...base,
        fileStorageId,
        processingStatus: "extracting",
      });
      return { missingItemId, emptyItemId };
    });
    // This is the same mutation-level sentinel write used when the best-effort
    // extraction action catches a missing blob, model error, or invalid JSON.
    await t.mutation(internal.portfolio.aiPatchDocumentHeading, {
      itemId: emptyItemId,
      documentHeading: "",
    });

    const result = await t.mutation(
      internal.portfolio.sweepMissingHeadings,
      {},
    );
    expect(result).toEqual({ considered: 4, scheduled: 1 });
    const jobs = await headingJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toMatchObject({
      itemId: missingItemId,
      force: false,
    });
  });

  test("redoEmpty retries empty sentinels but not real headings", async () => {
    const t = convexTest(schema, modules);
    const fileStorageId = await storedFile(t);
    const emptyItemId = await t.run(async (ctx) => {
      const base = {
        title: "Scan",
        source: "upload" as const,
        fileStorageId,
        matchStatus: "unmatched" as const,
        assignmentStatus: "none" as const,
        processingStatus: "ready" as const,
      };
      const emptyItemId = await ctx.db.insert("portfolioItems", {
        ...base,
        documentHeading: "",
      });
      await ctx.db.insert("portfolioItems", {
        ...base,
        documentHeading: "Exit Ticket",
      });
      return emptyItemId;
    });

    const result = await t.mutation(
      internal.portfolio.sweepMissingHeadings,
      { redoEmpty: true },
    );

    expect(result).toEqual({ considered: 2, scheduled: 1 });
    const jobs = await headingJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toMatchObject({
      itemId: emptyItemId,
      force: true,
    });
  });

  test("redoAll retries real headings and forces extraction", async () => {
    const t = convexTest(schema, modules);
    const fileStorageId = await storedFile(t);
    const headedItemId = await t.run((ctx) =>
      ctx.db.insert("portfolioItems", {
        title: "Scan",
        source: "upload",
        fileStorageId,
        documentHeading: "Exit Ticket",
        matchStatus: "unmatched",
        assignmentStatus: "none",
        processingStatus: "ready",
      }),
    );

    const result = await t.mutation(
      internal.portfolio.sweepMissingHeadings,
      { redoAll: true },
    );

    expect(result).toEqual({ considered: 1, scheduled: 1 });
    const jobs = await headingJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toMatchObject({
      itemId: headedItemId,
      force: true,
    });
  });

  test("sweep respects its scheduling limit", async () => {
    const t = convexTest(schema, modules);
    const fileStorageId = await storedFile(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("portfolioItems", {
          title: `Scan ${i}`,
          source: "upload",
          fileStorageId,
          matchStatus: "unmatched",
          assignmentStatus: "none",
          processingStatus: "ready",
        });
      }
    });

    const result = await t.mutation(
      internal.portfolio.sweepMissingHeadings,
      { limit: 2 },
    );
    expect(result).toEqual({ considered: 3, scheduled: 2 });
    expect(await headingJobs(t)).toHaveLength(2);
  });
});
