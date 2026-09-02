import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// The overlay + identity swap only engage when the feature flag is on. Set it
// for this file (vitest isolates modules per file) and restore after.
const prevFlag = process.env.IMPERSONATION_ENABLED;
beforeAll(() => {
  process.env.IMPERSONATION_ENABLED = "on";
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.IMPERSONATION_ENABLED;
  else process.env.IMPERSONATION_ENABLED = prevFlag;
});

type Role = "scholar" | "teacher" | "platform_admin";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
  );
}

// Returns the identity accessor AND the sessionId, so tests can assert the
// session-scoped overlay (the overlay is keyed to the ADMIN's session id).
async function withUserSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  const as = t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
  return { as, sessionId };
}

describe("impersonation overlay — start + escalation guard", () => {
  test("platform-admin can start; the overlay is recorded + audited", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "teacher", "lehua");
    const { as } = await withUserSession(t, admin);

    const res = await as.mutation(api.impersonation.startImpersonation, {
      targetUserId: target,
      reason: "verify enforcement",
    });
    expect(res.ok).toBe(true);

    const overlays = await t.run(async (ctx) =>
      ctx.db.query("impersonationOverlays").collect(),
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0].adminUserId).toBe(admin);
    expect(overlays[0].targetUserId).toBe(target);
    expect(overlays[0].active).toBe(true);

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_action", (q) => q.eq("action", "impersonation.start"))
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(admin);
    expect(audit[0].targetUserId).toBe(target);
  });

  test("rejects a platform-admin target (by users.role)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const other = await seedUser(t, "platform_admin", "rowan");
    const { as } = await withUserSession(t, admin);
    await expect(
      as.mutation(api.impersonation.startImpersonation, { targetUserId: other }),
    ).rejects.toThrow(/platform admin/i);
  });

  test("rejects a target holding a platform_admin membership row", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const sneaky = await seedUser(t, "scholar", "sneaky");
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { userId: sneaky, role: "platform_admin" }),
    );
    const { as } = await withUserSession(t, admin);
    await expect(
      as.mutation(api.impersonation.startImpersonation, { targetUserId: sneaky }),
    ).rejects.toThrow(/platform admin/i);
  });

  test("rejects self and non-admin callers", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const teacher = await seedUser(t, "teacher", "lehua");
    const scholar = await seedUser(t, "scholar", "kai");
    const { as: asAdmin } = await withUserSession(t, admin);
    await expect(
      asAdmin.mutation(api.impersonation.startImpersonation, { targetUserId: admin }),
    ).rejects.toThrow(/yourself/i);

    const { as: asTeacher } = await withUserSession(t, teacher);
    await expect(
      asTeacher.mutation(api.impersonation.startImpersonation, { targetUserId: scholar }),
    ).rejects.toThrow(); // requirePlatformAdmin
  });
});

describe("impersonation overlay — target by handle (username or id)", () => {
  test("resolves a username handle to the matching user", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "teacher", "lehua");
    const { as } = await withUserSession(t, admin);

    const res = await as.mutation(api.impersonation.startImpersonation, {
      targetHandle: "lehua",
    });
    expect(res.ok).toBe(true);
    const overlays = await t.run(async (ctx) =>
      ctx.db.query("impersonationOverlays").collect(),
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0].targetUserId).toBe(target);
  });

  test("resolves an id string passed as the handle", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "scholar", "kai");
    const { as } = await withUserSession(t, admin);

    const res = await as.mutation(api.impersonation.startImpersonation, {
      targetHandle: target, // a raw id string
    });
    expect(res.ok).toBe(true);
    const overlays = await t.run(async (ctx) =>
      ctx.db.query("impersonationOverlays").collect(),
    );
    expect(overlays[0].targetUserId).toBe(target);
  });

  test("throws a helpful error for an unknown handle", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    await seedUser(t, "teacher", "lehua");
    const { as } = await withUserSession(t, admin);

    await expect(
      as.mutation(api.impersonation.startImpersonation, {
        targetHandle: "nobody-by-this-name",
      }),
    ).rejects.toThrow(/No user matches/i);
  });

  test("still honors the escalation guard when resolving a username", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    await seedUser(t, "platform_admin", "root");
    const { as } = await withUserSession(t, admin);

    await expect(
      as.mutation(api.impersonation.startImpersonation, { targetHandle: "root" }),
    ).rejects.toThrow(/platform admin/i);
  });
});

describe("impersonation overlay — identity resolution", () => {
  test("currentUser resolves as the TARGET on the impersonating session, admin elsewhere", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "scholar", "kai");
    const impersonating = await withUserSession(t, admin);
    await impersonating.as.mutation(api.impersonation.startImpersonation, {
      targetUserId: target,
    });

    // Same (impersonating) session → resolves as the target.
    const asTarget = await impersonating.as.query(api.users.currentUser, {});
    expect(asTarget?._id).toBe(target);
    expect(asTarget?.username).toBe("kai");

    // A DIFFERENT admin session (no overlay) → resolves as the admin.
    const other = await withUserSession(t, admin);
    const asAdmin = await other.as.query(api.users.currentUser, {});
    expect(asAdmin?._id).toBe(admin);
    expect(asAdmin?.username).toBe("avery");
  });

  test("the target's OWN login is unaffected (no overlay on their session)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "teacher", "lehua");
    const impersonating = await withUserSession(t, admin);
    await impersonating.as.mutation(api.impersonation.startImpersonation, {
      targetUserId: target,
    });
    const targetLogin = await withUserSession(t, target);
    const me = await targetLogin.as.query(api.users.currentUser, {});
    expect(me?._id).toBe(target);
  });
});

describe("impersonation overlay — read-only gate", () => {
  test("blocks writes from the impersonating session, allows the target's own + a normal session", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "teacher", "lehua");
    const impersonating = await withUserSession(t, admin);
    await impersonating.as.mutation(api.impersonation.startImpersonation, {
      targetUserId: target,
    });

    // A write on the impersonating session is refused.
    await expect(
      impersonating.as.mutation(api.users.updatePreferredFont, {
        preferredFont: "serif",
      }),
    ).rejects.toThrow(/read-only while viewing/i);

    // The target's OWN login (different session) can write.
    const targetLogin = await withUserSession(t, target);
    await targetLogin.as.mutation(api.users.updatePreferredFont, {
      preferredFont: "serif",
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(target)))?.preferredFont,
    ).toBe("serif");

    // A normal (never-impersonating) user writes freely.
    const solo = await seedUser(t, "teacher", "solo");
    const soloLogin = await withUserSession(t, solo);
    await soloLogin.as.mutation(api.users.updatePreferredFont, {
      preferredFont: "mono",
    });
    expect((await t.run(async (ctx) => ctx.db.get(solo)))?.preferredFont).toBe("mono");
  });
});

describe("impersonation overlay — stop + banner + supersede", () => {
  test("stop ends the overlay; currentUser + myImpersonation revert", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "teacher", "lehua");
    const s = await withUserSession(t, admin);
    await s.as.mutation(api.impersonation.startImpersonation, { targetUserId: target });

    const before = await s.as.query(api.impersonation.myImpersonation, {});
    expect(before?.targetUsername).toBe("lehua");
    expect(before?.adminUsername).toBe("avery");

    const stop = await s.as.mutation(api.impersonation.stopImpersonation, {});
    expect(stop.ok).toBe(true);

    expect(await s.as.query(api.impersonation.myImpersonation, {})).toBeNull();
    const me = await s.as.query(api.users.currentUser, {});
    expect(me?._id).toBe(admin); // back to the admin — no re-mint needed
  });

  test("myImpersonation is null for a normal session + never throws unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const solo = await seedUser(t, "teacher", "solo");
    const soloLogin = await withUserSession(t, solo);
    expect(await soloLogin.as.query(api.impersonation.myImpersonation, {})).toBeNull();
    // Unauthenticated (no identity) — must resolve null, not throw.
    await expect(
      t.query(api.impersonation.myImpersonation, {}),
    ).resolves.toBeNull();
  });

  test("must exit before viewing as someone else (the session resolves as the non-admin target)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const a = await seedUser(t, "scholar", "kai");
    const b = await seedUser(t, "scholar", "lani");
    const s = await withUserSession(t, admin);
    await s.as.mutation(api.impersonation.startImpersonation, { targetUserId: a });

    // While impersonating, the session IS the target (a scholar) — a second
    // start is refused by requirePlatformAdmin. You must exit first.
    await expect(
      s.as.mutation(api.impersonation.startImpersonation, { targetUserId: b }),
    ).rejects.toThrow();

    await s.as.mutation(api.impersonation.stopImpersonation, {});
    await s.as.mutation(api.impersonation.startImpersonation, { targetUserId: b });

    const overlays = await t.run(async (ctx) =>
      ctx.db.query("impersonationOverlays").collect(),
    );
    expect(overlays.filter((o) => o.active)).toHaveLength(1);
    expect((await s.as.query(api.users.currentUser, {}))?._id).toBe(b);
  });

  test("switches scholar targets atomically and exposes the picker roster", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const a = await seedUser(t, "scholar", "kai");
    const b = await seedUser(t, "scholar", "lani");
    await seedUser(t, "teacher", "lehua");
    const s = await withUserSession(t, admin);
    await s.as.mutation(api.impersonation.startImpersonation, { targetUserId: a });

    const before = await s.as.query(api.impersonation.myImpersonation, {});
    expect(before?.targetUserId).toBe(a);
    expect(before?.switchableScholars.map((scholar) => scholar.id)).toEqual([
      a,
      b,
    ]);

    await s.as.mutation(api.impersonation.switchImpersonationTarget, {
      targetUserId: b,
    });

    expect((await s.as.query(api.users.currentUser, {}))?._id).toBe(b);
    const overlays = await t.run(async (ctx) =>
      ctx.db.query("impersonationOverlays").collect(),
    );
    expect(overlays.filter((overlay) => overlay.active)).toHaveLength(1);
    expect(overlays.find((overlay) => overlay.active)?.targetUserId).toBe(b);

    const switches = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_action", (q) => q.eq("action", "impersonation.switch"))
        .collect(),
    );
    expect(switches).toHaveLength(1);
    expect(switches[0].actorUserId).toBe(admin);
    expect(switches[0].targetUserId).toBe(b);
  });
});

describe("impersonation overlay — passkey status uses the REAL owner", () => {
  test("an impersonated passkey-less teacher view reports the ADMIN's passkey status", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "teacher", "lehua"); // no passkey
    // Admin HAS a passkey.
    await t.run(async (ctx) =>
      ctx.db.insert("passkeys", {
        userId: admin,
        credentialId: "cred-avery",
        publicKey: "pk",
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        transports: [],
        createdAt: Date.now(),
      }),
    );
    const s = await withUserSession(t, admin);
    await s.as.mutation(api.impersonation.startImpersonation, { targetUserId: target });

    // currentUser resolves as the target (teacher, no passkey)…
    expect((await s.as.query(api.users.currentUser, {}))?._id).toBe(target);
    // …but passkey status is about the REAL owner (admin) → no forced enrollment.
    const status = await s.as.query(api.passkeys.myStatus, {});
    expect(status.hasPasskey).toBe(true);
    expect(status.mustEnroll).toBe(false);
  });
});

describe("impersonation overlay — disabled by default", () => {
  test("with the flag OFF, startImpersonation throws and no overlay resolves", async () => {
    const prev = process.env.IMPERSONATION_ENABLED;
    delete process.env.IMPERSONATION_ENABLED;
    try {
      const t = convexTest(schema, modules);
      const admin = await seedUser(t, "platform_admin", "avery");
      const target = await seedUser(t, "scholar", "kai");
      const s = await withUserSession(t, admin);
      await expect(
        s.as.mutation(api.impersonation.startImpersonation, { targetUserId: target }),
      ).rejects.toThrow(/not enabled/i);
    } finally {
      process.env.IMPERSONATION_ENABLED = prev;
    }
  });
});

describe("impersonation overlay — Google account link uses the REAL owner", () => {
  test("an admin viewing-as a scholar still sees their OWN linked Google account", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "scholar", "ophelia"); // no curriculum access
    // Admin linked their OWN Google account — the OAuth callback binds the row
    // to the real owner id (getAuthUserId), independent of any overlay.
    await t.run(async (ctx) =>
      ctx.db.insert("googleAccounts", {
        userId: admin,
        googleSub: "sub-avery",
        email: "avery@moli.school",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["openid"],
        connectedAt: Date.now(),
      }),
    );
    const s = await withUserSession(t, admin);
    await s.as.mutation(api.impersonation.startImpersonation, { targetUserId: target });

    // The app UI resolves as the scholar target…
    expect((await s.as.query(api.users.currentUser, {}))?._id).toBe(target);
    // …but the Google-link status is about the REAL owner (admin). Before the
    // fix this either threw (scholar lacks curriculum access) or read the
    // target's (empty) row — hiding the admin's own valid link.
    const status = await s.as.query(api.googleAccounts.status, {});
    expect(status.connected).toBe(true);
    expect(status).toMatchObject({
      email: "avery@moli.school",
      hasRefreshToken: true,
    });
  });
});

describe("impersonation overlay — TTL + stale sweep", () => {
  test("an overlay past its TTL is inert — currentUser + banner revert with no sweep", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedUser(t, "scholar", "kai");
    const s = await withUserSession(t, admin);
    await s.as.mutation(api.impersonation.startImpersonation, { targetUserId: target });

    // Age the overlay past its TTL (row is still `active`).
    await t.run(async (ctx) => {
      const ov = await ctx.db.query("impersonationOverlays").first();
      await ctx.db.patch(ov!._id, { expiresAt: Date.now() - 1000 });
    });

    // Treated as ended everywhere, even before the sweep runs.
    expect((await s.as.query(api.users.currentUser, {}))?._id).toBe(admin);
    expect(await s.as.query(api.impersonation.myImpersonation, {})).toBeNull();
    // The read-only gate lifts too: a self-write now lands on the admin.
    await s.as.mutation(api.users.updatePreferredFont, { preferredFont: "serif" });
    expect((await t.run(async (ctx) => ctx.db.get(admin)))?.preferredFont).toBe("serif");
  });

  test("a legacy overlay with no expiresAt still expires via the startedAt fallback", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const kai = await seedUser(t, "scholar", "kai");
    const s = await withUserSession(t, admin);
    // A pre-TTL row: active, NO expiresAt, startedAt older than the 8h TTL —
    // exactly the shape of the orphans left on prod before this change.
    await t.run(async (ctx) => {
      await ctx.db.insert("impersonationOverlays", {
        adminUserId: admin,
        adminSessionId: s.sessionId,
        targetUserId: kai,
        startedAt: Date.now() - 9 * 60 * 60 * 1000,
        active: true,
      });
    });

    expect((await s.as.query(api.users.currentUser, {}))?._id).toBe(admin); // inert
    const res = await t.mutation(internal.impersonation.sweepStaleOverlays, {});
    expect(res.ended).toBe(1);
  });

  test("sweep ends expired + orphaned overlays, keeps a fresh one, and audits", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const mia = await seedUser(t, "scholar", "mia");

    // 1) Fresh overlay — survives (not expired, anchor session present).
    const fresh = await withUserSession(t, admin);
    await fresh.as.mutation(api.impersonation.startImpersonation, { targetUserId: kai });

    // 2) Expired overlay — TTL in the past.
    const expired = await withUserSession(t, admin);
    await expired.as.mutation(api.impersonation.startImpersonation, { targetUserId: lani });
    await t.run(async (ctx) => {
      const ov = await ctx.db
        .query("impersonationOverlays")
        .withIndex("by_admin_session", (q) =>
          q.eq("adminSessionId", expired.sessionId).eq("active", true),
        )
        .first();
      await ctx.db.patch(ov!._id, { expiresAt: Date.now() - 1000 });
    });

    // 3) Orphaned overlay — anchor authSession deleted (admin signed out).
    const orphan = await withUserSession(t, admin);
    await orphan.as.mutation(api.impersonation.startImpersonation, { targetUserId: mia });
    await t.run(async (ctx) => ctx.db.delete(orphan.sessionId));

    const res = await t.mutation(internal.impersonation.sweepStaleOverlays, {});
    expect(res.ended).toBe(2);

    const active = await t.run(async (ctx) =>
      (await ctx.db.query("impersonationOverlays").collect()).filter((o) => o.active),
    );
    expect(active).toHaveLength(1);
    expect(active[0].adminSessionId).toBe(fresh.sessionId);

    const expireAudits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_action", (q) => q.eq("action", "impersonation.expire"))
        .collect(),
    );
    expect(expireAudits).toHaveLength(2);
    expect(expireAudits.map((a) => a.detail).sort()).toEqual(["session ended", "ttl"]);
  });
});
