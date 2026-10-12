// Stand up a partner organisation for a demo or pilot in ONE reviewed,
// idempotent, dry-run-first prod mutation — the thing `/org-demo` drives.
//
// It exists because doing this by hand on 2026-09-03/05 took ~40 CLI calls and
// hit a footgun at nearly every one of them. Each step below names the trap it
// closes, so the next person understands why it is shaped the way it is:
//
//   • Institution — the only prior creator (`setupTutoringInstitution`) wrote no
//     timezone, so "until midnight" device locks fell back to a default.
//   • Staff accounts — `adminCreateUser`, `ensureStaffAccount` and `fixRole` all
//     run `ensureDefaultMembershipForUser`, which mints a membership at the
//     PRIMARY institution when the new role has no home. Three visiting
//     teachers ended up able to see primary-institution scholars. This file inserts the
//     user row directly and only ever writes memberships with an explicit
//     institutionId, so there is no default path to leak through.
//   • Dual role — a staffer who should also try the learner side gets a
//     `scholar` membership at the learner institution. That is a supported
//     shape: `users.role` drives the dashboard, `scholarInstitutionId` reads
//     the scholar membership when the role is not `scholar`. What is NOT safe
//     is calling that on someone who already learns somewhere else —
//     `reconcileScholarEnrollment` would delete the other membership and
//     re-stamp their sessions. So that case is detected and skipped with a
//     warning instead.
//   • Sign-in — staff sign in by magic link, so the email is stamped verified.
//     The password paths were the wrong tool: the scholar enrol-token flow
//     refuses non-scholar roles, and `setMyPassword` throws from the CLI on
//     session invalidation even after succeeding.
//   • Curriculum — a unit copy inherits the CALLER's school, so copying into a
//     partner school needed a throwaway teacher with temporary global admin
//     access. Here the target institution is an explicit argument and the copy
//     recipe is the same one `units.duplicate` uses. Session start enforces
//     `unit.institutionId === learner institution`, so a copy in the wrong
//     school produces "Couldn't start that activity" on the iPad.
//   • Assignments — `assignWork` only schedules (`startsAt`); the scholar home
//     shows an entry only once `pushActivity` writes `setAt`. Both happen here.
//   • Verification — the report returned is the read-back, not a promise. Then
//     `/org-demo` signs in as each new user with `--identity` and looks.
//
// Everything is idempotent on natural keys (slug, email, username, copied
// unit title) so a re-run repairs rather than duplicates. Dry-run is the
// default, as with the rest of the maintenance mutations in prodCleanup.ts.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getInstitutionBySlug } from "./institutions";
import { ensureMembership } from "./memberships";
import { coreAssignWork, applyPushActivity } from "./assignments";
import { slugifyInstitutionName } from "./users";
import { ROLES, isStaffRole } from "./lib/roles";
import { ensureActiveStaffCapabilityGrant } from "./lib/staffCapabilities";
import { assertValidUsername } from "./lib/username";
import { normalizeReadingLevel } from "./lib/readingLevels";
import { normalizeEmail, isValidEmail } from "./lib/email";
import { seedDefaultAppsForScholar } from "./lib/externalAppsSeed";
import {
  duplicateUnitDesign,
  duplicateLessonDesign,
  duplicateActivitiesIntoLesson,
  remapCopiedActivityReferences,
  type CopiedActivity,
} from "./lib/curriculumDuplication";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "../shared/institutionDay";

export const DEFAULT_LEARNER_INSTITUTION_SLUG = "albatross-society";
/** The reading-level enum tops out here; there is no adult tier. */
export const ADULT_READING_LEVEL = "college";

const staffRoleValidator = v.union(
  v.literal(ROLES.TEACHER),
  v.literal(ROLES.STAFF),
);

const staffValidator = v.object({
  email: v.string(),
  name: v.string(),
  /** `teacher` gets the teaching surfaces. `staff` is the base role; pair it
   *  with `canManageSchoolOperations` for "the ed-tech person who adds people". */
  role: staffRoleValidator,
  canEditCurriculum: v.optional(v.boolean()),
  canManageSchoolOperations: v.optional(v.boolean()),
  /** Also enrol this person as a learner at the learner institution so they
   *  can try the scholar experience. Default true. */
  alsoLearner: v.optional(v.boolean()),
});

const testScholarValidator = v.object({
  name: v.string(),
  username: v.string(),
  gradeLevel: v.string(),
  readingLevel: v.optional(v.string()),
});

const learnerAssignmentValidator = v.object({
  unitId: v.id("units"),
  activityId: v.id("activities"),
});

type Plan = string[];
type Warnings = string[];

function slugFor(org: { name: string; slug?: string }): string {
  const s = (org.slug ?? slugifyInstitutionName(org.name)).trim();
  if (!s) throw new Error("Organisation needs a name or slug");
  return s;
}

async function primaryInstitutionId(ctx: MutationCtx) {
  return (await ctx.db.query("institutions").collect()).find((i) => i.isPrimary)?._id;
}

/**
 * Copy one unit (lessons + activities + remapped references) INTO an explicit
 * institution, owned by `teacherId`, keeping the source title. The recipe is
 * `units.duplicate`'s; the difference is that the destination is an argument
 * rather than "wherever the caller happens to teach".
 */
async function copyUnitInto(
  ctx: MutationCtx,
  source: Doc<"units">,
  institutionId: Id<"institutions">,
  teacherId: Id<"users">,
): Promise<Id<"units">> {
  const copyId = await ctx.db.insert("units", {
    ...duplicateUnitDesign(source, teacherId),
    title: source.title,
    institutionId,
    // A demo copy mirrors its source's publication state.
    unpublished: source.unpublished === true ? true : undefined,
  });
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", source._id))
    .collect();
  lessons.sort((a, b) => a.order - b.order);
  const activityIdMap = new Map<string, Id<"activities">>();
  const copied: CopiedActivity[] = [];
  for (const lesson of lessons) {
    const lessonCopyId = await ctx.db.insert(
      "lessons",
      duplicateLessonDesign(lesson, copyId, lesson.order),
    );
    copied.push(
      ...(await duplicateActivitiesIntoLesson(ctx, lesson._id, lessonCopyId, activityIdMap)),
    );
  }
  await remapCopiedActivityReferences(ctx, copied, activityIdMap, {
    dropUnmappedResourceReferences: true,
  });
  return copyId;
}

export const setupPartnerOrg = internalMutation({
  args: {
    org: v.object({
      name: v.string(),
      slug: v.optional(v.string()),
      emoji: v.optional(v.string()),
      timeZone: v.optional(v.string()),
    }),
    staff: v.array(staffValidator),
    testScholars: v.optional(v.array(testScholarValidator)),
    /** Source units (any institution) to copy INTO the new organisation. */
    copyUnitIds: v.optional(v.array(v.id("units"))),
    /** Where staff-as-learners are enrolled. Default: Albatross Academy. */
    learnerInstitutionSlug: v.optional(v.string()),
    /** Quests at the learner institution to push live for the new learners.
     *  Each unit MUST already belong to the learner institution. */
    learnerAssignments: v.optional(v.array(learnerAssignmentValidator)),
    /** The platform admin running this: owns copied units and assignments, is
     *  recorded as the grantor on capabilities and the creator of the school. */
    actorUserId: v.id("users"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const now = Date.now();
    const plan: Plan = [];
    const warnings: Warnings = [];

    const actor = await ctx.db.get(args.actorUserId);
    if (!actor) throw new Error("Actor not found");
    if (actor.role !== ROLES.PLATFORM_ADMIN) {
      throw new Error("Actor must be a platform admin");
    }

    // ── Institution ────────────────────────────────────────────────────────
    const slug = slugFor(args.org);
    const tz = args.org.timeZone?.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(tz)) throw new Error("Enter a valid IANA time zone");
    let institution = await getInstitutionBySlug(ctx, slug);
    if (institution) {
      plan.push(`institution "${slug}" exists`);
      if (institution.name.trim().toLowerCase() !== args.org.name.trim().toLowerCase()) {
        warnings.push(
          `slug "${slug}" already belongs to "${institution.name}", not "${args.org.name}" — staff below would join THAT school`,
        );
      }
      const patch: Partial<Doc<"institutions">> = {};
      if (args.org.timeZone && institution.timeZone !== tz) patch.timeZone = tz;
      if (args.org.emoji && institution.emoji !== args.org.emoji) patch.emoji = args.org.emoji;
      if (Object.keys(patch).length) {
        plan.push(`  patch ${Object.keys(patch).join(", ")}`);
        if (!dryRun) await ctx.db.patch(institution._id, patch);
      }
    } else {
      plan.push(`create institution "${args.org.name}" (${slug}, ${tz})`);
      if (!dryRun) {
        const id = await ctx.db.insert("institutions", {
          name: args.org.name.trim(),
          slug,
          kind: "school",
          isPrimary: false,
          timeZone: tz,
          ...(args.org.emoji ? { emoji: args.org.emoji } : {}),
          createdBy: actor._id,
        });
        institution = await ctx.db.get(id);
      }
    }
    const orgId = institution?._id;

    const learnerSlug = args.learnerInstitutionSlug ?? DEFAULT_LEARNER_INSTITUTION_SLUG;
    const learnerInstitution = await getInstitutionBySlug(ctx, learnerSlug);
    if (!learnerInstitution) {
      throw new Error(`Learner institution "${learnerSlug}" does not exist`);
    }
    const primaryId = await primaryInstitutionId(ctx);

    // ── Staff ─────────────────────────────────────────────────────────────
    const staffReport: Array<{
      email: string;
      name: string;
      userId: Id<"users"> | null;
      created: boolean;
      role: string;
    }> = [];
    const newLearnerIds: Id<"users">[] = [];
    // Learners the dry run WOULD enrol (they have no userId yet). Only used so
    // the dry-run plan and warnings match what the apply run will do.
    let plannedLearnerCount = 0;

    for (const s of args.staff) {
      const email = normalizeEmail(s.email);
      if (!isValidEmail(email)) throw new Error(`Invalid staff email: ${s.email}`);
      const existing = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      let userId: Id<"users"> | null = existing?._id ?? null;
      const created = !existing;
      if (existing && !isStaffRole(existing.role)) {
        // A scholar/parent account that owns this email. Adding a scholar
        // membership would MOVE a learner's enrollment via reconcile; adding a
        // staff membership would silently promote them. Neither is this tool's
        // job — surface it and skip.
        warnings.push(
          `${email} is an existing ${existing.role ?? "unknown"} account, not staff — skipped entirely`,
        );
        staffReport.push({ email, name: s.name, userId: existing._id, created: false, role: existing.role ?? "?" });
        continue;
      }
      if (existing) {
        plan.push(`staff ${email}: exists (${existing.role})`);
        if (existing.role && existing.role !== s.role) {
          warnings.push(
            `${email} already has role "${existing.role}"; left as is (asked for "${s.role}")`,
          );
        }
      } else {
        plan.push(`staff ${email}: create ${s.role} "${s.name}"`);
        if (!dryRun) {
          userId = await ctx.db.insert("users", {
            email,
            emailVerificationTime: now,
            name: s.name.trim(),
            role: s.role,
            readingLevel: ADULT_READING_LEVEL,
          });
        }
      }
      const effectiveRole = existing?.role ?? s.role;
      staffReport.push({ email, name: s.name, userId, created, role: effectiveRole });

      plan.push(`  + ${effectiveRole} membership @ ${slug}`);
      if (!userId) {
        // Dry run of a not-yet-created user: report the rest of the intention
        // without any row to write against.
        if (s.canEditCurriculum) plan.push(`  + curriculum:edit @ ${slug}`);
        if (s.canManageSchoolOperations) plan.push(`  + school:operations @ ${slug}`);
        if (s.alsoLearner ?? true) {
          plan.push(`  + scholar membership @ ${learnerSlug}`);
          plannedLearnerCount++;
        }
        continue;
      }
      if (!dryRun && orgId) {
        await ensureMembership(ctx, {
          userId,
          role: effectiveRole as Doc<"memberships">["role"],
          institutionId: orgId,
          createdBy: actor._id,
        });
      }

      if (!dryRun && orgId) {
        if (s.canEditCurriculum) {
          plan.push(`  + curriculum:edit @ ${slug}`);
          await ensureActiveStaffCapabilityGrant(ctx, {
            granteeUserId: userId,
            institutionId: orgId,
            capability: "curriculum:edit",
            grantedBy: actor._id,
          });
        }
        if (s.canManageSchoolOperations) {
          plan.push(`  + school:operations @ ${slug}`);
          await ensureActiveStaffCapabilityGrant(ctx, {
            granteeUserId: userId,
            institutionId: orgId,
            capability: "school:operations",
            grantedBy: actor._id,
          });
        }
      } else {
        if (s.canEditCurriculum) plan.push(`  + curriculum:edit @ ${slug}`);
        if (s.canManageSchoolOperations) plan.push(`  + school:operations @ ${slug}`);
      }

      if (s.alsoLearner ?? true) {
        const scholarMemberships = await ctx.db
          .query("memberships")
          .withIndex("by_user_role", (q) => q.eq("userId", userId!).eq("role", ROLES.SCHOLAR))
          .collect();
        const elsewhere = scholarMemberships.find(
          (m) => m.institutionId !== learnerInstitution._id,
        );
        if (elsewhere) {
          warnings.push(
            `${email} already learns at another institution; NOT enrolling at ${learnerSlug} (reconcile would delete that membership)`,
          );
        } else {
          plan.push(`  + scholar membership @ ${learnerSlug}`);
          if (!dryRun) {
            await ensureMembership(ctx, {
              userId,
              role: ROLES.SCHOLAR,
              institutionId: learnerInstitution._id,
              createdBy: actor._id,
            });
            if (!existing?.readingLevel) {
              await ctx.db.patch(userId, { readingLevel: ADULT_READING_LEVEL });
            }
          }
          newLearnerIds.push(userId);
          plannedLearnerCount++;
        }
      }

      // Leak audit: report (never silently strip) any membership at the primary
      // institution. A genuine primary staffer running a demo keeps theirs.
      if (primaryId && primaryId !== orgId) {
        const all = await ctx.db
          .query("memberships")
          .withIndex("by_user", (q) => q.eq("userId", userId!))
          .collect();
        if (all.some((m) => m.institutionId === primaryId)) {
          warnings.push(`${email} holds a membership at the PRIMARY institution — check that is intended`);
        }
      }
    }

    // ── Test scholars ─────────────────────────────────────────────────────
    const scholarReport: Array<{ username: string; userId: Id<"users"> | null; created: boolean }> = [];
    for (const t of args.testScholars ?? []) {
      const username = assertValidUsername(t.username);
      const rl = t.readingLevel ? normalizeReadingLevel(t.readingLevel) : null;
      if (t.readingLevel && !rl) throw new Error(`Invalid reading level "${t.readingLevel}"`);
      const existing = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .unique();
      if (existing) {
        plan.push(`test scholar ${username}: exists`);
        scholarReport.push({ username, userId: existing._id, created: false });
        continue;
      }
      plan.push(`test scholar ${username}: create "${t.name}" grade ${t.gradeLevel}`);
      let userId: Id<"users"> | null = null;
      if (!dryRun && orgId) {
        userId = await ctx.db.insert("users", {
          name: t.name.trim(),
          username,
          role: ROLES.SCHOLAR,
          institutionId: orgId,
          gradeLevel: t.gradeLevel,
          ...(rl ? { readingLevel: rl } : {}),
          profileSetupComplete: true,
        });
        await ensureMembership(ctx, {
          userId,
          role: ROLES.SCHOLAR,
          institutionId: orgId,
          createdBy: actor._id,
        });
        await seedDefaultAppsForScholar(ctx, userId, actor._id);
        await ctx.scheduler.runAfter(0, internal.onboarding.enrollScholar, { scholarId: userId });
      }
      scholarReport.push({ username, userId, created: true });
    }

    // ── Curriculum copies ─────────────────────────────────────────────────
    const unitReport: Array<{ sourceId: Id<"units">; title: string; copyId: Id<"units"> | null; created: boolean }> = [];
    for (const sourceId of args.copyUnitIds ?? []) {
      const source = await ctx.db.get(sourceId);
      if (!source) throw new Error(`Source unit ${sourceId} not found`);
      const already = orgId
        ? (await ctx.db.query("units").withIndex("by_institution", (q) => q.eq("institutionId", orgId)).collect())
            .find((u) => u.title === source.title && u.isActive !== false)
        : undefined;
      if (already) {
        plan.push(`unit "${source.title}": already at ${slug}`);
        unitReport.push({ sourceId, title: source.title, copyId: already._id, created: false });
        continue;
      }
      plan.push(`unit "${source.title}": copy into ${slug}`);
      let copyId: Id<"units"> | null = null;
      if (!dryRun && orgId) copyId = await copyUnitInto(ctx, source, orgId, actor._id);
      unitReport.push({ sourceId, title: source.title, copyId, created: true });
    }

    // ── Learner quests ────────────────────────────────────────────────────
    const assignmentReport: Array<{ unitId: Id<"units">; assignmentId: Id<"assignments"> | null }> = [];
    if ((args.learnerAssignments ?? []).length && plannedLearnerCount === 0) {
      warnings.push("learnerAssignments given but no new learners to assign them to");
    }
    for (const la of args.learnerAssignments ?? []) {
      const unit = await ctx.db.get(la.unitId);
      if (!unit) throw new Error(`Learner unit ${la.unitId} not found`);
      if (unit.institutionId !== learnerInstitution._id) {
        // The exact bug from 2026-09-03: the iPad says "Couldn't start that activity".
        throw new Error(
          `Unit "${unit.title}" is not stamped to ${learnerSlug}; session start would refuse it`,
        );
      }
      if (plannedLearnerCount === 0) continue;
      plan.push(`assign "${unit.title}" to ${plannedLearnerCount} learner(s) and push live`);
      if (newLearnerIds.length === 0) {
        assignmentReport.push({ unitId: la.unitId, assignmentId: null });
        continue; // dry run: learners do not exist yet
      }
      let assignmentId: Id<"assignments"> | null = null;
      if (!dryRun) {
        const r = await coreAssignWork(ctx, {
          teacherId: actor._id,
          unitId: la.unitId,
          scholarIds: newLearnerIds,
          title: unit.title,
          startsAt: now,
          target: { kind: "activity", activityId: la.activityId, mode: "classFocus" },
        });
        assignmentId = r.assignmentId;
        const a = await ctx.db.get(assignmentId);
        if (a) await applyPushActivity(ctx, a, { activityId: la.activityId, mode: "classFocus" });
      }
      assignmentReport.push({ unitId: la.unitId, assignmentId });
    }

    return {
      dryRun,
      institution: { slug, id: orgId ?? null },
      learnerInstitution: { slug: learnerSlug, id: learnerInstitution._id },
      staff: staffReport,
      testScholars: scholarReport,
      units: unitReport,
      assignments: assignmentReport,
      warnings,
      plan,
      signIn: {
        staff: "magic link — the email sign-in state at /?sign_in=email, using the address above",
        contextSwitch:
          "account menu → Switch context: '<role> · <org>' for teaching, 'Scholar · learner institution' to try the student side",
      },
    };
  },
});

/**
 * Read-back for `/org-demo`'s verification step: everything the mutation
 * touched, as it now stands. Flags memberships at the primary institution.
 */
export const partnerOrgReport = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const inst = await getInstitutionBySlug(ctx, args.slug);
    if (!inst) return { found: false as const, slug: args.slug };
    const primary = (await ctx.db.query("institutions").collect()).find((i) => i.isPrimary);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_institution", (q) => q.eq("institutionId", inst._id))
      .collect();
    const people = [];
    for (const userId of new Set(memberships.map((m) => m.userId))) {
      const u = await ctx.db.get(userId);
      if (!u) continue;
      const mine = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      const insts = await Promise.all(
        mine.map(async (m) => ({
          role: m.role,
          institution: m.institutionId ? (await ctx.db.get(m.institutionId))?.slug ?? "?" : "(global)",
        })),
      );
      people.push({
        name: u.name ?? null,
        username: u.username ?? null,
        email: u.email ?? null,
        role: u.role ?? null,
        readingLevel: u.readingLevel ?? null,
        gradeLevel: u.gradeLevel ?? null,
        memberships: insts,
        atPrimary: primary ? mine.some((m) => m.institutionId === primary._id) : false,
      });
    }
    const units = (
      await ctx.db.query("units").withIndex("by_institution", (q) => q.eq("institutionId", inst._id)).collect()
    )
      .filter((u) => u.isActive !== false)
      .map((u) => u.title);
    return {
      found: true as const,
      institution: { slug: inst.slug, name: inst.name, timeZone: inst.timeZone ?? null, kind: inst.kind },
      people,
      units,
    };
  },
});
