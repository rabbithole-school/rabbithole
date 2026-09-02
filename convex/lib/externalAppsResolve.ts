// Shared name-resolution + caller-authorization helpers for the External-Apps
// BOT tools (convex/lib/externalAppsTools.ts). The tools run in an ActionCtx
// with NO auth identity, so the internal aide* wrappers they call must (a)
// re-check the caller's role from an explicit callerUserId, and (b) resolve the
// human-typed NAMES ("Acme Practice", "Room 3", "leilani_park") to Convex ids
// server-side. These are plain ctx-reader helpers (not registered Convex
// functions), so adding this module needs no _generated/api.d.ts edit.
//
// Every resolver throws a helpful, model-readable error when it finds 0 or >1
// matches, listing the candidates so the bot can ask the human to disambiguate.
//
// ⚠️ MULTI-TENANCY. A role check alone is a cross-tenant leak (CLAUDE.md →
// "Isolation is per-handler, so it is your job"), and these resolvers match on
// human-typed NAMES over whole tables — so an unscoped pool would let a teacher
// at school B grant/revoke apps for school A's scholars, AND leak A's group and
// school names through the "did you mean…" candidate lists. Every resolver
// therefore takes an `ExternalAppScope` (not an optional — a required argument
// is the only kind you cannot forget) and narrows its candidate pool BEFORE
// matching. Narrowing first, rather than checking the id afterwards, is what
// keeps the error strings from confirming that a foreign scholar/group exists.
// The sibling `install_external_app` toolset scopes the same way via
// `opts.allowedScholarIds` (lib/customAppTools.ts).

import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ROLES, isScholarAdminRole } from "./roles";
import { curatableInstitutionIds } from "./access";
import { schoolOperationsInstitutionIds } from "./staffCapabilities";

/**
 * Host of an **https** URL, lowercased — for deriving the webview allowlist.
 * Returns null for anything unparseable, non-https, or hostless, so the callers'
 * "Enter a valid https:// URL" refusal is literally true. Plain `http://` is
 * rejected on purpose: a catalog tile opens inside the locked in-app webview on
 * school iPads, and it must not carry a scholar's stored login over cleartext.
 * Same rule the sibling `install_external_app` bot tool enforces
 * (lib/customAppTools.ts).
 */
export function hostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return parsed.hostname.toLowerCase() || null;
}

/**
 * Public suffixes that are TWO labels long. Widening to the last two labels is
 * the right instinct almost everywhere ("kids.getepic.com" and "www.getepic.com"
 * are one site), but on these it would hand a scholar the whole registry —
 * "bbc.co.uk" would become "co.uk", i.e. every UK site — which isn't a loosened
 * lock, it's no lock. The app-hosting entries are the same hazard between
 * tenants: "someclass.github.io" must not widen to all of GitHub Pages.
 *
 * Deliberately PARTIAL — a complete answer needs the Public Suffix List, and a
 * dependency for that isn't worth it here. A suffix we've missed just widens
 * one app a bit too far, which is the direction we chose to err.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk", "ac.uk", "org.uk", "gov.uk", "sch.uk",
  "com.au", "edu.au", "co.nz", "co.jp", "co.za", "com.br",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app",
  "firebaseapp.com", "glitch.me", "wixsite.com", "blogspot.com",
]);

/**
 * Widen a host to the site it belongs to, for deriving a webview allowlist.
 *
 * The domain lock exists to keep a scholar on the site a teacher pointed them
 * at, and the matcher already reads a bare pattern as "this host + all its
 * subdomains" — so the only question is which host to store. Storing the EXACT
 * host is too tight: a teacher who pastes a deep link gets an allowlist that the
 * site's own sign-in then trips over. That is a real, shipped failure — Epic was
 * added as `kids.getepic.com/students`, and a valid class code navigates to
 * `www.getepic.com/app/profile-select`, which the lock cancelled, leaving the
 * scholar on an endless spinner (2026-08-19).
 *
 * So: subdomains are treated as interchangeable. `kids.getepic.com` and
 * `www.getepic.com` both derive `getepic.com`. This is deliberately permissive —
 * the standing instruction is to err that way and tighten later if a specific
 * app ever needs it (per-app `webAllowedHosts` is still explicit and always wins
 * over this derivation).
 *
 * Hosts with two or fewer labels, IP literals, and anything unparseable come
 * back unchanged.
 */
export function registrableHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return h;
  // An IPv4 literal has no "site" to widen to — 10.0.0.1 must not become 0.1.
  if (/^\d+(\.\d+){3}$/.test(h)) return h;
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * The caller plus the two tenancy boundaries every External-App resolver needs.
 * `"all"` is the global-role escape hatch (platform_admin), matching what
 * `curatableInstitutionIds` / `accessibleScholarIds` already return.
 */
export type ExternalAppScope = {
  caller: Doc<"users">;
  /** Scholars this caller may act on. */
  scholars: Set<Id<"users">> | "all";
  /** Institutions this caller may curate. */
  institutions: Set<Id<"institutions">> | "all";
};

/**
 * Re-check the caller is a scholar-admin (teacher / school_admin /
 * platform_admin / operations staff) or a granted school operator from an explicit id,
 * AND resolve their tenancy
 * scope — the auth gate for the External-Apps aide* wrappers, mirroring
 * masterSchedule's requireTeacherCaller. The ROLE half matches the
 * `scholarAdminMutation` gate on the underlying public mutations; the SCOPE
 * half is what stops that role check from being a cross-tenant leak.
 */
export async function requireScholarAdminScope(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
): Promise<ExternalAppScope> {
  const caller = await ctx.db.get(callerUserId);
  if (!caller) {
    throw new Error("External-app tools require an authorized staff account");
  }
  // Admission MUST match `requireScholarAdmin` (lib/auth.ts), the wrapper on
  // every public surface that reaches here: it admits a scholar-admin ROLE *or*
  // anyone holding school-operations access through a MEMBERSHIP. This helper
  // previously keyed only off the top-level role and returned null otherwise,
  // so a multi-hat caller — e.g. a `parent`-role user with a school_admin
  // membership, an explicitly supported shape in this repo — passed the wrapper
  // and then threw here, turning a working page into an error. Anyone whose
  // role is not itself scholar-admin falls back to their operations scope; the
  // empty-scope check below still fails closed for someone with no access.
  const institutions = isScholarAdminRole(caller.role)
    ? await curatableInstitutionIds(ctx, caller)
    : await schoolOperationsInstitutionIds(ctx, caller);
  if (
    !institutions ||
    (institutions !== "all" && institutions.size === 0)
  ) {
    throw new Error("External-app tools require school-operations access");
  }
  const scholars = await callerScholars(ctx, institutions);
  return { caller, scholars, institutions };
}

/**
 * Scholars the caller may act on, derived from the SAME institution scope the
 * group/school resolvers use — one notion of "my tenant" across the module.
 *
 * Semantically identical to `accessibleScholarIds`' teacher/operations staff/
 * school_admin branch ("every scholar whose users.institutionId is my school",
 * so an unassigned scholar is excluded — the settled fail-closed posture), but
 * sourced from `curatableInstitutionIds`, which degrades gracefully for a
 * staffer who has no `memberships` row yet (→ the primary school) instead of
 * throwing. Staff aren't in `users.institutionId` at all, so this set is
 * scholars only, by construction.
 */
async function callerScholars(
  ctx: QueryCtx,
  institutions: Set<Id<"institutions">> | "all",
): Promise<Set<Id<"users">> | "all"> {
  if (institutions === "all") return "all";
  const ids = new Set<Id<"users">>();
  for (const institutionId of institutions) {
    const members = await ctx.db
      .query("users")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    for (const u of members) if (u.role === ROLES.SCHOLAR) ids.add(u._id);
  }
  return ids;
}

// ── The three scope predicates — ONE home, used by both the name resolvers
// below and the read filters in appAudiences.ts, so "what is in my tenant"
// cannot drift between the write path and the read path.

export const isScholarInScope = (
  scope: ExternalAppScope,
  id: Id<"users">,
): boolean => scope.scholars === "all" || scope.scholars.has(id);

export const isInstitutionInScope = (
  scope: ExternalAppScope,
  id: Id<"institutions">,
): boolean => scope.institutions === "all" || scope.institutions.has(id);

/**
 * A group is in scope when the caller curates its institution. `scholarGroups`
 * stamps `institutionId` on create (empty groups included, from the creator's
 * active membership) and `institutionForRoster` refuses a mixed-institution
 * roster, so an UNSTAMPED group is a legacy artifact — handled all-or-nothing:
 * every member must be in scope, and an empty one is never in scope.
 *
 * That is deliberately stricter than `accessibleGroupScholars`, whose "empty
 * group is harmless, partial overlap is fine" rule is right for a READ ("what
 * can you see right now") and wrong here. A grant is a DURABLE WRITE against a
 * MUTABLE group: an empty unstamped group that anyone could name is a
 * pre-grant vector — school B grants an app to it today, school A adds its
 * first scholars tomorrow (which stamps the group and activates the waiting
 * grant, lib/appAudiences.ts resolving by membership), and B has provisioned
 * an app onto A's roster. Partial overlap is the same bug without the delay:
 * the grant covers every member, not the ones the caller can see.
 */
export const isGroupInScope = (
  scope: ExternalAppScope,
  group: Doc<"scholarGroups">,
): boolean => {
  if (scope.institutions === "all") return true;
  if (group.institutionId) return scope.institutions.has(group.institutionId);
  const roster = group.scholarIds ?? [];
  return roster.length > 0 && roster.every((id) => isScholarInScope(scope, id));
};

const inScholarScope = isScholarInScope;

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Resolve a catalog app by (fuzzy) name — case-insensitive: prefer an exact
 * name match, else a unique "contains" match. Throws listing candidates on 0
 * or an ambiguous >1.
 */
export async function resolveAppByName(
  ctx: QueryCtx,
  name: string,
): Promise<Doc<"externalApps">> {
  const q = norm(name);
  if (!q) throw new Error("An app name is required");
  const apps = await ctx.db.query("externalApps").collect();
  const exact = apps.filter((a) => norm(a.name) === q);
  const pool = exact.length > 0 ? exact : apps.filter((a) => norm(a.name).includes(q));
  if (pool.length === 0) {
    const known = apps.map((a) => a.name).sort().join(", ") || "(none)";
    throw new Error(`No app matches "${name}". Known apps: ${known}`);
  }
  if (pool.length > 1) {
    const cands = pool.map((a) => a.name).sort().join(", ");
    throw new Error(`"${name}" is ambiguous — matches: ${cands}. Be more specific.`);
  }
  return pool[0];
}

/**
 * Resolve a scholar group by name (case-insensitive exact, else unique
 * contains) **within the caller's tenancy scope**. A group stamped with an
 * institution must be one the caller curates; a legacy unstamped group falls
 * back to the roster rule `accessibleGroupScholars` already settled on — a
 * wholly-foreign roster is out of scope, while an EMPTY group (no scholars to
 * leak) stays reachable so a teacher can grant to a group they just created.
 */
export async function resolveGroupByName(
  ctx: QueryCtx,
  name: string,
  scope: ExternalAppScope,
): Promise<Doc<"scholarGroups">> {
  const q = norm(name);
  if (!q) throw new Error("A group name is required");
  const all = await ctx.db.query("scholarGroups").collect();
  const groups = all.filter((g) => isGroupInScope(scope, g));
  const exact = groups.filter((g) => norm(g.name) === q);
  const pool = exact.length > 0 ? exact : groups.filter((g) => norm(g.name).includes(q));
  if (pool.length === 0) {
    const known = groups.map((g) => g.name).sort().join(", ") || "(none)";
    throw new Error(`No group matches "${name}". Known groups: ${known}`);
  }
  if (pool.length > 1) {
    const cands = pool.map((g) => g.name).sort().join(", ");
    throw new Error(`"${name}" is ambiguous — matches: ${cands}. Be more specific.`);
  }
  return pool[0];
}

/**
 * Resolve an institution (school) by name or slug (case-insensitive exact, else
 * unique contains) **restricted to the schools the caller may curate**. This is
 * the widest-blast-radius resolver in the module — `enable_app_for_institution`
 * grants an app to an ENTIRE school — so an out-of-scope school must not even
 * appear in the "known schools" candidate list.
 */
export async function resolveInstitutionByName(
  ctx: QueryCtx,
  name: string,
  scope: ExternalAppScope,
): Promise<Doc<"institutions">> {
  const q = norm(name);
  if (!q) throw new Error("A school name is required");
  const all = await ctx.db.query("institutions").collect();
  const insts = all.filter((i) => isInstitutionInScope(scope, i._id));
  const exact = insts.filter((i) => norm(i.name) === q || norm(i.slug) === q);
  const pool = exact.length > 0 ? exact : insts.filter((i) => norm(i.name).includes(q));
  if (pool.length === 0) {
    const known = insts.map((i) => i.name).sort().join(", ") || "(none)";
    throw new Error(`No school matches "${name}". Known schools: ${known}`);
  }
  if (pool.length > 1) {
    const cands = pool.map((i) => i.name).sort().join(", ");
    throw new Error(`"${name}" is ambiguous — matches: ${cands}. Be more specific.`);
  }
  return pool[0];
}

/**
 * Resolve a SCHOLAR by username (exact, via by_username) or by name
 * (case-insensitive exact, else unique contains, over role=scholar). Throws
 * listing candidates on 0 / ambiguous. Only ever returns a scholar.
 *
 * Naming a scholar is itself the Extended Education opt-in
 * (lib/scholarParticipationTooling.ts) — this resolver deliberately keeps
 * resolving program guests; only enumerations apply the enrolled-only default.
 */
export async function resolveScholarByNameOrUsername(
  ctx: QueryCtx,
  query: string,
  scope: ExternalAppScope,
): Promise<Doc<"users">> {
  const raw = query.trim();
  if (!raw) throw new Error("A scholar name or username is required");
  // Exact username first — unambiguous and indexed. An out-of-scope hit falls
  // through to the (also scoped) name search and ends in the same "no scholar
  // matches" refusal, so the error never confirms a foreign scholar exists.
  const byUsername = await ctx.db
    .query("users")
    .withIndex("by_username", (uq) => uq.eq("username", raw))
    .first();
  if (
    byUsername &&
    byUsername.role === ROLES.SCHOLAR &&
    inScholarScope(scope, byUsername._id)
  ) {
    return byUsername;
  }

  const q = norm(raw);
  const all = await ctx.db
    .query("users")
    .withIndex("by_role", (uq) => uq.eq("role", ROLES.SCHOLAR))
    .collect();
  const scholars = all.filter((u) => inScholarScope(scope, u._id));
  const match = (u: Doc<"users">) => {
    const n = u.name ? norm(u.name) : "";
    const un = u.username ? norm(u.username) : "";
    return { n, un };
  };
  const exact = scholars.filter((u) => {
    const { n, un } = match(u);
    return n === q || un === q;
  });
  const pool =
    exact.length > 0
      ? exact
      : scholars.filter((u) => {
          const { n, un } = match(u);
          return n.includes(q) || un.includes(q);
        });
  if (pool.length === 0) {
    throw new Error(`No scholar matches "${query}". Try their exact username.`);
  }
  if (pool.length > 1) {
    const cands = pool
      .map((u) => u.username ?? u.name ?? String(u._id))
      .sort()
      .join(", ");
    throw new Error(
      `"${query}" is ambiguous — matches: ${cands}. Use the exact username.`,
    );
  }
  return pool[0];
}
