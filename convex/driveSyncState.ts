// State + cursor for the watched Google Drive folder feeding the portfolio.
//
// Non-node (queries/mutations) half of the Drive sync feature. The action
// half (Drive API calls, watch registration, file download) lives in
// `driveSync.ts` ("use node"). The webhook receiver is the `/drive-webhook`
// route in `http.ts`, forwarded from `app/api/drive/webhook/route.ts`.
//
// PER-INSTITUTION: one row per institution (keyed by `institutionId`, still
// indexed by `folderId` for channel-ops). The sync identity is an
// institution-owned credential (`institutionGoogleAccounts`, `credentialRef`),
// not a person's link — see driveSync.ts + review/drive-sync-institution-accounts-plan.html.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  schoolAdminQuery,
  teacherMutation,
  scholarAdminQuery,
} from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { isPlatformAdminRole, isSchoolAdminRole } from "./lib/roles";
import {
  getGoogleScopeCapability,
  INSTITUTION_WORKSPACE_BOT_SCOPES,
  type WorkspaceBotPurpose,
} from "./lib/google";

// ── Internal reads ──────────────────────────────────────────────────────

/**
 * Legacy: the single sync row (or null). Retained for the safety-net path and
 * migration; the fan-out now resolves rows by institution.
 */
export const getDefaultInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("driveSyncState").first();
  },
});

/** The sync row for one institution (or null). */
export const getByInstitutionInternal = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("driveSyncState")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .first();
  },
});

/** Every configured sync row — the cron fan-out iterates these (one per school). */
export const listConfiguredInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("driveSyncState").collect();
  },
});

/** Look up a row by the push channelId (webhook token validation). */
export const getByChannelInternal = internalQuery({
  args: { channelId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("driveSyncState").collect();
    return rows.find((r) => r.channelId === args.channelId) ?? null;
  },
});

/** Read one institution credential (token resolver + admin status). */
export const getCredentialInternal = internalQuery({
  args: { credentialId: v.id("institutionGoogleAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.credentialId);
  },
});

/** The institution's credential (or null) — used by connect + admin status. */
export const getCredentialByInstitutionInternal = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    const credentials = await ctx.db
      .query("institutionGoogleAccounts")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .collect();
    return credentials.find((credential) => credential.purpose === undefined) ?? null;
  },
});

/** Prefer the shared Workspace principal, with legacy Docs-bot fallback. */
export const getWorkspaceBotCredentialByInstitutionInternal = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    const credentials = await ctx.db
      .query("institutionGoogleAccounts")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .collect();
    return (
      credentials.find((credential) => credential.purpose === "workspace_bot") ??
      credentials.find((credential) => credential.purpose === "docs_bot") ??
      null
    );
  },
});

/** @deprecated Compatibility name for callers still using the Docs-bot label. */
export const getDocsBotCredentialByInstitutionInternal =
  getWorkspaceBotCredentialByInstitutionInternal;

/**
 * Resolve the institution an action caller is acting in, applying the same
 * membership WRITE guard as the query-side lens: a school_admin is pinned to
 * their own institution (an unauthorized `scope` falls back to home, never
 * honored); a platform_admin may act in any institution via `scope`. Returns
 * the resolved institution or null (pre-institution dev data). Actions call
 * this because they have no `ctx.db` to run the lens directly.
 */
export const resolveInstitutionForCaller = internalQuery({
  args: { userId: v.id("users"), scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");
    const lens = await resolveInstitutionLens(ctx, user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) return null;
    return {
      institutionId: institution._id,
      name: institution.name,
      slug: institution.slug,
      emoji: institution.emoji ?? null,
      // Whether the requested scope was actually granted to this caller.
      honored: lens.honored,
      isAdmin: lens.isAdmin,
    };
  },
});

/**
 * Re-check the same authority that starts institution OAuth setup. OAuth state
 * is valid for ten minutes, during which roles or memberships may change, so
 * the callback must prove the signer still administers this exact institution.
 */
export const canManageInstitutionGoogleCredentialInternal = internalQuery({
  args: {
    userId: v.id("users"),
    institutionId: v.id("institutions"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (
      !user ||
      (!isSchoolAdminRole(user.role) && !isPlatformAdminRole(user.role))
    ) {
      return false;
    }
    const lens = await resolveInstitutionLens(ctx, user, args.institutionId);
    const institution = lens.institution ?? lens.homeInstitution;
    return !!lens.honored && institution?._id === args.institutionId;
  },
});

// ── Internal writes ─────────────────────────────────────────────────────

/**
 * Create or update the per-institution folder config. Keyed by institution so
 * re-pointing a school's inbox to a new folder updates in place. Also updates
 * the folderId/credentialRef when they change.
 */
export const upsertConfigInternal = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    folderId: v.string(),
    credentialRef: v.id("institutionGoogleAccounts"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("driveSyncState")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        folderId: args.folderId,
        credentialRef: args.credentialRef,
        // Clear the legacy personal-link pointer once we're on a credential.
        syncOwnerUserId: undefined,
      });
      return existing._id;
    }
    return await ctx.db.insert("driveSyncState", {
      institutionId: args.institutionId,
      folderId: args.folderId,
      credentialRef: args.credentialRef,
    });
  },
});

/** Persist the active push channel after a successful changes.watch. */
export const setChannelInternal = internalMutation({
  args: {
    rowId: v.id("driveSyncState"),
    channelId: v.string(),
    resourceId: v.string(),
    channelExpiration: v.number(),
    channelToken: v.string(),
    startPageToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) throw new Error("No driveSyncState row");
    await ctx.db.patch(args.rowId, {
      channelId: args.channelId,
      resourceId: args.resourceId,
      channelExpiration: args.channelExpiration,
      channelToken: args.channelToken,
      startPageToken: args.startPageToken,
    });
  },
});

/** Clear channel fields (after stop / on expiry). */
export const clearChannelInternal = internalMutation({
  args: { rowId: v.id("driveSyncState") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) return;
    await ctx.db.patch(args.rowId, {
      channelId: undefined,
      resourceId: undefined,
      channelExpiration: undefined,
      channelToken: undefined,
    });
  },
});

/** Record the outcome of a sync run (timestamp / error). */
export const setSyncMetaInternal = internalMutation({
  args: {
    rowId: v.id("driveSyncState"),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) return;
    await ctx.db.patch(args.rowId, {
      ...(args.lastSyncedAt !== undefined ? { lastSyncedAt: args.lastSyncedAt } : {}),
      ...(args.lastError !== undefined ? { lastError: args.lastError ?? undefined } : {}),
    });
  },
});

// ── Institution credential writes ───────────────────────────────────────

/**
 * Create or replace one purpose-scoped institution identity. The legacy
 * scanner has no purpose; the Docs bot is a separate `docs_bot` row so a
 * fresh Docs consent cannot replace the scanner's read-only credential.
 */
export const upsertCredentialInternal = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    purpose: v.optional(
      v.union(v.literal("docs_bot"), v.literal("workspace_bot")),
    ),
    identityType: v.union(
      v.literal("google_oauth"),
      v.literal("service_account"),
    ),
    email: v.string(),
    scopes: v.array(v.string()),
    connectedBy: v.optional(v.id("users")),
    // google_oauth
    googleSub: v.optional(v.string()),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    preserveRefreshToken: v.optional(v.boolean()),
    expiresAt: v.optional(v.number()),
    // service_account
    saClientEmail: v.optional(v.string()),
    saPrivateKey: v.optional(v.string()),
    saPrivateKeyId: v.optional(v.string()),
    saClientId: v.optional(v.string()),
    saTokenUri: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"institutionGoogleAccounts">> => {
    const credentials = await ctx.db
      .query("institutionGoogleAccounts")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .collect();
    const existing =
      credentials.find((credential) => credential.purpose === args.purpose) ?? null;
    const doc = {
      institutionId: args.institutionId,
      purpose: args.purpose,
      identityType: args.identityType,
      email: args.email,
      scopes: args.scopes,
      connectedBy: args.connectedBy,
      connectedAt: Date.now(),
      googleSub: args.googleSub,
      accessToken: args.accessToken,
      refreshToken:
        args.refreshToken ??
        (args.preserveRefreshToken !== false &&
        args.identityType === "google_oauth" &&
        existing?.identityType === "google_oauth"
          ? existing.refreshToken
          : undefined),
      expiresAt: args.expiresAt,
      saClientEmail: args.saClientEmail,
      saPrivateKey: args.saPrivateKey,
      saPrivateKeyId: args.saPrivateKeyId,
      saClientId: args.saClientId,
      saTokenUri: args.saTokenUri,
      // Reset any cached SA token on re-link.
      saAccessToken: undefined,
      saAccessTokenExpiresAt: undefined,
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("institutionGoogleAccounts", doc);
  },
});

/** Cache a freshly-minted service-account access token. */
export const updateCredentialSaTokenInternal = internalMutation({
  args: {
    credentialId: v.id("institutionGoogleAccounts"),
    saAccessToken: v.string(),
    saAccessTokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const cred = await ctx.db.get(args.credentialId);
    if (!cred) return;
    await ctx.db.patch(args.credentialId, {
      saAccessToken: args.saAccessToken,
      saAccessTokenExpiresAt: args.saAccessTokenExpiresAt,
    });
  },
});

/** Persist a refreshed OAuth access token on an institution credential. */
export const updateCredentialOAuthTokenInternal = internalMutation({
  args: {
    credentialId: v.id("institutionGoogleAccounts"),
    accessToken: v.string(),
    expiresAt: v.number(),
    refreshToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cred = await ctx.db.get(args.credentialId);
    if (!cred) return;
    await ctx.db.patch(args.credentialId, {
      accessToken: args.accessToken,
      expiresAt: args.expiresAt,
      ...(args.refreshToken ? { refreshToken: args.refreshToken } : {}),
    });
  },
});

/** Set the scanner name + how-to instructions shown in the Add-work panel. */
export const setPrinterInfo = teacherMutation({
  args: {
    name: v.string(),
    instructions: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    // Prefer the caller's institution row; fall back to the first row so a
    // pre-per-institution (legacy) deployment still works.
    const row = institution
      ? (await ctx.db
          .query("driveSyncState")
          .withIndex("by_institution", (q) =>
            q.eq("institutionId", institution._id),
          )
          .first()) ?? (await ctx.db.query("driveSyncState").first())
      : await ctx.db.query("driveSyncState").first();
    if (!row) throw new Error("Connect a folder first");
    await ctx.db.patch(row._id, {
      printerName: args.name.trim() || undefined,
      printerInstructions: args.instructions?.trim() || undefined,
    });
  },
});

// ── Public status (teacher/admin) ───────────────────────────────────────

/**
 * Sanitized sync status for the UI, scoped to the caller's institution. Never
 * exposes the channelToken or any credential secret. Scholar-admin (incl.
 * operations staff) can read it — they operate the scanner inbox (ScannerPanel).
 * Drive-sync SETUP stays school-admin-gated in driveSync.ts.
 *
 * `scope` selects the institution: a school_admin/teacher gets their home
 * school; a platform_admin can pass an institution slug/id to inspect any.
 * The identity block reports the institution credential's type + email in
 * place of the old personal-link owner.
 */
export const status = scholarAdminQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    const row = institution
      ? (await ctx.db
          .query("driveSyncState")
          .withIndex("by_institution", (q) =>
            q.eq("institutionId", institution._id),
          )
          .first()) ??
        // Legacy fallback: a pre-per-institution row (no institutionId yet).
        (await ctx.db
          .query("driveSyncState")
          .filter((q) => q.eq(q.field("institutionId"), undefined))
          .first())
      : await ctx.db.query("driveSyncState").first();

    const institutionInfo = institution
      ? {
          _id: institution._id,
          name: institution.name,
          slug: institution.slug,
          emoji: institution.emoji ?? null,
        }
      : null;

    // Resolve the institution-owned credential (identity block) INDEPENDENTLY
    // of whether a folder is connected yet. The admin saves the identity first
    // (setIdentityServiceAccount / beginScannerOAuth), which writes the
    // credential BEFORE any driveSyncState row exists — so we must not gate the
    // identity on the row, or the UI can never show it (and Connect, which is
    // gated on a visible identity, stays blocked forever: a deadlock). Prefer
    // the connected row's credentialRef, else look the credential up by
    // institution so a just-saved identity shows immediately. Falls back to the
    // legacy personal owner when no credential is linked.
    const cred =
      (row?.credentialRef ? await ctx.db.get(row.credentialRef) : null) ??
      (institution
        ? (
            await ctx.db
              .query("institutionGoogleAccounts")
              .withIndex("by_institution", (q) =>
                q.eq("institutionId", institution._id),
              )
              .collect()
          ).find((credential) => credential.purpose === undefined) ?? null
        : null);
    const identity:
      | {
          type: "google_oauth" | "service_account";
          email: string | null;
          scopes: string[];
        }
      | null = cred
      ? { type: cred.identityType, email: cred.email, scopes: cred.scopes }
      : null;

    if (!row) {
      return {
        configured: false as const,
        institution: institutionInfo,
        identity,
      };
    }

    const legacyOwner = row.syncOwnerUserId
      ? await ctx.db.get(row.syncOwnerUserId)
      : null;

    return {
      configured: true as const,
      institution: institutionInfo,
      folderId: row.folderId,
      printerName: row.printerName ?? null,
      printerInstructions: row.printerInstructions ?? null,
      identity,
      // Kept for back-compat with any surface that still reads the owner.
      syncOwnerEmail: legacyOwner?.email ?? identity?.email ?? null,
      syncOwnerName: legacyOwner?.name ?? null,
      watchActive: !!row.channelId,
      channelExpiration: row.channelExpiration ?? null,
      lastSyncedAt: row.lastSyncedAt ?? null,
      lastError: row.lastError ?? null,
    };
  },
});

/**
 * Sanitized state of the separately consented Workspace principal. This is
 * school-admin-only because connecting or replacing the bot changes the
 * institution's shared Google identity.
 */
export const workspaceBotStatus = schoolAdminQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) {
      throw new Error(
        "No institution resolved for your account. Ask a platform admin to set up your school first.",
      );
    }
    const credentials = (
      await ctx.db
        .query("institutionGoogleAccounts")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", institution._id),
        )
        .collect()
    );
    const credential =
      credentials.find((candidate) => candidate.purpose === "workspace_bot") ??
      credentials.find((candidate) => candidate.purpose === "docs_bot");
    const capability = credential
      ? getGoogleScopeCapability(
          credential.scopes,
          INSTITUTION_WORKSPACE_BOT_SCOPES,
        )
      : null;
    const hasRefreshToken = credential
      ? credential.identityType === "service_account" || !!credential.refreshToken
      : false;

    return credential
      ? {
          connected: true as const,
          purpose: credential.purpose as WorkspaceBotPurpose,
          email: credential.email,
          scopes: capability!.grantedScopes,
          grantedScopes: capability!.grantedScopes,
          missingRequiredScopes: capability!.missingRequiredScopes,
          hasRefreshToken,
          requiresReconsent:
            !hasRefreshToken || !capability!.hasRequiredScopes,
          connectedAt: credential.connectedAt,
        }
      : { connected: false as const };
  },
});

/** @deprecated Compatibility name for the Workspace-principal status. */
export const docsBotStatus = workspaceBotStatus;
