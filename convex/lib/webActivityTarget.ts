// Resolve a kind="web" activity's effective launch target.
//
// A Web Assignment (kind="web" activity) and a launcher tile (scholarApps
// → externalApps) both describe "an external site opened in the locked
// webview". When an activity references a catalog app (externalAppId),
// the catalog is the single source of truth for the app's IDENTITY
// (name + icon) and its SECURITY ALLOWLIST (allowed hosts) — defined
// once, reused by both surfaces. The activity's own webUrl/webAllowedHosts
// remain optional per-activity overrides (e.g. a deep link to a specific
// page, or a tightened allowlist for one assignment).
//
// This keeps the two surfaces DRY: edit an app's identity (its hosts, its
// icon) once in the catalog and every launcher tile AND every Web
// Assignment that references it stays consistent.
//
// See review/external-apps-launcher.html.

import { registrableHost } from "./externalAppsResolve";
import { resolveAppIconUrl } from "./externalAppIconUrl";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export type ResolvedWebTarget = {
  /** The URL the webview opens. Activity override wins; else the app's. */
  webUrl: string | null;
  /** Effective allowlist. Activity override wins; else the app's. */
  webAllowedHosts: string[] | null;
  /** Catalog app identity, when the activity references one. */
  externalAppId: Doc<"activities">["externalAppId"] | null;
  appName: string | null;
  appIconUrl: string | null;
  appColor: string | null;
};

/** Pure resolution given the activity + its (already-fetched) catalog app. */
export function resolveWebTarget(
  activity: Pick<Doc<"activities">, "webUrl" | "webAllowedHosts" | "externalAppId">,
  app: Pick<Doc<"externalApps">, "_id" | "name" | "webUrl" | "webAllowedHosts" | "color"> | null,
  appIconUrl: string | null,
): ResolvedWebTarget {
  const ownUrl = activity.webUrl?.trim();

  // No catalog app — a freehand / one-off web activity. The activity's own
  // fields are the whole story (unchanged legacy behavior).
  if (!app) {
    const ownHosts = activity.webAllowedHosts?.filter((h) => h.trim().length > 0);
    return {
      webUrl: ownUrl || null,
      webAllowedHosts: ownHosts && ownHosts.length > 0 ? ownHosts : null,
      externalAppId: null,
      appName: null,
      appIconUrl: null,
      appColor: null,
    };
  }

  // Catalog app present: the catalog is the SINGLE SOURCE OF TRUTH for the
  // app's identity (name + icon) AND its security allowlist. The activity's
  // own webAllowedHosts is deliberately ignored — the editor doesn't let a
  // teacher set a per-activity allowlist while an app is linked, so the
  // displayed lock ("Locked to …") always equals what's enforced.
  const effectiveHosts =
    app.webAllowedHosts && app.webAllowedHosts.length > 0
      ? app.webAllowedHosts
      : hostsFromUrl(app.webUrl);
  // A deep-link override is honored ONLY when its host is inside the
  // catalog allowlist. A foreign-host deep-link would be yanked back by the
  // urlChange watchdog the instant it loaded (an unusable reload loop), so
  // fall back to the app's own URL — never a lockout, never an escape.
  const webUrl =
    ownUrl && hostInAllowlist(ownUrl, effectiveHosts) ? ownUrl : app.webUrl;
  return {
    webUrl,
    webAllowedHosts: effectiveHosts,
    externalAppId: app._id,
    appName: app.name,
    appIconUrl,
    appColor: app.color ?? null,
  };
}

/** Best-effort single-host allowlist from a URL — widened to the whole site, so
 *  a deep link doesn't lock the scholar out of the site's own sign-in hop
 *  (see `registrableHost`). */
function hostsFromUrl(url: string): string[] {
  try {
    return [registrableHost(new URL(url).hostname)];
  } catch {
    return [];
  }
}

/**
 * Is a URL's host covered by an allowlist? Bare patterns match the host
 * + its subdomains; "*." patterns match subdomains only.
 */
function hostInAllowlist(url: string, patterns: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.trim().toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (!host) return false;
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!p) return false;
    if (p.startsWith("*.")) {
      const apex = p.slice(2);
      return host !== apex && host.endsWith(`.${apex}`);
    }
    return host === p || host.endsWith(`.${p}`);
  });
}

/**
 * Fetch the referenced catalog app (+ its resolved icon URL) and resolve
 * the activity's effective web target. Use this at every read point that
 * feeds the web-assignment launch or renders an assignment card.
 */
export async function resolveActivityWebTarget(
  ctx: Pick<QueryCtx, "db" | "storage">,
  activity: Pick<Doc<"activities">, "webUrl" | "webAllowedHosts" | "externalAppId">,
): Promise<ResolvedWebTarget> {
  const app = activity.externalAppId
    ? await ctx.db.get(activity.externalAppId)
    : null;
  let appIconUrl: string | null = null;
  if (app && !app.archived) {
    appIconUrl = await resolveAppIconUrl(ctx, app);
    return resolveWebTarget(activity, app, appIconUrl);
  }
  // No app (or archived) — fall back to the activity's own freehand fields.
  return resolveWebTarget(activity, null, null);
}
