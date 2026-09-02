import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { makeScholarWriteTools, type AttachedFile } from "../scholarWriteTools";
import { ROLES } from "../roles";

/**
 * Unit tests for the scholar-write tool LAYER (lib/scholarWriteTools.ts) — the
 * attachment-resolution + arg-mapping logic that's unique to the tools (the
 * underlying writes are covered against a real DB in
 * __tests__/teacherAideWrites.test.ts). We stub ctx.runQuery (the roster
 * resolver) and ctx.runMutation (records the call) so we can assert exactly
 * what each tool forwards.
 */

// listScholarsInternal's shape: { scholars, extendedEducationOmitted }.
const ROSTER = {
  scholars: [{ id: "scholar1" as Id<"users">, name: "Kai Nakamura" }],
  extendedEducationOmitted: 0,
};

type MutCall = { fnName: string; args: Record<string, unknown> };
type AnyTool = { name: string; run: (i: unknown) => Promise<string> };

function makeCtx(
  currentPeriod: { _id: string; label: string } | null = {
    _id: "period1",
    label: "Writing",
  },
) {
  const calls: MutCall[] = [];
  const ctx = {
    runQuery: vi.fn(async (fn: unknown, _args?: unknown) =>
      getFunctionName(fn as Parameters<typeof getFunctionName>[0]).includes(
        "reportingPeriods:currentInternal",
      )
        ? currentPeriod
        : ROSTER,
    ),
    runMutation: vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
      calls.push({ fnName: getFunctionName(fn as Parameters<typeof getFunctionName>[0]), args });
      return {
        ok: true,
        documentId: "doc1",
        observationId: "obs1",
        reportId: "rep1",
        itemId: "item1",
        url: "https://app.example.invalid/enroll?token=test-token",
        username: "kai",
        removed: 1,
        deleted: true,
        name: "Kai Nakamura",
        mode: "append",
        readingLevel: args.readingLevel ?? null,
      };
    }),
  } as unknown as ActionCtx;
  return { ctx, calls };
}

const emit = () => {};

// `.find()` over the betaTool array widens each tool's run() input to the
// intersection of every tool's schema; this picks one and types its run
// loosely so a test can pass that one tool's actual args.
function pick(tools: { name: string; run: unknown }[], name: string): AnyTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not built: ${name}`);
  return { name, run: t.run as (i: unknown) => Promise<string> };
}

async function build(opts: Parameters<typeof makeScholarWriteTools>[2], ctx: ActionCtx) {
  return (await makeScholarWriteTools(ctx, emit, opts)) as { name: string; run: unknown }[];
}

const ATTACH: AttachedFile = {
  storageId: "s_pdf" as Id<"_storage">,
  fileName: "iq-report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1234,
};

const TEACHER_PRIVATE = {
  role: ROLES.TEACHER,
  callerUserId: "u_t" as Id<"users">,
  surface: "private" as const,
};

describe("makeScholarWriteTools — tool layer", () => {
  test("upload_scholar_document forwards the attached file's storageId + mime", async () => {
    const { ctx, calls } = makeCtx();
    const tools = await build({ ...TEACHER_PRIVATE, attachedFiles: [ATTACH] }, ctx);
    const out = await pick(tools, "upload_scholar_document").run({
      scholarName: "Kai",
      kind: "assessment",
    });
    expect(out).toMatch(/attached to Kai Nakamura/i);
    const docCall = calls.find((c) => c.fnName.includes("aideRegisterFromSlack"));
    expect(docCall?.args.storageId).toBe("s_pdf");
    expect(docCall?.args.fileMimeType).toBe("application/pdf");
    expect(docCall?.args.kind).toBe("assessment");
    expect(docCall?.args.title).toBe("iq-report.pdf");
  });

  test("upload_scholar_document with NO attachment returns the 'attach a file' message and does not write", async () => {
    const { ctx, calls } = makeCtx();
    const tools = await build({ ...TEACHER_PRIVATE, attachedFiles: [] }, ctx);
    const out = await pick(tools, "upload_scholar_document").run({
      scholarName: "Kai",
      kind: "assessment",
    });
    expect(out).toMatch(/No file is attached/i);
    expect(calls.find((c) => c.fnName.includes("aideRegisterFromSlack"))).toBeUndefined();
  });

  test("upload_scholar_document honors an explicit storageRef (the Slack DM path)", async () => {
    const { ctx, calls } = makeCtx();
    const tools = await build({ ...TEACHER_PRIVATE, attachedFiles: [] }, ctx);
    await pick(tools, "upload_scholar_document").run({
      scholarName: "Kai",
      kind: "iep",
      storageRef: "s_from_slack",
      title: "IEP 2026",
    });
    const docCall = calls.find((c) => c.fnName.includes("aideRegisterFromSlack"));
    expect(docCall?.args.storageId).toBe("s_from_slack");
    expect(docCall?.args.title).toBe("IEP 2026");
  });

  test("add_portfolio_item forwards the attached file", async () => {
    const { ctx, calls } = makeCtx();
    const tools = await build(
      { ...TEACHER_PRIVATE, attachedFiles: [{ ...ATTACH, fileName: "sketch.png", mimeType: "image/png" }] },
      ctx,
    );
    await pick(tools, "add_portfolio_item").run({ scholarName: "Kai" });
    const call = calls.find((c) => c.fnName.includes("addPortfolioItem"));
    expect(call?.args.fileStorageId).toBe("s_pdf");
    expect(call?.args.title).toBe("sketch.png");
  });

  test("set_scholar_reading_level maps 'none' to null", async () => {
    const { ctx, calls } = makeCtx();
    const tools = await build(TEACHER_PRIVATE, ctx);
    const out = await pick(tools, "set_scholar_reading_level").run({
      scholarName: "Kai",
      readingLevel: "none",
    });
    expect(out).toMatch(/cleared/i);
    const call = calls.find((c) => c.fnName.includes("setScholarReadingLevel"));
    expect(call?.args.readingLevel).toBeNull();
  });

  test("an unresolved scholar name never writes", async () => {
    const { ctx, calls } = makeCtx();
    const tools = await build(TEACHER_PRIVATE, ctx);
    const out = await pick(tools, "add_scholar_observation").run({
      scholarName: "Nobody",
      type: "praise",
      note: "x",
    });
    expect(out).toMatch(/No scholar found/i);
    expect(calls.length).toBe(0);
  });

  test("add_scholar_observation covers neutral Whole Child inputs without a second tool", async () => {
    const { ctx, calls } = makeCtx();
    const tools = await build(TEACHER_PRIVATE, ctx);
    expect(tools.map((tool) => tool.name)).not.toContain("add_whole_child_input");

    const out = await pick(tools, "add_scholar_observation").run({
      scholarName: "Kai",
      type: "note",
      category: "collaboration",
      note: "Made room for a peer's idea before adding his own.",
    });

    expect(out).toMatch(/Whole Child/i);
    const call = calls.find((candidate) =>
      candidate.fnName.includes("addScholarObservation"),
    );
    expect(call?.args).toMatchObject({
      scholarId: "scholar1",
      type: "note",
      category: "collaboration",
      periodId: "period1",
      note: "Made room for a peer's idea before adding his own.",
    });
  });

  test("category observation still writes when there is no current period", async () => {
    const { ctx, calls } = makeCtx(null);
    const tools = await build(TEACHER_PRIVATE, ctx);

    await pick(tools, "add_scholar_observation").run({
      scholarName: "Kai",
      type: "note",
      category: "passions",
      note: "Stayed with the telescope question after class.",
    });

    const call = calls.find((candidate) =>
      candidate.fnName.includes("addScholarObservation"),
    );
    expect(call?.args.category).toBe("passions");
    expect(call?.args.periodId).toBeUndefined();
  });

  test("surface + role gating: channel withholds credential/destructive/upload; operations staff (the retired registrar role's successor) gets account-only", async () => {
    const { ctx } = makeCtx();
    const names = async (
      role: Parameters<typeof makeScholarWriteTools>[2]["role"],
      surface: "private" | "channel",
      opts?: { hasSchoolOperationsAccess?: boolean },
    ) =>
      (
        await makeScholarWriteTools(ctx, emit, {
          role,
          callerUserId: "u" as Id<"users">,
          surface,
          hasSchoolOperationsAccess: opts?.hasSchoolOperationsAccess,
        })
      ).map((t) => t.name);

    const teacherPrivate = await names(ROLES.TEACHER, "private");
    expect(teacherPrivate).toContain("reset_scholar_password");
    expect(teacherPrivate).toContain("upload_scholar_document");
    expect(teacherPrivate).not.toContain("delete_scholar");

    const teacherChannel = await names(ROLES.TEACHER, "channel");
    expect(teacherChannel).toContain("add_scholar_observation");
    expect(teacherChannel).not.toContain("add_whole_child_input");
    expect(teacherChannel).not.toContain("reset_scholar_password");
    expect(teacherChannel).not.toContain("upload_scholar_document");

    const adminPrivate = await names(ROLES.PLATFORM_ADMIN, "private");
    expect(adminPrivate).toContain("delete_scholar");

    const registrar = await names(ROLES.STAFF, "private", {
      hasSchoolOperationsAccess: true,
    });
    expect(registrar).toContain("update_scholar_profile");
    expect(registrar).toContain("reset_scholar_password");
    expect(registrar).not.toContain("add_scholar_observation");
    expect(registrar).not.toContain("upload_scholar_document");
    expect(registrar).not.toContain("delete_scholar");

    const designer = await names(ROLES.CURRICULUM_DESIGNER, "private");
    expect(designer).toHaveLength(0);
  });
});
