// Custom Apps — the install/finalize/resolve backend for bot-installable
// classroom apps (schema.ts `customApps`). Three shapes, ONE launcher PATH
// (/custom-apps?token=<token>, resolved against whatever origin the client is
// on — dev, preview, or prod) and ONE grant system:
//
//   • installExistingUrlApp  — a teacher pasted a URL for a real website;
//     dedupe/create its `externalApps` catalog row and grant it. (No custom
//     app row — it's a plain external app.)
//   • createStaticApp        — the bot vibecoded a self-contained HTML app;
//     store the HTML, mint a token, create the catalog row at the token url,
//     grant it — all instantly, no PR.
//   • updateStaticApp        — replace a static app's HTML in place while
//     preserving its token, launcher URL, status, and grants. Tenant-scoped:
//     the caller's institution lens restricts the name scan, matched against
//     the app's LIVE reach (scholarApps/appAudiences grants, not stale install
//     intent), so a same-named app reaching another school is invisible (not
//     overwritable), and it fails CLOSED when no lens was resolved.
//   • createPendingCodedApp / finalizeCodedApp — the bot dispatched a Copilot
//     agent to build a real coded route; the pending row waits for the PR to
//     MERGE (convex/githubEvents.ts calls finalizeCodedApp), then the tile is
//     created + granted.
//     Manual recovery after a missed webhook or failed deploy:
//       npx convex run customApps:finalizeCodedApp '{"customAppId":"..."}'
//
// The bot TOOLS that call these live in lib/customAppTools.ts; they resolve
// scholar/group NAMES to ids and pass an explicit callerUserId (the mapped
// requesting user), so these are plain internal mutations — the same "bot acts
// on behalf of a user" pattern as lib/scholarWriteTools.ts. resolveByToken is
// the ONE public query, called by the /custom-apps Next route; the token is an
// unguessable bearer secret, so token-match is the gate.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { appBaseUrl } from "./lib/deploymentConfig";
import { ROLES } from "./lib/roles";
import { externalAppWithinLens } from "./lib/externalAppReach";

/** This deployment's configured app origin, trailing slash stripped. */
function siteOrigin(): string {
  return appBaseUrl().replace(/\/+$/, "");
}

/** The absolute launcher url — used only where a human needs a clickable link
 * (the teacher-facing "installed at …" message). The STORED catalog webUrl is
 * the domain-agnostic path below, so the tile resolves against whatever origin
 * the client is on. */
export function customAppUrl(token: string): string {
  return `${siteOrigin()}/custom-apps?token=${token}`;
}

/** The domain-agnostic launcher PATH a custom-app token resolves to — this is
 * what's stored as the catalog `webUrl`. The web launcher opens it relative to
 * the current origin (window.open), and the native host resolves it against the
 * configured Rabbithole web origin (rabbitholeWebUrl), so one install works on
 * dev, preview, and prod without baking in a domain. */
export function customAppPath(token: string): string {
  return `/custom-apps?token=${token}`;
}

/** A random, unguessable hex token (192 bits) for the ?token= url — same
 * shape/strength as the proposal sketch tokens (introspectionTools). */
export function generateAppToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function assertTargetsWithinLens(
  ctx: MutationCtx,
  scholarIds: Id<"users">[],
  groupIds: Id<"scholarGroups">[],
  allowedScholarIds: Id<"users">[] | undefined,
  scholarLensResolved: boolean | undefined,
) {
  // Fail CLOSED. An absent id set is legitimate ONLY when the caller actually
  // resolved a lens and found itself unrestricted (a platform admin). A caller
  // that never resolved one at all must install nothing: that silence is
  // precisely how the MCP write path used to slip past this guard, since the
  // old `if (!allowedScholarIds) return;` head turned "no lens was ever
  // considered" into "no restrictions apply".
  if (!allowedScholarIds) {
    if (scholarLensResolved === true) return;
    throw new Error(
      "Refusing to install: no institution scholar lens was resolved for this caller.",
    );
  }
  const allowed = new Set(allowedScholarIds);
  for (const scholarId of scholarIds) {
    if (!allowed.has(scholarId)) {
      throw new Error("Forbidden: scholar is outside the active institution view");
    }
  }
  for (const groupId of groupIds) {
    const group = await ctx.db.get(groupId);
    if (!group) {
      throw new Error("Forbidden: group is outside the active institution view");
    }
    for (const id of group.scholarIds) {
      // Ids that no longer resolve to a live scholar are not members: the
      // read layer (readScholarGroups) already drops them, so a stale id in
      // a stored roster must not make an otherwise-whole group read as
      // partial here and refuse a legitimate install.
      const member = await ctx.db.get(id);
      if (!member || member.role !== ROLES.SCHOLAR) continue;
      if (!allowed.has(id)) {
        throw new Error(
          "Forbidden: group is outside the active institution view",
        );
      }
    }
  }
}

/** Cap on inline static-app HTML (well under Convex's ~1MB value limit; a
 * self-contained vibecoded app is a single small file). Exported for the tool
 * to reject oversize content with a clear message before it reaches here. */
export const MAX_STATIC_HTML_BYTES = 700 * 1024;

/**
 * Grant an external app to a set of scholars (direct `scholarApps` rows) and/or
 * groups (`appAudiences` grants). Idempotent: an existing link/grant is
 * re-enabled rather than duplicated. Shared by every install path here.
 */
async function installGrants(
  ctx: MutationCtx,
  appId: Id<"externalApps">,
  scholarIds: Id<"users">[] | undefined,
  groupIds: Id<"scholarGroups">[] | undefined,
  addedBy: Id<"users"> | undefined,
): Promise<{ scholars: number; groups: number }> {
  let scholars = 0;
  let groups = 0;
  for (const scholarId of scholarIds ?? []) {
    const existing = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) =>
        q.eq("scholarId", scholarId).eq("appId", appId),
      )
      .first();
    if (existing) {
      if (!existing.enabled) await ctx.db.patch(existing._id, { enabled: true });
    } else {
      await ctx.db.insert("scholarApps", {
        scholarId,
        appId,
        enabled: true,
        source: "manual",
        addedBy,
      });
      scholars++;
    }
  }
  for (const groupId of groupIds ?? []) {
    const existing = await ctx.db
      .query("appAudiences")
      .withIndex("by_audience", (q) =>
        q.eq("audienceKind", "group").eq("audienceId", String(groupId)),
      )
      .filter((q) => q.eq(q.field("appId"), appId))
      .first();
    if (existing) {
      if (!existing.enabled) await ctx.db.patch(existing._id, { enabled: true });
    } else {
      await ctx.db.insert("appAudiences", {
        appId,
        audienceKind: "group",
        audienceId: String(groupId),
        enabled: true,
        addedBy,
      });
      groups++;
    }
  }
  return { scholars, groups };
}

/**
 * Install an EXISTING website (the teacher pasted a URL) as an external app for
 * the given scholars/groups. Dedupes into the catalog by exact `webUrl` (same
 * rule as scholarApps.addToScholar). No `customApps` row — this is a plain
 * external app, not a vibecoded one.
 */
export const installExistingUrlApp = internalMutation({
  args: {
    name: v.string(),
    webUrl: v.string(),
    webAllowedHosts: v.optional(v.array(v.string())),
    callerUserId: v.id("users"),
    scholarIds: v.array(v.id("users")),
    groupIds: v.array(v.id("scholarGroups")),
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertTargetsWithinLens(
      ctx,
      args.scholarIds,
      args.groupIds,
      args.allowedScholarIds,
      args.scholarLensResolved,
    );
    const name = args.name.trim();
    const webUrl = args.webUrl.trim();
    if (!name) throw new Error("Name is required");
    let parsed: URL;
    try {
      parsed = new URL(webUrl);
    } catch {
      throw new Error("Enter a valid https:// URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("Enter a valid https:// URL");
    }
    const host = parsed.hostname.toLowerCase();
    const existingApp = await ctx.db
      .query("externalApps")
      .filter((q) => q.eq(q.field("webUrl"), webUrl))
      .first();
    const appId =
      existingApp?._id ??
      (await ctx.db.insert("externalApps", {
        name,
        webUrl,
        webAllowedHosts:
          args.webAllowedHosts && args.webAllowedHosts.length > 0
            ? args.webAllowedHosts
                .map((h) => h.trim().toLowerCase())
                .filter(Boolean)
            : [host],
        createdBy: args.callerUserId,
      }));
    const grants = await installGrants(
      ctx,
      appId,
      args.scholarIds,
      args.groupIds,
      args.callerUserId,
    );
    return { appId, webUrl, name, ...grants };
  },
});

/**
 * Create + install a STATIC (self-contained HTML) custom app. Stores the HTML
 * inline, mints the token, creates the catalog row at the token url, and grants
 * it — all in one shot (no PR). The token is supplied by the tool so it can
 * echo the url to the teacher before this returns.
 */
export const createStaticApp = internalMutation({
  args: {
    name: v.string(),
    html: v.string(),
    token: v.string(),
    callerUserId: v.id("users"),
    scholarIds: v.array(v.id("users")),
    groupIds: v.array(v.id("scholarGroups")),
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertTargetsWithinLens(
      ctx,
      args.scholarIds,
      args.groupIds,
      args.allowedScholarIds,
      args.scholarLensResolved,
    );
    const name = args.name.trim();
    if (!name) throw new Error("Name is required");
    const bytes = new TextEncoder().encode(args.html).length;
    if (bytes > MAX_STATIC_HTML_BYTES) {
      throw new Error(
        `HTML is too large (${bytes} bytes; max ${MAX_STATIC_HTML_BYTES}). ` +
          `A static custom app must be a single self-contained file — trim it ` +
          `or build it as a coded app instead.`,
      );
    }
    const appId = await ctx.db.insert("externalApps", {
      name,
      // Domain-agnostic: stored as a path, resolved per-origin by the client
      // (window.open on web, rabbitholeWebUrl in the native host). No fixed
      // webAllowedHosts — the host is derived from the resolved same-origin url.
      webUrl: customAppPath(args.token),
      createdBy: args.callerUserId,
    });
    const customAppId = await ctx.db.insert("customApps", {
      token: args.token,
      name,
      kind: "static",
      status: "live",
      html: args.html,
      externalAppId: appId,
      installScholarIds: args.scholarIds,
      installGroupIds: args.groupIds,
      createdBy: args.callerUserId,
    });
    const grants = await installGrants(
      ctx,
      appId,
      args.scholarIds,
      args.groupIds,
      args.callerUserId,
    );
    return {
      customAppId,
      appId,
      token: args.token,
      url: customAppUrl(args.token),
      name,
      ...grants,
    };
  },
});

/** Whether a static app falls within the caller's institution scholar lens —
 * delegated to the shared reach containment helper so the customApps name scan
 * and the externalApps catalog write gate cannot drift. Fail CLOSED: an app the
 * lens cannot see must be invisible to the name scan, not merely un-patched.
 * `allowed === undefined` means the lens was resolved and found the caller
 * unrestricted (a platform admin). */
async function appIsWithinLens(
  ctx: MutationCtx,
  app: Doc<"customApps">,
  callerUserId: Id<"users">,
  allowed: Set<Id<"users">> | undefined,
): Promise<boolean> {
  return externalAppWithinLens(
    ctx,
    app.externalAppId,
    app.createdBy,
    callerUserId,
    allowed,
  );
}

/** Replace a STATIC app's HTML without changing any launcher or grant state.
 * Tenant-scoped: only apps within the caller's institution lens are eligible
 * name matches. */
export const updateStaticApp = internalMutation({
  args: {
    name: v.string(),
    html: v.string(),
    callerUserId: v.id("users"),
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Name is required");
    const bytes = new TextEncoder().encode(args.html).length;
    if (bytes > MAX_STATIC_HTML_BYTES) {
      throw new Error(
        `HTML is too large (${bytes} bytes; max ${MAX_STATIC_HTML_BYTES}). ` +
          `A static custom app must be a single self-contained file.`,
      );
    }
    // Fail CLOSED before any table scan. An absent id set is legitimate ONLY
    // when a lens WAS resolved and found the caller unrestricted (a platform
    // admin); "no lens was ever considered" must never read as "no
    // restrictions apply".
    if (args.allowedScholarIds === undefined && args.scholarLensResolved !== true) {
      throw new Error(
        "Refusing to update: no institution scholar lens was resolved for this caller.",
      );
    }
    const allowed = args.allowedScholarIds
      ? new Set(args.allowedScholarIds)
      : undefined;
    const named = (await ctx.db.query("customApps").collect()).filter(
      (app) => app.name.trim().toLowerCase() === name.toLowerCase(),
    );
    // Restrict to apps the caller's lens can see BEFORE the count checks, so a
    // same-named app at another school is neither overwritable nor a source of
    // a spurious `ambiguous` (a cross-tenant information leak).
    const matches: Doc<"customApps">[] = [];
    for (const app of named) {
      if (await appIsWithinLens(ctx, app, args.callerUserId, allowed)) {
        matches.push(app);
      }
    }
    if (matches.length === 0) return { kind: "not_found" as const };
    if (matches.length > 1) return { kind: "ambiguous" as const };
    const app = matches[0];
    if (app.kind !== "static") {
      return { kind: "wrong_kind" as const, name: app.name };
    }
    await ctx.db.patch(app._id, { html: args.html });
    return {
      kind: "updated" as const,
      customAppId: app._id,
      name: app.name,
      token: app.token,
      url: customAppUrl(app.token),
      status: app.status,
    };
  },
});

/**
 * Record a pending CODED custom app the moment its build is dispatched. The
 * tile isn't created and nothing is granted yet — that happens on merge
 * (finalizeCodedApp). `featureProposalId` links it to the dispatch so the merge
 * webhook can find it; `token`/`routePath` are baked into the dispatch brief so
 * the agent builds the app to be reachable at exactly this url.
 */
export const createPendingCodedApp = internalMutation({
  args: {
    name: v.string(),
    routePath: v.string(),
    token: v.string(),
    featureProposalId: v.id("featureProposals"),
    callerUserId: v.id("users"),
    scholarIds: v.array(v.id("users")),
    groupIds: v.array(v.id("scholarGroups")),
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertTargetsWithinLens(
      ctx,
      args.scholarIds,
      args.groupIds,
      args.allowedScholarIds,
      args.scholarLensResolved,
    );
    const customAppId = await ctx.db.insert("customApps", {
      token: args.token,
      name: args.name.trim(),
      kind: "coded",
      status: "building",
      routePath: args.routePath,
      featureProposalId: args.featureProposalId,
      installScholarIds: args.scholarIds,
      installGroupIds: args.groupIds,
      createdBy: args.callerUserId,
    });
    return { customAppId, token: args.token, url: customAppUrl(args.token) };
  },
});

/** The pending coded app linked to a merged dispatch, if any — the merge
 * webhook uses this to decide whether to finalize. */
export const getPendingByFeatureProposal = internalQuery({
  args: { featureProposalId: v.id("featureProposals") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("customApps")
      .withIndex("by_featureProposal", (q) =>
        q.eq("featureProposalId", args.featureProposalId),
      )
      .first();
    return row && row.status === "building" && row.kind === "coded"
      ? { customAppId: row._id, name: row.name }
      : null;
  },
});

/**
 * Finalize a coded app once its PR merges: create the launcher tile (catalog
 * row) at the token url, flip the row to live, and grant it to the stored
 * install targets. Idempotent — a webhook retry after finalize is a no-op.
 * Returns a summary (or null when there's nothing to do) for the ship notice.
 */
export const finalizeCodedApp = internalMutation({
  args: { customAppId: v.id("customApps") },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.customAppId);
    if (!app || app.kind !== "coded" || app.status !== "building") return null;
    const url = customAppUrl(app.token);
    const appId =
      app.externalAppId ??
      (await ctx.db.insert("externalApps", {
        name: app.name,
        // Domain-agnostic path; the client resolves it per origin (see
        // createStaticApp).
        webUrl: customAppPath(app.token),
        createdBy: app.createdBy,
      }));
    await ctx.db.patch(args.customAppId, {
      status: "live",
      externalAppId: appId,
    });
    const grants = await installGrants(
      ctx,
      appId,
      app.installScholarIds,
      app.installGroupIds,
      app.createdBy,
    );
    return { appId, token: app.token, url, name: app.name, ...grants };
  },
});

/**
 * Resolve a ?token= to what the /custom-apps route should render. PUBLIC and
 * token-gated (the token is the bearer secret). A static live app returns its
 * HTML (rendered in a sandboxed iframe); a coded live app returns its
 * routePath (the route redirects there). A still-building coded app returns
 * status:"building" with no payload so the route can show a placeholder.
 * Anything else (bad/archived token) → null (the route 404s).
 */
export const resolveByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    if (!token) return null;
    const row = await ctx.db
      .query("customApps")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!row || row.status === "archived") return null;
    if (row.kind === "static") {
      return {
        kind: "static" as const,
        name: row.name,
        status: row.status,
        html: row.status === "live" ? (row.html ?? "") : null,
      };
    }
    return {
      kind: "coded" as const,
      name: row.name,
      status: row.status,
      routePath: row.status === "live" ? (row.routePath ?? null) : null,
    };
  },
});
