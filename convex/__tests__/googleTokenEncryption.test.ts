import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  ADMISSIONS_GOOGLE_SCOPES,
  GMAIL_METADATA_SCOPE,
  GOOGLE_OAUTH_SCOPES,
  includeGrantedScopesFor,
  missingAdmissionsScopes,
  normalizeGoogleScopes,
  scopesForPersonalGooglePurpose,
  mergeGoogleScopes,
} from "../lib/google";
import { getValidAccessToken } from "../lib/googleTokens";
import { isEncryptedGoogleToken, openGoogleToken } from "../lib/googleTokenCrypto";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly";

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function seedStaff(t: ReturnType<typeof convexTest>, username: string) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role: "staff" }),
  );
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  const as = t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
  return { userId, as };
}

const _makeTest = () => convexTest(schema, modules);
type SchemaTest = ReturnType<typeof _makeTest>;

async function accountFor(t: SchemaTest, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://example.com/google/oauth/callback");
  vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "test-state-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("googleAccounts token encryption at rest", () => {
  test("upsert stores both tokens encrypted and readers get plaintext back", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedStaff(t, "enc-upsert");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-enc-upsert",
      email: "enc@moli.school",
      accessToken: "ya29.fresh",
      refreshToken: "1//refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [...GOOGLE_OAUTH_SCOPES],
    });
    const row = await accountFor(t, userId);
    expect(isEncryptedGoogleToken(row!.accessToken)).toBe(true);
    expect(isEncryptedGoogleToken(row!.refreshToken!)).toBe(true);
    expect(JSON.stringify(row)).not.toContain("ya29.fresh");
    expect(JSON.stringify(row)).not.toContain("1//refresh");

    await expect(
      t.run((ctx) => getValidAccessToken(ctx as never, userId)),
    ).resolves.toBe("ya29.fresh");
  });

  test("a legacy plaintext row still serves its token", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedStaff(t, "enc-legacy");
    await t.run((ctx) =>
      ctx.db.insert("googleAccounts", {
        userId,
        googleSub: "sub-legacy",
        email: "legacy@moli.school",
        accessToken: "ya29.legacy",
        refreshToken: "1//legacy",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: [],
        connectedAt: Date.now(),
      }),
    );
    await expect(
      t.run((ctx) => getValidAccessToken(ctx as never, userId)),
    ).resolves.toBe("ya29.legacy");
  });

  test("refresh decrypts the refresh token and writes the new token encrypted", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedStaff(t, "enc-refresh");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-refresh",
      email: "refresh@moli.school",
      accessToken: "ya29.stale",
      refreshToken: "1//the-refresh",
      expiresAt: Date.now() - 1000,
      scopes: [],
    });
    let sentRefreshToken: string | null = null;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      sentRefreshToken = new URLSearchParams(String(init?.body)).get("refresh_token");
      return json({
        access_token: "ya29.renewed",
        expires_in: 3600,
        scope: "",
        token_type: "Bearer",
      });
    });

    await expect(
      t.run((ctx) => getValidAccessToken(ctx as never, userId)),
    ).resolves.toBe("ya29.renewed");
    expect(sentRefreshToken).toBe("1//the-refresh");

    const row = await accountFor(t, userId);
    expect(isEncryptedGoogleToken(row!.accessToken)).toBe(true);
    expect(await openGoogleToken(row!.accessToken)).toBe("ya29.renewed");
    expect(await openGoogleToken(row!.refreshToken!)).toBe("1//the-refresh");
    expect(row!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("refresh upgrades a legacy plaintext refresh token on the way past", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedStaff(t, "enc-upgrade");
    await t.run((ctx) =>
      ctx.db.insert("googleAccounts", {
        userId,
        googleSub: "sub-upgrade",
        email: "upgrade@moli.school",
        accessToken: "ya29.old",
        refreshToken: "1//old-refresh",
        expiresAt: Date.now() - 1000,
        scopes: [],
        connectedAt: Date.now(),
      }),
    );
    vi.stubGlobal("fetch", async () =>
      json({ access_token: "ya29.new", expires_in: 3600, scope: "", token_type: "Bearer" }),
    );
    await t.run((ctx) => getValidAccessToken(ctx as never, userId));
    const row = await accountFor(t, userId);
    expect(isEncryptedGoogleToken(row!.accessToken)).toBe(true);
    expect(isEncryptedGoogleToken(row!.refreshToken!)).toBe(true);
    expect(await openGoogleToken(row!.refreshToken!)).toBe("1//old-refresh");
  });

  test("invalid_grant on refresh records that a reconnect is needed", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedStaff(t, "enc-revoked");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-revoked",
      email: "revoked@moli.school",
      accessToken: "ya29.stale",
      refreshToken: "1//revoked",
      expiresAt: Date.now() - 1000,
      scopes: [...ADMISSIONS_GOOGLE_SCOPES, DRIVE_READ],
    });
    vi.stubGlobal("fetch", async () =>
      json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
    );
    // Through a real action: in production the token helper only runs in
    // actions, where the reconnect marker commits even though the call fails.
    // (Inside `t.run` the marker would roll back with the thrown error.)
    await expect(
      as.action(api.googleAccountsActions.getDriveAccessToken, {}),
    ).resolves.toBeNull();
    const row = await accountFor(t, userId);
    expect(row!.reconnectReason).toBe("refresh_revoked");
    expect(
      await as.query(api.googleAccounts.admissionsConnectStatus, {}),
    ).toEqual({ connected: true, missingScopes: [], needsReconnect: true, bypass: false });
    expect(
      (await as.query(api.googleAccounts.admissionsConnectStatus, {})).connected,
    ).toBe(true);

    // A fresh consent clears it.
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-revoked",
      email: "revoked@moli.school",
      accessToken: "ya29.new",
      refreshToken: "1//new",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [...ADMISSIONS_GOOGLE_SCOPES],
    });
    expect(
      await as.query(api.googleAccounts.admissionsConnectStatus, {}),
    ).toEqual({ connected: true, missingScopes: [], needsReconnect: false, bypass: false });
  });

  test("a successful refresh does not clear a reconnect flag; only a fresh consent does", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedStaff(t, "enc-flap");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-flap",
      email: "flap@moli.school",
      accessToken: "ya29.stale",
      refreshToken: "1//alive",
      expiresAt: Date.now() - 1000,
      scopes: [...ADMISSIONS_GOOGLE_SCOPES, DRIVE_READ],
    });
    // Gmail refused the grant (the sync's GmailAuthError path).
    await t.mutation(internal.googleAccounts.markReconnectRequiredInternal, {
      userId,
      reason: "refresh_revoked",
    });
    vi.stubGlobal("fetch", async () =>
      json({ access_token: "ya29.renewed", expires_in: 3600, scope: "", token_type: "Bearer" }),
    );
    // Another feature refreshes the token successfully...
    await expect(
      t.run((ctx) => getValidAccessToken(ctx as never, userId)),
    ).resolves.toBe("ya29.renewed");
    // ...and the gate stays shut, so it does not flap.
    expect((await accountFor(t, userId))!.reconnectRequiredAt).toBeDefined();
    expect(
      (await as.query(api.googleAccounts.admissionsConnectStatus, {})).needsReconnect,
    ).toBe(true);
  });

  test("a transient refresh failure does not ask for a reconnect", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedStaff(t, "enc-transient");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-transient",
      email: "transient@moli.school",
      accessToken: "ya29.stale",
      refreshToken: "1//ok",
      expiresAt: Date.now() - 1000,
      scopes: [],
    });
    vi.stubGlobal("fetch", async () => new Response("backend error", { status: 503 }));
    await expect(
      t.run((ctx) => getValidAccessToken(ctx as never, userId)),
    ).rejects.toThrow(/503/);
    expect((await accountFor(t, userId))!.reconnectRequiredAt).toBeUndefined();
  });

  test("an unreadable stored token records token_unreadable", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedStaff(t, "enc-unreadable");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-unreadable",
      email: "unreadable@moli.school",
      accessToken: "ya29.x",
      refreshToken: "1//x",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [DRIVE_READ],
    });
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey()); // wrong key now
    await expect(
      t.run((ctx) => getValidAccessToken(ctx as never, userId)),
    ).rejects.toThrow(/Reconnect Google/);
    await expect(
      as.action(api.googleAccountsActions.getDriveAccessToken, {}),
    ).resolves.toBeNull();
    expect((await accountFor(t, userId))!.reconnectReason).toBe("token_unreadable");
  });


  test("disconnect hands the decrypted token to the revoke call", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedStaff(t, "enc-disconnect");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-disconnect",
      email: "disconnect@moli.school",
      accessToken: "ya29.at",
      refreshToken: "1//rt",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [],
    });
    const { token } = await t.mutation(internal.googleAccounts.disconnectInternal, {
      userId,
    });
    expect(token).toBe("1//rt");
    expect(await accountFor(t, userId)).toBeNull();
  });
});

describe("admissions Google scopes", () => {
  test("merge keeps existing grants, adds identity + admissions scopes, no duplicates", () => {
    const merged = scopesForPersonalGooglePurpose("admissions", [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(merged).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    expect(new Set(merged).size).toBe(merged.length);
  });

  test("a grant still carrying gmail.metadata needs the Gmail scopes again, without it", () => {
    const CAL = "https://www.googleapis.com/auth/calendar.readonly";
    const READ = "https://www.googleapis.com/auth/gmail.readonly";
    const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
    const DRIVE = "https://www.googleapis.com/auth/drive.readonly";
    // The old grant: calendar + metadata. Both Gmail scopes are missing.
    expect(missingAdmissionsScopes([CAL, GMAIL_METADATA_SCOPE]).sort()).toEqual([COMPOSE, READ].sort());
    // Even with readonly and compose present, a leftover metadata scope blocks full reads.
    expect(missingAdmissionsScopes([CAL, READ, COMPOSE, GMAIL_METADATA_SCOPE]).sort()).toEqual(
      [COMPOSE, READ].sort(),
    );
    expect(missingAdmissionsScopes([CAL, READ, COMPOSE])).toEqual([]);
    // The consent drops metadata, keeps Drive, and turns incremental auth off.
    const scopes = scopesForPersonalGooglePurpose("admissions", [DRIVE, CAL, GMAIL_METADATA_SCOPE]);
    expect(scopes).not.toContain(GMAIL_METADATA_SCOPE);
    expect(scopes).toEqual(expect.arrayContaining([DRIVE, CAL, READ, COMPOSE]));
    expect(includeGrantedScopesFor("admissions", [CAL, GMAIL_METADATA_SCOPE])).toBe(false);
    expect(includeGrantedScopesFor("admissions", [DRIVE, CAL])).toBe(true);
    expect(includeGrantedScopesFor("default", [GMAIL_METADATA_SCOPE])).toBe(true);
  });

  test("a first-time admissions connect asks only for identity + admissions scopes", () => {
    expect(scopesForPersonalGooglePurpose("admissions")).toEqual(
      normalizeGoogleScopes([
        "openid",
        "email",
        "profile",
        ...ADMISSIONS_GOOGLE_SCOPES,
      ]),
    );
  });

  test("the default purpose keeps the existing Docs/Slides/Drive request", () => {
    expect(scopesForPersonalGooglePurpose("default")).toEqual([...GOOGLE_OAUTH_SCOPES]);
    expect(mergeGoogleScopes(["email"], ["email", "profile"])).toEqual([
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ]);
  });

  test("beginOAuth(admissions) requests the merged set with incremental auth", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedStaff(t, "admissions-begin");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-admissions-begin",
      email: "begin@moli.school",
      accessToken: "ya29.x",
      refreshToken: "1//x",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const { url } = await as.action(api.googleAccountsActions.beginOAuth, {
      returnTo: "/school/admissions",
      purpose: "admissions",
    });
    const params = new URL(url).searchParams;
    expect(params.get("include_granted_scopes")).toBe("true");
    const requested = params.get("scope")!.split(" ");
    for (const scope of [
      ...ADMISSIONS_GOOGLE_SCOPES,
      "openid",
      "https://www.googleapis.com/auth/drive.readonly",
    ]) {
      expect(requested).toContain(scope);
    }
    // The signed state carries the purpose through the callback.
    const [b64Json] = params.get("state")!.split(".");
    expect(JSON.parse(atob(b64Json))).toMatchObject({
      purpose: "admissions",
      returnTo: "/school/admissions",
    });
  });

  test("beginOAuth without a purpose is unchanged", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedStaff(t, "default-begin");
    const { url } = await as.action(api.googleAccountsActions.beginOAuth, {});
    expect(new URL(url).searchParams.get("scope")).toBe(GOOGLE_OAUTH_SCOPES.join(" "));
  });
});

describe("googleAccounts.admissionsConnectStatus", () => {
  test("not connected", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedStaff(t, "status-none");
    expect(await as.query(api.googleAccounts.admissionsConnectStatus, {})).toEqual({
      connected: false,
      missingScopes: [...ADMISSIONS_GOOGLE_SCOPES],
      needsReconnect: false,
      bypass: false,
    });
  });

  test("connected without admissions scopes lists what is missing", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedStaff(t, "status-missing");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-status-missing",
      email: "missing@moli.school",
      accessToken: "ya29.x",
      refreshToken: "1//x",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
    });
    expect(await as.query(api.googleAccounts.admissionsConnectStatus, {})).toEqual({
      connected: true,
      missingScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
      needsReconnect: false,
      bypass: false,
    });
  });

  test("a link without a refresh token needs a reconnect", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedStaff(t, "status-expired");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-status-expired",
      email: "expired@moli.school",
      accessToken: "ya29.x",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [...ADMISSIONS_GOOGLE_SCOPES],
    });
    expect(
      (await as.query(api.googleAccounts.admissionsConnectStatus, {})).needsReconnect,
    ).toBe(true);
  });

  test("bypass: platform admin on an opted-in dev deployment only", async () => {
    const t = convexTest(schema, modules);
    const { userId: adminId, as: asAdmin } = await seedStaff(t, "status-admin");
    await t.run((ctx) => ctx.db.patch(adminId, { role: "platform_admin" }));
    const { as: asStaff } = await seedStaff(t, "status-staff");
    const bypass = async (as: typeof asAdmin) =>
      (await as.query(api.googleAccounts.admissionsConnectStatus, {})).bypass;

    vi.stubEnv("CONVEX_CLOUD_URL", "https://some-dev-deployment-123.convex.cloud");
    vi.stubEnv("ADMISSIONS_DEV_MODE", "1");
    expect(await bypass(asAdmin)).toBe(true);
    expect(await bypass(asStaff)).toBe(false);

    // Any hosted deployment without the opt-in is production.
    vi.stubEnv("ADMISSIONS_DEV_MODE", "");
    expect(await bypass(asAdmin)).toBe(false);
    expect(await bypass(asStaff)).toBe(false);
  });

  test("a scholar cannot read it", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Scholar", username: "status-scholar", role: "scholar" }),
    );
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 }),
    );
    const as = t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
    await expect(
      as.query(api.googleAccounts.admissionsConnectStatus, {}),
    ).rejects.toThrow();
  });
});

describe("getDriveAccessToken hands the browser a Drive-only token", () => {
  const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
  const GMAIL = "https://www.googleapis.com/auth/gmail";

  async function seedGmailLink(t: SchemaTest, username: string) {
    const { userId, as } = await seedStaff(t, username);
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: `sub-${username}`,
      email: `${username}@moli.school`,
      // Unexpired: the old code handed this stored token straight back.
      accessToken: "ya29.stored-with-gmail",
      refreshToken: "1//full-grant",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [...GOOGLE_OAUTH_SCOPES, ...ADMISSIONS_GOOGLE_SCOPES],
    });
    return { userId, as };
  }

  test("a link with Gmail scopes never returns the stored token; it mints a down-scoped one", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedGmailLink(t, "picker-downscope");
    const requests: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(String(init?.body));
      requests.push(body);
      return json({
        access_token: "ya29.drive-only",
        expires_in: 3600,
        scope: `${DRIVE_READ} ${DRIVE_FILE}`,
        token_type: "Bearer",
      });
    });

    const result = await as.action(api.googleAccountsActions.getDriveAccessToken, {});
    expect(result).toEqual({ token: "ya29.drive-only", email: "picker-downscope@moli.school" });

    // The down-scope request asks for Drive scopes and nothing else.
    expect(requests).toHaveLength(1);
    expect(requests[0].get("grant_type")).toBe("refresh_token");
    expect(requests[0].get("refresh_token")).toBe("1//full-grant");
    const asked = requests[0].get("scope")!.split(" ");
    expect(asked.sort()).toEqual([DRIVE_READ, DRIVE_FILE].sort());
    expect(asked.some((s) => s.includes("gmail") || s.includes("calendar"))).toBe(false);

    // Not persisted: the stored token still holds the full grant.
    const row = await accountFor(t, userId);
    expect(await openGoogleToken(row!.accessToken)).toBe("ya29.stored-with-gmail");
  });

  test("a token Google returns with any Gmail scope is refused (null)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedGmailLink(t, "picker-broad");
    vi.stubGlobal("fetch", async () =>
      json({
        access_token: "ya29.still-gmail",
        expires_in: 3600,
        scope: `${DRIVE_READ} ${DRIVE_FILE} ${GMAIL}.readonly`,
        token_type: "Bearer",
      }),
    );
    await expect(
      as.action(api.googleAccountsActions.getDriveAccessToken, {}),
    ).resolves.toBeNull();
  });

  test("a response with no scope field is refused (null)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedGmailLink(t, "picker-noscope");
    vi.stubGlobal("fetch", async () =>
      json({ access_token: "ya29.unknown", expires_in: 3600, token_type: "Bearer" }),
    );
    await expect(
      as.action(api.googleAccountsActions.getDriveAccessToken, {}),
    ).resolves.toBeNull();
  });

  test("a failed down-scope returns null so the client falls back to GIS", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedGmailLink(t, "picker-fail");
    vi.stubGlobal("fetch", async () => json({ error: "invalid_scope" }, 400));
    await expect(
      as.action(api.googleAccountsActions.getDriveAccessToken, {}),
    ).resolves.toBeNull();
    // Not a dead grant: no reconnect prompt.
    expect((await accountFor(t, userId))!.reconnectRequiredAt).toBeUndefined();
  });

  test("a link without a refresh token returns null without calling Google", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedStaff(t, "picker-norefresh");
    await t.mutation(internal.googleAccounts.upsertInternal, {
      userId,
      googleSub: "sub-picker-norefresh",
      email: "norefresh@moli.school",
      accessToken: "ya29.stored",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: [DRIVE_READ, ...ADMISSIONS_GOOGLE_SCOPES],
    });
    const fetchSpy = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      as.action(api.googleAccountsActions.getDriveAccessToken, {}),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Google OAuth callback: single-use state bound to the user", () => {
  async function seedWithEmail(t: SchemaTest, username: string, email: string) {
    const seeded = await seedStaff(t, username);
    await t.run((ctx) => ctx.db.patch(seeded.userId, { email }));
    return seeded;
  }

  function stubGoogle(googleEmail: string, opts: { verified?: boolean } = {}) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
      const u = String(url);
      calls.push(u);
      if (u === "https://oauth2.googleapis.com/token") {
        return json({
          access_token: "ya29.fresh",
          refresh_token: "1//fresh",
          expires_in: 3600,
          scope: [...GOOGLE_OAUTH_SCOPES, ...ADMISSIONS_GOOGLE_SCOPES].join(" "),
          token_type: "Bearer",
        });
      }
      if (u === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({
          sub: `sub-${googleEmail}`,
          email: googleEmail,
          email_verified: opts.verified ?? true,
          name: "Staff",
        });
      }
      if (u.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
      throw new Error(`unexpected request ${u}`);
    });
    return calls;
  }

  async function begin(as: Awaited<ReturnType<typeof seedStaff>>["as"], purpose?: "admissions") {
    const { url } = await as.action(api.googleAccountsActions.beginOAuth, {
      returnTo: "/school/admissions",
      ...(purpose ? { purpose } : {}),
    });
    return new URL(url).searchParams.get("state")!;
  }

  const callback = (t: SchemaTest, state: string) =>
    t.fetch(`/google/oauth/callback?code=code&state=${encodeURIComponent(state)}`);

  beforeEach(() => {
    vi.stubEnv("SITE_URL", "https://app.example.test");
  });

  test("the normal admissions path links the account", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedWithEmail(t, "cb-ok", "Pat.Staff@moli.school");
    const state = await begin(as, "admissions");
    stubGoogle("pat.staff@MOLI.school");
    const res = await callback(t, state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.example.test/school/admissions");
    expect((await accountFor(t, userId))?.email).toBe("pat.staff@moli.school");
  });

  test("a reused state is refused", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedWithEmail(t, "cb-reuse", "reuse@moli.school");
    const state = await begin(as);
    stubGoogle("reuse@moli.school");
    expect((await callback(t, state)).status).toBe(302);
    const calls = stubGoogle("reuse@moli.school");
    const again = await callback(t, state);
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/expired or was already used/);
    // Refused before the code exchange.
    expect(calls).toEqual([]);
  });

  test("a signed state whose nonce was never stored is refused", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedWithEmail(t, "cb-unknown", "unknown@moli.school");
    const { signState } = await import("../lib/google");
    const state = await signState(
      { userId, returnTo: "/teacher", nonce: "never-stored", purpose: "default" },
      "test-state-secret",
    );
    const calls = stubGoogle("unknown@moli.school");
    expect((await callback(t, state)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a nonce minted for another user is refused", async () => {
    const t = convexTest(schema, modules);
    const alice = await seedWithEmail(t, "cb-alice", "alice@moli.school");
    const bob = await seedWithEmail(t, "cb-bob", "bob@moli.school");
    const aliceState = await begin(alice.as);
    const [b64Json] = aliceState.split(".");
    const { nonce } = JSON.parse(atob(b64Json)) as { nonce: string };
    const { signState } = await import("../lib/google");
    const forged = await signState(
      { userId: bob.userId, returnTo: "/teacher", nonce, purpose: "default" },
      "test-state-secret",
    );
    stubGoogle("bob@moli.school");
    expect((await callback(t, forged)).status).toBe(400);
    expect(await accountFor(t, bob.userId)).toBeNull();
  });

  test("admissions refuses a Google account whose email is not the user's", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedWithEmail(t, "cb-mismatch", "pat@moli.school");
    const state = await begin(as, "admissions");
    const calls = stubGoogle("attacker@gmail.example");
    const res = await callback(t, state);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/^Connect the Google account for pat@moli\.school/);
    expect(await accountFor(t, userId)).toBeNull();
    // The grant just issued is revoked.
    expect(calls.some((u) => u.startsWith("https://oauth2.googleapis.com/revoke"))).toBe(true);
  });

  test("admissions refuses an unverified Google email", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedWithEmail(t, "cb-unverified", "pat2@moli.school");
    const state = await begin(as, "admissions");
    stubGoogle("pat2@moli.school", { verified: false });
    expect((await callback(t, state)).status).toBe(403);
    expect(await accountFor(t, userId)).toBeNull();
  });

  test("the default (Drive) purpose does not require a matching email", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedWithEmail(t, "cb-default", "pat3@moli.school");
    const state = await begin(as);
    stubGoogle("personal-drive@gmail.example");
    expect((await callback(t, state)).status).toBe(302);
    expect((await accountFor(t, userId))?.email).toBe("personal-drive@gmail.example");
  });
});
