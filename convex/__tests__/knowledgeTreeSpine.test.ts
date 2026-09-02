import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import schema from "../schema";
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

describe("knowledgeTree.spineForStandard", () => {
  test("matches a corpus component to its cluster-letter curated parent", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId, name: "Test Teacher", username: "test-teacher",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId, name: "Test Scholar", username: "test-scholar",
    });
    const standard = await t.run(async (ctx) => {
      const documentId = await ctx.db.insert("standardsDocuments", {
        asnDocumentId: "ccss-math",
        title: "CCSS Math",
        subject: "Mathematics",
        jurisdiction: "Common Core",
      });
      const standard = await ctx.db.insert("standards", {
        asnId: "3.NF.3a",
        notation: "3.NF.3a",
        description: "Recognize equivalent fractions.",
        gradeLevels: ["3"],
        subject: "Mathematics",
        statementLabel: "Standard",
        isLeaf: true,
        documentId,
      });
      return standard;
    });
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        userId: teacher,
        expirationTime: Date.now() + 3_600_000,
      } satisfies Omit<Doc<"authSessions">, "_id" | "_creationTime">),
    );

    await t.mutation(internal.knowledgeNodes.rebuildTree, {});

    const result = await t
      .withIdentity({
        subject: `${teacher}|${sessionId}`,
        issuer: "https://convex.dev",
      })
      .query(api.knowledgeTree.spineForStandard, {
        standardId: standard,
        scholarId: scholar,
      });

    expect(result.node?.key).toBe("equivalent");
    expect(result.node?.standard).toBe("3.NF.A.3");
  });
});
