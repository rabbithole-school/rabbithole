import {
  customQuery,
  customMutation,
  customAction,
} from "convex-helpers/server/customFunctions";
import { query, mutation, action } from "../_generated/server";
import { requireUser, requireTeacher, requirePlatformAdmin, requireSchoolAdmin, requireCurriculumAccess, requireCurriculumAccessSelf, requireStaffSelf, requireScholarAdmin, requireStaff, assertNotImpersonating } from "./auth";
import { Doc } from "../_generated/dataModel";

// ── Authenticated queries/mutations (any logged-in user) ──────────────

export const authedQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireUser(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const authedMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const user = await requireUser(ctx);
    await assertNotImpersonating(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const authedAction = customAction(action, {
  args: {},
  input: async (ctx) => {
    // Actions don't have db access directly, but we can pass user info
    return { ctx, args: {} };
  },
});

// ── Teacher-only queries/mutations ────────────────────────────────────

export const teacherQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireTeacher(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const teacherMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const user = await requireTeacher(ctx);
    await assertNotImpersonating(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

// ── Scholar-admin queries/mutations (teacher + admins + operations staff) ─────
// Account administration + portfolio. NOT sensitive data, NOT curriculum.

export const scholarAdminQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireScholarAdmin(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const scholarAdminMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const user = await requireScholarAdmin(ctx);
    await assertNotImpersonating(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

// ── Staff queries/mutations (teacher + admins + curriculum_designer + operations staff) ──
// For surfaces every staffer may touch (e.g. their own AI-assistant chat
// threads), regardless of specialty. Not for sensitive data or curriculum.

export const staffQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireStaff(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const staffMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const user = await requireStaff(ctx);
    await assertNotImpersonating(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

// ── Curriculum queries/mutations (teacher + admins + curriculum_designer) ──

export const curriculumQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireCurriculumAccess(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const curriculumMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const user = await requireCurriculumAccess(ctx);
    await assertNotImpersonating(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

// ── "Act as yourself" curriculum query ────────────────────────────────
// Same authorization as curriculumQuery, but ctx.user is the REAL session
// owner (impersonation-independent) rather than the effective/impersonated
// user. For per-user "me, the logged-in account" resources whose WRITE path
// binds to the real owner (e.g. the Google account link — beginOAuth/callback
// bind by getAuthUserId). Keeps the read identity consistent with the write so
// a platform-admin's own link stays visible while a view-as overlay is active.
// See requireCurriculumAccessSelf.
export const curriculumSelfQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireCurriculumAccessSelf(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

// ── "Act as yourself" staff query ─────────────────────────────────────
// Same real-session-owner semantics as curriculumSelfQuery, but the wider
// staff gate. For per-user "me, the logged-in account" resources that belong
// to every staff role — the Google account link, whose write path is gated on
// requireStaffAction. See requireStaffSelf.
export const staffSelfQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireStaffSelf(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

// ── Platform-admin-only queries/mutations ─────────────────────────────
// The GLOBAL Rabbithole operator: user/role administration, integrations,
// platform settings, cross-institution changes. School admins NEVER pass this gate.

export const platformAdminQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requirePlatformAdmin(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const platformAdminMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const user = await requirePlatformAdmin(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});


// ── School-admin queries/mutations ────────────────────────────────────
// Institution-scoped administration: a school_admin (institution leader) or a
// platform_admin acting in a school. The institution scope itself is enforced
// by the access boundary (convex/lib/access.ts).

export const schoolAdminQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const user = await requireSchoolAdmin(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

export const schoolAdminMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const user = await requireSchoolAdmin(ctx);
    await assertNotImpersonating(ctx);
    return { ctx: { ...ctx, user }, args: {} };
  },
});

// Re-export the user type for convenience
export type AuthenticatedUser = Doc<"users">;
