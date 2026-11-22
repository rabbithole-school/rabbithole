// Who may read + write a scholar conversation (`parentThreads` of kind
// "scholar"). The ONE access rule behind every scholarMessages.* read and
// write, the inbound-email path for named adults, and their email batch — so
// a revoked grant, a lost membership, or a suspended school ends access on
// the very next call, everywhere.
//
// Two kinds of conversation: "family" (a scholar's guardians and staff) and
// "scholar" (one scholar and adults). A scholar conversation has a FLAVOR:
//
//   flavor    scholar            team (teacher/school_admin at    mentor grant
//                                the scholar's school, platform   covering the
//                                admin)                           scholar
//   general   own: read+reply    read, reply, create              open with a covered
//                                                                 scholar; read+reply
//                                                                 only threads they
//                                                                 are NAMED on
//   workshop  own: read+reply    read, reply, start               no
//   about     own: read+reply    read, reply, open                no
//             (one thread per Quest or wonder; `thread.about` says which)
//
// Family threads are never reachable here, and these threads are never
// reachable through the family paths (parentMessages.ts refuses them).
//
// STORAGE (mid-migration). New rows store `kind: "scholar"` + `flavor`.
// Rows written before that store the flavor in `kind` itself, under its old
// names ("mentor" = general, "workshop", "about"). `threadKind` and
// `threadFlavor` read both, so nothing else ever looks at `thread.kind`.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ROLES, isPlatformAdminRole } from "./roles";
import { mentorCoversScholar } from "./staffCapabilities";
import { scholarInstitutionId } from "./scholarEnrollment";
import {
  flavorFromLegacyKind,
  legacyKindForFlavor,
  type LegacyScholarThreadKind,
  type ScholarThreadFlavor,
} from "../../shared/scholarThreadFlavor";

type Ctx = QueryCtx | MutationCtx;

export type ThreadKind = "family" | "scholar";
export type { LegacyScholarThreadKind, ScholarThreadFlavor };
export { flavorFromLegacyKind, legacyKindForFlavor };

type KindFields = Pick<Doc<"parentThreads">, "kind" | "flavor">;

export function threadKind(thread: Pick<Doc<"parentThreads">, "kind">): ThreadKind {
  return thread.kind === undefined || thread.kind === "family" ? "family" : "scholar";
}

/** A scholar conversation's flavor; null for a family conversation (or a
 *  malformed scholar row with no flavor, which then reaches no one). */
export function threadFlavor(thread: KindFields): ScholarThreadFlavor | null {
  if (thread.kind === undefined || thread.kind === "family") return null;
  if (thread.kind === "scholar") return thread.flavor ?? null;
  return flavorFromLegacyKind(thread.kind);
}

/** The fields a new scholar conversation is stored with. */
export function scholarThreadKindFields(flavor: ScholarThreadFlavor): {
  kind: "scholar";
  flavor: ScholarThreadFlavor;
} {
  return { kind: "scholar", flavor };
}

export function isFamilyThread(
  thread: Pick<Doc<"parentThreads">, "kind">,
): boolean {
  return threadKind(thread) === "family";
}

/** A participant row on the family side (a guardian). Absent side = family. */
export function isFamilySide(
  row: Pick<Doc<"parentThreadParticipants">, "side">,
): boolean {
  return (row.side ?? "family") === "family";
}

async function liveInstitution(
  ctx: Ctx,
  institutionId: Id<"institutions"> | undefined,
): Promise<Doc<"institutions"> | null> {
  if (!institutionId) return null;
  const institution = await ctx.db.get(institutionId);
  return institution && institution.disabledAt === undefined ? institution : null;
}

export async function isPlatformAdminUser(
  ctx: Ctx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<boolean> {
  if (isPlatformAdminRole(user.role)) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  return memberships.some((membership) => isPlatformAdminRole(membership.role));
}

/**
 * A teacher (or school admin) at this LIVE institution, by membership. Base
 * staff — even with school:operations — are not the teaching team.
 */
export async function teachesAtInstitution(
  ctx: Ctx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  if (!(await liveInstitution(ctx, institutionId))) return false;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return memberships.some(
    (membership) =>
      membership.institutionId === institutionId &&
      (membership.role === ROLES.TEACHER ||
        membership.role === ROLES.SCHOOL_ADMIN),
  );
}

/** Live institutions where this user is on the teaching team. */
export async function teachingInstitutionIds(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<Set<Id<"institutions">>> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const ids = new Set<Id<"institutions">>();
  for (const membership of memberships) {
    if (
      membership.institutionId &&
      (membership.role === ROLES.TEACHER ||
        membership.role === ROLES.SCHOOL_ADMIN) &&
      (await liveInstitution(ctx, membership.institutionId))
    ) {
      ids.add(membership.institutionId);
    }
  }
  return ids;
}

/**
 * "The Rabbithole team" for one scholar's school: a platform admin, or a
 * teacher/school admin there. The institution must be live either way.
 */
export async function isTeamForInstitution(
  ctx: Ctx,
  user: Pick<Doc<"users">, "_id" | "role">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  if (!(await liveInstitution(ctx, institutionId))) return false;
  return (
    (await isPlatformAdminUser(ctx, user)) ||
    (await teachesAtInstitution(ctx, user._id, institutionId))
  );
}

/**
 * The institution a scholar's threads are stamped with: their enrollment
 * (the legacy `users.institutionId`, else their scholar membership). A
 * scholar with neither rides the PRIMARY school — the same pre-backfill rule
 * the institution lens applies (`scholarInLens`), so an unassigned scholar's
 * Workshop idea stays answerable by the team that can already see it.
 */
export async function scholarThreadInstitutionId(
  ctx: Ctx,
  scholar: Doc<"users">,
): Promise<Id<"institutions"> | null> {
  if (scholar.role !== ROLES.SCHOLAR) return null;
  if (scholar.institutionId) return scholar.institutionId;
  const enrolled = await scholarInstitutionId(ctx, scholar._id);
  if (enrolled) return enrolled;
  // Memberships that do not resolve to one school never default to the
  // primary one (TRA-654): only a scholar with no learner membership does.
  const learnerMembership = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", scholar._id))
    .filter((q) =>
      q.or(
        q.eq(q.field("role"), ROLES.SCHOLAR),
        q.eq(q.field("role"), ROLES.LIFELONG_LEARNER),
      ),
    )
    .first();
  if (learnerMembership) return null;
  const primary = (await ctx.db.query("institutions").collect()).find(
    (institution) => institution.isPrimary && institution.disabledAt === undefined,
  );
  return primary?._id ?? null;
}

/**
 * An `about` thread's school: the scholar's REAL enrollment only. No primary
 * fallback: an unenrolled scholar has no about threads anywhere, so no
 * school's teachers can open, read or answer one for them.
 */
export async function aboutThreadInstitutionId(
  ctx: Ctx,
  scholar: Doc<"users">,
): Promise<Id<"institutions"> | null> {
  if (scholar.role !== ROLES.SCHOLAR) return null;
  return (await scholarInstitutionId(ctx, scholar._id)) ?? null;
}

/** The school a thread of `flavor` with this scholar belongs to right now. */
async function institutionForFlavor(
  ctx: Ctx,
  scholar: Doc<"users">,
  flavor: ScholarThreadFlavor,
): Promise<Id<"institutions"> | null> {
  return flavor === "about"
    ? await aboutThreadInstitutionId(ctx, scholar)
    : await scholarThreadInstitutionId(ctx, scholar);
}

/**
 * The thread's scholar, only when the thread is internally consistent: a
 * scholar-role subject whose (live) institution matches the thread's stamp.
 */
export async function scholarForThread(
  ctx: Ctx,
  thread: Doc<"parentThreads">,
): Promise<Doc<"users"> | null> {
  const flavor = threadFlavor(thread);
  if (!flavor || !thread.scholarId) return null;
  const scholar = await ctx.db.get(thread.scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) return null;
  const institutionId = await institutionForFlavor(ctx, scholar, flavor);
  if (
    !institutionId ||
    institutionId !== thread.institutionId ||
    !(await liveInstitution(ctx, institutionId))
  ) {
    return null;
  }
  return scholar;
}

/**
 * May a STAFF user reach a thread of this flavor about this scholar? The same
 * rule decides reading, replying, and opening one.
 */
export async function staffCanReachScholar(
  ctx: Ctx,
  user: Pick<Doc<"users">, "_id" | "role">,
  scholar: Doc<"users">,
  flavor: ScholarThreadFlavor,
): Promise<{ ok: boolean; asTeam: boolean }> {
  if (user.role === ROLES.SCHOLAR) return { ok: false, asTeam: false };
  const institutionId = await institutionForFlavor(ctx, scholar, flavor);
  if (!institutionId) return { ok: false, asTeam: false };
  if (await isTeamForInstitution(ctx, user, institutionId)) {
    return { ok: true, asTeam: true };
  }
  // A mentor grant only ever covers an explicitly enrolled scholar.
  if (flavor === "general" && (await mentorCoversScholar(ctx, user, scholar))) {
    return { ok: true, asTeam: false };
  }
  return { ok: false, asTeam: false };
}

export type ScholarThreadAccess = {
  viewer: "scholar" | "staff";
  flavor: ScholarThreadFlavor;
  scholar: Doc<"users">;
  /** The thread's stamped (live) institution. */
  institutionId: Id<"institutions">;
  /** Staff viewer on the teaching team (vs. reaching it through a mentor grant). */
  asTeam: boolean;
  /**
   * History from a school the scholar has since LEFT: the teaching team at the stamped
   * school keep read-only access; nobody writes (the scholar's current school
   * gets a fresh thread). The scholar never sees it.
   */
  readOnly: boolean;
};

async function namedStaffRow(
  ctx: Ctx,
  threadId: Id<"parentThreads">,
  userId: Id<"users">,
) {
  const row = await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread_parent", (q) =>
      q.eq("threadId", threadId).eq("parentUserId", userId),
    )
    .unique();
  return row?.side === "staff" ? row : null;
}

/** The caller's access to a scholar conversation, or null (no access). */
export async function scholarThreadAccess(
  ctx: Ctx,
  user: Doc<"users">,
  thread: Doc<"parentThreads">,
): Promise<ScholarThreadAccess | null> {
  const flavor = threadFlavor(thread);
  if (!flavor || !thread.scholarId || !thread.institutionId) return null;
  const institutionId = thread.institutionId;
  const current = await scholarForThread(ctx, thread);
  if (current) {
    if (user.role === ROLES.SCHOLAR) {
      return user._id === current._id
        ? {
            viewer: "scholar",
            flavor,
            scholar: current,
            institutionId,
            asTeam: false,
            readOnly: false,
          }
        : null;
    }
    const reach = await staffCanReachScholar(ctx, user, current, flavor);
    if (!reach.ok) return null;
    // A mentor (grant holder, not the teaching team) reaches ONLY the threads
    // they are named on — never a teacher↔scholar thread or another mentor's
    // conversation with the same scholar. The grant gates OPENING a thread
    // (staffCanReachScholar); being named gates everything after that.
    if (!reach.asTeam && !(await namedStaffRow(ctx, thread._id, user._id))) {
      return null;
    }
    return {
      viewer: "staff",
      flavor,
      scholar: current,
      institutionId,
      asTeam: reach.asTeam,
      readOnly: false,
    };
  }

  // Not the scholar's current school: read-only history for the TEACHING
  // TEAM of the school it's stamped with (and platform admins). No mentor
  // reaches history — a grant's scholar scope can't be re-checked for a
  // scholar who has left, and a mentor's work with them has ended. Never the
  // scholar, never a write.
  if (user.role === ROLES.SCHOLAR) return null;
  const scholar = await ctx.db.get(thread.scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) return null;
  if (!(await liveInstitution(ctx, institutionId))) return null;
  if (await isTeamForInstitution(ctx, user, institutionId)) {
    return { viewer: "staff", flavor, scholar, institutionId, asTeam: true, readOnly: true };
  }
  return null;
}

/**
 * A staff read (or post). A NAMED adult has their own marker, so their read
 * never clears anyone else's unread. The shared TEAM marker moves only when
 * the reader is on the teaching team — a mentor reading (or answering by
 * email) must not make a scholar's message look handled to the teachers.
 * Nobody gets a participant row just for reading.
 */
export async function markStaffRead(
  ctx: MutationCtx,
  thread: Doc<"parentThreads">,
  user: Pick<Doc<"users">, "_id" | "role">,
  now: number,
): Promise<void> {
  const row = await namedStaffRow(ctx, thread._id, user._id);
  if (row) await ctx.db.patch(row._id, { lastReadAt: now });
  if (
    thread.institutionId &&
    (await isTeamForInstitution(ctx, user, thread.institutionId))
  ) {
    await ctx.db.patch(thread._id, { lastReadByTeacherAt: now });
  }
}
