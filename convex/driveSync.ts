"use node";

// Google Drive → Portfolio ingestion (action half).
//
// The classroom printer drops scans into a watched Drive folder. We register
// a `changes.watch` push channel so Google pings us when anything changes;
// on a ping (or a cron safety-net) we RE-LIST the folder and ingest any file
// we haven't seen yet. We deliberately don't track/advance the changes page
// token for listing — re-listing + dedupe-on-driveFileId is simpler and
// self-healing if a ping is ever missed. The page token is only used to open
// the watch channel.
//
// PER-INSTITUTION: every school gets its own row + its own push channel, and
// the sync identity is an INSTITUTION-OWNED credential
// (`institutionGoogleAccounts`) — a dedicated Google account (OAuth) or a GCP
// service account (2-legged JWT; folder shared to the SA email) — not a
// person's personal `googleAccounts` link. The webhook resolves the pinging
// institution and the cron iterates all configured rows. Institution-scoped
// matching lands in ingestScan. See
// review/drive-sync-institution-accounts-plan.html.
//
// Why a Next.js forwarder (`app/api/drive/webhook/route.ts`) instead of
// pointing Google straight at the Convex `.convex.site` URL: Google only
// delivers push notifications to a VERIFIED domain, and we can't verify
// convex.site (Convex owns it). Google continues to ping the stable legacy
// endpoint at the configured application domain's `/api/drive/webhook` even while user-facing
// links move to rabbithole.school. DRIVE_WEBHOOK_BASE_URL owns that intentional
// separation.
//
// Auth: setup/management actions are gated to school_admin (own institution)
// or platform_admin (any). We call Drive as the institution's credential, so
// that identity must be able to see the folder (a member/owner for OAuth, or
// have the folder shared to it for a service account).

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireSchoolAdminAction } from "./lib/auth";
import {
  getValidAccessToken,
  getValidAccessTokenForCredential,
} from "./lib/googleTokens";
import {
  INSTITUTION_DRIVE_SYNC_SCOPES,
  INSTITUTION_WORKSPACE_BOT_SCOPES,
} from "./lib/google";
import { parseServiceAccountKey } from "./lib/serviceAccount";
import { isIngestibleMime } from "./lib/ingestMimes";
import { driveWebhookUrl } from "./lib/deploymentConfig";

const DRIVE = "https://www.googleapis.com/drive/v3";
// Channel TTL — Drive caps push channels at 7 days. We renew daily via cron.
const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
}

const MAX_UNSUPPORTED_FILE_DIAGNOSTICS = 3;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 64;

function boundedDiagnosticValue(
  value: string | undefined,
  fallback: string,
): string {
  const sanitized = (value ?? fallback)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"/g, "'");
  if (sanitized.length <= MAX_DIAGNOSTIC_VALUE_LENGTH) return sanitized || fallback;
  return `${sanitized.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH - 3)}...`;
}

/** A bounded, metadata-only notice for files the scanner cannot ingest. */
export function unsupportedDriveFilesDiagnostic(
  files: Pick<DriveFile, "name" | "mimeType">[],
): string | null {
  if (files.length === 0) return null;
  const shown = files
    .slice(0, MAX_UNSUPPORTED_FILE_DIAGNOSTICS)
    .map(
      (file) =>
        `"${boundedDiagnosticValue(file.name, "Untitled file")}" (${boundedDiagnosticValue(
          file.mimeType,
          "unknown MIME type",
        )})`,
    );
  const more =
    files.length > MAX_UNSUPPORTED_FILE_DIAGNOSTICS
      ? `; and ${files.length - MAX_UNSUPPORTED_FILE_DIAGNOSTICS} more`
      : "";
  return `Unsupported watched-folder file${files.length === 1 ? "" : "s"}: ${shown.join(
    "; ",
  )}${more}. Use PDF, JPEG, PNG, WebP, or GIF.`;
}

export function driveFileDisposition(
  file: Pick<DriveFile, "id" | "mimeType">,
  knownIds: ReadonlySet<string>,
): "duplicate" | "unsupported" | "ingest" {
  if (knownIds.has(file.id)) return "duplicate";
  return isIngestibleMime(file.mimeType) ? "ingest" : "unsupported";
}

// A driveSyncState row as the action half needs it (subset of the Doc).
type SyncRow = Doc<"driveSyncState">;

async function listFolderFiles(
  accessToken: string,
  folderId: string
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  do {
    const url =
      `${DRIVE}/files?q=${q}` +
      `&fields=nextPageToken,files(id,name,mimeType,size)` +
      `&pageSize=100&orderBy=createdTime desc` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Drive files.list failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      files?: DriveFile[];
      nextPageToken?: string;
    };
    files.push(...(json.files ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return files;
}

async function downloadFile(accessToken: string, fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Drive download failed (${res.status}): ${await res.text()}`);
  }
  return await res.arrayBuffer();
}

/**
 * Resolve a Drive access token for a sync row: the institution-owned
 * credential if present, else the legacy personal owner link. Throws if the
 * row has neither (a misconfigured/half-migrated row).
 */
async function resolveTokenForRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  row: SyncRow,
): Promise<string> {
  if (row.credentialRef) {
    return await getValidAccessTokenForCredential(
      ctx,
      row.credentialRef,
      INSTITUTION_DRIVE_SYNC_SCOPES,
    );
  }
  if (row.syncOwnerUserId) {
    return await getValidAccessToken(ctx, row.syncOwnerUserId);
  }
  throw new Error(
    "Drive-sync row has no institution credential or owner. Re-link the identity.",
  );
}

// ─── Core sync: re-list folder, ingest unseen files ─────────────────────────

async function syncFolderImpl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  row: SyncRow,
): Promise<{
  ingested: number;
  skipped: number;
  unsupported: Pick<DriveFile, "name" | "mimeType">[];
}> {
  const accessToken = await resolveTokenForRow(ctx, row);

  const [files, knownIds] = await Promise.all([
    listFolderFiles(accessToken, row.folderId),
    ctx.runQuery(internal.portfolio.knownDriveFileIds, {}),
  ]);
  const known = new Set<string>(knownIds);

  let ingested = 0;
  let skipped = 0;
  const unsupported: Pick<DriveFile, "name" | "mimeType">[] = [];
  for (const f of files) {
    const disposition = driveFileDisposition(f, known);
    if (disposition === "duplicate") {
      skipped++;
      continue;
    }
    if (disposition === "unsupported") {
      skipped++;
      unsupported.push({ name: f.name, mimeType: f.mimeType });
      continue;
    }
    // The webhook and cron can list the same unseen file at once. Claim before
    // download/AI work; portfolioItems alone cannot close that race because
    // one Drive file may produce several items only after segmentation.
    const claim = await ctx.runMutation(
      internal.portfolioIngestions.claimDriveFile,
      { institutionId: row.institutionId, driveFileId: f.id },
    );
    if (claim.kind !== "claimed") {
      skipped++;
      continue;
    }
    try {
      const bytes = await downloadFile(accessToken, f.id);
      const blob = new Blob([bytes], {
        type: f.mimeType ?? "application/octet-stream",
      });
      const storageId = await ctx.storage.store(blob);
      // Hand off to the ingestion action: it segments a stack into per-student
      // submissions, rotates each, matches (scoped to THIS institution's
      // roster), and creates the portfolio item(s).
      const res = await ctx.runAction(internal.portfolioActions.ingestScan, {
        source: "google_drive",
        driveFileId: f.id,
        originalStorageId: storageId,
        fileMimeType: f.mimeType,
        title: f.name ?? "Untitled scan",
        institutionId: row.institutionId,
        ingestionClaimToken: claim.claimToken,
      });
      if (res.error) {
        await ctx.runMutation(internal.portfolioIngestions.failDriveFile, {
          institutionId: row.institutionId,
          driveFileId: f.id,
          claimToken: claim.claimToken,
          reason: res.error,
        });
        skipped++;
        continue;
      }
      await ctx.runMutation(internal.portfolioIngestions.completeDriveFile, {
        institutionId: row.institutionId,
        driveFileId: f.id,
        claimToken: claim.claimToken,
      });
      if (res.created > 0) ingested += res.created;
      else skipped++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.portfolioIngestions.failDriveFile, {
        institutionId: row.institutionId,
        driveFileId: f.id,
        claimToken: claim.claimToken,
        reason: message,
      });
      throw err;
    }
  }
  return { ingested, skipped, unsupported };
}

/**
 * Internal entry point for the webhook + a single manual sync. Loads the row
 * for the given institution (or the legacy default row when no institutionId
 * is passed), runs a folder sync, records the outcome. No-op if nothing is
 * configured.
 */
export const syncFolder = internalAction({
  args: { institutionId: v.optional(v.id("institutions")) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ingested: number; skipped: number } | null> => {
    const row: SyncRow | null = args.institutionId
      ? await ctx.runQuery(internal.driveSyncState.getByInstitutionInternal, {
          institutionId: args.institutionId,
        })
      : await ctx.runQuery(internal.driveSyncState.getDefaultInternal, {});
    if (!row) {
      console.log("[driveSync.syncFolder] no folder configured — skipping");
      return null;
    }
    try {
      const result = await syncFolderImpl(ctx, row);
    const { unsupported, ...summary } = result;
    await ctx.runMutation(internal.driveSyncState.setSyncMetaInternal, {
      rowId: row._id,
      lastSyncedAt: Date.now(),
      lastError: unsupportedDriveFilesDiagnostic(unsupported),
    });
    console.log(
      `[driveSync.syncFolder] institution=${row.institutionId ?? "legacy"} ingested=${summary.ingested} skipped=${summary.skipped}`
    );
    return summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[driveSync.syncFolder] FAILED: ${message}`);
      await ctx.runMutation(internal.driveSyncState.setSyncMetaInternal, {
        rowId: row._id,
        lastError: message.slice(0, 500),
      });
      return null;
    }
  },
});

/**
 * Cron safety-net: iterate EVERY configured institution row and sync each.
 * One row per school, so this is bounded. Self-healing backstop for any
 * missed push ping.
 */
export const syncAllFolders = internalAction({
  args: {},
  handler: async (ctx): Promise<{ institutions: number }> => {
    const rows: SyncRow[] = await ctx.runQuery(
      internal.driveSyncState.listConfiguredInternal,
      {},
    );
    for (const row of rows) {
      await ctx.runAction(internal.driveSync.syncFolder, {
        institutionId: row.institutionId ?? undefined,
      });
    }
    return { institutions: rows.length };
  },
});

// ─── Watch registration ─────────────────────────────────────────────────────

async function getStartPageToken(accessToken: string): Promise<string> {
  const res = await fetch(`${DRIVE}/changes/startPageToken?supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Drive changes.startPageToken failed (${res.status}): ${await res.text()}`
    );
  }
  return ((await res.json()) as { startPageToken: string }).startPageToken;
}

async function stopChannel(
  accessToken: string,
  channelId: string,
  resourceId: string
): Promise<void> {
  const res = await fetch(`${DRIVE}/channels/stop`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: channelId, resourceId }),
  });
  // 404 just means it already expired — ignore.
  if (!res.ok && res.status !== 404) {
    console.warn(`[driveSync] channels.stop ${res.status}: ${await res.text()}`);
  }
}

async function registerWatchImpl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  row: SyncRow,
): Promise<{ channelId: string; expiration: number }> {
  const address = driveWebhookUrl();
  const accessToken = await resolveTokenForRow(ctx, row);

  // Tear down any previous channel so we don't accumulate live watches.
  if (row.channelId && row.resourceId) {
    await stopChannel(accessToken, row.channelId, row.resourceId);
  }

  const startPageToken = await getStartPageToken(accessToken);
  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomUUID();

  const res = await fetch(
    `${DRIVE}/changes/watch?pageToken=${encodeURIComponent(startPageToken)}&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address,
        token: channelToken,
        params: { ttl: String(CHANNEL_TTL_SECONDS) },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Drive changes.watch failed (${res.status}): ${await res.text()}`);
  }
  const watch = (await res.json()) as { resourceId: string; expiration?: string };
  const expiration = watch.expiration
    ? Number(watch.expiration)
    : Date.now() + CHANNEL_TTL_SECONDS * 1000;

  await ctx.runMutation(internal.driveSyncState.setChannelInternal, {
    rowId: row._id,
    channelId,
    resourceId: watch.resourceId,
    channelExpiration: expiration,
    channelToken,
    startPageToken,
  });

  return { channelId, expiration };
}

// ─── Institution scope + identity helpers ───────────────────────────────────

type ResolvedInstitution = {
  institutionId: Id<"institutions">;
  name: string;
  slug: string;
  emoji: string | null;
  honored: boolean;
  isAdmin: boolean;
};

/**
 * Gate to school_admin/platform_admin AND resolve which institution the caller
 * is acting in (membership WRITE guard). Throws if no institution resolves
 * (pre-institution dev data) — the per-institution flow requires one.
 */
async function gateAndResolveInstitution(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  scope: string | undefined,
): Promise<{ userId: Id<"users">; institution: ResolvedInstitution }> {
  const userId = await requireSchoolAdminAction(ctx);
  const institution: ResolvedInstitution | null = await ctx.runQuery(
    internal.driveSyncState.resolveInstitutionForCaller,
    { userId, scope },
  );
  if (!institution) {
    throw new Error(
      "No institution resolved for your account. Ask a platform admin to set up your school first.",
    );
  }
  return { userId, institution };
}

/** Start a Drive-read-only consent flow for the institution scanner identity. */
export const beginScannerOAuth = action({
  args: { scope: v.optional(v.string()), returnTo: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const { userId, institution } = await gateAndResolveInstitution(ctx, args.scope);
    const { buildAuthUrl, readOAuthConfig, readStateSecret, signState } =
      await import("./lib/google");
    const { clientId, redirectUri } = readOAuthConfig();
    const returnTo =
      args.returnTo && args.returnTo.startsWith("/") && !args.returnTo.startsWith("//")
        ? args.returnTo
        : "/admin/drive-sync";
    const state = await signState(
      {
        userId,
        institutionId: institution.institutionId,
        purpose: "scanner",
        returnTo,
        nonce: crypto.randomUUID(),
      },
      readStateSecret(),
    );
    return {
      url: buildAuthUrl({
        clientId,
        redirectUri,
        state,
        scopes: INSTITUTION_DRIVE_SYNC_SCOPES,
        includeGrantedScopes: false,
      }),
    };
  },
});

/**
 * Start a fresh consent flow for the dedicated Docs bot. This is deliberately
 * not the scanner setup flow: Docs writes need a separate account and grant.
 */
export const beginWorkspaceBotOAuth = action({
  args: { scope: v.optional(v.string()), returnTo: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const { userId, institution } = await gateAndResolveInstitution(ctx, args.scope);
    const { buildAuthUrl, readOAuthConfig, readStateSecret, signState } =
      await import("./lib/google");
    const { clientId, redirectUri } = readOAuthConfig();
    const returnTo =
      args.returnTo && args.returnTo.startsWith("/") && !args.returnTo.startsWith("//")
        ? args.returnTo
        : "/teacher";
    const state = await signState(
      {
        userId,
        institutionId: institution.institutionId,
        purpose: "workspace_bot",
        returnTo,
        nonce: crypto.randomUUID(),
      },
      readStateSecret(),
    );
    return {
      url: buildAuthUrl({
        clientId,
        redirectUri,
        state,
        scopes: INSTITUTION_WORKSPACE_BOT_SCOPES,
      }),
    };
  },
});

/** @deprecated Compatibility entry point; new consent writes `workspace_bot`. */
export const beginDocsBotOAuth = beginWorkspaceBotOAuth;

/**
 * Link the institution's sync identity to a GCP SERVICE ACCOUNT — identity
 * type B, the enterprise-grade north star. The admin pastes the downloaded SA
 * key JSON. We validate + store it and VERIFY by minting a token immediately
 * (a bad key fails loudly at setup, not at first sync). Returns the SA email
 * so the admin can share the Drive folder to it — no domain-wide delegation.
 */
export const setIdentityServiceAccount = action({
  args: { scope: v.optional(v.string()), keyJson: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    email: string;
    identityType: "service_account";
    shareHint: string;
  }> => {
    const { userId, institution } = await gateAndResolveInstitution(ctx, args.scope);
    const key = parseServiceAccountKey(args.keyJson);

    // Verify the key actually mints a token before we persist it as the
    // school's identity.
    const { mintServiceAccountAccessToken } = await import("./lib/serviceAccount");
    await mintServiceAccountAccessToken({
      key,
      scopes: INSTITUTION_DRIVE_SYNC_SCOPES,
    });

    await ctx.runMutation(internal.driveSyncState.upsertCredentialInternal, {
      institutionId: institution.institutionId,
      identityType: "service_account",
      email: key.clientEmail,
      scopes: [...INSTITUTION_DRIVE_SYNC_SCOPES],
      connectedBy: userId,
      saClientEmail: key.clientEmail,
      saPrivateKey: key.privateKey,
      saPrivateKeyId: key.privateKeyId,
      saClientId: key.clientId,
      saTokenUri: key.tokenUri,
    });
    return {
      email: key.clientEmail,
      identityType: "service_account",
      shareHint: `Share the scanner's Drive folder with ${key.clientEmail} (Viewer) — no domain-wide delegation needed.`,
    };
  },
});

/**
 * Connect (or re-point) the institution's watched folder, register its push
 * channel, and do an initial sync. Requires the institution's sync identity to
 * be set first (beginScannerOAuth / setIdentityServiceAccount). school_admin for
 * their own institution; platform_admin for any (via `scope`).
 */
export const connectFolder = action({
  args: { folderId: v.string(), scope: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    channelId: string;
    expiration: number;
    identityEmail: string;
    initial: { ingested: number; skipped: number } | null;
  }> => {
    const { institution } = await gateAndResolveInstitution(ctx, args.scope);
    const cred = await ctx.runQuery(
      internal.driveSyncState.getCredentialByInstitutionInternal,
      { institutionId: institution.institutionId },
    );
    if (!cred) {
      throw new Error(
        "Set this school's Drive-sync identity first (a Google account or a service account), then connect the folder.",
      );
    }

    await ctx.runMutation(internal.driveSyncState.upsertConfigInternal, {
      institutionId: institution.institutionId,
      folderId: args.folderId,
      credentialRef: cred._id,
    });
    const row: SyncRow | null = await ctx.runQuery(
      internal.driveSyncState.getByInstitutionInternal,
      { institutionId: institution.institutionId },
    );
    if (!row) throw new Error("Failed to persist sync config");

    const watch = await registerWatchImpl(ctx, row);
    const initial = await ctx.runAction(internal.driveSync.syncFolder, {
      institutionId: institution.institutionId,
    });
    return { ...watch, identityEmail: cred.email, initial };
  },
});

/**
 * Re-register ONE institution's watch channel (cron per-row + manual re-arm).
 * No-op if that institution has no folder configured.
 */
export const renewWatch = internalAction({
  args: { institutionId: v.optional(v.id("institutions")) },
  handler: async (
    ctx,
    args,
  ): Promise<{ channelId: string; expiration: number } | null> => {
    const row: SyncRow | null = args.institutionId
      ? await ctx.runQuery(internal.driveSyncState.getByInstitutionInternal, {
          institutionId: args.institutionId,
        })
      : await ctx.runQuery(internal.driveSyncState.getDefaultInternal, {});
    if (!row) return null;
    try {
      return await registerWatchImpl(ctx, row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[driveSync.renewWatch] FAILED: ${message}`);
      await ctx.runMutation(internal.driveSyncState.setSyncMetaInternal, {
        rowId: row._id,
        lastError: `watch renewal failed: ${message.slice(0, 400)}`,
      });
      return null;
    }
  },
});

/** Cron: renew EVERY configured institution's watch channel (bounded fan-out). */
export const renewAllWatches = internalAction({
  args: {},
  handler: async (ctx): Promise<{ institutions: number }> => {
    const rows: SyncRow[] = await ctx.runQuery(
      internal.driveSyncState.listConfiguredInternal,
      {},
    );
    for (const row of rows) {
      await ctx.runAction(internal.driveSync.renewWatch, {
        institutionId: row.institutionId ?? undefined,
      });
    }
    return { institutions: rows.length };
  },
});

/** Stop the active push channel for the caller's institution. */
export const stopWatch = action({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { institution } = await gateAndResolveInstitution(ctx, args.scope);
    const row: SyncRow | null = await ctx.runQuery(
      internal.driveSyncState.getByInstitutionInternal,
      { institutionId: institution.institutionId },
    );
    if (!row || !row.channelId || !row.resourceId) return { ok: true };
    const accessToken = await resolveTokenForRow(ctx, row);
    await stopChannel(accessToken, row.channelId, row.resourceId);
    await ctx.runMutation(internal.driveSyncState.clearChannelInternal, {
      rowId: row._id,
    });
    return { ok: true };
  },
});

/** Manually trigger a folder sync for the caller's institution. */
export const syncNow = action({
  args: { scope: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ingested: number; skipped: number } | null> => {
    const { institution } = await gateAndResolveInstitution(ctx, args.scope);
    return await ctx.runAction(internal.driveSync.syncFolder, {
      institutionId: institution.institutionId,
    });
  },
});
