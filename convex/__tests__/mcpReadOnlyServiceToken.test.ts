import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../lib/oauthCrypto";
import { isReadOnlyToolName } from "../lib/scholarReadPolicy";
import { READ_ONLY_ACCOUNT_ERROR } from "../lib/auth";
import { WITHHELD_CUSTOM_APP_TOKEN } from "../lib/readOnlyRedaction";
import { makeSession } from "./factories/world";
import { CUSTOM_APP_URL_PREFIX, customAppPath } from "../../shared/appKind";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

// Why this file: an `rhsa_` service token used to be read-only only when it
// was pointed at /api/mcp/read. The same token worked on the full /api/mcp,
// and its Convex Auth JWT reached every public mutation as the service user.
// A token issued read-only (mcpServiceTokens.readOnly, the default) now signs
// in as a read-only service user (users.readOnly), so it is refused writes on
// BOTH MCP URLs and through its JWT, while it can still read; a full token
// keeps working as before. The harness drives the real Next route handlers
// against convex-test (the same one the /api/mcp/read test uses).

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

const harness = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://read-only-token-test.convex.cloud";
  return {
    t: null as unknown as T,
    calls: [] as { kind: "query" | "mutation" | "action"; name: string }[],
  };
});

// ConvexHttpClient stand-in: runs each call against the test backend as the
// identity the route set. Convex Auth's signIn needs JWT signing keys, so the
// exchange redeems through the same internal mutation the mcpServiceToken
// provider calls and returns `userId|sessionId` — the subject a real JWT has.
vi.mock("convex/browser", () => {
  class FakeConvexHttpClient {
    private subject: string | null = null;
    constructor(_url: string) {}
    setAuth(jwt: string) {
      this.subject = jwt;
    }
    private as() {
      return this.subject
        ? harness.t.withIdentity({ subject: this.subject, issuer: "https://convex.dev" })
        : harness.t;
    }
    async query(ref: any, args: any) {
      harness.calls.push({ kind: "query", name: getFunctionName(ref) });
      return this.as().query(ref, args);
    }
    async mutation(ref: any, args: any) {
      harness.calls.push({ kind: "mutation", name: getFunctionName(ref) });
      return this.as().mutation(ref, args);
    }
    async action(ref: any, args: any) {
      const name = getFunctionName(ref);
      harness.calls.push({ kind: "action", name });
      if (name === "auth:signIn") {
        const grant = await harness.t.mutation(internal.mcpServiceAccounts.redeemToken, {
          tokenHash: await sha256Hex(args.params.token),
        });
        return grant ? { tokens: { token: `${grant.userId}|${grant.sessionId}`, refreshToken: "r" } } : {};
      }
      return this.as().action(ref, args);
    }
  }
  return { ConvexHttpClient: FakeConvexHttpClient };
});

// The link-preview fetch resolves DNS and pins the connection, so it is the
// module, not global fetch, that a test must intercept.
vi.mock("../lib/messageLinkPreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/messageLinkPreview")>();
  return {
    ...actual,
    fetchMessageLinkPreview: vi.fn(async (url: string) => ({
      url,
      hostname: "example.com",
      title: "Tide notes",
      description: null,
    })),
  };
});
const { fetchMessageLinkPreview } = await import("../lib/messageLinkPreview");
const previewFetch = vi.mocked(fetchMessageLinkPreview);

const { POST: readPost } = await import("../../app/api/mcp/read/route");
const { POST: fullPost } = await import("../../app/api/mcp/route");

// ── Fixture ──────────────────────────────────────────────────────────

type Kind = "teacher" | "staff";

async function seed(t: T) {
  const institutionId = await seedTestInstitution(t, { slug: "moli", name: "Moli School", isPrimary: true });
  const admin = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Avery Stone", username: "avery", role: "school_admin", institutionId }),
  );
  await grantInstitutionMembership(t, admin, institutionId, "school_admin");
  const scholarId = await seedScholarInInstitution(t, { institutionId, name: "Hoku Makani", username: "hoku" });
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId: admin, expirationTime: Date.now() + 60 * 60 * 1000 }),
  );
  const asAdmin = t.withIdentity({ subject: `${admin}|${sessionId}`, issuer: "https://convex.dev" });
  const issue = (kind: Kind, readOnly?: boolean) =>
    asAdmin.mutation(api.mcpServiceAccounts.issueToken, {
      kind,
      ...(readOnly === undefined ? {} : { readOnly }),
    });
  return { institutionId, scholarId, asAdmin, issue };
}

/** The JWT subject a token's exchange yields — what anyone holding it gets. */
async function jwtFor(t: T, token: string) {
  const grant = await t.mutation(internal.mcpServiceAccounts.redeemToken, {
    tokenHash: await sha256Hex(token),
  });
  expect(grant).not.toBeNull();
  return {
    userId: grant!.userId,
    as: t.withIdentity({ subject: `${grant!.userId}|${grant!.sessionId}`, issuer: "https://convex.dev" }),
  };
}

// ── MCP over HTTP ────────────────────────────────────────────────────

let rpcId = 0;
type Post = (r: Request) => Promise<Response>;

async function rpc(post: Post, path: string, token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await post(
    new Request(`https://rabbithole.test${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
  expect(res.status, `${method} on ${path} answered ${res.status}`).toBe(200);
  const body = await res.text();
  const data = body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length))
    .join("");
  return JSON.parse(data || body) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

const ENDPOINTS = [
  { label: "/api/mcp", post: fullPost as Post, path: "/api/mcp" },
  { label: "/api/mcp/read", post: readPost as Post, path: "/api/mcp/read" },
];

async function toolNames(post: Post, path: string, token: string): Promise<string[]> {
  const res = await rpc(post, path, token, "tools/list");
  expect(res.error).toBeUndefined();
  return (res.result!.tools as { name: string }[]).map((t) => t.name);
}

function resultText(res: { result?: Record<string, unknown> }): string {
  return ((res.result?.content ?? []) as { text: string }[]).map((c) => c.text).join("");
}

async function snapshotDb(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables).sort()) {
      out[table] = await ctx.db.query(table as any).collect();
    }
    return JSON.stringify(out);
  });
}

const NAMED_WRITES = [
  "set_attendance",
  "update_scholar_profile",
  "give",
  "create_scholar_account",
  "delete_scholar",
  "reset_scholar_password",
  "restart_managed_device",
  "add_scholar_observation",
  "update_scholar_dossier",
  "get_mentava_progress", // named like a read, but saves the level it fetches
  "unit_update_unit",
  "unit_give",
];

beforeEach(() => {
  harness.t = convexTest(schema, modules);
  harness.calls = [];
  vi.stubEnv("INTROSPECTION_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Issuing ──────────────────────────────────────────────────────────

describe("issuing", () => {
  test("a token is read-only by default and signs in as a separate read-only service user", async () => {
    const { issue, asAdmin } = await seed(harness.t);
    const ro = await issue("teacher");
    const full = await issue("teacher", false);
    expect(ro.readOnly).toBe(true);
    expect(full.readOnly).toBe(false);

    const roUser = await harness.t.run(async (ctx) => ctx.db.get((await jwtFor(harness.t, ro.token)).userId));
    const fullUser = await harness.t.run(async (ctx) => ctx.db.get((await jwtFor(harness.t, full.token)).userId));
    expect(roUser!._id).not.toBe(fullUser!._id);
    expect(roUser!.readOnly).toBe(true);
    expect(roUser!.isSystem).toBe(true);
    expect(roUser!.role).toBe("teacher");
    expect(fullUser!.readOnly).not.toBe(true);

    // A second read-only token reuses the read-only user.
    const ro2 = await issue("teacher", true);
    expect((await jwtFor(harness.t, ro2.token)).userId).toBe(roUser!._id);

    const rows = await asAdmin.query(api.mcpServiceAccounts.list, {});
    const teacher = rows.find((r) => r.kind === "teacher")!;
    expect(teacher.activeTokens.map((t) => t.readOnly).sort()).toEqual([false, true, true]);
  });

  test("a token whose service user's read-only flag drifted is refused at exchange", async () => {
    const { issue } = await seed(harness.t);
    const ro = await issue("staff");
    const { userId } = await jwtFor(harness.t, ro.token);
    await harness.t.run((ctx) => ctx.db.patch(userId, { readOnly: undefined }));
    expect(
      await harness.t.mutation(internal.mcpServiceAccounts.redeemToken, { tokenHash: await sha256Hex(ro.token) }),
    ).toBeNull();
    // Re-issuing reconciles the flag back.
    await issue("staff", true);
    expect((await harness.t.run((ctx) => ctx.db.get(userId)))!.readOnly).toBe(true);
  });

  test("a token row from before the flag existed stays a full token", async () => {
    const { issue } = await seed(harness.t);
    const full = await issue("teacher", false);
    // Strip the flag, as on a row issued before it existed.
    await harness.t.run(async (ctx) => {
      for (const r of await ctx.db.query("mcpServiceTokens").collect()) {
        await ctx.db.patch(r._id, { readOnly: undefined });
      }
    });
    const { userId } = await jwtFor(harness.t, full.token);
    expect((await harness.t.run((ctx) => ctx.db.get(userId)))!.readOnly).not.toBe(true);
  });
});

// ── A read-only token on both MCP URLs ───────────────────────────────

describe.each(["teacher", "staff"] as const)("a read-only %s token", (kind) => {
  describe.each(ENDPOINTS)("on $label", ({ post, path }) => {
    test("lists only read tools and refuses every write by name, changing no row", async () => {
      const { issue } = await seed(harness.t);
      const fullToken = (await issue(kind, false)).token;
      const roToken = (await issue(kind)).token;

      const fullNames = await toolNames(fullPost, "/api/mcp", fullToken);
      const names = await toolNames(post, path, roToken);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(isReadOnlyToolName(name), `${name} is listed for a read-only token`).toBe(true);
      }

      const writes = [...new Set([...fullNames.filter((n) => !isReadOnlyToolName(n)), ...NAMED_WRITES])];
      // The fixture is meaningful: a full token of this kind is offered writes.
      expect(fullNames.filter((n) => !isReadOnlyToolName(n)).length).toBeGreaterThan(0);

      await rpc(post, path, roToken, "tools/list"); // warm the exchange (stamps lastUsedAt)
      const before = await snapshotDb(harness.t);
      for (const name of writes) {
        harness.calls = [];
        const res = await rpc(post, path, roToken, "tools/call", {
          name,
          arguments: { scholarName: "Hoku", unitId: "x", status: "absent", date: "2026-11-10" },
        });
        expect(res.result, `${name} returned a result for a read-only token on ${path}`).toBeUndefined();
        expect(res.error?.message).toContain("read-only Rabbithole connection");
        for (const call of harness.calls) {
          expect(call.kind, `${name} invoked ${call.name}`).not.toBe("mutation");
          expect(call.name, `${name} reached ${call.name}`).not.toMatch(/^mcp:call/);
        }
      }
      expect(await snapshotDb(harness.t)).toBe(before);
    });

    test("still reads", async () => {
      const { issue } = await seed(harness.t);
      const res = await rpc(post, path, (await issue(kind)).token, "tools/call", {
        name: "list_scholars",
        arguments: {},
      });
      expect(res.error).toBeUndefined();
      expect(resultText(res)).toContain("Hoku Makani");
    });
  });
});

test("a read-only teacher token can run a curriculum read through the proxy", async () => {
  const { issue } = await seed(harness.t);
  const token = (await issue("teacher")).token;
  const names = await toolNames(fullPost, "/api/mcp", token);
  expect(names).toContain("list_assignments");
  const res = await rpc(fullPost, "/api/mcp", token, "tools/call", { name: "list_assignments", arguments: {} });
  expect(res.error).toBeUndefined();
  expect(res.result?.isError).not.toBe(true);
});

// ── The JWT a read-only token mints ──────────────────────────────────

describe("the JWT minted from a read-only token", () => {
  const directive = (scholarId: Id<"users">) => ({
    scholarId,
    label: "focus",
    content: "Ask about fractions",
  });

  test("cannot run a public mutation; a full token's JWT can", async () => {
    const { issue, scholarId } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("teacher")).token);
    const full = await jwtFor(harness.t, (await issue("teacher", false)).token);

    const before = await snapshotDb(harness.t);
    await expect(ro.as.mutation(api.teacherDirectives.upsertByTeacher, directive(scholarId))).rejects.toThrow(
      READ_ONLY_ACCOUNT_ERROR,
    );
    expect(await snapshotDb(harness.t)).toBe(before);

    await full.as.mutation(api.teacherDirectives.upsertByTeacher, directive(scholarId));
    const rows = await harness.t.run((ctx) => ctx.db.query("teacherDirectives").collect());
    expect(rows).toHaveLength(1);
  });

  test("cannot call a curriculum write through the MCP proxy action directly", async () => {
    const { issue } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("teacher")).token);
    await expect(
      ro.as.action(api.mcp.callCurriculumTool, {
        name: "set_attendance",
        input: { scholarName: "Hoku", status: "absent", date: "2026-11-10" },
      }),
    ).rejects.toThrow(READ_ONLY_ACCOUNT_ERROR);
  });

  test("cannot edit a unit it could otherwise edit through the unit-designer proxy; a full token can", async () => {
    const { issue, institutionId } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("teacher")).token);
    const full = await jwtFor(harness.t, (await issue("teacher", false)).token);
    const unitId = await harness.t.run((ctx) =>
      ctx.db.insert("units", { teacherId: full.userId, institutionId, title: "Tide Pools", isActive: true }),
    );
    const call = { name: "unit_update_unit", unitId, input: { subject: "Marine science" } };
    const subject = async () => (await harness.t.run((ctx) => ctx.db.get(unitId)))?.subject;

    await expect(ro.as.action(api.mcp.callUnitDesignerTool, call)).rejects.toThrow(READ_ONLY_ACCOUNT_ERROR);
    expect(await subject()).toBeUndefined();

    await full.as.action(api.mcp.callUnitDesignerTool, call);
    expect(await subject()).toBe("Marine science");
  });

  test("still reads", async () => {
    const { issue } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("teacher")).token);
    const me = await ro.as.query(api.mcp.whoami, { probeSession: true });
    expect(me.readOnly).toBe(true);
    expect(me.role).toBe("teacher");
  });
});

// ── A full token keeps working ───────────────────────────────────────

test("a full staff token still writes on /api/mcp and is refused on /api/mcp/read", async () => {
  const { issue, scholarId } = await seed(harness.t);
  const token = (await issue("staff", false)).token;
  const dob = async () => (await harness.t.run((ctx) => ctx.db.get(scholarId)))?.dateOfBirth;
  const call = { name: "update_scholar_profile", arguments: { scholarName: "Hoku", dateOfBirth: "2017-03-04" } };

  const refused = await rpc(readPost, "/api/mcp/read", token, "tools/call", call);
  expect(refused.error?.message).toContain("read-only Rabbithole connection");
  expect(await dob()).toBeUndefined();

  const written = await rpc(fullPost, "/api/mcp", token, "tools/call", call);
  expect(written.error).toBeUndefined();
  expect(await dob()).toBe("2017-03-04");

  const me = await (await jwtFor(harness.t, token)).as.query(api.mcp.whoami, {});
  expect(me.readOnly).toBe(false);
});

test("the same staff write is refused for a read-only token on /api/mcp", async () => {
  const { issue, scholarId } = await seed(harness.t);
  const token = (await issue("staff")).token;
  const res = await rpc(fullPost, "/api/mcp", token, "tools/call", {
    name: "update_scholar_profile",
    arguments: { scholarName: "Hoku", dateOfBirth: "2017-03-04" },
  });
  expect(res.error?.message).toContain("Its token can only read");
  expect((await harness.t.run((ctx) => ctx.db.get(scholarId)))?.dateOfBirth).toBeUndefined();
});

// ── A write credential inside a readable row (custom-app bearer tokens) ──
// A static custom app launches at /custom-apps?token=<token>, and that token
// alone authorizes appStates.updateCustomAppState, even with no session. A
// read-only identity can read the app catalog, so the token must be withheld
// from it on every read path, and it must not be able to use one it got
// elsewhere while signed in.

const APP_TOKEN = "c0ffee1234567890abcdef1234567890abcdef12345678";

async function seedCustomApp(t: T, createdBy: Id<"users">) {
  return await t.run(async (ctx) => {
    const externalAppId = await ctx.db.insert("externalApps", {
      name: "Tide Chart",
      webUrl: customAppPath(APP_TOKEN),
      createdBy,
    });
    await ctx.db.insert("customApps", {
      token: APP_TOKEN,
      name: "Tide Chart",
      kind: "static",
      status: "live",
      html: "<!doctype html><p>tides</p>",
      externalAppId,
      installScholarIds: [],
      installGroupIds: [],
      createdBy,
      updatedAt: Date.now(),
    });
    return externalAppId;
  });
}

describe("custom-app bearer tokens", () => {
  test("the catalog withholds the token from a read-only token's JWT; a full token still sees it", async () => {
    const { issue } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("staff")).token);
    const full = await jwtFor(harness.t, (await issue("staff", false)).token);
    await seedCustomApp(harness.t, full.userId);

    const roRow = (await ro.as.query(api.externalApps.listCatalog, {})).find((a) => a.name === "Tide Chart")!;
    expect(roRow.webUrl).toBe(customAppPath(WITHHELD_CUSTOM_APP_TOKEN));
    expect(JSON.stringify(roRow)).not.toContain(APP_TOKEN);

    const fullRow = (await full.as.query(api.externalApps.listCatalog, {})).find((a) => a.name === "Tide Chart")!;
    expect(fullRow.webUrl).toBe(customAppPath(APP_TOKEN));
  });

  test("the whole chain: read-only token → catalog → no usable token, so no app-state write", async () => {
    const { issue, scholarId } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("staff")).token);
    await seedCustomApp(harness.t, ro.userId);

    const row = (await ro.as.query(api.externalApps.listCatalog, {})).find((a) => a.name === "Tide Chart")!;
    const leaked = row.webUrl.slice(CUSTOM_APP_URL_PREFIX.length);
    const write = { userId: String(scholarId), key: "progress", patch: { level: 9 } };

    // What it was handed does not authorize anything, signed in or not.
    await expect(ro.as.mutation(api.appStates.updateCustomAppState, { token: leaked, ...write })).rejects.toThrow();
    await expect(harness.t.mutation(api.appStates.updateCustomAppState, { token: leaked, ...write })).rejects.toThrow();
    // And the real token is refused while signed in as the read-only identity.
    await expect(
      ro.as.mutation(api.appStates.updateCustomAppState, { token: APP_TOKEN, ...write }),
    ).rejects.toThrow(READ_ONLY_ACCOUNT_ERROR);
    expect(await harness.t.run((ctx) => ctx.db.query("appStates").collect())).toHaveLength(0);

    // The app's own runtime path (the token, no session) is unchanged.
    await harness.t.mutation(api.appStates.updateCustomAppState, { token: APP_TOKEN, ...write });
    expect(await harness.t.run((ctx) => ctx.db.query("appStates").collect())).toHaveLength(1);
  });

  test("an MCP read tool's text withholds the token for a read-only token on /api/mcp", async () => {
    const { issue } = await seed(harness.t);
    const roToken = (await issue("staff")).token;
    const fullToken = (await issue("staff", false)).token;
    await seedCustomApp(harness.t, (await jwtFor(harness.t, fullToken)).userId);
    const call = { name: "list_external_apps", arguments: {} };

    const full = await rpc(fullPost, "/api/mcp", fullToken, "tools/call", call);
    expect(full.error).toBeUndefined();
    expect(resultText(full)).toContain(APP_TOKEN); // the control: the tool really prints it

    const ro = await rpc(fullPost, "/api/mcp", roToken, "tools/call", call);
    expect(ro.error).toBeUndefined();
    expect(resultText(ro)).toContain("Tide Chart");
    expect(resultText(ro)).not.toContain(APP_TOKEN);
  });
});

// ── SimpleMDM refreshes write snapshot/inventory rows ────────────────

describe("SimpleMDM refresh actions", () => {
  test("a read-only staff token's JWT is refused before any vendor call or write", async () => {
    vi.stubEnv("SIMPLEMDM_API_KEY", "test-key");
    const fetchSpy = vi.fn(async () => {
      throw new Error("network is stubbed");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { issue, institutionId, scholarId } = await seed(harness.t);
      const ro = await jwtFor(harness.t, (await issue("staff")).token);
      const pairedDeviceId = await harness.t.run((ctx) =>
        ctx.db.insert("pairedDevices", {
          institutionId,
          deviceId: "device-tide-1",
          scholarId,
          pairedAt: Date.now(),
          pairedBy: ro.userId,
        }),
      );
      const before = await snapshotDb(harness.t);

      await expect(ro.as.action(api.simplemdm.verifySimpleMdmClaims, {})).rejects.toThrow(READ_ONLY_ACCOUNT_ERROR);
      await expect(ro.as.action(api.simplemdm.lostModeStatus, { pairedDeviceId })).rejects.toThrow(
        READ_ONLY_ACCOUNT_ERROR,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await snapshotDb(harness.t)).toBe(before);

      // Control: a full staff token gets past the guard to the vendor.
      const full = await jwtFor(harness.t, (await issue("staff", false)).token);
      await full.as.action(api.simplemdm.verifySimpleMdmClaims, {}).catch(() => undefined);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── Actions that write as a side effect of a read ────────────────────

describe("slides export", () => {
  test("a read-only token's JWT cannot store an export; a full token gets past the guard", async () => {
    const { issue, scholarId } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("teacher")).token);
    const full = await jwtFor(harness.t, (await issue("teacher", false)).token);
    const sessionId = await makeSession(harness.t, scholarId);
    // A non-slides artifact: the full-token control stops at the type check,
    // AFTER the read-only guard and the access gate, without rendering.
    const artifactId = await harness.t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Tide notes",
        content: "<p>notes</p>",
        lastEditedBy: "scholar",
        type: "text",
      }),
    );
    const files = () => harness.t.run((ctx) => ctx.db.system.query("_storage").collect());

    const fn = api.slidesExport.exportDeckFile;
    await expect(ro.as.action(fn, { artifactId, format: "pdf" })).rejects.toThrow(READ_ONLY_ACCOUNT_ERROR);
    await expect(full.as.action(fn, { artifactId, format: "pdf" })).rejects.toThrow(/not a slides deck/);
    expect(await files()).toHaveLength(0);
  });
});

describe("message link previews", () => {
  async function seedThreadMessage(fullTeacherAs: Awaited<ReturnType<typeof jwtFor>>["as"], scholarId: Id<"users">) {
    const parentId = await harness.t.run((ctx) =>
      ctx.db.insert("users", { name: "Lehua Torres", username: "lehua", role: "parent" }),
    );
    await harness.t.run((ctx) =>
      ctx.db.insert("guardianships", { parentUserId: parentId, scholarUserId: scholarId, createdBy: parentId }),
    );
    const sent = await fullTeacherAs.mutation(api.parentMessages.sendMessage, {
      scholarId,
      body: "Read https://example.com/tide-notes.",
    });
    const messages = await harness.t.run((ctx) => ctx.db.query("parentMessages").collect());
    const message = messages.find((m) => m.threadId === sent.threadIds[0])!;
    return message._id as Id<"parentMessages">;
  }

  test("a read-only token's JWT gets only a cached preview and never fetches or writes", async () => {
    previewFetch.mockClear();
    const fetchSpy = previewFetch;
    const { issue, scholarId } = await seed(harness.t);
    const ro = await jwtFor(harness.t, (await issue("teacher")).token);
    const full = await jwtFor(harness.t, (await issue("teacher", false)).token);
    const messageId = await seedThreadMessage(full.as, scholarId);
    const args = { messageId, url: "https://example.com/tide-notes" };
    const cacheRows = () => harness.t.run((ctx) => ctx.db.query("messageLinkPreviewCache").collect());

    // Uncached: nothing, and nothing written or fetched.
    const before = await snapshotDb(harness.t);
    expect(await ro.as.action(api.messageLinkPreviews.previewForMessage, args)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshotDb(harness.t)).toBe(before);

    // Cached: the read-only identity sees it, still without writing.
    await harness.t.run((ctx) =>
      ctx.db.insert("messageLinkPreviewCache", {
        url: args.url,
        state: "ready",
        hostname: "example.com",
        title: "Tide notes",
        expiresAt: Date.now() + 60_000,
      } as any),
    );
    const cachedSnapshot = await snapshotDb(harness.t);
    expect(await ro.as.action(api.messageLinkPreviews.previewForMessage, args)).toMatchObject({
      title: "Tide notes",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshotDb(harness.t)).toBe(cachedSnapshot);

    // Control: a full token claims and fetches an uncached URL as before.
    await harness.t.run(async (ctx) => {
      for (const row of await ctx.db.query("messageLinkPreviewCache").collect()) await ctx.db.delete(row._id);
    });
    await full.as.action(api.messageLinkPreviews.previewForMessage, args);
    expect(fetchSpy).toHaveBeenCalled();
    expect((await cacheRows()).length).toBeGreaterThan(0);
  });
});
