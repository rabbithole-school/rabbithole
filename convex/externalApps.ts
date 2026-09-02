// External Apps — the org catalog of standing, launchable external web apps
// that attach to a scholar's home launcher.
//
// This module owns the CATALOG (the `externalApps` table) + the
// generic default-app backfill. Per-scholar wiring (which apps a scholar has,
// launcher reads, the teacher panel) lives in scholarApps.ts.
//
// Distinct from a kind="web" activity: an External App is durable and
// standing, not a scheduled assignment. Launching one reuses the same
// domain-locked webview + webActivitySessions capture pipeline.
// See review/external-apps-launcher.html.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import {
  scholarAdminMutation,
  staffQuery,
} from "./lib/customFunctions";
import { ROLES } from "./lib/roles";
import { seedDefaultAppsForScholar } from "./lib/externalAppsSeed";
import {
  hostOf,
  registrableHost,
  requireScholarAdminScope,
  resolveAppByName,
} from "./lib/externalAppsResolve";
import {
  externalAppWithinLens,
  liveReachOfExternalApp,
} from "./lib/externalAppReach";
import { normalizeAppTileEmoji } from "../shared/appTileMark";
import type { Doc, Id } from "./_generated/dataModel";
import {
  scheduleUnlockRevocationCheck,
  scheduleUnlockRevocationCheckForKey,
} from "./lib/deviceAppUnlockScheduling";
import { managedNativeAppKeyForScheme } from "./lib/managedNativeApps";
import { resolveAppIconUrl } from "./lib/externalAppIconUrl";

// The catalog fields an app can be created/updated with (shared by the public
// mutations + the aide* wrappers). `credentialSource` picks where autofill pulls
// the stored login from ("scholarApp" = per-scholar site account; "libraryCard"
// = the scholar's shared library credential).
const credentialSourceValidator = v.union(
  v.literal("scholarApp"),
  v.literal("libraryCard"),
);

// A native app URL scheme is a scheme-URL prefix like "googlesheets://" — a
// scheme (letter, then letters/digits/+/-/.) followed by "://". Presence on a
// catalog app means "this app is also launchable as an INSTALLED native iOS
// app"; the native launcher opens it via Linking.openURL. Deliberately NO
// installed-app detection and NO bundle-id field — visibility is staff-assigned.
const NATIVE_URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Trim + validate a native app URL scheme. Empty/whitespace clears the field
 *  (undefined), matching the "empty string clears an optional text field"
 *  convention the catalog patch uses; a non-empty value must be a scheme URL. */
function normalizeNativeUrlScheme(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!NATIVE_URL_SCHEME_RE.test(trimmed)) {
    throw new Error(
      'Enter a native app URL scheme like "googlesheets://"',
    );
  }
  return trimmed;
}


// PressReader — library-card sign-in (spike). Reuses the launcher /
// domain-locked webview infrastructure, but its sign-in is a MULTI-step
// library flow (open the "Library or Group Sign In" modal → pick the library →
// enter card # + PIN → agree checkbox → Log In), so a plain username/password
// selector fill isn't enough. Instead it declares `loginFlow`, which the native
// host maps to a bundled auto-login script (see ExternalAppHost.tsx). The
// scholar's stored login = their library CARD NUMBER + PIN, held at the SCHOLAR
// level in users.libraryCredential (shared across every library-backed app),
// which this app opts into with `credentialSource: "libraryCard"`.
//
// Deep-link straight to the library-card sign-in (per Hawaii State Public
// Library System instructions: Sign In → Library or Group). Because the native
// host is a real WebView (not an iframe), PressReader's anti-iframe headers
// don't block embedding.
export const PRESSREADER = {
  name: "PressReader",
  webUrl: "https://www.pressreader.com/catalog/librarycard",
  webAllowedHosts: ["pressreader.com"],
  color: "#00857b",
  // Bare `/catalog/librarycard` is the library-card sign-in entry point.
  loginUrlPattern: "/catalog/librarycard",
  // Heuristic fallbacks (the bundled flow does the real work, but keep these so
  // the 🔑 button still has selectors if the flow is ever cleared).
  usernameSelector:
    "input[name*=card i], input[name*=barcode i], input[type=text], input[type=tel]",
  passwordSelector: "input[type=password]",
  loginFlow: "pressReaderLibraryCard",
  // The scholar's stored login for PressReader is their PUBLIC-LIBRARY card,
  // which lives at the SCHOLAR level (users.libraryCredential) — shared by every
  // library-backed app — not on the per-app scholarApps link.
  credentialSource: "libraryCard",
} as const;


/**
 * Idempotently ensure the PressReader catalog row exists (spike). Like
 * other single-provider seed helpers, this only maintains the catalog row + its account-link /
 * auto-login config; it is NOT flagged `defaultForNewScholars`, so it's
 * assigned to scholars manually (teacher panel) or by the dev seed. Self-heals
 * an existing row's webUrl / selectors / loginFlow. Returns its id. Internal —
 * safe to re-run.
 */
export const seedPressReader = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("externalApps").collect();
    const existing = all.find((a) => a.webUrl.includes("pressreader.com"));
    if (existing) {
      await ctx.db.patch(existing._id, {
        defaultForNewScholars: undefined,
        archived: undefined,
        name: existing.name ?? PRESSREADER.name,
        webUrl: PRESSREADER.webUrl,
        webAllowedHosts: [...PRESSREADER.webAllowedHosts],
        color: existing.color ?? PRESSREADER.color,
        loginUrlPattern: PRESSREADER.loginUrlPattern,
        usernameSelector: PRESSREADER.usernameSelector,
        passwordSelector: PRESSREADER.passwordSelector,
        loginFlow: PRESSREADER.loginFlow,
        credentialSource: PRESSREADER.credentialSource,
      });
      return existing._id;
    }
    return await ctx.db.insert("externalApps", {
      name: PRESSREADER.name,
      webUrl: PRESSREADER.webUrl,
      webAllowedHosts: [...PRESSREADER.webAllowedHosts],
      color: PRESSREADER.color,
      loginUrlPattern: PRESSREADER.loginUrlPattern,
      usernameSelector: PRESSREADER.usernameSelector,
      passwordSelector: PRESSREADER.passwordSelector,
      loginFlow: PRESSREADER.loginFlow,
      credentialSource: PRESSREADER.credentialSource,
    });
  },
});


/**
 * One-shot backfill: seed every existing scholar with the default apps
 * they don't already have (any catalog row flagged
 * `defaultForNewScholars`). Idempotent — safe to re-run. Generic infra:
 * it is a no-op until a catalog app is flagged default.
 */
export const backfillDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    let added = 0;
    for (const s of scholars) {
      added += await seedDefaultAppsForScholar(ctx, s._id);
    }
    return { scholars: scholars.length, linksAdded: added };
  },
});

/**
 * Admin tool: restrict an app's launcher visibility to a specific set of
 * scholars — deletes every `scholarApps` link for the app that isn't in
 * `keepScholarIds`, and optionally stops auto-seeding it onto new scholars
 * (`unsetDefault`). The inverse of backfillDefaults: scope a rolled-out
 * app back down to a pilot group. Internal — run via CLI.
 */
export const restrictToScholars = internalMutation({
  args: {
    appId: v.id("externalApps"),
    keepScholarIds: v.array(v.id("users")),
    unsetDefault: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const keep = new Set(args.keepScholarIds.map((id) => String(id)));
    const links = await ctx.db
      .query("scholarApps")
      .withIndex("by_app", (q) => q.eq("appId", args.appId))
      .collect();
    let removed = 0;
    let kept = 0;
    for (const link of links) {
      if (keep.has(String(link.scholarId))) {
        kept++;
        continue;
      }
      await ctx.db.delete(link._id);
      removed++;
    }
    if (args.unsetDefault) {
      await ctx.db.patch(args.appId, { defaultForNewScholars: undefined });
    }
    return { removed, kept };
  },
});

/**
 * The catalog picker: all non-archived External Apps, for the teacher's
 * "Add app from catalog" list, and the Web Assignment activity editor's
 * "Use an External App" picker. Non-sensitive (names/URLs/icons), so open
 * to all staff incl. curriculum designers who author web activities.
 */
export const listCatalog = staffQuery({
  args: {},
  handler: async (ctx) => {
    const apps = await ctx.db.query("externalApps").collect();
    const visible = apps.filter((a) => !a.archived);
    const rows = await Promise.all(
      visible.map(async (a) => ({
        _id: a._id,
        name: a.name,
        webUrl: a.webUrl,
        webAllowedHosts: a.webAllowedHosts ?? null,
        iconUrl: await resolveAppIconUrl(ctx, a),
        iconEmoji: a.iconEmoji ?? null,
        color: a.color ?? null,
        defaultForNewScholars: !!a.defaultForNewScholars,
      })),
    );
    return rows.sort((x, y) => x.name.localeCompare(y.name));
  },
});

/**
 * Create a catalog app (teacher/admin/operations staff — both staff trusted).
 * Used by the admin App Catalog and indirectly when a teacher pastes an
 * ad-hoc URL on a scholar's panel (scholarApps.addToScholar dedupes into
 * this). Derives the allowlist from the URL host when not supplied.
 */
export const createCatalogApp = scholarAdminMutation({
  args: {
    name: v.string(),
    webUrl: v.string(),
    webAllowedHosts: v.optional(v.array(v.string())),
    iconUrl: v.optional(v.string()),
    iconEmoji: v.optional(v.string()),
    color: v.optional(v.string()),
    defaultForNewScholars: v.optional(v.boolean()),
    credentialSource: v.optional(credentialSourceValidator),
    nativeUrlScheme: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"externalApps">> =>
    coreCreateApp(ctx, args, ctx.user._id),
});

// ── Shared catalog-write core (public mutations + aide* wrappers) ──────────

type CreateAppInput = {
  name: string;
  webUrl: string;
  webAllowedHosts?: string[];
  iconUrl?: string;
  iconEmoji?: string;
  color?: string;
  defaultForNewScholars?: boolean;
  credentialSource?: "scholarApp" | "libraryCard";
  nativeUrlScheme?: string;
};

async function coreCreateApp(
  ctx: MutationCtx,
  args: CreateAppInput,
  createdBy: Id<"users">,
): Promise<Id<"externalApps">> {
  const name = args.name.trim();
  const webUrl = args.webUrl.trim();
  if (!name) throw new Error("Name is required");
  const host = hostOf(webUrl);
  if (!host) throw new Error("Enter a valid https:// URL");
  const allowed =
    args.webAllowedHosts && args.webAllowedHosts.length > 0
      ? args.webAllowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)
      : [registrableHost(host)];
  return await ctx.db.insert("externalApps", {
    name,
    webUrl,
    webAllowedHosts: allowed,
    iconUrl: args.iconUrl?.trim() || undefined,
    iconEmoji: normalizeAppTileEmoji(args.iconEmoji),
    color: args.color?.trim() || undefined,
    defaultForNewScholars: args.defaultForNewScholars || undefined,
    credentialSource: args.credentialSource,
    nativeUrlScheme: normalizeNativeUrlScheme(args.nativeUrlScheme),
    createdBy,
  });
}

// The catalog fields `updateCatalogApp` / `aideUpdateApp` can patch. Shared so
// both functions declare an identical arg surface.
const catalogPatchArgs = {
  name: v.optional(v.string()),
  webUrl: v.optional(v.string()),
  webAllowedHosts: v.optional(v.array(v.string())),
  iconUrl: v.optional(v.string()),
  iconEmoji: v.optional(v.string()),
  color: v.optional(v.string()),
  defaultForNewScholars: v.optional(v.boolean()),
  credentialSource: v.optional(credentialSourceValidator),
  loginUrlPattern: v.optional(v.string()),
  usernameSelector: v.optional(v.string()),
  passwordSelector: v.optional(v.string()),
  loginFlow: v.optional(v.string()),
  nativeUrlScheme: v.optional(v.string()),
} as const;

type UpdateAppInput = {
  name?: string;
  webUrl?: string;
  webAllowedHosts?: string[];
  iconUrl?: string;
  iconEmoji?: string;
  color?: string;
  defaultForNewScholars?: boolean;
  credentialSource?: "scholarApp" | "libraryCard";
  loginUrlPattern?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  loginFlow?: string;
  nativeUrlScheme?: string;
};

/** Patch only the provided fields of a catalog app. Empty string clears an
 *  optional text field; a new `webUrl` re-derives the host allowlist unless one
 *  is supplied alongside it.
 *
 *  TENANT GATE: `externalApps` deliberately has no `institutionId` — the catalog
 *  is shared so several schools can grant the same third-party app — so the
 *  boundary is REACH CONTAINMENT, the same shape customApps.appIsWithinLens
 *  uses: a caller may mutate a catalog app iff every scholar it CURRENTLY
 *  REACHES is inside their institution lens (or it reaches nobody and they
 *  created it). This is the choke point all four entry points share
 *  (updateCatalogApp / setCatalogAppArchived / aideUpdateApp / aideSetAppArchived),
 *  so no caller can route around it. `webUrl` is the dangerous field: changing
 *  it re-derives `webAllowedHosts`, so the locked webview follows it — an
 *  ungated writer let school B repoint an app school A's children open. */
async function coreUpdateApp(
  ctx: MutationCtx,
  caller: Doc<"users">,
  appId: Id<"externalApps">,
  patch: UpdateAppInput,
): Promise<Doc<"externalApps">> {
  const app = await ctx.db.get(appId);
  if (!app) throw new Error("App not found");
  await assertCatalogAppWritable(ctx, caller, app);
  // Resolve the OLD managed key + who currently reaches this app BEFORE any
  // patch — same discipline as coreSetArchived's archive edge. Only matters
  // when nativeUrlScheme is actually being touched; a managed app can lose
  // its managed identity here (swapped to a different managed app, or
  // cleared back to a plain web app) exactly like an archive does, and the
  // OLD identity's device unlocks need the same force-close, even though
  // authorization itself doesn't flip to false (a different app now owns
  // that reach — the tile just points somewhere else).
  const oldManagedKey = managedNativeAppKeyForScheme(app.nativeUrlScheme);
  // Reach is resolved for ANY scheme change, not only for an app that was
  // already managed. The closing edge below needs it when the OLD scheme was
  // managed; the opening edge needs it when the NEW one is — a plain web app
  // repointed at a managed native scheme newly belongs in every reachable
  // scholar's device allowlist, which the lease model had no reason to notice
  // because gaining a scheme could not open anything.
  const affectedScholarIds =
    patch.nativeUrlScheme !== undefined
      ? Array.from(await liveReachOfExternalApp(ctx, appId))
      : [];
  const updates: Partial<Doc<"externalApps">> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("Name cannot be empty");
    updates.name = name;
  }
  const explicitHosts =
    patch.webAllowedHosts && patch.webAllowedHosts.length > 0
      ? patch.webAllowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)
      : null;
  if (patch.webUrl !== undefined) {
    const webUrl = patch.webUrl.trim();
    const host = hostOf(webUrl);
    if (!host) throw new Error("Enter a valid https:// URL");
    updates.webUrl = webUrl;
    // Re-derive the allowlist from the new URL when no explicit one is given.
    if (!explicitHosts) updates.webAllowedHosts = [registrableHost(host)];
  }
  if (explicitHosts) updates.webAllowedHosts = explicitHosts;
  if (patch.iconUrl !== undefined)
    updates.iconUrl = patch.iconUrl.trim() || undefined;
  if (patch.iconEmoji !== undefined)
    updates.iconEmoji = normalizeAppTileEmoji(patch.iconEmoji);
  if (patch.color !== undefined)
    updates.color = patch.color.trim() || undefined;
  if (patch.defaultForNewScholars !== undefined)
    updates.defaultForNewScholars = patch.defaultForNewScholars || undefined;
  if (patch.credentialSource !== undefined)
    updates.credentialSource = patch.credentialSource;
  if (patch.loginUrlPattern !== undefined)
    updates.loginUrlPattern = patch.loginUrlPattern.trim() || undefined;
  if (patch.usernameSelector !== undefined)
    updates.usernameSelector = patch.usernameSelector.trim() || undefined;
  if (patch.passwordSelector !== undefined)
    updates.passwordSelector = patch.passwordSelector.trim() || undefined;
  if (patch.loginFlow !== undefined)
    updates.loginFlow = patch.loginFlow.trim() || undefined;
  if (patch.nativeUrlScheme !== undefined)
    updates.nativeUrlScheme = normalizeNativeUrlScheme(patch.nativeUrlScheme);
  if (Object.keys(updates).length > 0) await ctx.db.patch(appId, updates);
  const updated = (await ctx.db.get(appId))!;
  if (oldManagedKey && affectedScholarIds.length > 0) {
    const newManagedKey = managedNativeAppKeyForScheme(updated.nativeUrlScheme);
    if (newManagedKey !== oldManagedKey) {
      // The catalog entry no longer maps to the OLD managed app (swapped to a
      // different one, or dropped back to plain web) — that old app's device
      // unlocks must be force-closed the same way an archive would, or a
      // scholar could keep an already-unlocked Sheets/SPIKE iPad usable for
      // up to 8h after a teacher repointed the tile elsewhere. Deliberately
      // scoped to the OLD key only: scheduleUnlockRevocationCheckForKey never
      // touches the new key, so a fresh swap-in is never spuriously closed.
      await scheduleUnlockRevocationCheckForKey(ctx, {
        appKey: oldManagedKey,
        scholarIds: affectedScholarIds,
      });
    }
  }
  // The OPENING edge of the same change: a plain web app repointed AT a
  // managed native scheme (or swapped from one managed app to another) newly
  // belongs in every reachable scholar's device allowlist. The branch above
  // only ever closed the OLD key, because under the lease model gaining a
  // scheme could not open anything. `scheduleUnlockRevocationCheck` no-ops for
  // a non-managed app, so this is a single guarded call rather than a second
  // scheme classification.
  if (affectedScholarIds.length > 0) {
    const newManagedKey = managedNativeAppKeyForScheme(updated.nativeUrlScheme);
    if (newManagedKey && newManagedKey !== oldManagedKey) {
      await scheduleUnlockRevocationCheckForKey(ctx, {
        appKey: newManagedKey,
        scholarIds: affectedScholarIds,
      });
    }
  }
  return updated;
}


async function coreSetArchived(
  ctx: MutationCtx,
  caller: Doc<"users">,
  appId: Id<"externalApps">,
  archived: boolean,
): Promise<Doc<"externalApps">> {
  const app = await ctx.db.get(appId);
  if (!app) throw new Error("App not found");
  await assertCatalogAppWritable(ctx, caller, app);
  // Resolve BEFORE the patch, same discipline as appAudiences.ts's unassign —
  // archiving flips authorization to false for every scholar currently
  // reachable, so a managed-native app that was still unlocked on a device
  // must have its unlock force-closed too. Reuse the SAME live-reach
  // computation the write-gate above already trusts, rather than a second
  // "who does this app reach" pass, and route through the ONE nudge primitive
  // both the direct scholarApps and appAudiences paths already call — this
  // covers the web/core AND Slack archive paths identically, since both call
  // this function.
  //
  // BOTH edges are nudged now. Archiving still revokes; un-archiving RESTORES
  // a managed app to every reachable scholar's device allowlist, which the
  // lease model had no reason to care about (it could not open anything) but
  // the projection does. Reach is resolved before the patch either way — on
  // the archive edge because the grants are about to stop counting, and on the
  // un-archive edge because it is the same set.
  const flipping = archived !== !!app.archived;
  const affectedScholarIds = flipping
    ? Array.from(await liveReachOfExternalApp(ctx, appId))
    : [];
  await ctx.db.patch(appId, { archived: archived ? true : undefined });
  if (affectedScholarIds.length > 0) {
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: appId,
      scholarIds: affectedScholarIds,
    });
  }
  return (await ctx.db.get(appId))!;
}

/** Refuse a catalog write unless the caller's tenant contains every scholar the
 *  app currently reaches (or it reaches nobody and they created it).
 *
 *  The allowed set comes from `requireScholarAdminScope`, the SAME resolver the
 *  rest of this module's name lookups and the appAudiences read filters use —
 *  deliberately not a second lens derived from `institutionLens` here. Using one
 *  resolver keeps the aide and web paths identical (a bare user doc loses the
 *  enrichment the web path carries, which made the aide strictly MORE permissive
 *  than the public mutation) and keeps a membership-less staffer consistent:
 *  requireScholarAdminScope admits them via its primary-school fallback, so the
 *  gate must not then refuse them with a misleading cross-school message.
 *  `scholars === "all"` is a platform admin → unrestricted.
 *
 *  Accepted consequence, commented as intentional: an app that genuinely reaches
 *  TWO schools is editable ONLY by a platform admin. That is correct — editing it
 *  changes what children at another school load — and it is why the gate is
 *  reach-based rather than ownership-based.
 *
 *  KNOWN GAP (tracked, not fixed here): `scholarApps.addToScholar` gates the
 *  SCHOLAR but takes `appId` raw, so a staffer can attach any catalog app to
 *  their own scholar and widen its reach — freezing the app's rightful school
 *  out of editing it. The containment rule is still right (those children really
 *  do have the app now); the durable fix is distinguishing a school-PRIVATE
 *  catalog row from a genuinely shared one, which is a schema change.
 */
async function assertCatalogAppWritable(
  ctx: MutationCtx,
  caller: Doc<"users">,
  app: Doc<"externalApps">,
): Promise<void> {
  const { scholars } = await requireScholarAdminScope(ctx, caller._id);
  const allowed = scholars === "all" ? undefined : scholars;
  const within = await externalAppWithinLens(
    ctx,
    app._id,
    app.createdBy,
    caller._id,
    allowed,
  );
  if (within) return;
  // Distinguish the two refusal causes: "another school" is false for an app
  // that reaches nobody and simply was not created by this caller.
  const reaches = (await liveReachOfExternalApp(ctx, app._id)).size > 0;
  throw new Error(
    reaches
      ? "That app is in use by another school, so it can't be changed here."
      : "Only the staff member who added that app can change it while no scholar is using it.",
  );
}

/**
 * Reconfigure a catalog app (teacher/admin/operations staff). Patches only the fields
 * supplied — name, URL (re-derives the host allowlist), icon, color, default
 * flag, credential source, and the login-helper selectors/flow.
 */
export const updateCatalogApp = scholarAdminMutation({
  args: { appId: v.id("externalApps"), ...catalogPatchArgs },
  handler: async (ctx, { appId, ...patch }): Promise<void> => {
    await coreUpdateApp(ctx, ctx.user, appId, patch);
  },
});

/**
 * Archive (hide from the catalog) or un-archive a catalog app. Archiving never
 * deletes grants or per-scholar links — it just removes the tile from the
 * pickers/launcher; un-archiving restores it.
 */
export const setCatalogAppArchived = scholarAdminMutation({
  args: { appId: v.id("externalApps"), archived: v.boolean() },
  handler: async (ctx, args): Promise<void> => {
    await coreSetArchived(ctx, ctx.user, args.appId, args.archived);
  },
});

// ── Internal aide* wrappers (verified callerUserId, no ctx.user) ───────────

export const aideCreateApp = internalMutation({
  args: {
    callerUserId: v.id("users"),
    name: v.string(),
    webUrl: v.string(),
    webAllowedHosts: v.optional(v.array(v.string())),
    iconUrl: v.optional(v.string()),
    iconEmoji: v.optional(v.string()),
    color: v.optional(v.string()),
    defaultForNewScholars: v.optional(v.boolean()),
    credentialSource: v.optional(credentialSourceValidator),
    nativeUrlScheme: v.optional(v.string()),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    await requireScholarAdminScope(ctx, callerUserId);
    // Dedupe on webUrl, exactly as the sibling `install_external_app` path does
    // (customApps.installExistingUrlApp). A model that retries a tool call — or
    // reaches for `create_external_app` for a site the catalog already has —
    // must not leave two tiles behind. The web Apps tab keeps the plain
    // always-insert `createCatalogApp`, where a human is the dedupe.
    const webUrl = args.webUrl.trim();
    const existing = await ctx.db
      .query("externalApps")
      .filter((q) => q.eq(q.field("webUrl"), webUrl))
      .first();
    if (existing) {
      return { appId: existing._id, name: existing.name, deduped: true };
    }
    const appId = await coreCreateApp(ctx, args, callerUserId);
    const app = await ctx.db.get(appId);
    return { appId, name: app?.name ?? args.name, deduped: false };
  },
});

export const aideUpdateApp = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    ...catalogPatchArgs,
  },
  handler: async (ctx, { callerUserId, appName, ...patch }) => {
    const { caller } = await requireScholarAdminScope(ctx, callerUserId);
    const app = await resolveAppByName(ctx, appName);
    const updated = await coreUpdateApp(ctx, caller, app._id, patch);
    return { appId: app._id, name: updated.name };
  },
});

export const aideSetAppArchived = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    archived: v.boolean(),
  },
  handler: async (ctx, { callerUserId, appName, archived }) => {
    const { caller } = await requireScholarAdminScope(ctx, callerUserId);
    const app = await resolveAppByName(ctx, appName);
    const updated = await coreSetArchived(ctx, caller, app._id, archived);
    return { appId: app._id, name: updated.name, archived: !!updated.archived };
  },
});
