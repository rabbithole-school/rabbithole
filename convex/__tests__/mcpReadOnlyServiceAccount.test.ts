import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { sha256Hex } from "../lib/oauthCrypto";
import { isReadOnlyToolName } from "../lib/scholarReadPolicy";
import {
  grantInstitutionMembership,
  grantStaffCapability,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

// Why this file: a Claude Tag channel reaches prod data only through the MCP
// connector, authenticated by an `rhsa_` service-account token and pointed at
// the READ-ONLY endpoint /api/mcp/read. Claude Tag can restrict HTTP methods,
// but every MCP call is a POST, so read-only has to hold on our server. These
// tests drive the real Next route handler (app/api/mcp/read/route.ts) end to
// end against convex-test, with real teacher- and staff-kind service tokens,
// and pin that the endpoint lists no write tool AND refuses every write tool
// called by name (listing alone would be hiding, not refusing), without
// touching a single row.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

// The route reads this at import time; nothing is ever fetched from it.
const harness = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://read-only-test.convex.cloud";
  return {
    t: null as unknown as T,
    /** Every Convex function the route invoked, in order. */
    calls: [] as { kind: "query" | "mutation" | "action"; name: string }[],
  };
});

// Stand-in for ConvexHttpClient that runs each call against the test backend,
// as the identity the route set with setAuth. The one thing it cannot run is
// Convex Auth's signIn action (it needs JWT signing keys), so the exchange
// redeems the token through the same internal mutation the mcpServiceToken
// provider calls (convex/auth.ts) and hands back `userId|sessionId` as the
// "JWT" — exactly the subject a real one carries.
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

const { POST: readPost } = await import("../../app/api/mcp/read/route");
const { POST: fullPost } = await import("../../app/api/mcp/route");

// ── Fixture ──────────────────────────────────────────────────────────

async function seedServiceTokens(t: T) {
  const institutionId = await seedTestInstitution(t, { slug: "moli", name: "Moli School", isPrimary: true });
  const admin = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Avery Stone", username: "avery", role: "school_admin", institutionId }),
  );
  await grantInstitutionMembership(t, admin, institutionId, "school_admin");
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
    username: "hoku",
  });
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId: admin, expirationTime: Date.now() + 60 * 60 * 1000 }),
  );
  const asAdmin = t.withIdentity({ subject: `${admin}|${sessionId}`, issuer: "https://convex.dev" });
  // FULL tokens on purpose: this file proves the /read URL refuses writes
  // even for a token that could write (a read-only token, now the default, is
  // refused everywhere — mcpReadOnlyServiceToken.test.ts).
  const teacher = await asAdmin.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher", readOnly: false });
  const staff = await asAdmin.mutation(api.mcpServiceAccounts.issueToken, { kind: "staff", readOnly: false });
  return {
    institutionId,
    scholarId,
    asAdmin,
    // A person's OAuth access token is a session JWT; the fake client takes
    // its subject verbatim, as it does for an exchanged service token.
    adminBearer: `${admin}|${sessionId}`,
    tokens: { teacher: teacher.token, staff: staff.token },
  };
}

// ── MCP over HTTP ────────────────────────────────────────────────────

let rpcId = 0;

async function rpc(
  post: (r: Request) => Promise<Response>,
  path: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
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
  // The stateless transport answers as a one-message SSE stream.
  const data = body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length))
    .join("");
  return JSON.parse(data || body);
}

const read = (token: string, method: string, params?: Record<string, unknown>) =>
  rpc(readPost, "/api/mcp/read", token, method, params);
const full = (token: string, method: string, params?: Record<string, unknown>) =>
  rpc(fullPost, "/api/mcp", token, method, params);

async function toolNames(call: typeof read, token: string): Promise<string[]> {
  const res = await call(token, "tools/list");
  expect(res.error).toBeUndefined();
  return (res.result!.tools as { name: string }[]).map((t) => t.name);
}

/** Every row of every table, for a "nothing changed" comparison. */
async function snapshotDb(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables).sort()) {
      out[table] = await ctx.db.query(table as any).collect();
    }
    return JSON.stringify(out);
  });
}

// Writes named in the lane brief plus a spread of families (curriculum,
// roster, iPad, scholar records, admissions, unit designer, the folded give
// verbs and their legacy names). Called whether or not the caller's full list
// offers them: an unlisted write must be refused too, not routed onward.
const NAMED_WRITES = [
  "set_attendance",
  "update_scholar_profile",
  "dispatch_feature_proposal",
  "dispatch_implementation",
  "give",
  "create_scholar_account",
  "delete_scholar",
  "reset_scholar_password",
  "restart_managed_device",
  "set_rabbithole_lock",
  "add_scholar_observation",
  "update_scholar_dossier",
  "get_mentava_progress", // named like a read, but saves the level it fetches
  "pipeline_status_update", // paid model call + usage log
  "unit_update_unit",
  "unit_give",
  "send_slack_dm",
];

// ── Tests ────────────────────────────────────────────────────────────

describe.each(["teacher", "staff"] as const)("/api/mcp/read with a %s service-account token", (kind) => {
  beforeEach(() => {
    harness.t = convexTest(schema, modules);
    harness.calls = [];
    // Production switches the repo-grounding tools on; include them so the
    // dispatch tools are in the full list this test refuses.
    vi.stubEnv("INTROSPECTION_ENABLED", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("lists no write tool", async () => {
    const { tokens } = await seedServiceTokens(harness.t);
    const token = tokens[kind];

    const fullNames = await toolNames(full, token);
    const readNames = await toolNames(read, token);

    // The fixture is meaningful: the full connector offers this account writes.
    expect(fullNames.filter((n) => !isReadOnlyToolName(n)).length).toBeGreaterThan(0);
    expect(readNames.length).toBeGreaterThan(0);
    for (const name of readNames) {
      expect(isReadOnlyToolName(name), `${name} is listed on the read-only connector`).toBe(true);
    }
    for (const name of NAMED_WRITES) expect(readNames).not.toContain(name);
    // Read-only never invents a tool the full connector does not offer.
    for (const name of readNames) expect(fullNames).toContain(name);
  });

  test("refuses every write tool called by name, before reaching Convex, and changes no row", async () => {
    const { tokens } = await seedServiceTokens(harness.t);
    const token = tokens[kind];

    const fullNames = await toolNames(full, token);
    const writes = [...new Set([...fullNames.filter((n) => !isReadOnlyToolName(n)), ...NAMED_WRITES])];
    for (const name of ["set_attendance", "update_scholar_profile"]) {
      // Present in at least one account's full list (teacher: attendance;
      // both: the profile write), so at least some refusals are of tools
      // this caller could otherwise really run.
      if (fullNames.includes(name)) expect(writes).toContain(name);
    }

    // Warm the token exchange (it stamps lastUsedAt) before the snapshot.
    await read(token, "tools/list");
    const before = await snapshotDb(harness.t);

    for (const name of writes) {
      harness.calls = [];
      const res = await read(token, "tools/call", {
        name,
        arguments: { scholarName: "Hoku", unitId: "x", status: "absent", date: "2026-11-10" },
      });
      expect(res.result, `${name} returned a result on the read-only connector`).toBeUndefined();
      expect(res.error?.message).toContain("read-only Rabbithole connection");
      // Nothing that could write was invoked: only the per-request auth probe
      // and the tool-list assembly (all queries or list* actions).
      for (const call of harness.calls) {
        expect(call.kind, `${name} invoked ${call.name}`).not.toBe("mutation");
        expect(call.name, `${name} reached ${call.name}`).not.toMatch(/^mcp:call/);
      }
    }

    expect(await snapshotDb(harness.t)).toBe(before);
  });

  test("still answers a read", async () => {
    const { tokens } = await seedServiceTokens(harness.t);
    const res = await read(tokens[kind], "tools/call", { name: "list_scholars", arguments: {} });
    expect(res.error).toBeUndefined();
    const text = (res.result!.content as { type: string; text: string }[]).map((c) => c.text).join("");
    expect(text).toContain("Hoku Makani");
  });
});

describe("the same write, both endpoints", () => {
  // Positive control: the identical call that /api/mcp/read refuses really
  // does write through /api/mcp with the same token, so the refusal above is
  // the read path's doing, not a broken fixture.
  test("update_scholar_profile writes on /api/mcp and is refused on /api/mcp/read", async () => {
    harness.t = convexTest(schema, modules);
    const { tokens, scholarId } = await seedServiceTokens(harness.t);
    const dob = async () => (await harness.t.run((ctx) => ctx.db.get(scholarId)))?.dateOfBirth;
    const call = (dateOfBirth: string) => ({
      name: "update_scholar_profile",
      arguments: { scholarName: "Hoku", dateOfBirth },
    });

    const refused = await read(tokens.staff, "tools/call", call("2017-03-04"));
    expect(refused.error?.message).toContain("read-only Rabbithole connection");
    expect(await dob()).toBeUndefined();

    const written = await full(tokens.staff, "tools/call", call("2017-03-04"));
    expect(written.error).toBeUndefined();
    expect(await dob()).toBe("2017-03-04");
  });
});

// Claude Tag answers "what access does this colleague have?" through the
// read-only connector. find_staff_account is the aide's own lookup
// (staffCapabilities.aideFindStaffAccounts), listed in READS_DESPITE_NAME so
// /api/mcp/read serves it. Tenancy is the query's: the caller's own schools,
// never another school's staff, and never contact or scholar details.
describe("find_staff_account on /api/mcp/read", () => {
  async function seedColleagues(t: T, institutionId: Awaited<ReturnType<typeof seedTestInstitution>>) {
    const noe = await seedStaffWithMembership(t, {
      institutionId,
      role: "staff",
      name: "Noe Kapule",
      username: "noe_kapule",
    });
    await t.run((ctx) => ctx.db.patch(noe, { email: "noe.kapule@example.test", phone: "555-0100" }));
    await grantStaffCapability(t, noe, institutionId, "curriculum:edit");
    // Same first name at another school: never visible from Moli.
    const kailua = await seedTestInstitution(t, { slug: "kailua", name: "Kailua Academy" });
    const otherNoe = await seedStaffWithMembership(t, {
      institutionId: kailua,
      role: "teacher",
      name: "Noe Akana",
      username: "noe_akana",
    });
    await grantStaffCapability(t, otherNoe, kailua, "school:operations");
  }

  async function lookUp(token: string) {
    const names = await toolNames(read, token);
    expect(names).toContain("find_staff_account");
    const res = await read(token, "tools/call", { name: "find_staff_account", arguments: { name: "noe" } });
    expect(res.error).toBeUndefined();
    const text = (res.result!.content as { type: string; text: string }[]).map((c) => c.text).join("");
    return { text, body: JSON.parse(text) };
  }

  function expectMoliOnly({ text, body }: { text: string; body: any }) {
    expect(body.schoolsSearched).toEqual(["Moli School"]);
    expect(body.staff).toHaveLength(1);
    expect(body.staff[0]).toMatchObject({
      name: "Noe Kapule",
      username: "noe_kapule",
      linkedToSlack: false,
      schools: [{ school: "Moli School", roles: ["staff"] }],
    });
    expect(body.staff[0].capabilityGrants).toContainEqual({
      capability: "curriculum:edit",
      school: "Moli School",
      group: null,
    });
    expect(text).not.toContain("Noe Akana");
    expect(text).not.toContain("Kailua");
    expect(text).not.toContain("example.test");
    expect(text).not.toContain("555-0100");
    expect(text).not.toContain("Hoku");
  }

  beforeEach(() => {
    harness.t = convexTest(schema, modules);
    harness.calls = [];
  });

  test("a school admin signed in over OAuth sees roles and grants at their own school only", async () => {
    const { institutionId, adminBearer } = await seedServiceTokens(harness.t);
    await seedColleagues(harness.t, institutionId);
    expectMoliOnly(await lookUp(adminBearer));
  });

  test.each(["teacher", "staff"] as const)(
    "a read-only %s service account sees its own school only, and writes nothing",
    async (kind) => {
      const { institutionId, asAdmin } = await seedServiceTokens(harness.t);
      await seedColleagues(harness.t, institutionId);
      const { token } = await asAdmin.mutation(api.mcpServiceAccounts.issueToken, { kind, readOnly: true });
      await read(token, "tools/list");
      const before = await snapshotDb(harness.t);
      expectMoliOnly(await lookUp(token));
      expect(await snapshotDb(harness.t)).toBe(before);
    },
  );
});
