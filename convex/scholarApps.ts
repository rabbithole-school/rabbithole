// Per-scholar External Apps — the wiring between the catalog
// (externalApps.ts) and an individual scholar's home launcher.
//
//  - listForLauncher  → the scholar's own enabled apps (or, for a
//                       teacher/admin, a target scholar's) — drives the
//                       squircle grid on /scholar.
//  - listForScholar   → the teacher panel: ALL of a scholar's apps
//                       (enabled + disabled) with catalog detail.
//  - addToScholar / setEnabled / removeFromScholar → teacher management.
//
// See review/external-apps-launcher.html §2 & §4.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  authedQuery,
  scholarAdminQuery,
  scholarAdminMutation,
} from "./lib/customFunctions";
import { ROLES, isTeacherRole } from "./lib/roles";
import { requireActiveScholarAccess } from "./lib/access";
import {
  grantedAppIdsForScholar,
  grantProvenanceForScholar,
  launcherShowsApp,
  scholarHasGrantForApp,
} from "./lib/appAudiences";
import { libraryCredentialRevision } from "../shared/libraryCard";
import { scheduleUnlockRevocationCheck } from "./lib/deviceAppUnlockScheduling";
import { isPublicProductionDeployment } from "./lib/deploymentSafety";
import {
  registrableHost,
  requireScholarAdminScope,
  resolveAppByName,
  resolveScholarByNameOrUsername,
} from "./lib/externalAppsResolve";
import { resolveAppIconUrl } from "./lib/externalAppIconUrl";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/** Whose launcher to read: self, or — for staff — a target scholar. */
function resolveTargetScholar(
  ctx: { user: Doc<"users"> },
  scholarId: Id<"users"> | undefined,
): Id<"users"> {
  if (!scholarId || scholarId === ctx.user._id) return ctx.user._id;
  const role = ctx.user.role;
  if (!isTeacherRole(role)) {
    throw new Error("Forbidden");
  }
  return scholarId;
}

/**
 * The scholar launcher feed: the apps a scholar can open, or — when a
 * teacher/admin passes `scholarId` (remote mode) — that scholar's. The result
 * is the UNION of two sources (plan §5):
 *   • DIRECT rows — the scholar's own enabled `scholarApps` (source
 *     "manual"/"default"), exactly as before.
 *   • GRANTS — every app granted to an audience the scholar belongs to (their
 *     institution + each group), resolved at read time so membership churn is
 *     free (join a group → the tile appears the same second, no backfill).
 * A `source:"grant"` row is visibility-neutral (it only parks credentials).
 * Returns everything the tile + launch needs (no extra round-trip).
 */
export const listForLauncher = authedQuery({
  args: { scholarId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const scholarId = resolveTargetScholar(ctx, args.scholarId);
    if (scholarId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    }
    const scholar = await ctx.db.get(scholarId);
    if (!scholar) return [];

    const links = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    const linkByApp = new Map(links.map((l) => [String(l.appId), l]));

    const grantedIds = await grantedAppIdsForScholar(ctx, scholar);

    // Show an app iff an enabled grant covers it OR an enabled direct
    // (manual/default) row exists — `launcherShowsApp`, the one home for that
    // rule (the launch-time gates enforce the same predicate, so tile and
    // launch can't disagree). Deduped by appId (a scholar with both a grant and
    // a direct add sees one tile).
    const grantedKeys = new Set([...grantedIds].map(String));
    const showIds = new Set<string>();
    for (const id of [...grantedKeys, ...links.map((l) => String(l.appId))]) {
      if (launcherShowsApp({ link: linkByApp.get(id), granted: grantedKeys.has(id) })) {
        showIds.add(id);
      }
    }

    const tiles = [];
    for (const appIdStr of showIds) {
      const appId = ctx.db.normalizeId("externalApps", appIdStr);
      const app = appId ? await ctx.db.get(appId) : null;
      if (!app || app.archived) continue;
      const link = linkByApp.get(appIdStr);
      tiles.push({
        scholarAppId: link?._id ?? null,
        appId: app._id,
        name: app.name,
        webUrl: app.webUrl,
        webAllowedHosts: app.webAllowedHosts ?? null,
        iconUrl: await resolveAppIconUrl(ctx, app),
        iconEmoji: app.iconEmoji ?? null,
        color: app.color ?? null,
        nativeUrlScheme: app.nativeUrlScheme ?? null,
      });
    }
    // Stable order: alphabetical by name (no per-scholar ordering — <4 apps).
    tiles.sort((a, b) => a.name.localeCompare(b.name));
    return tiles;
  },
});

/**
 * Teacher panel: every app a scholar HAS (a direct add OR an audience grant),
 * with catalog detail, per-scholar credential state, and DERIVED provenance
 * (which groups grant it / whether it's school-wide / whether it's a direct
 * add). The panel labels each row from this and gates editing: granted rows are
 * read-only provenance + credentials; only a direct add keeps the on/off toggle
 * and Remove. (Teacher/admin/operations staff.)
 */
export const listForScholar = scholarAdminQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) return [];

    const links = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const linkByApp = new Map(links.map((l) => [String(l.appId), l]));

    const provenance = await grantProvenanceForScholar(ctx, scholar);

    // Union of every app the scholar HAS: a direct (manual/default) add, or an
    // app granted via an audience. A lone source:"grant" credential-parking row
    // with no live grant is intentionally omitted (the app isn't on the
    // launcher).
    const appIdStrs = new Set<string>();
    for (const l of links) {
      if (l.source === "manual" || l.source === "default") {
        appIdStrs.add(String(l.appId));
      }
    }
    for (const key of provenance.keys()) appIdStrs.add(key);

    const rows = [];
    for (const appIdStr of appIdStrs) {
      const appId = ctx.db.normalizeId("externalApps", appIdStr);
      const app = appId ? await ctx.db.get(appId) : null;
      if (!app) continue;
      const link = linkByApp.get(appIdStr) ?? null;
      const prov = provenance.get(appIdStr) ?? { groups: [], institution: false };
      const direct =
        !!link && (link.source === "manual" || link.source === "default");

      // A "libraryCard" app's login is the scholar-level users.libraryCredential
      // (shared across library apps), not the per-app link. Surface THAT so the
      // Sign-in panel reads/edits the right store (setCredentials mirrors this).
      const usesLibraryCard = app.credentialSource === "libraryCard";
      const loginUsername = usesLibraryCard
        ? (scholar.libraryCredential?.id ?? null)
        : (link?.loginUsername ?? null);
      const hasPassword = usesLibraryCard
        ? !!scholar.libraryCredential?.password
        : !!link?.loginPassword;

      rows.push({
        // Present for a direct add OR a grant-parked row; null for a
        // granted-only app with no per-scholar row yet (setCredentials
        // materialises one on demand).
        scholarAppId: link?._id ?? null,
        appId: app._id,
        name: app.name,
        webUrl: app.webUrl,
        webAllowedHosts: app.webAllowedHosts ?? null,
        iconUrl: await resolveAppIconUrl(ctx, app),
        iconEmoji: app.iconEmoji ?? null,
        color: app.color ?? null,
        // `enabled`/`source` describe the DIRECT add (the only thing the on/off
        // toggle touches); default to enabled for a granted-only row.
        enabled: link?.enabled ?? true,
        source: link?.source ?? null,
        isDefault: !!app.defaultForNewScholars,
        archived: !!app.archived,
        // Where this app's login comes from — lets the panel label the field
        // ("Library card number" vs "App username") and edit the right store.
        credentialSource: app.credentialSource ?? null,
        // Account-link state for the teacher Sign-in panel. The username is
        // not a secret (shown); the password is opt-in plaintext (only its
        // presence is surfaced, never the value).
        loginUsername,
        hasPassword,
        // ── Derived provenance (plan §6.4). Never stored, so never stale.
        //    `direct` gates the on/off toggle + Remove (granted rows are
        //    read-only); the grant lists drive the "via <group>" / "School-wide"
        //    chips.
        direct,
        grantGroups: prov.groups,
        grantInstitution: prov.institution,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  },
});

async function requireScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Doc<"users">> {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) {
    throw new Error("Scholar not found");
  }
  return scholar;
}

/**
 * Add an app to a scholar's launcher. Either link an existing catalog
 * app (`appId`) or create one ad-hoc from a pasted URL (`name`+`webUrl`),
 * which dedupes into the catalog by URL. Idempotent per (scholar, app).
 * Teacher/admin/operations staff.
 */
export const addToScholar = scholarAdminMutation({
  args: {
    scholarId: v.id("users"),
    appId: v.optional(v.id("externalApps")),
    // Ad-hoc URL path (when no appId):
    name: v.optional(v.string()),
    webUrl: v.optional(v.string()),
    webAllowedHosts: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireScholar(ctx, args.scholarId);
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    let appId = args.appId ?? null;
    if (!appId) {
      const name = (args.name ?? "").trim();
      const webUrl = (args.webUrl ?? "").trim();
      if (!name || !webUrl) {
        throw new Error("Pick a catalog app or enter a name and URL");
      }
      let host: string;
      try {
        host = new URL(webUrl).hostname.toLowerCase();
      } catch {
        throw new Error("Enter a valid https:// URL");
      }
      // Dedupe ad-hoc URLs into one catalog row.
      const existingApp = await ctx.db
        .query("externalApps")
        .filter((q) => q.eq(q.field("webUrl"), webUrl))
        .first();
      appId =
        existingApp?._id ??
        (await ctx.db.insert("externalApps", {
          name,
          webUrl,
          webAllowedHosts:
            args.webAllowedHosts && args.webAllowedHosts.length > 0
              ? args.webAllowedHosts
                  .map((h) => h.trim().toLowerCase())
                  .filter(Boolean)
              : [registrableHost(host)],
          createdBy: ctx.user._id,
        }));
    }

    // Idempotent: re-enable an existing link rather than duplicate it.
    return coreAddToScholar(ctx, args.scholarId, appId, ctx.user._id);
  },
});

// ── Shared per-scholar link core (public mutation + aide* wrapper) ─────────

/** Idempotently give a scholar a DIRECT (manual) link to an app — re-enabling
 *  an existing link instead of duplicating it. */
async function coreAddToScholar(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  appId: Id<"externalApps">,
  addedBy: Id<"users">,
): Promise<{ scholarAppId: Id<"scholarApps"> }> {
  const existing = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar_app", (q) =>
      q.eq("scholarId", scholarId).eq("appId", appId),
    )
    .first();
  if (existing) {
    if (!existing.enabled) await ctx.db.patch(existing._id, { enabled: true });
    // The OPENING edge nudges too, now that a device's allowlist is a
    // projection of grants rather than a per-launch lease. Under the lease
    // model only revocation needed a hook — adding access could never require
    // closing an unlock — so every "grant given" path here was silent. That
    // left the workflow this system exists for ("a teacher grants the app, the
    // kid taps it") waiting out a 5-minute cron.
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: appId,
      scholarIds: [scholarId],
    });
    return { scholarAppId: existing._id };
  }
  const scholarAppId = await ctx.db.insert("scholarApps", {
    scholarId,
    appId,
    enabled: true,
    source: "manual",
    addedBy,
  });
  await scheduleUnlockRevocationCheck(ctx, {
    externalAppId: appId,
    scholarIds: [scholarId],
  });
  return { scholarAppId };
}

/** Remove a scholar's DIRECT (manual/default) link to an app — never a
 *  grant-parked credential row (those are visibility-neutral + retained). */
async function coreRemoveByScholarAndApp(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  appId: Id<"externalApps">,
): Promise<{ removed: number }> {
  const links = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar_app", (q) =>
      q.eq("scholarId", scholarId).eq("appId", appId),
    )
    .collect();
  let removed = 0;
  for (const l of links) {
    if (l.source === "manual" || l.source === "default") {
      await ctx.db.delete(l._id);
      removed++;
    }
  }
  // A removed direct link may have been the scholar's only route to a
  // managed-native tile — force-close any device it left unlocked. A no-op
  // for a plain web/deep-link app, and a no-op if a group/institution grant
  // still covers them.
  if (removed > 0) {
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: appId,
      scholarIds: [scholarId],
    });
  }
  return { removed };
}

/** Toggle a scholar's app on/off (hides the tile). Teacher/admin/operations staff. */
export const setEnabled = scholarAdminMutation({
  args: {
    scholarAppId: v.id("scholarApps"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.scholarAppId);
    if (!link) throw new Error("Not found");
    await requireActiveScholarAccess(ctx, ctx.user, link.scholarId);
    await ctx.db.patch(args.scholarAppId, { enabled: args.enabled });
    // BOTH edges: the device's allowlist is a projection of this fact now, so
    // turning a tile back ON is as much an allowlist change as turning it off.
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: link.appId,
      scholarIds: [link.scholarId],
    });
  },
});

/** Remove an app from a scholar's launcher (never touches the catalog). */
export const removeFromScholar = scholarAdminMutation({
  args: { scholarAppId: v.id("scholarApps") },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.scholarAppId);
    if (!link) return;
    await requireActiveScholarAccess(ctx, ctx.user, link.scholarId);
    await ctx.db.delete(args.scholarAppId);
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: link.appId,
      scholarIds: [link.scholarId],
    });
  },
});

/**
 * Internal aide wrapper (verified callerUserId, no ctx.user): enable/disable an
 * app for ONE scholar by name/username. Enable adds a direct manual link
 * (idempotent); disable removes the direct link (never a grant-parked
 * credential row). Teacher/admin/operations staff, re-checked from callerUserId.
 */
export const aideSetScholarAccess = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    scholarQuery: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { callerUserId, appName, scholarQuery, enabled }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const caller = scope.caller;
    const app = await resolveAppByName(ctx, appName);
    const scholar = await resolveScholarByNameOrUsername(ctx, scholarQuery, scope);
    const scholarLabel = scholar.name ?? scholar.username ?? "the scholar";
    if (enabled) {
      await coreAddToScholar(ctx, scholar._id, app._id, caller._id);
      return { app: app.name, scholar: scholarLabel, enabled: true };
    }
    const r = await coreRemoveByScholarAndApp(ctx, scholar._id, app._id);
    return { app: app.name, scholar: scholarLabel, enabled: false, removed: r.removed };
  },
});

/**
 * The OWNER's stored login + the catalog's account-link config (powers the
 * embedded-browser "key" autofill + login-page prefill). Self-only: returns
 * the current user's saved login for the app plus where to type on the login
 * page, or null. Returns nothing for anyone else.
 *
 * The secret comes from the app's `credentialSource`:
 *  • "scholarApp" (default) → the per-app scholarApps.loginUsername/Password
 *    (each scholar's own site account).
 *  • "libraryCard" → the scholar's shared users.libraryCredential (PressReader
 *    + any future library-backed app). One card, every library app.
 * Either way the scholar must actually HAVE the app — the same `launcherShowsApp`
 * rule the launcher renders, so a bulk-GRANTED app (which has no per-scholar row
 * until a credential is parked on it) still gets its autofill — and a missing
 * secret yields null (tile still launches, just no autofill).
 */
export const credentialsForApp = authedQuery({
  args: { appId: v.id("externalApps") },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) =>
        q.eq("scholarId", ctx.user._id).eq("appId", args.appId),
      )
      .first();
    // Gate on the LAUNCHER rule, not on the mere existence of a per-scholar
    // row. An app reached only through an `appAudiences` grant has no row until
    // a credential is parked on it — which never happens for a "libraryCard"
    // app, whose secret lives on `users.libraryCredential`. So a group-granted
    // library app returned null here and lost its 🔑 autofill even though the
    // scholar's card was on file.
    const granted = await scholarHasGrantForApp(ctx, ctx.user, args.appId);
    if (!launcherShowsApp({ link, granted })) return null;
    const app = await ctx.db.get(args.appId);
    if (!app) return null;

    let username: string | null;
    let password: string | null;
    if (app.credentialSource === "libraryCard") {
      const lib = ctx.user.libraryCredential;
      username = lib?.id ?? null;
      password = lib?.password ?? null;
    } else {
      username = link?.loginUsername ?? null;
      password = link?.loginPassword ?? null;
    }
    if (!username) return null;

    return {
      username,
      password,
      usernameSelector: app.usernameSelector ?? null,
      passwordSelector: app.passwordSelector ?? null,
      loginUrlPattern: app.loginUrlPattern ?? null,
      // Declarative auto-login flow id (e.g. "pressReaderLibraryCard"). When
      // set, the native host runs a bundled multi-step login script instead of
      // the plain username/password selector fill. See ExternalAppHost.tsx.
      loginFlow: app.loginFlow ?? null,
    };
  },
});

/**
 * Set/update/clear a scholar's stored login for an app. Teacher/admin/operations staff.
 * Merge-safe: an arg left `undefined` is untouched; an empty string clears it.
 * So the username helper can be set without disturbing a saved password.
 *
 * A "libraryCard" app (PressReader) writes the scholar-level
 * users.libraryCredential (shared across library apps) instead of the per-app
 * link — so the same panel edits the store credentialsForApp actually reads.
 */
export const setCredentials = scholarAdminMutation({
  args: {
    scholarId: v.id("users"),
    appId: v.id("externalApps"),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const app = await ctx.db.get(args.appId);
    let link = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) =>
        q.eq("scholarId", args.scholarId).eq("appId", args.appId),
      )
      .first();

    // No per-scholar row yet. Allow parking a credential ONLY for an app the
    // scholar actually HAS via an audience grant (§5) — a scholarApp-credential
    // app gets a lazily-materialised, visibility-neutral source:"grant" row to
    // hold the login (a libraryCard app stores it on the scholar, so it needs
    // no row). Otherwise there's nothing to attach a credential to.
    if (!link) {
      const scholar = await ctx.db.get(args.scholarId);
      if (!scholar) throw new Error("Scholar not found");
      const granted = await scholarHasGrantForApp(ctx, scholar, args.appId);
      if (!granted) throw new Error("Scholar has no link for this app");
      if (app?.credentialSource !== "libraryCard") {
        const grantLinkId = await ctx.db.insert("scholarApps", {
          scholarId: args.scholarId,
          appId: args.appId,
          enabled: true,
          source: "grant",
          addedBy: ctx.user._id,
        });
        link = await ctx.db.get(grantLinkId);
      }
    }

    if (app?.credentialSource === "libraryCard") {
      // Merge onto the scholar-level library credential. `id` is the key: with
      // no id the whole credential clears (an object can't hold a lone PIN).
      const scholar = await ctx.db.get(args.scholarId);
      const cur = scholar?.libraryCredential;
      let id = cur?.id ?? "";
      let password = cur?.password ?? "";
      if (args.username !== undefined) id = args.username.trim();
      if (args.password !== undefined) password = args.password;
      const revision =
        libraryCredentialRevision(
          cur,
          scholar?.libraryCredentialRevision,
        ) + 1;
      await ctx.db.patch(args.scholarId, {
        libraryCredential: id ? { id, password } : undefined,
        libraryCredentialRevision: revision,
      });
      return;
    }

    if (!link) throw new Error("Scholar has no link for this app");
    const patch: { loginUsername?: string | undefined; loginPassword?: string | undefined } = {};
    if (args.username !== undefined) patch.loginUsername = args.username.trim() || undefined;
    if (args.password !== undefined) patch.loginPassword = args.password || undefined;
    await ctx.db.patch(link._id, patch);
  },
});

// Dev-only: set a stored password by username (CLI-runnable, no auth gate).
export const devSetPassword = internalMutation({
  args: { username: v.string(), appId: v.id("externalApps"), password: v.string() },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (!u) throw new Error("no user");
    const link = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) =>
        q.eq("scholarId", u._id).eq("appId", args.appId),
      )
      .first();
    if (!link) throw new Error("no link");
    await ctx.db.patch(link._id, { loginPassword: args.password });
  },
});

// Deliberately invalid fictional credentials for local/dev autofill wiring.
// Never put a real library card or PIN in source or seeded data.
const TEST_LIBRARY_CARD = { id: "0000000000", password: "0000" } as const;

/** Resolve a scholar by userId (preferred) or username. Throws if not found. */
async function resolveUser(
  ctx: MutationCtx,
  args: { username?: string; userId?: Id<"users"> },
): Promise<Doc<"users">> {
  const u = args.userId
    ? await ctx.db.get(args.userId)
    : args.username
      ? await ctx.db
          .query("users")
          .withIndex("by_username", (q) => q.eq("username", args.username!))
          .first()
      : null;
  if (!u) throw new Error("Scholar not found (pass a valid username or userId)");
  return u;
}

/** The PressReader catalog row (by host). Throws until seedPressReader has run. */
async function findPressReaderApp(
  ctx: MutationCtx,
): Promise<Doc<"externalApps">> {
  const apps = await ctx.db.query("externalApps").collect();
  const app = apps.find((a) => a.webUrl.includes("pressreader.com"));
  if (!app)
    throw new Error("PressReader catalog row not seeded — run seedPressReader");
  return app;
}

/**
 * Provision one scholar for PressReader: store their SCHOLAR-LEVEL library
 * credential (card # + PIN in users.libraryCredential) and ensure an ENABLED
 * PressReader launcher link. Idempotent and NON-DESTRUCTIVE: the credential is
 * written only when a card/PIN is explicitly passed, or when the scholar has
 * none yet — a bare re-run never clobbers a card that's already stored. The
 * link carries no per-app login (PressReader reads the shared library
 * credential via credentialSource: "libraryCard").
 */
async function provisionPressReader(
  ctx: MutationCtx,
  userId: Id<"users">,
  app: Doc<"externalApps">,
  cred?: { card?: string; pin?: string },
): Promise<{ scholarAppId: Id<"scholarApps">; linked: boolean }> {
  const user = await ctx.db.get(userId);
  const explicit = cred?.card !== undefined || cred?.pin !== undefined;
  if (explicit || !user?.libraryCredential) {
    const current = user?.libraryCredential;
    const revision =
      libraryCredentialRevision(current, user?.libraryCredentialRevision) + 1;
    await ctx.db.patch(userId, {
      libraryCredential: {
        id: cred?.card ?? current?.id ?? TEST_LIBRARY_CARD.id,
        password:
          cred?.pin ?? current?.password ?? TEST_LIBRARY_CARD.password,
      },
      libraryCredentialRevision: revision,
    });
  }
  const existing = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar_app", (q) =>
      q.eq("scholarId", userId).eq("appId", app._id),
    )
    .first();
  if (existing) {
    if (!existing.enabled) await ctx.db.patch(existing._id, { enabled: true });
    return { scholarAppId: existing._id, linked: false };
  }
  const scholarAppId = await ctx.db.insert("scholarApps", {
    scholarId: userId,
    appId: app._id,
    enabled: true,
    source: "manual",
  });
  return { scholarAppId, linked: true };
}

/**
 * CLI-runnable (internal): provision ONE scholar (by userId or username) for
 * PressReader — set their library credential + PressReader launcher link.
 * Generic, so it runs on PROD for a specific scholar (with approval) as well as
 * on dev. When card/pin are omitted it defaults to the shared Hawai'i State
 * Public Library System test card ONLY if the scholar has no credential yet;
 * a bare re-run never overwrites a real card. Assumes seedPressReader has
 * registered the catalog row.
 */
export const provisionPressReaderForScholar = internalMutation({
  args: {
    username: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    card: v.optional(v.string()),
    pin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const u = await resolveUser(ctx, args);
    const app = await findPressReaderApp(ctx);
    return provisionPressReader(ctx, u._id, app, {
      card: args.card,
      pin: args.pin,
    });
  },
});

/**
 * DEV-ONLY (CLI/seed): provision EVERY scholar for PressReader with the shared
 * test card, so the embedded auto-login is clickable for any dev seed user.
 * Guarded off prod (prod is provisioned per-scholar via
 * provisionPressReaderForScholar). Idempotent.
 */
export const seedPressReaderForAllScholars = internalMutation({
  args: { card: v.optional(v.string()), pin: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isProductionDeployment = (() => {
      const cloudUrl = process.env.CONVEX_CLOUD_URL;
      if (!cloudUrl) return false;
      return isPublicProductionDeployment("RABBITHOLE_ALLOW_DEV_FIXTURES");
    })();
    if (isProductionDeployment) {
      console.log("seedPressReaderForAllScholars: skipped (prod).");
      return { scholars: 0, linked: 0 };
    }
    const app = await findPressReaderApp(ctx);
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    let linked = 0;
    for (const s of scholars) {
      const r = await provisionPressReader(ctx, s._id, app, {
        card: args.card,
        pin: args.pin,
      });
      if (r.linked) linked++;
    }
    return { scholars: scholars.length, linked };
  },
});
