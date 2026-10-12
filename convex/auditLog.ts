// The staff-facing audit-trail READER (TRA-362): "who changed this, and when",
// answerable by an agent. Backs the `get_audit_log` tool
// (lib/auditLogTools.ts), which reaches staff through assembleCurriculumTools
// exactly where `get_external_app_access` does — the in-app aide, Slack, and
// the MCP connector.
//
// Tenancy is the whole design. `auditLog` mixes every school's staff actions
// (app grants, managed devices, health documents, impersonation), so a row is
// listed only through the `by_institution_at` index for an institution the
// caller both (a) curates, via the SAME `requireScholarAdminScope` gate the
// External-Apps tools use, and (b) has in their active institution lens. A row
// with no `institutionId` (not yet backfilled, or genuinely unresolvable) is
// never listed — fail closed. Staff actions ARE listed (ruling, Andy
// 2026-09-27); request forensics (`ip`, `userAgent`) never are.
//
// Three further walls, all here at the query layer so no surface can bypass
// them: health-record rows need HEALTH access at the row's school (not just
// school operations), admissions rows need the FULL admissions tier there, and
// an impersonation row shows who/whom/when but never its free-text detail. Private surfaces only: the tool refuses channels, and
// this query refuses service accounts (a shared channel identity).

import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireScholarAdminScope } from "./lib/externalAppsResolve";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { timeZoneForInstitution } from "./lib/institutionTime";
import {
  admissionsTierAtInstitution,
  healthInstitutionIds,
} from "./lib/staffCapabilities";
import { localInstant, resolveAudienceMeta } from "./appAudiences";
import { AUDIT_LOG_PRIVATE_ONLY } from "./lib/auditLog";

export const AUDIT_LOG_DEFAULT_LIMIT = 25;
export const AUDIT_LOG_MAX_LIMIT = 100;
export const AUDIT_LOG_DEFAULT_SINCE_DAYS = 7;
export const AUDIT_LOG_MAX_SINCE_DAYS = 90;
// Rows read per institution before giving up on filters that match rarely.
// Bounds the query's read set; the reply says when it was hit.
const SCAN_CAP = 2000;
const DETAIL_MAX_CHARS = 240;

function userLabel(user: Doc<"users"> | null): string {
  return user?.name ?? user?.username ?? "unknown";
}

function matchesName(user: Doc<"users"> | null, needle: string): boolean {
  if (!user) return false;
  const n = needle.trim().toLowerCase();
  return [user.name, user.username].some(
    (s) => !!s && s.toLowerCase().includes(n),
  );
}

/**
 * A compact, human-readable rendering of `detail`. App-grant rows carry JSON
 * with raw ids — render the app and audience by NAME, drop the ids. Anything
 * else is free text already written for humans; clip it.
 */
async function summarizeDetail(
  ctx: QueryCtx,
  detail: string | undefined,
): Promise<string | null> {
  if (!detail) return null;
  let parsed: Record<string, unknown> | null = null;
  if (detail.startsWith("{")) {
    try {
      parsed = JSON.parse(detail) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    return detail.length > DETAIL_MAX_CHARS
      ? `${detail.slice(0, DETAIL_MAX_CHARS)}…`
      : detail;
  }
  const parts: string[] = [];
  if (typeof parsed.appId === "string") {
    const appId = ctx.db.normalizeId("externalApps", parsed.appId);
    const app = appId ? await ctx.db.get(appId) : null;
    parts.push(`app ${app?.name ?? "(deleted app)"}`);
  }
  const kind = parsed.audienceKind;
  if (
    (kind === "group" || kind === "institution") &&
    typeof parsed.audienceId === "string"
  ) {
    const meta = await resolveAudienceMeta(ctx, kind, parsed.audienceId);
    parts.push(`${kind} ${meta.label}`);
  }
  if ("previousEnabled" in parsed || "newEnabled" in parsed) {
    const from = parsed.previousEnabled;
    const to = parsed.newEnabled;
    const word = (x: unknown) =>
      x === null ? "none" : x === true ? "on" : x === false ? "off" : String(x);
    parts.push(`${word(from)} → ${word(to)}`);
  }
  if (typeof parsed.via === "string") parts.push(`via ${parsed.via}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * The institutions this caller may read the audit trail of: their active lens
 * (one school, or every allowed school on an "all" lens), intersected with the
 * External-Apps curation scope. Throws when that is empty, so a caller with no
 * standing gets a legible refusal rather than an empty list that reads as
 * "nothing happened".
 */
async function readableInstitutions(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  institutionScope: string | undefined,
): Promise<{ caller: Doc<"users">; institutions: Doc<"institutions">[] }> {
  const scope = await requireScholarAdminScope(ctx, callerUserId);
  // A service account (`isSystem`, convex/mcpServiceAccounts.ts) is ONE
  // identity a whole Claude-in-Slack channel acts as — mcp.ts gives it the
  // "channel" surface for exactly that reason. Audit history is private-surface
  // only, so refuse it here too, where no transport can route around it.
  if (scope.caller.isSystem === true) {
    throw new Error(AUDIT_LOG_PRIVATE_ONLY);
  }
  const lens = await resolveInstitutionLens(
    ctx,
    scope.caller,
    institutionScope ?? "",
  );
  const lensIds =
    lens.scope === "institution"
      ? lens.institution
        ? [lens.institution._id]
        : []
      : [...lens.allowedInstitutionIds];
  const out: Doc<"institutions">[] = [];
  for (const id of lensIds) {
    if (scope.institutions !== "all" && !scope.institutions.has(id)) continue;
    const inst = await ctx.db.get(id);
    if (inst && !inst.disabledAt) out.push(inst);
  }
  if (out.length === 0) {
    throw new Error(
      "The audit log is scoped to your school, and no school is in your current view.",
    );
  }
  return { caller: scope.caller, institutions: out };
}

/**
 * Health-record audit rows name the document kind (custody document,
 * medication authorization, …) and review outcome — health data. They are
 * listed only where the caller holds HEALTH access at the row's school, by the
 * same gate the health-record surfaces use (`healthInstitutionIds`), which is
 * independent of the school-operations standing that admits this tool.
 */
const HEALTH_AUDIT_PREFIXES = [
  "health_document.",
  "medical_clearance.",
  "physical_exam.",
] as const;

function isHealthAuditAction(action: string): boolean {
  return HEALTH_AUDIT_PREFIXES.some((p) => action.startsWith(p));
}

/**
 * Admissions rows (`admissions.*`) name candidate households and what staff
 * changed about them. They are listed only where the caller holds the FULL
 * admissions tier at the row's school (`admissionsTierAtInstitution`), the
 * twin of the health wall: school-operations standing alone never shows them.
 */
function isAdmissionsAuditAction(action: string): boolean {
  return action.startsWith("admissions.");
}

/** View-as rows: who/whom/when only — the free-text reason and the
 *  `from <userId>` on a switch are never shown. */
function isImpersonationAuditAction(action: string): boolean {
  return action.startsWith("impersonation.");
}

export const aideListAuditLog = internalQuery({
  args: {
    callerUserId: v.id("users"),
    institutionScope: v.optional(v.string()),
    actionPrefix: v.optional(v.string()),
    targetName: v.optional(v.string()),
    actorName: v.optional(v.string()),
    sinceDays: v.optional(v.number()),
    limit: v.optional(v.number()),
    // Minute-rounded caller clock for the `since` window (T11 — Date.now()
    // inside a query is not a dependency).
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const { caller, institutions } = await readableInstitutions(
      ctx,
      args.callerUserId,
      args.institutionScope,
    );
    const healthIds = await healthInstitutionIds(ctx, caller);
    const healthReadable = (id: Id<"institutions">) =>
      healthIds === "all" || healthIds.has(id);
    const admissionsFullIds = new Set<Id<"institutions">>();
    for (const institution of institutions) {
      if (
        (await admissionsTierAtInstitution(ctx, caller, institution._id)) ===
        "full"
      ) {
        admissionsFullIds.add(institution._id);
      }
    }
    const limit = Math.max(
      1,
      Math.min(
        AUDIT_LOG_MAX_LIMIT,
        Math.floor(args.limit ?? AUDIT_LOG_DEFAULT_LIMIT),
      ),
    );
    const sinceDays = Math.max(
      0,
      Math.min(
        AUDIT_LOG_MAX_SINCE_DAYS,
        args.sinceDays ?? AUDIT_LOG_DEFAULT_SINCE_DAYS,
      ),
    );
    const since = args.now - sinceDays * 24 * 60 * 60 * 1000;
    const prefix = args.actionPrefix?.trim() || null;
    const targetName = args.targetName?.trim() || null;
    const actorName = args.actorName?.trim() || null;

    const users = new Map<Id<"users">, Doc<"users"> | null>();
    const getUser = async (id: Id<"users"> | undefined) => {
      if (!id) return null;
      if (!users.has(id)) users.set(id, await ctx.db.get(id));
      return users.get(id) ?? null;
    };

    const matched: Array<{ row: Doc<"auditLog">; institution: Doc<"institutions"> }> = [];
    let truncatedScan = false;
    let hitLimit = false;
    for (const institution of institutions) {
      let scanned = 0;
      let kept = 0;
      const rows = ctx.db
        .query("auditLog")
        .withIndex("by_institution_at", (q) =>
          q.eq("institutionId", institution._id).gte("at", since),
        )
        .order("desc");
      for await (const row of rows) {
        if (++scanned > SCAN_CAP) {
          truncatedScan = true;
          break;
        }
        if (prefix && !row.action.startsWith(prefix)) continue;
        if (
          isHealthAuditAction(row.action) &&
          !healthReadable(institution._id)
        ) {
          continue;
        }
        if (
          isAdmissionsAuditAction(row.action) &&
          !admissionsFullIds.has(institution._id)
        ) {
          continue;
        }
        if (actorName && !matchesName(await getUser(row.actorUserId), actorName)) {
          continue;
        }
        if (
          targetName &&
          !matchesName(await getUser(row.targetUserId), targetName)
        ) {
          continue;
        }
        matched.push({ row, institution });
        if (++kept >= limit) {
          hitLimit = true;
          break;
        }
      }
    }
    matched.sort((a, b) => b.row.at - a.row.at);
    const page = matched.slice(0, limit);

    const timeZones = new Map<Id<"institutions">, string>();
    const entries = [];
    for (const { row, institution } of page) {
      if (!timeZones.has(institution._id)) {
        timeZones.set(
          institution._id,
          await timeZoneForInstitution(ctx, institution._id),
        );
      }
      entries.push({
        at: localInstant(row.at, timeZones.get(institution._id)!),
        action: row.action,
        actor: userLabel(await getUser(row.actorUserId)),
        target:
          row.targetUserId && row.targetUserId !== row.actorUserId
            ? userLabel(await getUser(row.targetUserId))
            : null,
        detail: isImpersonationAuditAction(row.action)
          ? null
          : await summarizeDetail(ctx, row.detail),
        ...(institutions.length > 1 ? { school: institution.name } : {}),
      });
    }
    return {
      schools: institutions.map((i) => i.name),
      sinceDays,
      entries,
      // The limit was reached or the scan stopped early — there may be more.
      // Said out loud so a short list is never read as "nothing else happened".
      more: hitLimit || truncatedScan,
    };
  },
});
