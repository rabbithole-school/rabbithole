// The ONE writer for `auditLog`, and the institution resolver its backfill
// shares (TRA-362).
//
// `auditLog.institutionId` is the tenancy key the staff-facing reader
// (`get_audit_log`) filters on. A row without it is invisible to every school,
// so a writer that forgets to stamp it silently drops the row from the record
// agents can read — the WRITER twin of engineering-principles.md's "a new
// state must be honored by every reader". Routing every insert through
// `writeAuditLog` makes the institution a required argument at compile time;
// `convex/__tests__/auditLog.test.ts` fails if a raw `insert("auditLog", …)`
// reappears anywhere else.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isPlatformAdminRole, ROLES } from "./roles";

/** What `get_audit_log` answers on any non-private surface (a Slack channel
 *  or group DM, a service-account MCP connection, a Google Doc comment). */
export const AUDIT_LOG_PRIVATE_ONLY =
  "Audit history is only available in a private chat with me.";

export type AuditEntry = {
  actorUserId: Id<"users">;
  action: string;
  targetUserId?: Id<"users">;
  detail?: string;
  ip?: string;
  userAgent?: string;
  /**
   * The institution the handler authorized against. Required so every call
   * site has to answer the question. `null` means the site genuinely has none
   * in scope; the row is then resolved exactly as the historical backfill
   * resolves it (`resolveAuditInstitution`), and left unset if that is
   * ambiguous.
   */
  institutionId: Id<"institutions"> | null;
};

export async function writeAuditLog(
  ctx: MutationCtx,
  entry: AuditEntry & { at?: number },
): Promise<Id<"auditLog">> {
  const { institutionId: explicit, at, ...row } = entry;
  const institutionId =
    explicit ?? (await resolveAuditInstitution(ctx, row))?.institutionId;
  return await ctx.db.insert("auditLog", {
    ...row,
    at: at ?? Date.now(),
    ...(institutionId ? { institutionId } : {}),
  });
}

/**
 * The institution of an app-grant AUDIENCE: the school itself for an
 * institution audience, the group's stamped school for a group audience. A
 * legacy unstamped group (or an id that no longer resolves) returns null
 * rather than guessing.
 */
export async function audienceInstitutionId(
  ctx: QueryCtx,
  kind: string,
  audienceId: string,
): Promise<Id<"institutions"> | null> {
  if (kind === "institution") {
    const iid = ctx.db.normalizeId("institutions", audienceId);
    return iid && (await ctx.db.get(iid)) ? iid : null;
  }
  if (kind === "group") {
    const gid = ctx.db.normalizeId("scholarGroups", audienceId);
    const group = gid ? await ctx.db.get(gid) : null;
    return group?.institutionId ?? null;
  }
  return null;
}

/**
 * A user's institution when it is UNAMBIGUOUS: the scholar projection
 * (`users.institutionId`) plus every institution-scoped membership, and only
 * if they all name the same school. Platform admins return null — their
 * standing is global, so a membership they happen to hold does not say which
 * school an action of theirs was about (an admin viewing a second school's
 * scholar is that school's record, not the admin's home school's).
 */
async function unambiguousUserInstitution(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Id<"institutions"> | null> {
  const user: Doc<"users"> | null = await ctx.db.get(userId);
  if (!user || isPlatformAdminRole(user.role)) return null;
  const ids = new Set<Id<"institutions">>();
  if (user.role === ROLES.SCHOLAR && user.institutionId) {
    ids.add(user.institutionId);
  }
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const m of memberships) if (m.institutionId) ids.add(m.institutionId);
  return ids.size === 1 ? [...ids][0] : null;
}

/** One distinct institution across `candidates`, else null. */
function single(
  candidates: Array<Id<"institutions"> | null | undefined>,
): Id<"institutions"> | null {
  const ids = new Set(candidates.filter((c): c is Id<"institutions"> => !!c));
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * An institution named by the row's `detail`, for the action families whose
 * detail carries an id or a key that resolves to exactly one school:
 * app-grant JSON (`audienceKind`/`audienceId`, or `scholarId`), a managed
 * device `serial …`, a paired `device …`, and an institution lifecycle row's
 * `(slug)`. Anything else — or anything that resolves to more than one school
 * — returns null.
 */
async function institutionFromDetail(
  ctx: QueryCtx,
  action: string,
  detail: string | undefined,
): Promise<Id<"institutions"> | null> {
  if (!detail) return null;
  if (action.startsWith("app-grant.")) {
    let parsed: { audienceKind?: unknown; audienceId?: unknown; scholarId?: unknown };
    try {
      parsed = JSON.parse(detail) as typeof parsed;
    } catch {
      return null;
    }
    if (
      typeof parsed.audienceKind === "string" &&
      typeof parsed.audienceId === "string"
    ) {
      return await audienceInstitutionId(
        ctx,
        parsed.audienceKind,
        parsed.audienceId,
      );
    }
    if (typeof parsed.scholarId === "string") {
      const sid = ctx.db.normalizeId("users", parsed.scholarId);
      return sid ? await unambiguousUserInstitution(ctx, sid) : null;
    }
    return null;
  }
  if (action.startsWith("institution.")) {
    const slug = /\(([^()\s]+)\)/.exec(detail)?.[1];
    if (!slug) return null;
    const inst = await ctx.db
      .query("institutions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    return single(inst.map((i) => i._id));
  }
  const serial = /\bserial (\S+?)[;,)]?(?:\s|$)/.exec(detail)?.[1];
  if (serial) {
    const claims = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_serial", (q) => q.eq("serial", serial))
      .collect();
    return single(claims.map((c) => c.institutionId));
  }
  const deviceId = /\bdevice (\S+?)[;,]?(?:\s|$)/.exec(detail)?.[1];
  if (deviceId) {
    const devices = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
      .collect();
    return single(devices.map((d) => d.institutionId));
  }
  return null;
}

export type AuditInstitutionSource = "target" | "actor" | "detail";

/**
 * Resolve the institution an audit row belongs to, failing closed:
 *   (a) the TARGET user's, if unambiguous (one school across their scholar
 *       projection + memberships; never for a platform admin) — the data
 *       acted on lives at the target's school, and actor-first would mis-file
 *       the older rows of a staffer who later changed schools;
 *   (b) else the actor's, if unambiguous (same rule);
 *   (c) else one named by `detail` for a known action family;
 *   (d) else null — the row stays unstamped and no school's reader shows it.
 * Shared by `writeAuditLog` (for a call site with no institution in scope)
 * and the `migrations:backfillAuditLogInstitution` backfill, so a live write
 * and a historical row are resolved by the same rules.
 */
export async function resolveAuditInstitution(
  ctx: QueryCtx,
  row: Pick<Doc<"auditLog">, "actorUserId" | "action" | "targetUserId" | "detail">,
): Promise<{ institutionId: Id<"institutions">; via: AuditInstitutionSource } | null> {
  if (row.targetUserId && row.targetUserId !== row.actorUserId) {
    const viaTarget = await unambiguousUserInstitution(ctx, row.targetUserId);
    if (viaTarget) return { institutionId: viaTarget, via: "target" };
  }
  const viaActor = await unambiguousUserInstitution(ctx, row.actorUserId);
  if (viaActor) return { institutionId: viaActor, via: "actor" };
  const viaDetail = await institutionFromDetail(ctx, row.action, row.detail);
  if (viaDetail) return { institutionId: viaDetail, via: "detail" };
  return null;
}
