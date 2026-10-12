import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import * as scholarDocumentsModule from "../scholarDocuments";
import type { FunctionReference } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Privacy boundary for sensitive scholar assessment documents.
// These direct read queries expose adult-facing psych/neuropsych source
// material (metadata, summaries, raw extracted text, original downloads, and
// audit trails). If scholarDocuments ever widens beyond teacher/admin roles,
// this test must break.

const DENIAL_ERROR = "Forbidden: teacher or admin role required";

const DENIED_ROLES = [
  "staff",
  "parent",
  "scholar",
  "curriculum_designer",
  "lifelong_learner",
] as const satisfies readonly Role[];

const ALLOWED_ROLES = [
  "teacher",
  "school_admin",
  "platform_admin",
] as const satisfies readonly Role[];

type TestCtx = ReturnType<typeof convexTest>;

type Fixtures = {
  scholarId: Id<"users">;
  documentId: Id<"scholarDocuments">;
};

async function seedInstitution(t: TestCtx) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name: "Gate Test School",
      slug: "gate-test-school",
      kind: "school",
    }),
  );
}

async function seedUser(
  t: TestCtx,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      institutionId,
    }),
  );
}

async function grantMembership(
  t: TestCtx,
  userId: Id<"users">,
  role: Role,
  institutionId?: Id<"institutions">,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("memberships", { userId, role, institutionId });
  });
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

async function seedDocumentFixture(
  t: TestCtx,
  uploaderId: Id<"users">,
  institutionId?: Id<"institutions">,
) {
  const scholarId = await seedUser(
    t,
    "scholar",
    "target-scholar",
    institutionId,
  );
  const documentId = await t.run(async (ctx) => {
    const fileStorageId = await ctx.storage.store(
      new Blob(["fake assessment pdf"], { type: "application/pdf" }),
    );
    const id = await ctx.db.insert("scholarDocuments", {
      scholarId,
      kind: "assessment",
      format: "file",
      title: "Confidential assessment",
      fileStorageId,
      fileMimeType: "application/pdf",
      fileSizeBytes: 19,
      extractedText: "Raw neuropsych text with sensitive scores",
      summary: "Teacher-only assessment summary",
      keyFindings: ["Teacher-only finding"],
      redactedSummary: "Scholar-safe summary",
      redactedKeyFindings: ["Scholar-safe finding"],
      uploadedBy: uploaderId,
      processingStatus: "ready",
      feedsTutor: false,
    });
    await ctx.db.insert("documentAccessLog", {
      documentId: id,
      scholarId,
      userId: uploaderId,
      action: "upload",
    });
    return id;
  });
  return { scholarId, documentId };
}

async function setupForDeniedRole(
  t: TestCtx,
  role: (typeof DENIED_ROLES)[number],
) {
  const uploaderId = await seedUser(t, "teacher", "uploader");
  const fixtures = await seedDocumentFixture(t, uploaderId);

  if (role === "scholar") {
    return { asUser: await withUser(t, fixtures.scholarId), fixtures };
  }

  const callerId = await seedUser(t, role, `caller-${role}`);
  if (role === "parent") {
    await t.run(async (ctx) => {
      await ctx.db.insert("guardianships", {
        parentUserId: callerId,
        scholarUserId: fixtures.scholarId,
        createdBy: uploaderId,
      });
    });
  }

  return { asUser: await withUser(t, callerId), fixtures };
}

async function setupForAllowedRole(
  t: TestCtx,
  role: (typeof ALLOWED_ROLES)[number],
) {
  const institutionId = await seedInstitution(t);
  const callerId = await seedUser(t, role, `caller-${role}`);
  await grantMembership(
    t,
    callerId,
    role,
    role === "platform_admin" ? undefined : institutionId,
  );
  return {
    asUser: await withUser(t, callerId),
    fixtures: await seedDocumentFixture(t, callerId, institutionId),
  };
}

type AsUser = Awaited<ReturnType<typeof withUser>>;

const READ_QUERIES: {
  name: string;
  run: (asUser: AsUser, fixtures: Fixtures) => Promise<unknown>;
  assertAllowedResult: (result: unknown, fixtures: Fixtures) => void;
}[] = [
  {
    name: "listForScholar",
    run: (asUser, { scholarId }) =>
      asUser.query(api.scholarDocuments.listForScholar, { scholarId }),
    assertAllowedResult: (result, { documentId }) => {
      expect(Array.isArray(result)).toBe(true);
      const rows = result as {
        _id: Id<"scholarDocuments">;
        hasFile: boolean;
        hasExtractedText: boolean;
      }[];
      const row = rows.find((r) => r._id === documentId);
      expect(row).toMatchObject({ hasFile: true, hasExtractedText: true });
    },
  },
  {
    name: "get",
    run: (asUser, { documentId }) =>
      asUser.query(api.scholarDocuments.get, { documentId }),
    assertAllowedResult: (result, { documentId }) => {
      expect(result).toMatchObject({
        _id: documentId,
        title: "Confidential assessment",
      });
      expect(result).not.toHaveProperty("extractedText");
    },
  },
  {
    name: "getExtractedText",
    run: (asUser, { documentId }) =>
      asUser.query(api.scholarDocuments.getExtractedText, { documentId }),
    assertAllowedResult: (result, { documentId, scholarId }) => {
      expect(result).toMatchObject({
        _id: documentId,
        scholarId,
        extractedText: "Raw neuropsych text with sensitive scores",
        processingStatus: "ready",
      });
    },
  },
  {
    name: "getDownloadUrl",
    run: (asUser, { documentId }) =>
      asUser.query(api.scholarDocuments.getDownloadUrl, { documentId }),
    assertAllowedResult: (result) => {
      expect(result).toEqual(expect.any(String));
    },
  },
  {
    name: "auditLogForDocument",
    run: (asUser, { documentId }) =>
      asUser.query(api.scholarDocuments.auditLogForDocument, { documentId }),
    assertAllowedResult: (result, { documentId, scholarId }) => {
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentId,
            scholarId,
            action: "upload",
          }),
        ]),
      );
    },
  },
];

describe("scholarDocuments direct read queries — teacher/admin-only role gate", () => {
  describe.each(READ_QUERIES)("$name", ({ run, assertAllowedResult }) => {
    test.each(DENIED_ROLES)("denies %s", async (role) => {
      const t = convexTest(schema, modules);
      const { asUser, fixtures } = await setupForDeniedRole(t, role);

      await expect(run(asUser, fixtures)).rejects.toThrow(DENIAL_ERROR);
    });

    test.each(ALLOWED_ROLES)("allows %s", async (role) => {
      const t = convexTest(schema, modules);
      const { asUser, fixtures } = await setupForAllowedRole(t, role);

      const result = await run(asUser, fixtures);
      assertAllowedResult(result, fixtures);
    });
  });
});

describe("scholarDocuments writes — the same gate, unchanged by health uploads", () => {
  // Staff health-document upload (see staffHealthDocumentUpload.test.ts) lets
  // operations staff (base `staff` + `health:manage` — the retired registrar
  // role's successor) file an immunization card. It must not have bought
  // them a way into THIS table: a cognitive assessment is a different
  // document with a different audience, and it lands in a pipeline that
  // eventually feeds the scholar-facing tutor.
  test.each(DENIED_ROLES)("denies %s registerUpload", async (role) => {
    const t = convexTest(schema, modules);
    const { asUser, fixtures } = await setupForDeniedRole(t, role);
    const fileStorageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob(["fake assessment pdf"], { type: "application/pdf" }),
      ),
    );

    await expect(
      asUser.mutation(api.scholarDocuments.registerUpload, {
        scholarId: fixtures.scholarId,
        kind: "assessment",
        title: "Smuggled assessment",
        fileStorageId,
        fileMimeType: "application/pdf",
      }),
    ).rejects.toThrow(DENIAL_ERROR);

    expect(
      await t.run((ctx) =>
        ctx.db
          .query("scholarDocuments")
          .filter((q) => q.eq(q.field("title"), "Smuggled assessment"))
          .collect(),
      ),
    ).toHaveLength(0);
  });

  test.each(DENIED_ROLES)("denies %s createTextReport", async (role) => {
    const t = convexTest(schema, modules);
    const { asUser, fixtures } = await setupForDeniedRole(t, role);

    await expect(
      asUser.mutation(api.scholarDocuments.createTextReport, {
        scholarId: fixtures.scholarId,
        title: "Smuggled report",
        bodyText: "Should never be written.",
      }),
    ).rejects.toThrow(DENIAL_ERROR);
  });
});

/**
 * The gate a diff can't show you.
 *
 * The named tests above cover the endpoints that exist today. The regression
 * that actually bites is the SIXTH one — someone adds a query next year,
 * forgets `requireTeacherOrAdmin`, and no existing test notices because no
 * existing test mentions it. So this block enumerates the module's real
 * exports and fails on anything it hasn't been told about, which forces the
 * author of that sixth function to come here and declare their intent.
 */
describe("every public scholarDocuments export refuses operations staff", () => {
  // The ONE public export a non-teacher scholar-admin may call: the merged
  // document list, which returns the health half only and never reads a
  // scholarDocuments row on their behalf. Adding to this list is a privacy
  // decision, which is exactly why it has to be made here in the open.
  const NON_TEACHER_CALLABLE = new Set([
    "listDocumentsForStaff",
    // Returns a bare storage upload URL (no scholar data); the kind and the
    // scholar are gated in `registerUpload`, which the loop below still
    // proves refuses a teacher-only kind.
    "generateUploadUrl",
  ]);

  type Invocation = {
    kind: "query" | "mutation";
    args: (f: Fixtures & { storageId: Id<"_storage"> }) => Record<string, unknown>;
  };

  const INVOCATIONS: Record<string, Invocation> = {
    generateUploadUrl: { kind: "mutation", args: () => ({}) },
    registerUpload: {
      kind: "mutation",
      args: (f) => ({
        scholarId: f.scholarId,
        kind: "assessment",
        title: "Should never be written",
        fileStorageId: f.storageId,
      }),
    },
    createTextReport: {
      kind: "mutation",
      args: (f) => ({
        scholarId: f.scholarId,
        title: "Should never be written",
        bodyText: "…",
      }),
    },
    updateTextReport: {
      kind: "mutation",
      args: (f) => ({ documentId: f.documentId, title: "Should never apply" }),
    },
    addGoogleDocLink: {
      kind: "mutation",
      args: (f) => ({
        scholarId: f.scholarId,
        title: "Should never be linked",
        link: { driveFileId: "drive-1", url: "https://example.test/doc" },
      }),
    },
    deleteDocument: {
      kind: "mutation",
      args: (f) => ({ documentId: f.documentId }),
    },
    listForScholar: { kind: "query", args: (f) => ({ scholarId: f.scholarId }) },
    get: { kind: "query", args: (f) => ({ documentId: f.documentId }) },
    getExtractedText: {
      kind: "query",
      args: (f) => ({ documentId: f.documentId }),
    },
    getDownloadUrl: {
      kind: "query",
      args: (f) => ({ documentId: f.documentId }),
    },
    auditLogForDocument: {
      kind: "query",
      args: (f) => ({ documentId: f.documentId }),
    },
    logSummaryView: {
      kind: "mutation",
      args: (f) => ({ documentId: f.documentId }),
    },
    logExtractedView: {
      kind: "mutation",
      args: (f) => ({ documentId: f.documentId }),
    },
    logDownload: {
      kind: "mutation",
      args: (f) => ({ documentId: f.documentId }),
    },
    listDocumentsForStaff: {
      kind: "query",
      args: (f) => ({ scholarId: f.scholarId }),
    },
  };

  function publicExportNames(): string[] {
    return Object.entries(
      scholarDocumentsModule as Record<string, { isPublic?: boolean }>,
    )
      .filter(([, fn]) => fn?.isPublic === true)
      .map(([name]) => name);
  }

  test("the invocation table covers every public export — no silent additions", () => {
    const exported = publicExportNames().sort();
    expect(exported.length).toBeGreaterThan(0);
    expect(Object.keys(INVOCATIONS).sort()).toEqual(exported);
  });

  test("operations staff cannot reach a scholarDocuments row through any of them", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const teacherId = await seedUser(t, "teacher", "gate-teacher", institutionId);
    await grantMembership(t, teacherId, "teacher", institutionId);
    const fixtures = await seedDocumentFixture(t, teacherId, institutionId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "application/pdf" })),
    );
    // Operations staff: base `staff` + `school:operations` + `health:manage`
    // grants (the retired registrar role's successor — registrar implied
    // both scholar-admin and health-record access).
    const opsStaffId = await seedUser(
      t,
      "staff",
      "gate-ops-staff",
      institutionId,
    );
    await grantMembership(t, opsStaffId, "staff", institutionId);
    await t.run(async (ctx) => {
      for (const capability of ["school:operations", "health:manage"] as const) {
        await ctx.db.insert("staffCapabilityGrants", {
          granteeUserId: opsStaffId,
          institutionId,
          capability,
          grantedBy: teacherId,
          grantedAt: Date.now(),
        });
      }
    });
    const opsStaff = await withUser(t, opsStaffId);
    const ctx = { ...fixtures, storageId };

    const reached: string[] = [];
    for (const name of publicExportNames()) {
      if (NON_TEACHER_CALLABLE.has(name)) continue;
      const invocation = INVOCATIONS[name];
      if (!invocation) {
        reached.push(`${name} (no invocation declared — add one above)`);
        continue;
      }
      const fn = (
        api.scholarDocuments as unknown as Record<
          string,
          FunctionReference<"query" | "mutation">
        >
      )[name];
      try {
        if (invocation.kind === "query") {
          await opsStaff.query(
            fn as FunctionReference<"query">,
            invocation.args(ctx),
          );
        } else {
          await opsStaff.mutation(
            fn as FunctionReference<"mutation">,
            invocation.args(ctx),
          );
        }
        reached.push(name);
      } catch (error) {
        // A gate rejection is the pass. An argument-validation error would be
        // a false pass, so insist the message is the role gate itself.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(DENIAL_ERROR)) {
          reached.push(`${name} (threw the wrong error: ${message})`);
        }
      }
    }
    expect(reached).toEqual([]);

    // Nothing above wrote a row either — a mutation that logs before gating
    // would still be a leak of a different shape.
    const rows = await t.run(async (ctx2) =>
      ctx2.db.query("scholarDocuments").collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("operations staff reach exactly the administrative kinds they may file", () => {
  // The registry's `capability: "operations"` rows (incident reports, transfer
  // records, conference notes, doctor's notes, report cards) are the front
  // office's own filings, so the same staffer may see, download and delete
  // them — and still never an assessment. Widening THIS set is the privacy
  // decision; it is made in lib/documentKinds.ts, and this test pins it.
  async function seedOpsWorld(t: TestCtx) {
    const institutionId = await seedInstitution(t);
    const teacherId = await seedUser(t, "teacher", "ops-teacher", institutionId);
    await grantMembership(t, teacherId, "teacher", institutionId);
    const fixtures = await seedDocumentFixture(t, teacherId, institutionId);
    const incidentId = await t.run(async (ctx) => {
      const fileStorageId = await ctx.storage.store(
        new Blob(["incident"], { type: "application/pdf" }),
      );
      return await ctx.db.insert("scholarDocuments", {
        scholarId: fixtures.scholarId,
        kind: "incident_report",
        format: "file",
        title: "Playground incident",
        fileStorageId,
        fileMimeType: "application/pdf",
        fileSizeBytes: 8,
        uploadedBy: teacherId,
        processingStatus: "ready",
        feedsTutor: false,
      });
    });
    const opsStaffId = await seedUser(t, "staff", "ops-only-staff", institutionId);
    await grantMembership(t, opsStaffId, "staff", institutionId);
    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: opsStaffId,
        institutionId,
        capability: "school:operations",
        grantedBy: teacherId,
        grantedAt: Date.now(),
      });
    });
    const opsStaff = await withUser(t, opsStaffId);
    return { ...fixtures, incidentId, opsStaff, opsStaffId };
  }

  test("the merged list shows the incident report and never the assessment", async () => {
    const t = convexTest(schema, modules);
    const w = await seedOpsWorld(t);
    const list = await w.opsStaff.query(api.scholarDocuments.listDocumentsForStaff, {
      scholarId: w.scholarId,
    });
    expect(list.canReadScholarDocuments).toBe(false);
    expect(list.documents.map((d) => d.kind)).toEqual(["incident_report"]);
  });

  test("per-document reads and the delete follow the same kind rule", async () => {
    const t = convexTest(schema, modules);
    const w = await seedOpsWorld(t);

    const incident = await w.opsStaff.query(api.scholarDocuments.get, {
      documentId: w.incidentId,
    });
    expect(incident?.kind).toBe("incident_report");
    expect(
      await w.opsStaff.query(api.scholarDocuments.getDownloadUrl, {
        documentId: w.incidentId,
      }),
    ).toBeTruthy();
    await w.opsStaff.mutation(api.scholarDocuments.logDownload, {
      documentId: w.incidentId,
    });

    for (const name of ["get", "getDownloadUrl", "getExtractedText", "auditLogForDocument"] as const) {
      await expect(
        w.opsStaff.query(api.scholarDocuments[name], { documentId: w.documentId }),
      ).rejects.toThrow(DENIAL_ERROR);
    }
    await expect(
      w.opsStaff.mutation(api.scholarDocuments.deleteDocument, {
        documentId: w.documentId,
      }),
    ).rejects.toThrow(DENIAL_ERROR);
    // The raw text and the audit trail stay teacher-only even for their own kinds.
    await expect(
      w.opsStaff.query(api.scholarDocuments.getExtractedText, {
        documentId: w.incidentId,
      }),
    ).rejects.toThrow(DENIAL_ERROR);

    await w.opsStaff.mutation(api.scholarDocuments.deleteDocument, {
      documentId: w.incidentId,
    });
    const kinds = await t.run(async (ctx) =>
      (await ctx.db.query("scholarDocuments").collect()).map((r) => r.kind),
    );
    expect(kinds).toEqual(["assessment"]);
  });

  test("uploads from the profile obey the registry too", async () => {
    const t = convexTest(schema, modules);
    const w = await seedOpsWorld(t);
    // The profile upload's first step must work for them too.
    expect(
      await w.opsStaff.mutation(api.scholarDocuments.generateUploadUrl, {}),
    ).toMatch(/^https?:\/\//);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["note"], { type: "application/pdf" })),
    );
    await expect(
      w.opsStaff.mutation(api.scholarDocuments.registerUpload, {
        scholarId: w.scholarId,
        kind: "assessment",
        title: "Never",
        fileStorageId: storageId,
      }),
    ).rejects.toThrow(DENIAL_ERROR);
    const { documentId } = await w.opsStaff.mutation(
      api.scholarDocuments.registerUpload,
      {
        scholarId: w.scholarId,
        kind: "doctor_note",
        title: "Excuse note",
        fileStorageId: storageId,
      },
    );
    const row = await t.run((ctx) => ctx.db.get(documentId));
    expect(row).toMatchObject({
      kind: "doctor_note",
      uploadedBy: w.opsStaffId,
      processingStatus: "ready",
      feedsTutor: false,
    });
  });
});
