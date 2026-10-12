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
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  authedQuery,
  scholarAdminQuery,
  scholarAdminMutation,
} from "./lib/customFunctions";
import { ROLES, isTeacherRole } from "./lib/roles";
import { requireActiveScholarAccess } from "./lib/access";
import {
  directLinkHasEnded,
  grantedAppIdsForScholar,
  grantProvenanceForScholar,
  launcherShowsApp,
  scholarHasGrantForApp,
} from "./lib/appAudiences";
import { timeZoneForScholar } from "./lib/institutionTime";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
} from "../shared/institutionDay";
import {
  catalogAppIsVisible,
  livePushedAppIdsForScholar,
  scholarAppAccess,
} from "./lib/deviceAppProjection";
import {
  libraryCardValidationIssue,
  libraryCredentialRevision,
} from "../shared/libraryCard";
import { scheduleUnlockRevocationCheck } from "./lib/deviceAppUnlockScheduling";
import { isPublicProductionDeployment } from "./lib/deploymentSafety";
import {
  groupLabelInScope,
  HIDDEN_GROUP,
  hostOf,
  registrableHost,
  requireScholarAdminScope,
  resolveAppByName,
  resolveScholarByNameOrUsername,
} from "./lib/externalAppsResolve";
import { resolveAppIconUrl } from "./lib/externalAppIconUrl";
import { auditManagedClaim } from "./lib/managedDeviceClaimState";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { scholarInstitutionId } from "./lib/scholarEnrollment";

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
  args: {
    scholarId: v.optional(v.id("users")),
    // Minute-rounded client clock used ONLY to re-arm this reactive query
    // across institution-local midnight — the same cache-buster contract as
    // `pushes.livePushesForMe`, and never a time authority (the server derives
    // the effective day). A live push's visibility is day-scoped
    // (`isFocusShowing`: shown if `setAt` is TODAY or `endsAt` is still
    // future), so an uncleared push stops showing at the institution day
    // boundary with NO database write for a subscription to notice. Without
    // this argument the tile can outlive the push until some unrelated
    // invalidation — and the FocusStrip card, which does pass a bucket, would
    // have already dropped it. Tile and card must not disagree.
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    void args.now;
    // t11-ok: a direct add's end (TRA-444) is judged at the server clock, as
    // the push term below is; the minute-rounded `now` arg re-arms this
    // subscription, and expireDirectGrant's delete at the end invalidates it.
    const nowMs = Date.now();
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
    // A live push is the third authority (see `launcherShowsApp`): a
    // block-scoped app placement must put the app on the Apps launcher for the
    // duration of the push, not only on the FocusStrip "Right now" card.
    // Resolved ONCE per scholar, like the grants above.
    const pushedIds = await livePushedAppIdsForScholar(ctx, scholar);

    // Show an app iff an enabled grant covers it, a live push is showing it,
    // OR an enabled direct (manual/default) row exists — `launcherShowsApp`,
    // the one home for that rule (the launch-time gates enforce the same
    // predicate, so tile and launch can't disagree). Deduped by appId (a
    // scholar with a grant, a push and a direct add sees one tile).
    const grantedKeys = new Set([...grantedIds].map(String));
    const pushedKeys = new Set([...pushedIds].map(String));
    const showIds = new Set<string>();
    for (const id of [
      ...grantedKeys,
      ...pushedKeys,
      ...links.map((l) => String(l.appId)),
    ]) {
      if (
        launcherShowsApp({
          link: linkByApp.get(id),
          granted: grantedKeys.has(id),
          pushed: pushedKeys.has(id),
          nowMs,
        })
      ) {
        showIds.add(id);
      }
    }

    const tiles = [];
    for (const appIdStr of showIds) {
      const appId = ctx.db.normalizeId("externalApps", appIdStr);
      const app = appId ? await ctx.db.get(appId) : null;
      if (!catalogAppIsVisible(app)) continue;
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
        nativeBundleId: app.nativeBundleId ?? null,
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
    // t11-ok: a direct add past its end (TRA-444) is dropped at the server
    // clock; expireDirectGrant deletes that row at the end, which re-runs this.
    const nowMs = Date.now();
    const timeZone = await timeZoneForScholar(ctx, args.scholarId);

    const links = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const linkByApp = new Map(links.map((l) => [String(l.appId), l]));
    // A direct add, on or off, that has not reached its end. One whose end
    // has passed is absent, exactly as the launcher treats it.
    const isDirect = (l: Doc<"scholarApps"> | null | undefined) =>
      !!l &&
      (l.source === "manual" || l.source === "default") &&
      !directLinkHasEnded(l, nowMs);

    const provenance = await grantProvenanceForScholar(ctx, scholar);
    // The grant scan reads every school's groups (the tile's rule), so a
    // granting group can be another school's: it still counts, but its chip
    // says HIDDEN_GROUP instead of naming it (TRA-447).
    const scope = await requireScholarAdminScope(ctx, ctx.user._id);
    const groupLabel = new Map<string, string>();
    for (const prov of provenance.values()) {
      for (const g of prov.groups) {
        if (!groupLabel.has(String(g.id))) {
          groupLabel.set(
            String(g.id),
            (await groupLabelInScope(ctx, scope, g.id)) ?? HIDDEN_GROUP,
          );
        }
      }
    }

    // Union of every app the scholar HAS: a direct (manual/default) add, or an
    // app granted via an audience. A lone source:"grant" credential-parking row
    // with no live grant is intentionally omitted (the app isn't on the
    // launcher).
    const appIdStrs = new Set<string>();
    for (const l of links) {
      if (isDirect(l)) appIdStrs.add(String(l.appId));
    }
    for (const key of provenance.keys()) appIdStrs.add(key);

    const rows = [];
    for (const appIdStr of appIdStrs) {
      const appId = ctx.db.normalizeId("externalApps", appIdStr);
      const app = appId ? await ctx.db.get(appId) : null;
      if (!app) continue;
      const link = linkByApp.get(appIdStr) ?? null;
      const prov = provenance.get(appIdStr) ?? { groups: [], institution: false };
      const direct = isDirect(link);

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
        // The last school day a direct add was opened for ("Open all day
        // today", "Open until…"; TRA-444), as "YYYY-MM-DD": it ends at the
        // midnight after it. Null for a standing add, no direct add, or one
        // switched off (it opens nothing, so it has no last day to show).
        directThroughDay:
          direct && link?.enabled && link.expiresAt !== undefined
            ? dayKeyForTimezone(link.expiresAt - 1, timeZone)
            : null,
        grantGroups: prov.groups.map((g) => {
          const name = groupLabel.get(String(g.id)) ?? HIDDEN_GROUP;
          return name === HIDDEN_GROUP ? { id: g.id, name, emoji: null } : g;
        }),
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
 *
 * The add is STANDING: it never ends on its own, and it takes the end off an
 * add that was opened for a day. `openForScholar`, below, is the add that
 * ends (TRA-444).
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
      // Validate the pasted URL the SAME way the /teacher/apps create/update
      // path does (hostOf, convex/externalApps.ts): only https:// with a
      // non-empty host, so http:/data:/javascript: can't enter the shared
      // catalog. One validator, no second copy.
      const host = hostOf(webUrl);
      if (!host) {
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

    // Idempotent: re-enable an existing link rather than duplicate it. A
    // standing add: `null` takes off any end it had (TRA-444).
    const { scholarAppId } = await coreAddToScholar(
      ctx,
      args.scholarId,
      appId,
      ctx.user._id,
      "ui",
      null,
    );
    return { scholarAppId };
  },
});

/**
 * Open an app to one scholar through the end of a school day: today unless
 * `throughDay` names a later one. The add ends by itself at the midnight
 * after that day, in the scholar's school's time zone, so extra access given
 * as a one-off cannot turn into a standing grant (TRA-444; Andy, 2026-09-28:
 * "let them use Stop Motion all day today"). Opening never shortens access:
 * an add that already runs at least that long, or is standing, is left as it
 * is, and its own last day comes back (`throughDay: null` for standing).
 * `addToScholar` is the standing add, which never ends. The device console's
 * "Open all day today" and "Open until…" call this.
 * Teacher/admin/operations staff.
 */
export const openForScholar = scholarAdminMutation({
  args: {
    scholarId: v.id("users"),
    appId: v.id("externalApps"),
    // The last day the scholar may open the app, "YYYY-MM-DD" on the
    // scholar's school's calendar. Omitted means today, read from the server
    // clock so a device whose clock is wrong can't turn "today" into
    // "tomorrow".
    throughDay: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireScholar(ctx, args.scholarId);
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const app = await ctx.db.get(args.appId);
    if (!app || app.archived) {
      throw new Error("That app is no longer in the catalog");
    }
    const timeZone = await timeZoneForScholar(ctx, args.scholarId);
    const today = dayKeyForTimezone(Date.now(), timeZone);
    const throughDay = args.throughDay ?? today;
    let expiresAt: number;
    try {
      expiresAt = dayStartForDayKey(shiftDayKey(throughDay, 1), timeZone);
    } catch {
      throw new Error("Pick a valid day");
    }
    if (throughDay < today) throw new Error("Pick today or a later day");
    const existing = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) =>
        q.eq("scholarId", args.scholarId).eq("appId", args.appId),
      )
      .first();
    if (
      existing?.enabled &&
      (existing.source === "manual" || existing.source === "default") &&
      (existing.expiresAt === undefined || existing.expiresAt >= expiresAt)
    ) {
      return {
        scholarAppId: existing._id,
        throughDay:
          existing.expiresAt === undefined
            ? null
            : dayKeyForTimezone(existing.expiresAt - 1, timeZone),
        expiresAt: existing.expiresAt ?? null,
      };
    }
    const { scholarAppId } = await coreAddToScholar(
      ctx,
      args.scholarId,
      args.appId,
      ctx.user._id,
      "ui",
      expiresAt,
    );
    return { scholarAppId, throughDay, expiresAt };
  },
});

// ── Shared per-scholar link core (public mutation, aide* wrapper, and the
//    customApps installs) ─────────────────────────────────────────────────

/** Idempotently give a scholar a DIRECT (manual) link to an app — re-enabling
 *  an existing link instead of duplicating it, and promoting a grant-parked
 *  credential row (which records no access on its own) to a direct one.
 *  The Apps panel, the aide's enable and the aide's app installs in
 *  customApps.ts share it, so they apply the parked-row rule the same way
 *  (TRA-437). The caller enforces access and tenancy. `added` is true when
 *  the scholar had no direct add before. With no `addedBy` (a creator-less
 *  legacy app finalizing on merge) nothing is audited, since there is no
 *  actor to attribute the add to.
 *
 *  `end` is when the add ends on its own (TRA-444), in three states:
 *  - a time: the add ends then (`openForScholar`, which never passes one
 *    that would shorten an add).
 *  - `null`: a standing add, taking any end off (`addToScholar`, the one
 *    door that says so: the Apps panel's add and the device console's
 *    "Allow at all hours" after its warning).
 *  - omitted: the caller does not manage ends (the aide's and Slack's
 *    enable, app installs). A live end is kept, so "enable Stop Motion for
 *    Kai" cannot quietly turn a day's access into a standing grant; an end
 *    already past is cleared, since the add is being given again.
 *  A new end schedules `expireDirectGrant` for that instant. */
export async function coreAddToScholar(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  appId: Id<"externalApps">,
  addedBy: Id<"users"> | undefined,
  via: "ui" | "aide" | "slack" | "merge-webhook" = "ui",
  end?: number | null,
): Promise<{ scholarAppId: Id<"scholarApps">; added: boolean }> {
  const existing = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar_app", (q) =>
      q.eq("scholarId", scholarId).eq("appId", appId),
    )
    .first();
  if (existing) {
    // A source:"grant" row only parks a saved login for a group-granted app
    // and is visibility-neutral (`launcherShowsApp`), so finding one is not
    // "already added": re-enabling it would record no direct access at all
    // (TRA-431). Promote it to a direct row and keep the login on it.
    const parked = existing.source === "grant";
    const liveEnd =
      existing.expiresAt !== undefined && Date.now() < existing.expiresAt
        ? existing.expiresAt
        : undefined;
    const expiresAt = end === undefined ? liveEnd : (end ?? undefined);
    const endChanged = existing.expiresAt !== expiresAt;
    if (parked || !existing.enabled || endChanged) {
      const patch: Partial<Doc<"scholarApps">> = { enabled: true };
      if (parked) {
        patch.source = "manual";
        patch.addedBy = addedBy;
      }
      if (endChanged) {
        // `undefined` removes the field: a standing add. Whoever sets the end
        // is who the expiry's audit entry names.
        patch.expiresAt = expiresAt;
        if (addedBy) patch.addedBy = addedBy;
      }
      await ctx.db.patch(existing._id, patch);
      if (addedBy) await auditManagedClaim(
        ctx,
        addedBy,
        "app-grant.scholar-assigned",
        scholarId,
        JSON.stringify({
          appId,
          scholarId,
          // A parked row gave no direct access, so this is a new direct add.
          previousEnabled: parked ? null : existing.enabled,
          newEnabled: true,
          // The ends, only where there is one (absent = standing). A previous
          // end may already have passed.
          ...(!parked && existing.expiresAt !== undefined
            ? { previousExpiresAt: existing.expiresAt }
            : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          via,
        }),
        (await scholarInstitutionId(ctx, scholarId)) ?? null,
      );
      if (expiresAt !== undefined && endChanged) {
        await ctx.scheduler.runAt(expiresAt, internal.scholarApps.expireDirectGrant, {
          scholarAppId: existing._id,
          expiresAt,
        });
      }
    }
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
    return { scholarAppId: existing._id, added: parked };
  }
  const expiresAt = end ?? undefined;
  const scholarAppId = await ctx.db.insert("scholarApps", {
    scholarId,
    appId,
    enabled: true,
    source: "manual",
    addedBy,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
  if (addedBy) await auditManagedClaim(
    ctx,
    addedBy,
    "app-grant.scholar-assigned",
    scholarId,
    JSON.stringify({
      appId,
      scholarId,
      previousEnabled: null,
      newEnabled: true,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      via,
    }),
    (await scholarInstitutionId(ctx, scholarId)) ?? null,
  );
  if (expiresAt !== undefined) {
    await ctx.scheduler.runAt(expiresAt, internal.scholarApps.expireDirectGrant, {
      scholarAppId,
      expiresAt,
    });
  }
  await scheduleUnlockRevocationCheck(ctx, {
    externalAppId: appId,
    scholarIds: [scholarId],
  });
  return { scholarAppId, added: true };
}

/** Take a scholar's DIRECT link off their launcher. Deletes it — unless it
 *  holds a saved login and a live grant still gives them the app, in which case
 *  it goes back to parking that login (source:"grant"): undoing a direct add
 *  must not take the grant's autofill with it (TRA-431). A paused grant does
 *  not count, the same rule `coreSetCredentials` parks a login under. A
 *  parked row keeps no end: the end belonged to the direct add. */
async function removeLink(ctx: MutationCtx, link: Doc<"scholarApps">) {
  if (link.loginUsername || link.loginPassword) {
    const scholar = await ctx.db.get(link.scholarId);
    if (scholar && (await scholarHasGrantForApp(ctx, scholar, link.appId))) {
      await ctx.db.patch(link._id, {
        enabled: true,
        source: "grant",
        expiresAt: undefined,
      });
      return;
    }
  }
  await ctx.db.delete(link._id);
}

/**
 * The end of an add opened for a day or until a date (TRA-444), scheduled for
 * `expiresAt` by `coreAddToScholar`. Readers already treat the row as absent
 * from that instant (`launcherShowsApp`); this removes it from the table
 * too, so the reads that list rows themselves (the scholar's Apps panel, the
 * Apps tab and the aide's "who can use this app") agree, and it marks the
 * scholar's iPads for the projector's next pass rather than its next
 * five-minute sweep.
 *
 * It re-checks from scratch, like masterSchedule's activatePlacementAppPush:
 * if the add was removed, re-opened with another end or made standing after
 * this was scheduled, the row's `expiresAt` no longer matches and this does
 * nothing. The removal is `removeLink`'s, so a login a live group grant still
 * needs stays parked (TRA-431). The audit entry names whoever set the end.
 */
export const expireDirectGrant = internalMutation({
  args: { scholarAppId: v.id("scholarApps"), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.scholarAppId);
    if (!link || link.expiresAt !== args.expiresAt) return;
    if (link.source !== "manual" && link.source !== "default") return;
    // The scheduler never runs a job early, but a direct call can: put it back
    // on the clock rather than end access before its time.
    if (Date.now() < args.expiresAt) {
      await ctx.scheduler.runAt(args.expiresAt, internal.scholarApps.expireDirectGrant, args);
      return;
    }
    await removeLink(ctx, link);
    if (link.addedBy) {
      await auditManagedClaim(
        ctx,
        link.addedBy,
        "app-grant.scholar-unassigned",
        link.scholarId,
        JSON.stringify({
          appId: link.appId,
          scholarId: link.scholarId,
          previousEnabled: link.enabled,
          newEnabled: "removed",
          expiresAt: args.expiresAt,
          via: "expiry",
        }),
        (await scholarInstitutionId(ctx, link.scholarId)) ?? null,
      );
    }
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: link.appId,
      scholarIds: [link.scholarId],
    });
  },
});

/** Remove a scholar's DIRECT (manual/default) link to an app — never a
 *  grant-parked credential row (those are visibility-neutral + retained). */
async function coreRemoveByScholarAndApp(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  appId: Id<"externalApps">,
  actorUserId: Id<"users">,
  via: "ui" | "aide" | "slack" = "ui",
): Promise<{ removed: number }> {
  const links = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar_app", (q) =>
      q.eq("scholarId", scholarId).eq("appId", appId),
    )
    .collect();
  const removableLinks = links.filter(
    (link) => link.source === "manual" || link.source === "default",
  );
  let removed = 0;
  for (const link of removableLinks) {
    await removeLink(ctx, link);
    removed++;
  }
  // A removed direct link may have been the scholar's only route to a
  // managed-native tile — force-close any device it left unlocked. A no-op
  // for a plain web/deep-link app, and a no-op if a group/institution grant
  // still covers them.
  if (removed > 0) {
    await auditManagedClaim(
      ctx,
      actorUserId,
      "app-grant.scholar-unassigned",
      scholarId,
      JSON.stringify({
        appId,
        scholarId,
        previousEnabled: removableLinks[0].enabled,
        newEnabled: "removed",
        via,
      }),
      (await scholarInstitutionId(ctx, scholarId)) ?? null,
    );
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
    // Audit only a real edge. The projection kick below still runs on a
    // no-op re-set: an unchanged flag is not proof the device converged, and
    // callers (and the deviceAppProjection tests) lean on this mutation as a
    // cheap "re-project this grant" nudge.
    if (link.enabled !== args.enabled) {
      await ctx.db.patch(args.scholarAppId, { enabled: args.enabled });
      await auditManagedClaim(
        ctx,
        ctx.user._id,
        args.enabled
          ? "app-grant.scholar-enabled"
          : "app-grant.scholar-disabled",
        link.scholarId,
        JSON.stringify({
          appId: link.appId,
          scholarId: link.scholarId,
          previousEnabled: link.enabled,
          newEnabled: args.enabled,
          via: "ui",
        }),
        (await scholarInstitutionId(ctx, link.scholarId)) ?? null,
      );
    }
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
    // Only a direct add is removed here. A grant-parked row is not the
    // scholar's access (a stale drawer can still hold its id after a removal
    // parked the login again), so it stays, unaudited.
    if (link.source === "grant") return;
    await removeLink(ctx, link);
    await auditManagedClaim(
      ctx,
      ctx.user._id,
      "app-grant.scholar-unassigned",
      link.scholarId,
      JSON.stringify({
        appId: link.appId,
        scholarId: link.scholarId,
        previousEnabled: link.enabled,
        newEnabled: "removed",
        via: "ui",
      }),
      (await scholarInstitutionId(ctx, link.scholarId)) ?? null,
    );
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
    via: v.optional(v.union(v.literal("aide"), v.literal("slack"))),
  },
  handler: async (
    ctx,
    { callerUserId, appName, scholarQuery, enabled, via },
  ) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const caller = scope.caller;
    const app = await resolveAppByName(ctx, appName);
    const scholar = await resolveScholarByNameOrUsername(ctx, scholarQuery, scope);
    const scholarLabel = scholar.name ?? scholar.username ?? "the scholar";
    if (enabled) {
      await coreAddToScholar(
        ctx,
        scholar._id,
        app._id,
        caller._id,
        via ?? "aide",
      );
      return { app: app.name, scholar: scholarLabel, enabled: true };
    }
    const r = await coreRemoveByScholarAndApp(
      ctx,
      scholar._id,
      app._id,
      caller._id,
      via ?? "aide",
    );
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
 * rule the launcher renders, on a catalog app that is not archived, so a
 * bulk-GRANTED app (which has no per-scholar row until a credential is parked on
 * it) still gets its autofill — and a missing secret yields null (tile still
 * launches, just no autofill).
 */
export const credentialsForApp = authedQuery({
  args: {
    appId: v.id("externalApps"),
    // Same cache-buster contract as `listForLauncher` above; never a time
    // authority. This query consults push liveness too, so it needs the same
    // re-arm to avoid offering an autofill for a push that has stopped showing.
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    void args.now;
    // Gate on the LAUNCHER rule, not on the mere existence of a per-scholar
    // row: an app reached only through an `appAudiences` grant has no row until
    // a credential is parked on it, which never happens for a "libraryCard"
    // app (its secret lives on `users.libraryCredential`); a pushed app is on
    // the launcher for its block; and an archived app's tile is gone, so its
    // 🔑 must go too (TRA-425). `scholarAppAccess` is that rule, shared with
    // the web and native launch gates.
    const access = await scholarAppAccess(ctx, ctx.user, args.appId);
    if (!access.allowed) return null;
    const { app, link } = access;

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
    await coreSetCredentials(ctx, { ...args, addedBy: ctx.user._id });
  },
});

async function coreSetCredentials(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    appId: Id<"externalApps">;
    username?: string;
    password?: string;
    addedBy: Id<"users">;
  },
) {
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
        addedBy: args.addedBy,
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
}

/** Internal aide wrapper: set a named scholar's saved External App login. */
export const aideSetCredentials = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    scholarQuery: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, { callerUserId, appName, scholarQuery, ...credentials }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const app = await resolveAppByName(ctx, appName);
    const scholar = await resolveScholarByNameOrUsername(ctx, scholarQuery, scope);
    const displayName = scholar.name ?? scholar.username ?? "the scholar";
    if (app.credentialSource === "libraryCard") {
      // A library card is ONE credential keyed by its number: coreSetCredentials
      // drops the whole thing when the merged card number is empty. That is
      // the right meaning of an explicit empty username (clear it), and the
      // wrong meaning of a PIN-only update for a scholar with no card on file
      // — which would silently discard the PIN and report success.
      const cur = scholar.libraryCredential;
      const nextId =
        credentials.username !== undefined
          ? credentials.username.trim()
          : (cur?.id ?? "");
      // Trimmed like libraryCards.replace stores it, so the value validated
      // is the value saved.
      if (credentials.password !== undefined) {
        credentials.password = credentials.password.trim();
      }
      const nextPin = credentials.password ?? cur?.password ?? "";
      if (credentials.username === undefined && !nextId) {
        throw new Error(
          `${displayName} has no library card number on file — pass the card number as the username along with the PIN.`,
        );
      }
      // Same format rules the guardian-facing writer (libraryCards.replace)
      // enforces, applied once the credential is complete.
      if (nextId && nextPin) {
        const issue = libraryCardValidationIssue(nextId, nextPin);
        if (issue) throw new Error(issue.message);
      }
    }
    await coreSetCredentials(ctx, {
      scholarId: scholar._id,
      appId: app._id,
      addedBy: scope.caller._id,
      ...credentials,
    });
    // "Cleared" is read back from what was written, not inferred from the
    // request: an empty username on a link that held only a username leaves
    // nothing behind, and the tool must not call that "Saved".
    let cleared: boolean;
    if (app.credentialSource === "libraryCard") {
      cleared = !(await ctx.db.get(scholar._id))?.libraryCredential;
    } else {
      const link = await ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) =>
          q.eq("scholarId", scholar._id).eq("appId", app._id),
        )
        .first();
      cleared = !link?.loginUsername && !link?.loginPassword;
    }
    return {
      app: app.name,
      scholar: displayName,
      credentialSource: app.credentialSource ?? "scholarApp",
      cleared,
    };
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
