/**
 * COMPLETE cascade purge for users and projects — CLI/internal only.
 *
 * Why this exists: `users.deleteUser` (platformAdminMutation) covers only ~12 tables and
 * leaves orphans in passkeys, scholarUnitBadges, activityCompletions, deliverables,
 * readingLevelHistory, teacherDirectives, scholarActivityAngles, chats,
 * curriculumMessages, notificationPrefs, guardianships, googleAccounts,
 * scholarDocuments (+ access logs / proposals), portfolioItems, and the auth
 * passkey tables. This module deletes EVERYTHING keyed to a userId/scholarId, and
 * a sibling for a single project.
 *
 * Read-only `inspect*` / `footprint*` queries let us preview exact targets before
 * deleting and verify counts go to zero after. internalMutation/internalQuery are
 * CLI-callable via `npx convex run` (no client identity needed).
 *
 * SAFE TO LEAVE IN THE TREE — internal only, never exposed to a client. Used for
 * one-off prod cleanup (demo accounts, test_ users) with per-turn approval.
 */
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
import { deleteSessionAppStates } from "./appStates";
import { detachScholarFromPortfolio } from "./lib/portfolioAttributions";
import { scheduleClaimDecommissionLocksForScholar } from "./lib/deviceAppUnlockScheduling";

// ─── Project cascade (shared by purgeSession + purgeUser) ────────────
//
// Also reused by `units.remove` to purge a unit's leftover test-drive
// projects (the teacher's own throwaway sessions) on hard-delete.

export async function deleteSessionInner(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const counts: Record<string, number> = {};
  const del = async (table: string, ids: Id<TableNames>[]) => {
    for (const id of ids) await ctx.db.delete(id);
    counts[table] = (counts[table] ?? 0) + ids.length;
  };

  // Indexed by_project (unrolled — a union `table` var trips Convex's index typing)
  counts.appStates = await deleteSessionAppStates(ctx, sessionId);
  await del("messages", (await ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("artifacts", (await ctx.db.query("artifacts").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("analyses", (await ctx.db.query("analyses").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("processState", (await ctx.db.query("processState").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("sessionSignals", (await ctx.db.query("sessionSignals").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("crossDomainConnections", (await ctx.db.query("crossDomainConnections").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("deliverables", (await ctx.db.query("deliverables").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("testDriveFlags", (await ctx.db.query("testDriveFlags").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));
  await del("observations", (await ctx.db.query("observations").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect()).map((r) => r._id));

  // masteryObservations by_project — also drop each one's teacher overrides
  const mastery = await ctx.db.query("masteryObservations").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
  for (const m of mastery) {
    const ovs = await ctx.db.query("teacherMasteryOverrides").withIndex("by_observation", (q) => q.eq("observationId", m._id)).collect();
    await del("teacherMasteryOverrides", ovs.map((o) => o._id));
  }
  await del("masteryObservations", mastery.map((m) => m._id));

  // projectId-bearing tables WITHOUT a by_project index → filter
  const seeds = await ctx.db.query("seeds").filter((q) => q.eq(q.field("sessionId"), sessionId)).collect();
  await del("seeds", seeds.map((s) => s._id));
  const acts = await ctx.db.query("activityCompletions").filter((q) => q.eq(q.field("sessionId"), sessionId)).collect();
  await del("activityCompletions", acts.map((a) => a._id));

  await ctx.db.delete(sessionId);
  counts.sessions = (counts.sessions ?? 0) + 1;
  return counts;
}

function mergeCounts(into: Record<string, number>, add: Record<string, number>) {
  for (const [k, n] of Object.entries(add)) into[k] = (into[k] ?? 0) + n;
}

// ─── purgeSession ────────────────────────────────────────────────────

export const purgeSession = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error(`No project ${args.sessionId}`);
    const owner = await ctx.db.get(session.userId);
    const counts = await deleteSessionInner(ctx, args.sessionId);
    return {
      deletedSession: { id: args.sessionId, title: session.title, owner: owner?.name ?? owner?.username ?? null },
      counts,
    };
  },
});

// ─── purgeUser (complete cascade) ────────────────────────────────────

export const purgeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error(`No user ${args.userId}`);
    const uid = args.userId;
    const counts: Record<string, number> = {};
    const warnings: string[] = [];
    const del = async (table: string, ids: Id<TableNames>[]) => {
      for (const id of ids) await ctx.db.delete(id);
      counts[table] = (counts[table] ?? 0) + ids.length;
    };

    // 1. Projects (full per-project cascade)
    const sessions = await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
    for (const p of sessions) mergeCounts(counts, await deleteSessionInner(ctx, p._id));

    // 2. Scholar-keyed observation/learning-record tables
    for (const o of await ctx.db.query("observations").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()) await ctx.db.delete(o._id);
    for (const o of await ctx.db.query("observations").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()) await ctx.db.delete(o._id);

    const mastery = await ctx.db.query("masteryObservations").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
    for (const m of mastery) {
      const ovs = await ctx.db.query("teacherMasteryOverrides").withIndex("by_observation", (q) => q.eq("observationId", m._id)).collect();
      await del("teacherMasteryOverrides", ovs.map((o) => o._id));
    }
    await del("masteryObservations", mastery.map((m) => m._id));
    await del("teacherMasteryOverrides", (await ctx.db.query("teacherMasteryOverrides").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((o) => o._id));

    await del("seeds", (await ctx.db.query("seeds").withIndex("by_scholar_status", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("sessionSignals", (await ctx.db.query("sessionSignals").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("crossDomainConnections", (await ctx.db.query("crossDomainConnections").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("scholarDossiers", (await ctx.db.query("scholarDossiers").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("teacherDirectives", (await ctx.db.query("teacherDirectives").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("readingLevelHistory", (await ctx.db.query("readingLevelHistory").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("scholarActivityAngles", (await ctx.db.query("scholarActivityAngles").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("scholarUnitBadges", (await ctx.db.query("scholarUnitBadges").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("activityCompletions", (await ctx.db.query("activityCompletions").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("deliverables", (await ctx.db.query("deliverables").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));

    // 3. Scholar documents (+ their access logs / proposals)
    const docs = await ctx.db.query("scholarDocuments").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
    for (const d of docs) {
      await del("documentAccessLog", (await ctx.db.query("documentAccessLog").withIndex("by_document", (q) => q.eq("documentId", d._id)).collect()).map((r) => r._id));
      await del("documentProposals", (await ctx.db.query("documentProposals").withIndex("by_document", (q) => q.eq("documentId", d._id)).collect()).map((r) => r._id));
    }
    await del("scholarDocuments", docs.map((d) => d._id));
    await del("documentAccessLog", (await ctx.db.query("documentAccessLog").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("documentAccessLog", (await ctx.db.query("documentAccessLog").withIndex("by_user", (q) => q.eq("userId", uid)).collect()).map((r) => r._id));
    await del("documentProposals", (await ctx.db.query("documentProposals").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));

    // 4. Portfolio — retain shared evidence for surviving attributed peers.
    const detached = await detachScholarFromPortfolio(ctx, uid);
    counts.portfolioAttributions =
      (counts.portfolioAttributions ?? 0) + detached.deletedAttributions;
    counts.captureStationCaptures =
      (counts.captureStationCaptures ?? 0) + detached.deletedCaptures;
    await del(
      "portfolioItems",
      detached.orphanedItems.map((item) => item._id),
    );

    // 5. Parent / guardianship / notifications
    await del("guardianships", (await ctx.db.query("guardianships").withIndex("by_scholar", (q) => q.eq("scholarUserId", uid)).collect()).map((r) => r._id));
    await del("guardianships", (await ctx.db.query("guardianships").withIndex("by_parent", (q) => q.eq("parentUserId", uid)).collect()).map((r) => r._id));
    await del("parentChatMessages", (await ctx.db.query("parentChatMessages").withIndex("by_parent", (q) => q.eq("parentUserId", uid)).collect()).map((r) => r._id));
    await del("notificationPrefs", (await ctx.db.query("notificationPrefs").withIndex("by_user", (q) => q.eq("userId", uid)).collect()).map((r) => r._id));

    // 6. Teacher-side chat (also catches scholar-scoped threads)
    await del("chats", (await ctx.db.query("chats").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()).map((r) => r._id));
    await del("chats", (await ctx.db.query("chats").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));
    await del("curriculumMessages", (await ctx.db.query("curriculumMessages").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()).map((r) => r._id));
    await del("curriculumMessages", (await ctx.db.query("curriculumMessages").withIndex("by_scholar_and_creation", (q) => q.eq("scholarId", uid)).collect()).map((r) => r._id));

    // 7. Assignments authored as teacher
    await del("assignments", (await ctx.db.query("assignments").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()).map((r) => r._id));

    // 8. Independent-study units authored by this scholar (+ their lessons/activities)
    const isUnits = await ctx.db.query("units").withIndex("by_authorScholar", (q) => q.eq("authorScholarId", uid)).collect();
    for (const u of isUnits) {
      const lessons = await ctx.db.query("lessons").withIndex("by_unit", (q) => q.eq("unitId", u._id)).collect();
      for (const l of lessons) {
        await del("activities", (await ctx.db.query("activities").withIndex("by_lesson", (q) => q.eq("lessonId", l._id)).collect()).map((r) => r._id));
      }
      await del("lessons", lessons.map((l) => l._id));
    }
    await del("units", isUnits.map((u) => u._id));

    // 9. Auth + per-user tokens
    await del("passkeys", (await ctx.db.query("passkeys").withIndex("by_user", (q) => q.eq("userId", uid)).collect()).map((r) => r._id));
    await del("webauthnChallenges", (await ctx.db.query("webauthnChallenges").withIndex("by_user", (q) => q.eq("userId", uid)).collect()).map((r) => r._id));
    await del("enrollmentTokens", (await ctx.db.query("enrollmentTokens").withIndex("by_user", (q) => q.eq("userId", uid)).collect()).map((r) => r._id));
    await del("googleAccounts", (await ctx.db.query("googleAccounts").withIndex("by_user", (q) => q.eq("userId", uid)).collect()).map((r) => r._id));

    const authSessions = await ctx.db.query("authSessions").filter((q) => q.eq(q.field("userId"), uid)).collect();
    for (const s of authSessions) {
      await del("authRefreshTokens", (await ctx.db.query("authRefreshTokens").filter((q) => q.eq(q.field("sessionId"), s._id)).collect()).map((r) => r._id));
    }
    await del("authSessions", authSessions.map((s) => s._id));
    const accounts = await ctx.db.query("authAccounts").filter((q) => q.eq(q.field("userId"), uid)).collect();
    for (const a of accounts) {
      await del("authVerificationCodes", (await ctx.db.query("authVerificationCodes").filter((q) => q.eq(q.field("accountId"), a._id)).collect()).map((r) => r._id));
    }
    await del("authAccounts", accounts.map((a) => a._id));

    // 10. Residuals we intentionally DON'T auto-delete (report instead)
    const personaN = (await ctx.db.query("personas").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()).length;
    if (personaN) warnings.push(`${personaN} personas authored by this user as teacher — NOT deleted (shared curriculum). Review manually.`);
    const perspN = (await ctx.db.query("perspectives").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()).length;
    if (perspN) warnings.push(`${perspN} perspectives authored by this user as teacher — NOT deleted (shared curriculum). Review manually.`);
    const procN = (await ctx.db.query("processes").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()).length;
    if (procN) warnings.push(`${procN} processes authored by this user as teacher — NOT deleted (shared curriculum). Review manually.`);
    const teacherUnits = (await ctx.db.query("units").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()).length;
    if (teacherUnits) warnings.push(`${teacherUnits} teacher-authored units — NOT deleted (shared curriculum). Review manually.`);
    // Array-membership references (no index → small-table scans)
    const inAssignments = (await ctx.db.query("assignments").collect()).filter((a) => a.scholarIds.some((s) => s === uid)).length;
    if (inAssignments) warnings.push(`Listed in ${inAssignments} assignment scholarIds — left as dangling id (low harm).`);
    const inGroups = (await ctx.db.query("scholarGroups").collect()).filter((g) => g.scholarIds.some((s) => s === uid)).length;
    if (inGroups) warnings.push(`Listed in ${inGroups} scholarGroups — left as dangling id (low harm).`);

    // 11. A deleted user's own managed device claim(s) — nothing else here
    // tells an already-unlocked device to re-lock (mirrors the same guard in
    // users.deleteUserCore / adminCloneScholar / lib/cascade.ts).
    await scheduleClaimDecommissionLocksForScholar(ctx, uid);

    // 12. The user row
    await ctx.db.delete(uid);
    counts.users = (counts.users ?? 0) + 1;

    return { deleted: { id: uid, name: user.name ?? null, username: user.username ?? null, role: user.role ?? null }, counts, warnings };
  },
});

// ─── Read-only inspection (for the pre-delete confirmation) ──────────

export const inspectUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const sessions = await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", args.userId)).collect();
    const withCounts = await Promise.all(sessions.map(async (p) => {
      const msgs = await ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", p._id)).collect();
      return { id: p._id, title: p.title, isArchived: p.isArchived, messages: msgs.length, firstMessage: msgs.find((m) => m.role === "user")?.content?.slice(0, 140) ?? null };
    }));
    return { id: user._id, name: user.name ?? null, username: user.username ?? null, role: user.role ?? null, email: user.email ?? null, sessions: withCounts };
  },
});

/** Users whose username starts with any of the given prefixes (case-sensitive). */
export const listByUsernamePrefixes = internalQuery({
  args: { prefixes: v.array(v.string()) },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.username && args.prefixes.some((p) => u.username!.startsWith(p)))
      .map((u) => ({ id: u._id, username: u.username, name: u.name ?? null, role: u.role ?? null }));
  },
});

/** Find users by a case-insensitive substring of name or username. */
export const findUsers = internalQuery({
  args: { needle: v.string() },
  handler: async (ctx, args) => {
    const n = args.needle.toLowerCase();
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => (u.name?.toLowerCase().includes(n)) || (u.username?.toLowerCase().includes(n)))
      .map((u) => ({ id: u._id, username: u.username ?? null, name: u.name ?? null, role: u.role ?? null }));
  },
});
