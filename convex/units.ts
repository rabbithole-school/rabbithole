import { v, type ObjectType } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { stream } from "convex-helpers/server/stream";
import schema from "./schema";
import { unitFitsSubjectFilter, unitSubjectFilterOptions } from "../lib/subjects";
import { unitFitsGradeFilter, unitGradeFilterOptions } from "../shared/unitGrade";
import {
  authedMutation,
  authedQuery,
  curriculumMutation,
  teacherMutation,
  teacherQuery,
} from "./lib/customFunctions";
import {
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { chosenPathValidator } from "./bakeUnitFromSeed";
import {
  requireAgentUnitEditAccess,
  requireUnitEditAccess,
  requireUnitEditAccessForUser,
} from "./lib/auth";
import {
  assertInstitutionActive,
  canAccessScholar,
  requireActiveScholarAccess,
  requireScholarsAccessible,
} from "./lib/access";
import {
  programSchedulableUnits,
  requireProgramPublishAccess,
} from "./lib/programGroupAccess";
import {
  requireActiveLearnerInstitution,
  scholarInstitutionId as resolveScholarInstitutionId,
} from "./lib/scholarEnrollment";
import {
  institutionIdForUnitAuthor,
  requireUnitAccess,
} from "./lib/unitAccess";
import { deleteSessionInner } from "./devPurge";
import { deleteActivityCascade } from "./lib/activityCascade";
import {
  schoolSubjectOptions,
  syncClassesForPlacements,
  unitSubjectOptions,
} from "./lib/classLink";
import { ROLES, isPlatformAdminRole, isTeacherRole } from "./lib/roles";
import { isProgramGuest } from "./lib/enrollmentStanding";
import {
  assignedProgramUnitIdsForScholar,
  isOwnQuestUnit,
} from "./lib/programGuestWork";
import {
  curriculumAccessInstitutionIds,
  hasCurriculumAccess,
} from "./lib/curriculumAccess";
import {
  institutionIdInLens,
  resolveInstitutionLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import { primaryInstitutionId } from "./institutions";
import {
  firstIncompleteSessionActivityInUnit,
  isSessionActivityComplete,
  unitSessionProgressForScholar,
} from "./lib/scholarReads";
import { SCHOLAR_DISMISSED_REASON, plantTeacherSeed } from "./lib/seeds";
import { questBuildLocksFor } from "./lib/questBuildLock";
import {
  homeTitleForIndependentStudyUnit,
  mintIndependentStudyUnit,
} from "./lib/independentStudy";
import { mergeKeyedGranules, toKeyedGranules } from "./lib/granules";
import { resolveUnitGradeEdit, unitGradeUnreadableError } from "./lib/unitGrade";
import {
  resolveUnitSubject,
  resolveUnitSubjectEdit,
  unitSubjectNotAClassError,
} from "./lib/unitSubject";
import {
  duplicateActivitiesIntoLesson,
  duplicateLessonDesign,
  duplicateUnitDesign,
  remapCopiedActivityReferences,
  type CopiedActivity,
} from "./lib/curriculumDuplication";
import { isStalledQuest, questsForScholar } from "./lib/questLifecycle";
import {
  isUnansweredOrDeclinedProposal,
  withoutQuestApproval,
} from "./lib/questApproval";
import { assertProposalTakesNoStructure } from "./lib/questStructure";
import {
  isUnitPublished,
  scholarHoldsAssignmentForUnit,
} from "./lib/unitPublication";
import type { QuestState } from "./lib/questLifecycle";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * Whether `units.list` needs the scholar-id scan to filter independent-study
 * units. The two unrestricted cases retain their historical deployment-wide
 * results without reading every scholar.
 */
export function unitListNeedsScholarEnumeration({
  adminAll,
  legacySingleTenant,
}: {
  adminAll: boolean;
  legacySingleTenant: boolean;
}): boolean {
  return !adminAll && !legacySingleTenant;
}

/**
 * The curriculum tenancy lens as a per-unit predicate: catalog units follow
 * their own `institutionId` stamp; Independent Study units
 * (`authorScholarId`) follow their author scholar's institution. Resolved once
 * per call, so the collect-then-filter callers (`curriculumUnitsInLens`) and
 * the paginated Units browser (`listForBrowser`, which filters its stream
 * BEFORE picking the page) apply the exact same boundary. Also the aide's
 * unit list and title resolver (`curriculumAssistant.listUnitsInternal`), so
 * the bot sees exactly the units the caller's Curriculum page does.
 */
export async function curriculumUnitLensPredicate(
  ctx: QueryCtx & { user?: Doc<"users"> },
  scope?: string,
  explicitUser?: Doc<"users">,
): Promise<(unit: Doc<"units">) => boolean> {
  const user = explicitUser ?? ctx.user;
  if (!user) throw new Error("Not authenticated");
  const lens = await resolveInstitutionLens(ctx, user, scope);
  const adminAll = lens.isAdmin && scope === undefined;
  const staffPrimaryFallback =
    !lens.isAdmin &&
    !lens.hasStaffMembership &&
    !!lens.primaryInstitution;
  const legacySingleTenant =
    !lens.primaryInstitution &&
    !lens.institution &&
    lens.allowedInstitutionIds.size === 0;
  let visible: (unit: Doc<"units">) => boolean;
  if (
    !unitListNeedsScholarEnumeration({
      adminAll,
      legacySingleTenant,
    })
  ) {
    visible = () => true;
  } else {
    // A withdrawn scholar's authored units stay visible as history.
    const allowedScholarIds = await scholarIdsInLens(ctx, lens, {
      includeWithdrawn: true,
    });
    visible = (unit) =>
      unit.authorScholarId
        ? allowedScholarIds.has(unit.authorScholarId)
        : staffPrimaryFallback
          ? (unit.institutionId ?? lens.primaryInstitution?._id) ===
            lens.primaryInstitution?._id
          : institutionIdInLens(lens, unit.institutionId);
  }

  const curriculumInstitutionIds = await curriculumAccessInstitutionIds(
    ctx,
    user,
  );
  if (curriculumInstitutionIds === "all") return visible;
  // The spread keeps the caller's scholarReadInstitutionIds, so a
  // scholar-authored unit is visible only where the caller may also read
  // scholars — curriculum:edit alone never surfaces a scholar's work (TRA-374).
  const curriculumScholarIds = await scholarIdsInLens(ctx, {
    ...lens,
    scope: "all",
    institution: null,
    isAdmin: false,
    allowedInstitutionIds: curriculumInstitutionIds,
  }, { includeWithdrawn: true });
  return (unit) => {
    if (!visible(unit)) return false;
    if (unit.authorScholarId) {
      return curriculumScholarIds.has(unit.authorScholarId);
    }
    const institutionId =
      unit.institutionId ?? lens.primaryInstitution?._id;
    return !!institutionId && curriculumInstitutionIds.has(institutionId);
  };
}

async function curriculumUnitsInLens(
  ctx: QueryCtx & { user?: Doc<"users"> },
  all: Doc<"units">[],
  scope?: string,
  explicitUser?: Doc<"users">,
) {
  return all.filter(
    await curriculumUnitLensPredicate(ctx, scope, explicitUser),
  );
}

/**
 * The institution a non-scholar caller's unit list is scoped to: their oldest
 * membership at an ACTIVE (non-suspended) institution, preferring one held in
 * their own role. Only a caller with no institution-scoped membership at all
 * gets the primary fallback — a member of a suspended school is scoped to
 * nothing rather than to another school.
 */
async function membershipInstitutionId(
  ctx: QueryCtx,
  user: Doc<"users">,
  primaryId: Id<"institutions"> | null | undefined,
): Promise<Id<"institutions"> | undefined> {
  const scoped = (
    await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect()
  ).filter((membership) => membership.institutionId);
  if (scoped.length === 0) return primaryId ?? undefined;
  const active = [];
  for (const membership of scoped) {
    const institution = await ctx.db.get(membership.institutionId!);
    if (institution && !institution.disabledAt) active.push(membership);
  }
  active.sort(
    (a, b) =>
      Number(b.role === user.role) - Number(a.role === user.role) ||
      a._creationTime - b._creationTime,
  );
  return active[0]?.institutionId;
}

export const list = authedQuery({
  args: {
    // Institution lens for the curriculum-role path (a slug, "all", "primary",
    // or ""), same shape as `units.listScholarAuthored`. Optional so the many
    // non-institution-aware callers keep working — and, unlike the Quests
    // board, an ABSENT scope still scopes: `resolveInstitutionLens` falls back
    // to the caller's home membership, so the default is safe rather than
    // deployment-wide.
    scope: v.optional(v.string()),
    // Shared adult accounts retain their staff/parent capabilities while using
    // the scholar surface. This explicit route context keeps the unit picker in
    // their learner institution instead of resolving through their home role.
    asLearner: v.optional(v.boolean()),
    // Program-schedule picker: only the units this program group can schedule
    // (its own school's active units the caller may edit), so the column never
    // offers a unit `ensureProgramAssignment` would refuse. Takes precedence
    // over `scope`.
    programGroupId: v.optional(v.id("scholarGroups")),
  },
  handler: async (ctx, args) => {
    const learnerInstitutionId = args.asLearner
      ? await requireActiveLearnerInstitution(ctx, ctx.user._id)
      : null;
    const curriculumInstitutionIds = await curriculumAccessInstitutionIds(
      ctx,
      ctx.user,
    );
    const canManageCurriculum = !args.asLearner && (
      curriculumInstitutionIds === "all" ||
      curriculumInstitutionIds.size > 0
    );

    // The learner path below gets the scholar view of each unit (no
    // teacher-facing description); the curriculum and program paths are staff.
    const learnerView = !args.programGroupId && !canManageCurriculum;

    let unitList;
    if (args.programGroupId) {
      const group = await requireProgramPublishAccess(
        ctx,
        ctx.user,
        await ctx.db.get(args.programGroupId),
      );
      unitList = (await programSchedulableUnits(ctx, ctx.user, group)).sort(
        (a, b) => b._creationTime - a._creationTime,
      );
    } else if (canManageCurriculum) {
      // Catalog units follow their own institution stamp; Independent Study
      // units follow their author scholar through the same lens used by the
      // Quests board.
      const all = await ctx.db.query("units").order("desc").collect();
      unitList = await curriculumUnitsInLens(ctx, all, args.scope);
    } else {
      // Scholar path: active, PUBLISHED non-IS units (visible to the
      // whole class) + this scholar's own IS units. An unpublished unit
      // (TRA-490) is teachers-only until a teacher publishes or assigns it;
      // a scholar already holding an assignment to one (it was unpublished
      // after assigning) still sees it, so their assigned session resolves
      // its unit. IS units authored by
      // *other* scholars are private and must not leak into this
      // scholar's picker. Post-refactor (May 2026): the legacy
      // activities.scholarId narrowing is gone, so this filter is
      // the only thing keeping cross-scholar IS units invisible.
      const all = await ctx.db
        .query("units")
        .withIndex("by_active", (q) => q.eq("isActive", true))
        .order("desc")
        .collect();
      const primaryId = await primaryInstitutionId(ctx);
      // A non-scholar caller without curriculum access (e.g. operations or
      // program staff) is scoped by their own active institution membership;
      // only a caller with no institution membership at all falls back to the
      // primary school. Falling straight to primary served another school's
      // staff the primary school's whole active catalog.
      const scholarInstitutionId =
        learnerInstitutionId ??
        (await resolveScholarInstitutionId(ctx, ctx.user._id)) ??
        (await membershipInstitutionId(ctx, ctx.user, primaryId));
      const inLens = all.filter(
        (u) =>
          u.authorScholarId
            ? // Their own Quests, but not a proposal still waiting or
              // declined: it has no activity to start (TRA-685).
              u.authorScholarId === ctx.user._id &&
              !isUnansweredOrDeclinedProposal(u)
            : u.institutionId
              ? u.institutionId === scholarInstitutionId
              : primaryId
                ? scholarInstitutionId === primaryId
                : true,
      );
      // Unpublished units are few (drafts in progress), so the per-unit
      // assignment check stays cheap.
      const visible = await Promise.all(
        inLens.map(
          async (u) =>
            !!u.authorScholarId ||
            isUnitPublished(u) ||
            (await scholarHoldsAssignmentForUnit(ctx, ctx.user._id, u._id)),
        ),
      );
      unitList = inLens.filter((_, i) => visible[i]);
      if (isProgramGuest(ctx.user)) {
        const assignedUnitIds = await assignedProgramUnitIdsForScholar(
          ctx,
          ctx.user._id,
        );
        unitList = unitList.filter(
          (unit) =>
            assignedUnitIds.has(unit._id) ||
            isOwnQuestUnit(unit, ctx.user._id),
        );
      }
    }

    return Promise.all(
      unitList.map(async (u) => {
        const teacher = await ctx.db.get(u.teacherId);
        // Resolve building block names for display
        const persona = u.personaId ? await ctx.db.get(u.personaId) : null;
        const perspective = u.perspectiveId ? await ctx.db.get(u.perspectiveId) : null;
        const process = u.processId ? await ctx.db.get(u.processId) : null;
        // Count lessons
        const lessons = await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", u._id))
          .collect();
        return {
          ...(learnerView ? scholarUnitView(u) : withoutQuestApproval(u)),
          id: u._id,
          teacherName: teacher?.name ?? null,
          personaTitle: persona?.title ?? null,
          personaEmoji: persona?.emoji ?? null,
          perspectiveTitle: perspective?.title ?? null,
          perspectiveIcon: perspective?.icon ?? null,
          processTitle: process?.title ?? null,
          processEmoji: process?.emoji ?? null,
          lessonCount: lessons.length,
          createdAt: u._creationTime,
        };
      })
    );
  },
});

/** Whether the caller may see the curriculum-design unit catalog at all —
 *  the same test `units.list` uses to pick its curriculum path. */
async function canBrowseCurriculum(ctx: QueryCtx, user: Doc<"users">) {
  const ids = await curriculumAccessInstitutionIds(ctx, user);
  return ids === "all" || ids.size > 0;
}

/**
 * The unit fields a reader outside curriculum design may receive (TRA-671):
 * exactly what scholar screens read from `units.get` / `units.list`, on web
 * and on every installed BunnyPad build. Everything else on a unit stays
 * with staff: the tutor's `systemPrompt`, the `rubric`, the design fields
 * (big idea, essential questions, Bloom target, building blocks, grade,
 * duration, video transcript), publication and review state, and the badge
 * config. Add a field here only when a scholar or parent screen reads it.
 *
 * - `_id`, `_creationTime`, `teacherId`, `title`, `isActive`: the unit
 *   type's required keys, so every caller keeps one row type. None carries
 *   teacher-written text (list rows already name the teacher).
 * - `emoji`, `subject`: the web unit picker; `emoji` also the Quest header on
 *   web and iPad.
 * - `slug`: the web session page resolves `?unit=` by slug.
 * - `youtubeUrl`: the unit video in the web session.
 * - `authorScholarId`: "is this my Quest" on web and iPad.
 * - `mission`: the scholar's own Quest mission on the iPad (their words).
 */
const SCHOLAR_UNIT_FIELDS = [
  "_id",
  "_creationTime",
  "teacherId",
  "title",
  "isActive",
  "emoji",
  "subject",
  "slug",
  "youtubeUrl",
  "authorScholarId",
  "mission",
] as const satisfies readonly (keyof Doc<"units">)[];

/**
 * A unit as a reader outside curriculum design sees it (a scholar, a parent,
 * an adult on the learner surface): only `SCHOLAR_UNIT_FIELDS`, plus
 * `description`. `description` is teacher-facing design intent, and on a
 * Quest a teacher offered one scholar it is the teacher's notes about that
 * child, so it becomes the scholar-facing `scholarDescription`, or "" when
 * there is none (the key stays a string so the shape holds). A scholar's own
 * Quest keeps their words: every scholar-authored path
 * (`mintIndependentStudyUnit`) writes both fields.
 */
function scholarUnitView(unit: Doc<"units">): Doc<"units"> {
  // Every required key is in the allowlist and always set on a row, so the
  // undefined filter only drops absent optional fields.
  const allowed = Object.fromEntries(
    SCHOLAR_UNIT_FIELDS.filter((key) => unit[key] !== undefined).map((key) => [
      key,
      unit[key],
    ]),
  ) as Pick<Doc<"units">, (typeof SCHOLAR_UNIT_FIELDS)[number]>;
  return { ...allowed, description: unit.scholarDescription ?? "" };
}

/**
 * Whether `units.get` hands this caller the whole unit, teacher-facing
 * `description` included. Curriculum staff only; and for a scholar's Quest
 * (`authorScholarId`, the one per-scholar marker on a unit) only when they
 * reach that scholar AS STAFF: a platform admin, or a non-parent membership
 * that passes `canAccessScholar`. `requireUnitAccessForUser` also admits the
 * Quest's author and any guardian; reaching it that way gets the scholar
 * view, whatever else the account can do elsewhere (a teacher who is a parent
 * at another school, curriculum:edit-only staff who are a parent here, an
 * adult reading their own learner Quest). `units.list` gets the same result
 * from `asLearner` plus the institution lens.
 */
async function readsFullUnit(
  ctx: QueryCtx,
  user: Doc<"users">,
  unit: Doc<"units">,
): Promise<boolean> {
  if (!(await canBrowseCurriculum(ctx, user))) return false;
  const scholarId = unit.authorScholarId;
  if (!scholarId) return true;
  if (scholarId === user._id) return false;
  if (isPlatformAdminRole(user.role)) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  for (const membership of memberships) {
    // A parent membership reaches its guardianships, never as staff.
    if (membership.role === ROLES.PARENT) continue;
    if (await canAccessScholar(ctx, membership, scholarId)) return true;
  }
  return false;
}

/** Guard against a filter that excludes almost everything making one page
 *  read the whole table; a short page just reports `CanLoadMore` and the
 *  browser asks again. */
const BROWSER_MAX_ROWS_READ_PER_PAGE = 1000;

/**
 * The teacher Curriculum → Units column, one page at a time (TRA-468).
 *
 * Same unit set as `units.list`'s curriculum path — the identical tenancy
 * predicate (`curriculumUnitLensPredicate`) — but the browser's Author /
 * Subject / Grade / Archived / scholar-quest filters run here, BEFORE the page is cut,
 * so a page is never mostly empty after client filtering. Newest first, so a
 * just-created unit lands at the top of page one.
 *
 * Scholar Quests (`authorScholarId` set) are left out when
 * `showScholarQuests` is false, which the browser sends by default: their
 * home is the Quests tab (`listScholarAuthored`), and mixed into this list
 * they buried the reusable teacher units. Omitted keeps them, so a tab still
 * running the client from before the toggle existed loses nothing it can't
 * get back.
 *
 * Index choice: an author filter reads `by_teacher` (one teacher's units are
 * few); the default hides archived units through `by_active`; only "all
 * authors + show archived" walks the whole table. The tenancy lens, the
 * subject match by meaning (`unitFitsSubjectFilter`) and the grade match by
 * span (`unitFitsGradeFilter`, a "3-5" unit fits grade 4) are not index ranges (an
 * Independent Study unit's tenant is its author scholar's institution, not a
 * field on the row), so they run as a convex-helpers stream `filterWith` —
 * applied before pagination,
 * unlike a post-filter that would hand back short or empty pages.
 *
 * Rows are slim: only what `CurriculumUnitsBrowser` renders, subject and grade
 * included so two versions of a topic can be told apart. `lessonCount` is
 * a `by_unit` read per row, bounded by the page size.
 */
export const listForBrowser = authedQuery({
  args: {
    scope: v.optional(v.string()),
    authorId: v.optional(v.id("users")),
    subject: v.optional(v.string()),
    // One grade ("K", "4"); a unit fits when its span covers it.
    grade: v.optional(v.string()),
    showArchived: v.boolean(),
    // Optional, and omitted means shown: a tab loaded before this arg existed
    // has no toggle to bring Quests back.
    showScholarQuests: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (!(await canBrowseCurriculum(ctx, ctx.user))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const inLens = await curriculumUnitLensPredicate(ctx, args.scope);
    const units = stream(ctx.db, schema).query("units");
    const ordered = args.authorId
      ? units
          .withIndex("by_teacher", (q) => q.eq("teacherId", args.authorId!))
          .order("desc")
      : args.showArchived
        ? units.order("desc")
        : units
            .withIndex("by_active", (q) => q.eq("isActive", true))
            .order("desc");
    const subject = args.subject?.trim() || null;
    const grade = args.grade?.trim() || null;
    const result = await ordered
      .filterWith(
        async (unit) =>
          (args.showArchived || unit.isActive) &&
          (args.showScholarQuests !== false || !unit.authorScholarId) &&
          (!subject || unitFitsSubjectFilter(unit.subject, subject)) &&
          (!grade || unitFitsGradeFilter(unit.gradeLevel, grade)) &&
          inLens(unit),
      )
      .paginate({
        ...args.paginationOpts,
        maximumRowsRead: BROWSER_MAX_ROWS_READ_PER_PAGE,
      });

    const page = await Promise.all(
      result.page.map(async (unit) => {
        const teacher = await ctx.db.get(unit.teacherId);
        const lessons = await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
          .collect();
        return {
          _id: unit._id,
          title: unit.title,
          emoji: unit.emoji ?? null,
          isActive: unit.isActive,
          unpublished: unit.unpublished === true,
          teacherId: unit.teacherId,
          teacherName: teacher?.name ?? null,
          subject: unit.subject?.trim() || null,
          gradeLevel: unit.gradeLevel?.trim() || null,
          lessonCount: lessons.length,
        };
      }),
    );
    return { ...result, page };
  },
});

/**
 * The Units browser's filter options — Author, Subject and Grade menus plus the
 * "Show archived (N)" and "Show scholar quests (N)" counts — without shipping
 * every unit's row. Same lens and same semantics the browser used to derive
 * client-side: authors span every unit in the lens (archived too), subjects
 * and grades only units visible under the current archived toggle (and NOT narrowed by
 * the author filter). Both follow the scholar-quest toggle, so a scholar
 * (a Quest's `teacherId`) is offered as an author only while their Quests
 * are shown. Each count is what its toggle would reveal given the other's
 * current state; `hasArchived` / `hasScholarQuests` say whether a toggle has
 * anything behind it at all, so archived Quests stay reachable when both
 * counts are zero. `showScholarQuests` omitted means shown, as in
 * `listForBrowser`.
 */
export const browserFilterOptions = authedQuery({
  args: {
    scope: v.optional(v.string()),
    showArchived: v.boolean(),
    showScholarQuests: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!(await canBrowseCurriculum(ctx, ctx.user))) {
      return {
        authors: [],
        subjects: [],
        grades: [],
        archivedCount: 0,
        scholarQuestCount: 0,
        hasArchived: false,
        hasScholarQuests: false,
      };
    }
    const all = await ctx.db.query("units").order("desc").collect();
    const inLens = await curriculumUnitsInLens(ctx, all, args.scope);
    const showScholarQuests = args.showScholarQuests !== false;
    const units = inLens.filter(
      (unit) => showScholarQuests || !unit.authorScholarId,
    );

    const authorIds: Id<"users">[] = [];
    const seen = new Set<Id<"users">>();
    for (const unit of units) {
      if (!seen.has(unit.teacherId)) {
        seen.add(unit.teacherId);
        authorIds.push(unit.teacherId);
      }
    }
    const authors = await Promise.all(
      authorIds.map(async (id) => ({
        id: String(id),
        name: (await ctx.db.get(id))?.name ?? "Unknown",
      })),
    );
    const shown = units.filter((unit) => args.showArchived || unit.isActive);
    return {
      authors,
      subjects: unitSubjectFilterOptions(shown),
      grades: unitGradeFilterOptions(shown),
      archivedCount: units.filter((unit) => !unit.isActive).length,
      scholarQuestCount: inLens.filter(
        (unit) =>
          !!unit.authorScholarId && (args.showArchived || unit.isActive),
      ).length,
      hasArchived: inLens.some((unit) => !unit.isActive),
      hasScholarQuests: inLens.some((unit) => !!unit.authorScholarId),
    };
  },
});

/** One flat ⌘K-addressable curriculum hit below the unit altitude. Units are
 *  deliberately ABSENT: the palette already renders them from the
 *  `api.units.list` subscription its shell holds, and re-returning them here
 *  would be a second rendering of the same rows. */
export type CurriculumSearchHit =
  | {
      kind: "lesson";
      unitId: Id<"units">;
      unitTitle: string;
      lessonId: Id<"lessons">;
      lessonTitle: string;
    }
  | {
      kind: "activity";
      unitId: Id<"units">;
      unitTitle: string;
      lessonId: Id<"lessons">;
      lessonTitle: string;
      activityId: Id<"activities">;
      activityTitle: string;
    };

/**
 * Lesson/activity autocomplete for the staff ⌘K palette.
 *
 * Authorization is NOT a fresh policy: it reuses `curriculumUnitsInLens` — the
 * exact helper `units.list` uses — so a hit can only ever come from a unit the
 * caller can already open, and the institution lens is resolved from the
 * caller rather than from anything the client sends. Callers without any
 * curriculum access get `[]` (they have no Units tab to land on).
 *
 * Archived units are skipped, matching both `searchProgramCurriculum` and the
 * Curriculum browser, which hides them behind a `showArchived` toggle. Their
 * children are noise in a jump-to list. (The unit ROWS themselves stay
 * findable — that is pre-existing palette behaviour and how you reopen an
 * archived unit — so this filter is deliberately about children only.)
 *
 * Traversal, not an index: Convex search indexes are unused elsewhere in this
 * repo, and `masterSchedule.searchProgramCurriculum` already does this same
 * unit→lesson→activity walk in production for the Assign picker. The walk is
 * bounded by the real curriculum, and `units.list` — which this shell is
 * already subscribed to — collects every unit's lessons anyway for its
 * `lessonCount`. The client debounces, so this runs per PAUSE, not per
 * keystroke. If it ever does get slow, the fix is a search index for both
 * callers, not a silent scan cap here: capping the SCAN would make a real
 * lesson permanently unfindable with nothing to show for it, which is the
 * failure mode `standingPractice.searchSkills` is one domain-growth-spurt away
 * from. Only the RESULT list is capped, and it is ranked before it is cut so
 * an exact match cannot be crowded out by substring hits in earlier units.
 */
export const searchCurriculum = authedQuery({
  args: {
    query: v.string(),
    scope: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CurriculumSearchHit[]> => {
    const needle = args.query.trim().toLocaleLowerCase();
    if (needle.length < 2) return [];

    const curriculumInstitutionIds = await curriculumAccessInstitutionIds(
      ctx,
      ctx.user,
    );
    if (
      curriculumInstitutionIds !== "all" &&
      curriculumInstitutionIds.size === 0
    ) {
      return [];
    }

    const take = Math.max(1, Math.min(Math.floor(args.limit ?? 12), 30));
    const all = await ctx.db.query("units").order("desc").collect();
    const units = (await curriculumUnitsInLens(ctx, all, args.scope)).sort(
      (a, b) => a.title.localeCompare(b.title),
    );

    // Rank before the cap: exact title, then prefix, then substring. Plain
    // ordering, not a tuned score — nothing here needs calibrating.
    const rank = (title: string) => {
      const t = title.toLocaleLowerCase();
      if (t === needle) return 0;
      if (t.startsWith(needle)) return 1;
      return 2;
    };
    const hits: Array<CurriculumSearchHit & { _rank: number; _sort: string }> = [];
    for (const unit of units) {
      if (!unit.isActive) continue;
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect();
      lessons.sort((a, b) => a.title.localeCompare(b.title));
      for (const lesson of lessons) {
        if (lesson.title.toLocaleLowerCase().includes(needle)) {
          hits.push({
            kind: "lesson",
            unitId: unit._id,
            unitTitle: unit.title,
            lessonId: lesson._id,
            lessonTitle: lesson.title,
            _rank: rank(lesson.title),
            _sort: lesson.title,
          });
        }
        const activities = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect();
        activities.sort((a, b) => a.title.localeCompare(b.title));
        for (const activity of activities) {
          if (
            activity.archivedAt ||
            !activity.title.toLocaleLowerCase().includes(needle)
          ) {
            continue;
          }
          hits.push({
            kind: "activity",
            unitId: unit._id,
            unitTitle: unit.title,
            lessonId: lesson._id,
            lessonTitle: lesson.title,
            activityId: activity._id,
            activityTitle: activity.title,
            _rank: rank(activity.title),
            _sort: activity.title,
          });
        }
      }
    }
    hits.sort(
      (a, b) => a._rank - b._rank || a._sort.localeCompare(b._sort),
    );
    return hits
      .slice(0, take)
      .map(({ _rank: _r, _sort: _s, ...hit }) => hit);
  },
});

export const searchCurriculumForAide = internalQuery({
  args: {
    callerUserId: v.id("users"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CurriculumSearchHit[]> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      throw new Error("Forbidden: teacher or admin role required");
    }
    await assertInstitutionActive(ctx, caller);
    const needle = args.query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const all = await ctx.db.query("units").order("desc").collect();
    const units = await curriculumUnitsInLens(
      ctx,
      all,
      undefined,
      caller,
    );
    const rank = (title: string) => {
      const normalized = title.toLocaleLowerCase();
      if (normalized === needle) return 0;
      if (normalized.startsWith(needle)) return 1;
      return 2;
    };
    const hits: Array<
      Extract<CurriculumSearchHit, { kind: "activity" }> & { _rank: number }
    > = [];
    for (const unit of units) {
      if (!unit.isActive) continue;
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect();
      for (const lesson of lessons) {
        const activities = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect();
        for (const activity of activities) {
          if (
            activity.archivedAt ||
            !activity.title.toLocaleLowerCase().includes(needle)
          ) {
            continue;
          }
          hits.push({
            kind: "activity",
            unitId: unit._id,
            unitTitle: unit.title,
            lessonId: lesson._id,
            lessonTitle: lesson.title,
            activityId: activity._id,
            activityTitle: activity.title,
            _rank: rank(activity.title),
          });
        }
      }
    }
    hits.sort(
      (a, b) =>
        a._rank - b._rank ||
        a.activityTitle.localeCompare(b.activityTitle),
    );
    return hits
      .slice(0, Math.max(1, Math.min(Math.floor(args.limit ?? 12), 30)))
      .map(({ _rank: _r, ...hit }) => hit);
  },
});

export const get = authedQuery({
  args: { id: v.id("units") },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.id);
    if (!unit) return null;
    await requireUnitAccess(ctx, args.id);
    // B6 learn-before-you-build (TRA-519), for the scholar viewing their OWN
    // Quest only: `questLocks` maps each locked build-step activity id to the
    // learning step that unlocks it (absent entry = open), and
    // `canUnlockBuild` says the Quest is finished with no build step yet, so
    // the completion surface may offer to append one. Anyone else (teachers,
    // a teacher's unit, a remote view) gets `{}` / false: never locked.
    const questLocks = await questBuildLocksFor(ctx, {
      unit,
      scholarId: ctx.user._id,
    });
    // The learn-first lock is retired: `questLocks` is always empty and
    // `canUnlockBuild` always false, so older BunnyPads show no lock and no
    // "Unlock: build a simulation" offer. The fields stay for them.
    const canUnlockBuild = false;
    // Curriculum staff reaching the unit as staff get the whole unit; a
    // scholar or parent gets the scholar view (see readsFullUnit).
    // A proposal's words and thread reach people only through the dedicated
    // proposal read, never a generic unit read (TRA-685).
    const view = (await readsFullUnit(ctx, ctx.user, unit))
      ? withoutQuestApproval(unit)
      : scholarUnitView(unit);
    return { ...view, questLocks, canUnlockBuild };
  },
});

/**
 * Lightweight structure counts for a unit (lessons + activities).
 * Used by the Curriculum unit-preview subtitle. Class progress lives
 * on the Assignments Run page (Assignments own execution), not the
 * Design surface, so this stays a cheap structural sweep. Kept
 * separate from `units.get` so the many hot callers of `get` don't
 * pay for the lesson/activity sweep.
 */
export const structureCounts = authedQuery({
  args: { id: v.id("units") },
  handler: async (ctx, { id }) => {
    const unit = await ctx.db.get(id);
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", id))
      .collect();
    let activityCount = 0;
    for (const l of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      activityCount += acts.filter((a) => a.archivedAt == null).length;
    }
    const teacher = unit ? await ctx.db.get(unit.teacherId) : null;
    return {
      lessonCount: lessons.length,
      activityCount,
      teacherId: unit?.teacherId ?? null,
      teacherName: teacher?.name ?? teacher?.username ?? null,
    };
  },
});

/**
 * Distinct, non-empty Subject values across the units visible to the
 * caller — drives the Subject autocomplete (unit editor) and the
 * Subject filter chips (teacher Curriculum list + scholar picker).
 *
 * Scoped exactly like `list`: managers see every unit's subject;
 * scholars see active published non-IS units plus their own IS units. Deduped
 * case-insensitively, keeping the first-seen display casing, so
 * "ELA" and "ela" collapse to one suggestion. Sorted alphabetically.
 */
export const subjects = authedQuery({
  args: {},
  handler: async (ctx) => {
    const canManageCurriculum = await hasCurriculumAccess(ctx, ctx.user);

    let unitList;
    if (canManageCurriculum) {
      const all = await ctx.db.query("units").collect();
      unitList = await curriculumUnitsInLens(ctx, all);
    } else {
      const all = await ctx.db
        .query("units")
        .withIndex("by_active", (q) => q.eq("isActive", true))
        .collect();
      unitList = all.filter((u) =>
        u.authorScholarId
          ? u.authorScholarId === ctx.user._id
          : isUnitPublished(u),
      );
    }

    const byFolded = new Map<string, string>();
    for (const u of unitList) {
      const s = u.subject?.trim();
      if (!s) continue;
      const folded = s.toLowerCase();
      if (!byFolded.has(folded)) byFolded.set(folded, s);
    }
    return [...byFolded.values()].sort((a, b) => a.localeCompare(b));
  },
});

/**
 * The subjects a unit can be filed under (TRA-723): the class names on the
 * UNIT's school's timetable in the term covering `at` (`unitSubjectOptions`,
 * the same rule the aide's writes check), whoever is viewing. The unit
 * designer's subject picker; empty (keep free text) when that school has no
 * classes this term, for a scholar's own unit, or when the caller may not
 * edit the unit. `at` comes from the client, rounded, so this query never
 * reads the clock.
 */
export const subjectOptions = authedQuery({
  args: { unitId: v.id("units"), at: v.number() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    let unit: Doc<"units">;
    try {
      ({ unit } = await requireUnitEditAccessForUser(ctx, ctx.user, {
        unitId: args.unitId,
      }));
    } catch {
      return [];
    }
    return await unitSubjectOptions(ctx, unit, args.at);
  },
});

/**
 * Scholar's own Independent Study units (where they're the
 * authorScholarId). Returned newest first. Includes a tiny progress
 * snapshot for the home-page card: completed vs. total session-backed
 * activities + whether the completion badge is earned.
 */
/**
 * Core of `myIndependentStudyUnits`, parameterized by scholar so BOTH the
 * scholar's own home-page card AND the teacher Home-mirror's not-started
 * section build the SAME shape without duplicating the logic. Returns the
 * scholar's ACTIVE authored IS units (newest first, offered-star units
 * dropped) each with a tiny progress snapshot + `hasStartedSession` — whether
 * a plate-visible `scholarPlate.activeForMe` row already covers the unit.
 */
export async function independentStudyUnitsForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const units = await ctx.db
    .query("units")
    .withIndex("by_authorScholar", (q) =>
      q.eq("authorScholarId", scholarId),
    )
    .collect();
  // A proposal waiting for a teacher, or one declined, is not a Quest yet:
  // no activity, so no "Start" card for it (TRA-685, lib/questApproval.ts).
  const active = units.filter(
    (u) => u.isActive && !isUnansweredOrDeclinedProposal(u),
  );
  active.sort((a, b) => b._creationTime - a._creationTime);

  // Units OFFERED to this scholar (a star on their map points at them —
  // a teacher/bot offer) belong on the star map as a destination, NOT in
  // this not-started-cards list. Drop them so they aren't double-surfaced.
  // An offer the scholar dismissed from Prep (seeds.dismissForSelf) stays
  // dropped: dismissing it must not turn it into a "not started" card.
  const myOfferStars = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
    .collect();
  const offeredUnitIds = new Set(
    myOfferStars
      .filter(
        (s) =>
          s.unitId &&
          (s.status === "active" ||
            s.status === "pending" ||
            (s.status === "dismissed" &&
              s.dismissedReason === SCHOLAR_DISMISSED_REASON)),
      )
      .map((s) => String(s.unitId)),
  );
  const ownUnits = active.filter((u) => !offeredUnitIds.has(String(u._id)));

  // Which IS units already have a plate-visible row? Those render on the
  // home through scholarPlate.activeForMe, so the home only needs a
  // standalone card for units the scholar hasn't opened yet.
  const mySessions = await ctx.db
    .query("sessions")
    .withIndex("by_user_and_archived", (q) =>
      q.eq("userId", scholarId).eq("isArchived", false),
    )
    .collect();
  // A quest started from a TOPIC seed spawns an ANCHORLESS session (seedId set,
  // unitId still null) whose baked unit is linked only by provenance
  // (`unit.bakedFromSeedId === session.seedId`) — the background bake may never
  // back-patch `session.unitId` (empty/failed bake, or the link refused). So a
  // dedup that keys on `session.unitId` alone misses that session, and the SAME
  // quest double-renders: an in-progress "Continue" card (the anchorless session,
  // via scholarPlate) AND a "not started / Start" card (this baked unit). Map the
  // seed→unit provenance back so the seed session anchors its unit too (pilot9
  // J8a).
  const unitIdBySeedId = new Map<string, Id<"units">>();
  for (const u of active) {
    if (u.bakedFromSeedId) unitIdBySeedId.set(String(u.bakedFromSeedId), u._id);
  }
  const candidateSessions = mySessions.filter(
    (p) => !p.isTestDrive && !p.isOffline && (p.unitId || p.seedId),
  );
  const unitIdsWithSession = new Set<string>();
  for (const p of candidateSessions) {
    const resolvedUnitId: Id<"units"> | null =
      p.unitId ??
      (p.seedId ? unitIdBySeedId.get(String(p.seedId)) ?? null : null);
    if (!resolvedUnitId) continue;
    const complete = await isSessionActivityComplete(ctx, scholarId, p);
    if (complete) {
      const nextIncomplete = await firstIncompleteSessionActivityInUnit(
        ctx,
        scholarId,
        resolvedUnitId,
        p.assignmentId,
      );
      if (!nextIncomplete) continue;
    }
    unitIdsWithSession.add(String(resolvedUnitId));
  }

  return Promise.all(
    ownUnits.map(async (u) => {
      const progress = await unitSessionProgressForScholar(ctx, scholarId, u._id);
      const totalOnline = progress.totalOnline;
      const completed = progress.completedOnline;
      const allActivityIds = progress.ordered.map((item) => item.activity._id);
      const badge = await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", u._id),
        )
        .first();
      return {
        unitId: u._id,
        title: await homeTitleForIndependentStudyUnit(ctx, u),
        emoji: u.emoji ?? null,
        description: u.scholarDescription ?? null,
        activityCount: allActivityIds.length,
        onlineActivityCount: totalOnline,
        completedCount: completed,
        badgeConfig: u.badgeOnCompletion ?? null,
        badgeEarned: !!badge,
        hasStartedSession: unitIdsWithSession.has(String(u._id)),
      };
    }),
  );
}

/**
 * A single not-started IS unit is "on the plate" (belongs on the home as a
 * standalone card / would be a Sky star) when it has NO plate-visible row yet
 * and isn't already fully finished. Shared by the scholar web home
 * (ScholarPlate) and the teacher Home-mirror so the two never drift.
 */
export function isNotStartedISUnit(u: {
  hasStartedSession: boolean;
  onlineActivityCount: number;
  completedCount: number;
}): boolean {
  if (u.hasStartedSession) return false;
  const done =
    u.onlineActivityCount > 0 && u.completedCount >= u.onlineActivityCount;
  return !done;
}

export const myIndependentStudyUnits = authedQuery({
  args: {
    // Teacher remote mode: inspect the named scholar's not-yet-started IS cards.
    // Scholars may only read their own cards.
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    let scholarId = ctx.user._id;
    if (args.userId && args.userId !== ctx.user._id) {
      if (!isTeacherRole(ctx.user.role)) {
        throw new Error("Forbidden");
      }
      await requireActiveScholarAccess(ctx, ctx.user, args.userId);
      scholarId = args.userId;
    } else if (args.userId) {
      scholarId = args.userId;
    }
    return independentStudyUnitsForScholar(ctx, scholarId);
  },
});

export const create = curriculumMutation({
  args: {
    title: v.string(),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    rubric: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    youtubeUrl: v.optional(v.string()),
    videoTranscript: v.optional(v.string()),
    personaId: v.optional(v.id("personas")),
    perspectiveId: v.optional(v.id("perspectives")),
    processId: v.optional(v.id("processes")),
    bigIdea: v.optional(v.string()),
    essentialQuestions: v.optional(v.array(v.string())),
    enduringUnderstandings: v.optional(v.array(v.string())),
    subject: v.optional(v.string()),
    gradeLevel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // One grade or a span within K–8 in one form (lib/unitGrade.ts).
    const grade = resolveUnitGradeEdit({}, args.gradeLevel ?? null);
    if (grade.kind === "unreadable") throw unitGradeUnreadableError(grade.given);
    const institutionId = await institutionIdForUnitAuthor(
      ctx,
      ctx.user._id,
    );
    // A subject names one of the school's classes (TRA-723): a class name or
    // a clear fit is stored as the class's spelling, anything else refused.
    let subject = args.subject?.trim() || undefined;
    if (subject) {
      const resolved = resolveUnitSubject(
        subject,
        await schoolSubjectOptions(ctx, institutionId, Date.now()),
      );
      if (resolved.kind === "ask") {
        throw unitSubjectNotAClassError(resolved.given, resolved.options);
      }
      if (resolved.kind === "ok") subject = resolved.subject;
    }
    return await ctx.db.insert("units", {
      teacherId: ctx.user._id,
      institutionId,
      title: args.title.trim(),
      emoji: args.emoji?.trim() || undefined,
      description: args.description?.trim() || undefined,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      rubric: args.rubric?.trim() || undefined,
      durationMinutes: args.durationMinutes,
      youtubeUrl: args.youtubeUrl?.trim() || undefined,
      videoTranscript: args.videoTranscript?.trim() || undefined,
      personaId: args.personaId,
      perspectiveId: args.perspectiveId,
      processId: args.processId,
      bigIdea: args.bigIdea?.trim() || undefined,
      essentialQuestions: args.essentialQuestions
        ? toKeyedGranules(args.essentialQuestions, undefined, "eq")
        : undefined,
      enduringUnderstandings: args.enduringUnderstandings
        ? toKeyedGranules(args.enduringUnderstandings, undefined, "eu")
        : undefined,
      subject,
      gradeLevel: grade.gradeLevel,
      isActive: true,
      // Teachers only until published or assigned (TRA-490).
      unpublished: true,
    });
  },
});

export const duplicate = curriculumMutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const source = await requireUnitAccess(ctx, args.unitId);
    const institutionId = await institutionIdForUnitAuthor(
      ctx,
      ctx.user._id,
    );

    const design = duplicateUnitDesign(source, ctx.user._id);
    // A copy is filed under the class its subject fits (TRA-723), so an old
    // off-list subject ("Mathematics") doesn't spread to the copy. A subject
    // that fits no single class is copied as it is.
    if (design.subject?.trim()) {
      const resolved = resolveUnitSubject(
        design.subject,
        await schoolSubjectOptions(ctx, institutionId, Date.now()),
      );
      if (resolved.kind === "ok") design.subject = resolved.subject;
    }
    const copyId = await ctx.db.insert("units", { ...design, institutionId });
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", source._id))
      .collect();
    lessons.sort((a, b) => a.order - b.order);

    const activityIdMap = new Map<string, Id<"activities">>();
    const copiedActivities: CopiedActivity[] = [];
    for (const lesson of lessons) {
      const lessonCopyId = await ctx.db.insert(
        "lessons",
        duplicateLessonDesign(lesson, copyId, lesson.order),
      );
      copiedActivities.push(
        ...(await duplicateActivitiesIntoLesson(
          ctx,
          lesson._id,
          lessonCopyId,
          activityIdMap,
        )),
      );
    }
    await remapCopiedActivityReferences(
      ctx,
      copiedActivities,
      activityIdMap,
      { dropUnmappedResourceReferences: true },
    );
    return copyId;
  },
});

/**
 * Scholar-authored Independent Study unit. The scholar becomes the
 * unit's `authorScholarId` AND its nominal teacher (so unit-scoped
 * permission checks pass).
 *
 * Unit starts empty — no seeded lesson or activity. Planning happens
 * in a unit-anchored project (no activityId) where the AI tutor
 * uses the create_lesson / create_activity tools to populate the
 * unit. The planning conversation is a property of the unit, not
 * an activity that needs "completing." See
 * review/scholar-IS-codesign.md.
 *
 * Authored by the caller (the scholar). Teachers viewing this unit
 * see it read-only.
 */
const createQuestArgs = {
  title: v.string(),
  description: v.optional(v.string()),
  badgeIcon: v.optional(v.string()),
};

/** Also the first step of the local runner's `localRunner:startTopicChat`. */
export async function createQuestHandler(
  ctx: MutationCtx & { user: Doc<"users"> },
  args: {
    title: string;
    description?: string;
    badgeIcon?: string;
  },
) {
  const scholarId = ctx.user._id;
  const title = args.title.trim() || "My Independent Study";
  // Shared thin-IS-unit mint — see convex/lib/independentStudy.ts. The
  // free-form sessions.create auto-mint and the backfill migration reuse
  // the SAME helper so the three can never diverge.
  const unitId = await mintIndependentStudyUnit(ctx, {
    scholarId,
    title,
    description: args.description,
    badgeIcon: args.badgeIcon,
  });
  return { unitId };
}

export const createQuest = authedMutation({
  args: createQuestArgs,
  handler: createQuestHandler,
});

/**
 * A scholar's own Custom Quest is a plain open chat: the server no longer
 * "bakes" a lesson and activities into it (TRA-660). Old clients still call
 * this right after creating the unit + session, so the function stays: it
 * checks that the caller owns both and does nothing else. No bake is
 * scheduled and `questBakeStatus` is never set, so no screen waits on one.
 * Teacher-designed units keep the Curriculum Bot's bake (`bakeUnitFromSeed.ts`
 * is unchanged); a scholar's Quest becomes structured only when a teacher
 * approves it.
 */
const scheduleCustomQuestBakeArgs = {
  unitId: v.id("units"),
  sessionId: v.id("sessions"),
  bakePath: v.optional(chosenPathValidator),
};

/** The core of `scheduleCustomQuestBake`, acting as `ctx.user`; also the last
 *  step of the local runner's `localRunner:startTopicChat`. */
export async function scheduleCustomQuestBakeAs(
  ctx: MutationCtx & { user: Doc<"users"> },
  args: ObjectType<typeof scheduleCustomQuestBakeArgs>,
) {
  const unit = await ctx.db.get(args.unitId);
  if (!unit) throw new Error("Unit not found");
  // Only the scholar who owns this independent-study unit may call it.
  if (unit.authorScholarId !== ctx.user._id) throw new Error("Forbidden");
  // A Quest proposal takes no structure from here either way.
  assertProposalTakesNoStructure(unit);
  const session = await ctx.db.get(args.sessionId);
  if (!session || session.userId !== ctx.user._id) throw new Error("Forbidden");
  return { scheduled: false as const };
}

export const scheduleCustomQuestBake = authedMutation({
  args: scheduleCustomQuestBakeArgs,
  handler: scheduleCustomQuestBakeAs,
});

/**
 * Teacher-side counterpart to createQuest — but it OFFERS a
 * destination rather than handing the scholar a pre-owned quest. It still
 * builds the Unit (the teacher authors it in the Designer), but it also
 * drops an OFFER STAR on the scholar's map (a `seeds` row pointing at the
 * unit). The scholar's home shows it as a destination to chase, NOT as a
 * not-started "quest" card — a quest only exists once the scholar opts in
 * (createFromSeed starts the unit). The Unit stays scholar-owned
 * (authorScholarId=scholarId) so the teacher Quests tab still lists it and
 * the scholar can edit it.
 */
export const createAndOfferQuestForScholar = teacherMutation({
  args: {
    scholarId: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    // Optional 2nd-person blurb for the scholar's own home card; the teacher
    // (or the generator) can supply one so the scholar isn't addressed in the
    // third person. `description` stays teacher-facing.
    scholarDescription: v.optional(v.string()),
    badgeIcon: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found");
    await requireScholarsAccessible(ctx, ctx.user, [args.scholarId]);
    const title = args.title.trim() || "Independent Study";
    const institutionId = await institutionIdForUnitAuthor(
      ctx,
      args.scholarId,
      { asScholar: true },
    );
    const unitId = await ctx.db.insert("units", {
      teacherId: args.scholarId,
      institutionId,
      title,
      emoji: "⚡",
      description: args.description?.trim() || undefined,
      scholarDescription: args.scholarDescription?.trim() || undefined,
      isActive: true,
      authorScholarId: args.scholarId,
      // The TEACHER designed this and offered it; the scholar is the spark,
      // not the author → "Inspired by X".
      authorRole: "inspired",
      badgeOnCompletion: {
        title: `${title} — completed`,
        description: `Earned by completing every activity in "${title}".`,
        icon: args.badgeIcon ?? "🏆",
      },
    });
    // Offer it as a destination (a star), not a pre-owned quest. The
    // scholar reads `scholarInvitation`: their own blurb, or a kid-voiced
    // default. `description` is teacher-facing and never becomes scholar copy.
    const scholarDefault = `A quest your teacher set up for you to explore — fly here when you're ready.`;
    await plantTeacherSeed(ctx, {
      scholarId: args.scholarId,
      topic: title,
      rationale: args.description?.trim() || scholarDefault,
      scholarInvitation: args.scholarDescription?.trim() || scholarDefault,
      teacherId: ctx.user._id,
      unitId,
    });
    return { unitId };
  },
});

/**
 * Teacher view of every scholar-authored IS Unit, grouped by scholar.
 * Used by the Quests tab. Returns enriched rows including scholar name,
 * lesson/activity counts, and the per-scholar QUEST STATE.
 *
 * Lifecycle is DELEGATED to `questsForScholar` (convex/lib/questLifecycle.ts) —
 * the ONE canonical derivation. This handler only decorates each canonical
 * quest with the board-only presentation extras (scholar identity, total
 * lesson/activity counts, earned-badge art, and the `staleOffer`/`stalled`
 * nudge flags). The old inline lifecycle/lane/source math is gone.
 */
export const listScholarAuthored = teacherQuery({
  args: {
    scope: v.optional(v.string()),
    // The board defaults to ACTIVE units only, so it matches what the Work
    // tab / scholar plate actually surface (both filter isActive). Pass
    // `includeInactive: true` behind the "Show inactive" toggle to also list
    // deactivated Quests (state === "retracted"; they render with a quiet
    // "Inactive" badge).
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const adminAll = lens.isAdmin && args.scope === undefined;
    const legacySingleTenant =
      !lens.primaryInstitution &&
      !lens.institution &&
      lens.allowedInstitutionIds.size === 0;
    const allowedScholarIds = adminAll || legacySingleTenant
      ? null
      : await scholarIdsInLens(ctx, lens, { includeWithdrawn: true });

    // Cheap scan of by_authorScholar to find WHICH scholars have authored a
    // unit (filtered by the institution lens) + a unit → creation-time map for
    // stale-offer fallback. The per-quest lifecycle facts come from the helper.
    let authoredUnits = await ctx.db
      .query("units")
      .withIndex("by_authorScholar", (q) => q.gt("authorScholarId", undefined))
      .collect();
    if (allowedScholarIds) {
      authoredUnits = authoredUnits.filter(
        (u) => !!u.authorScholarId && allowedScholarIds!.has(u.authorScholarId),
      );
    }
    const unitCreatedById = new Map<string, number>();
    for (const u of authoredUnits) {
      unitCreatedById.set(String(u._id), u._creationTime);
    }
    // Per-scholar set of unit ids they AUTHOR. `questsForScholar` now also
    // returns CATALOG free-starts (teacher-authored units the scholar merely
    // started); the board's listing scope stays authored-units-only (design
    // §4 — surfaces may differ in WHICH quests they list, never in a quest's
    // STATE), so we filter those catalog pairs back out below.
    const authoredUnitIdsByScholar = new Map<string, Set<string>>();
    for (const u of authoredUnits) {
      if (!u.authorScholarId) continue;
      const k = String(u.authorScholarId);
      let set = authoredUnitIdsByScholar.get(k);
      if (!set) {
        set = new Set<string>();
        authoredUnitIdsByScholar.set(k, set);
      }
      set.add(String(u._id));
    }
    const scholarIds = [
      ...new Set(authoredUnits.map((u) => u.authorScholarId).filter(Boolean)),
    ] as Id<"users">[];

    const now = Date.now();
    const STALE_MS = 7 * 24 * 60 * 60_000; // an offer un-launched this long

    const rows: Array<{
      _id: Id<"units">;
      title: string;
      emoji: string | null;
      description: string | null;
      isActive: boolean;
      isDraft: boolean;
      createdAt: number;
      scholarId: Id<"users"> | null;
      scholarName: string;
      scholarImage: string | null;
      lessonCount: number;
      activityCount: number;
      completedCount: number;
      onlineActivityCount: number;
      state: QuestState;
      source: "teacher" | "scholar";
      staleOffer: boolean;
      stalled: boolean;
      lastTouched: number | null;
      badge: {
        title: string;
        emoji: string | null;
        imageUrl: string | null;
        artStatus: "ready" | "generating" | "failed";
      } | null;
      offeredAt: number | null;
    }> = [];

    // Per scholar (sequentially — no concurrent cache races), derive the
    // canonical quests once, then decorate the surviving ones.
    for (const sid of scholarIds) {
      const quests = await questsForScholar(ctx, sid);
      const authoredByThisScholar =
        authoredUnitIdsByScholar.get(String(sid)) ?? new Set<string>();
      const scholar = await ctx.db.get(sid);
      const scholarName = scholar?.name ?? scholar?.username ?? "(unknown)";
      const scholarImage = scholar?.image ?? null;

      // The scholar's earned unit badges, so a finished card can render the
      // real badge art (mirrors scholarUnitBadges.hydrateArt).
      const badges = await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar", (q) => q.eq("scholarId", sid))
        .collect();
      const badgeByUnit = new Map<string, Doc<"scholarUnitBadges">>();
      for (const b of badges) {
        if (b.unitId) badgeByUnit.set(String(b.unitId), b);
      }

      for (const q of quests) {
        // Board scope = authored units only (design §4). The widened helper
        // also returns catalog free-starts (units this scholar started but does
        // NOT author); those belong on the plate, not this board — drop them.
        if (!authoredByThisScholar.has(String(q.unitId))) continue;
        // Default active-only board: drop retracted quests entirely.
        if (!args.includeInactive && q.state === "retracted") continue;

        const uk = String(q.unitId);
        const createdAt = unitCreatedById.get(uk) ?? q.lastTouched ?? now;

        // Total lesson + activity counts (ALL activities, not just online) —
        // board decorations, so keep the per-unit lessons/activities reads.
        const lessons = await ctx.db
          .query("lessons")
          .withIndex("by_unit", (x) => x.eq("unitId", q.unitId))
          .collect();
        let activityCount = 0;
        for (const l of lessons) {
          const acts = await ctx.db
            .query("activities")
            .withIndex("by_lesson", (x) => x.eq("lessonId", l._id))
            .collect();
          activityCount += acts.length;
        }

        const badgeDoc = badgeByUnit.get(uk) ?? null;
        const badge = badgeDoc
          ? {
              title: badgeDoc.badgeSnapshot.title || q.title,
              emoji: q.emoji ?? badgeDoc.badgeSnapshot.icon ?? null,
              imageUrl: badgeDoc.imageStorageId
                ? await ctx.storage.getUrl(badgeDoc.imageStorageId)
                : null,
              artStatus:
                badgeDoc.artStatus ??
                (badgeDoc.imageStorageId
                  ? ("ready" as const)
                  : ("generating" as const)),
            }
          : null;

        // An offer that's sat un-launched for a week — the teacher-nudge signal.
        const staleOffer =
          q.state === "offered" &&
          now - (q.offeredAt ?? createdAt) > STALE_MS;
        // A started quest left untouched — the "bounced off it" signal.
        const stalled = isStalledQuest(q, now);

        rows.push({
          _id: q.unitId,
          title: q.title,
          emoji: q.emoji,
          description: q.description,
          isActive: q.unitIsActive,
          isDraft: q.unitIsDraft,
          createdAt,
          scholarId: sid,
          scholarName,
          scholarImage,
          lessonCount: lessons.length,
          activityCount,
          completedCount: q.completedCount,
          onlineActivityCount: q.onlineActivityCount,
          state: q.state,
          source: q.source,
          staleOffer,
          stalled,
          lastTouched: q.lastTouched,
          badge,
          offeredAt: q.offeredAt,
        });
      }
    }

    return rows;
  },
});

export const update = authedMutation({
  args: {
    id: v.id("units"),
    title: v.optional(v.string()),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    rubric: v.optional(v.string()),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
    youtubeUrl: v.optional(v.union(v.string(), v.null())),
    videoTranscript: v.optional(v.union(v.string(), v.null())),
    personaId: v.optional(v.union(v.id("personas"), v.null())),
    perspectiveId: v.optional(v.union(v.id("perspectives"), v.null())),
    processId: v.optional(v.union(v.id("processes"), v.null())),
    bigIdea: v.optional(v.union(v.string(), v.null())),
    essentialQuestions: v.optional(v.union(v.array(v.string()), v.null())),
    enduringUnderstandings: v.optional(v.union(v.array(v.string()), v.null())),
    subject: v.optional(v.union(v.string(), v.null())),
    gradeLevel: v.optional(v.union(v.string(), v.null())),
    mathDomain: v.optional(v.union(v.string(), v.null())),
    scholarDescription: v.optional(v.union(v.string(), v.null())),
    targetBloomLevel: v.optional(
      v.union(
        v.literal("remember"),
        v.literal("understand"),
        v.literal("apply"),
        v.literal("analyze"),
        v.literal("evaluate"),
        v.literal("create"),
        v.null(),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const { user, unit: current } = await requireUnitEditAccess(ctx, {
      unitId: args.id,
    });
    const { id, ...updates } = args;
    // Scholar IS-authors can edit the descriptive surface of their
    // own unit (title, emoji, description, big idea, EQs, etc.) but
    // NOT the fields that steer the AI tutor or pick pedagogical
    // components. Those stay teacher/curriculum only — otherwise a
    // scholar could rewrite their own systemPrompt to bypass
    // tutor guardrails.
    const isScholarOnly = !(await hasCurriculumAccess(ctx, user));
    const cleaned: Record<string, unknown> = {};
    if (updates.title !== undefined) cleaned.title = updates.title.trim();
    if (updates.emoji !== undefined)
      cleaned.emoji = updates.emoji.trim() || undefined;
    if (updates.description !== undefined) {
      cleaned.description = updates.description.trim() || undefined;
      // A scholar author's own words are also their Quest's scholar copy
      // (what scholar reads show, scholarUnitView), so their edit updates
      // both, as mintIndependentStudyUnit writes both. A teacher's edit
      // stays teacher-facing. An explicit scholarDescription below wins.
      if (current.authorScholarId === user._id)
        cleaned.scholarDescription = cleaned.description;
    }
    if (!isScholarOnly && updates.systemPrompt !== undefined)
      cleaned.systemPrompt = updates.systemPrompt.trim() || undefined;
    if (!isScholarOnly && updates.rubric !== undefined)
      cleaned.rubric = updates.rubric.trim() || undefined;
    if (updates.durationMinutes !== undefined)
      cleaned.durationMinutes = updates.durationMinutes ?? undefined;
    if (!isScholarOnly && updates.youtubeUrl !== undefined)
      cleaned.youtubeUrl = updates.youtubeUrl?.trim() || undefined;
    if (!isScholarOnly && updates.videoTranscript !== undefined)
      cleaned.videoTranscript = updates.videoTranscript?.trim() || undefined;
    if (!isScholarOnly && updates.personaId !== undefined)
      cleaned.personaId = updates.personaId ?? undefined;
    if (!isScholarOnly && updates.perspectiveId !== undefined)
      cleaned.perspectiveId = updates.perspectiveId ?? undefined;
    if (!isScholarOnly && updates.processId !== undefined)
      cleaned.processId = updates.processId ?? undefined;
    if (updates.bigIdea !== undefined)
      cleaned.bigIdea = updates.bigIdea?.trim() || undefined;
    if (updates.essentialQuestions !== undefined) {
      const unit = await ctx.db.get(id);
      cleaned.essentialQuestions = updates.essentialQuestions
        ? toKeyedGranules(updates.essentialQuestions, unit?.essentialQuestions, "eq")
        : undefined;
    }
    if (updates.enduringUnderstandings !== undefined) {
      const unit = await ctx.db.get(id);
      cleaned.enduringUnderstandings = updates.enduringUnderstandings
        ? toKeyedGranules(updates.enduringUnderstandings, unit?.enduringUnderstandings, "eu")
        : undefined;
    }
    if (updates.subject !== undefined) {
      // A subject names one of the school's classes (TRA-723). The picker
      // already offers only those; this holds the rule for any other client.
      const edit = await resolveUnitSubjectEdit(current, updates.subject, () =>
        unitSubjectOptions(ctx, current, Date.now()),
      );
      if (edit.kind === "ask") throw unitSubjectNotAClassError(edit.given, edit.options);
      if (edit.subject !== current.subject) cleaned.subject = edit.subject;
    }
    if (updates.gradeLevel !== undefined) {
      // One grade or a span within K–8 in one form (lib/unitGrade.ts). The
      // picker writes only that; this holds the rule for any other client.
      const grade = resolveUnitGradeEdit(current, updates.gradeLevel);
      if (grade.kind === "unreadable") throw unitGradeUnreadableError(grade.given);
      if (grade.gradeLevel !== current.gradeLevel) cleaned.gradeLevel = grade.gradeLevel;
    }
    if (updates.mathDomain !== undefined)
      cleaned.mathDomain = updates.mathDomain?.trim() || undefined;
    if (updates.scholarDescription !== undefined)
      cleaned.scholarDescription =
        updates.scholarDescription?.trim() || undefined;
    if (!isScholarOnly && updates.targetBloomLevel !== undefined)
      cleaned.targetBloomLevel = updates.targetBloomLevel ?? undefined;

    await ctx.db.patch(id, cleaned);
  },
});

const keyedGranuleInput = v.object({
  key: v.optional(v.string()),
  text: v.string(),
});

export const setGranules = authedMutation({
  args: {
    id: v.id("units"),
    essentialQuestions: v.optional(v.array(keyedGranuleInput)),
    enduringUnderstandings: v.optional(v.array(keyedGranuleInput)),
  },
  handler: async (ctx, args) => {
    const { unit } = await requireUnitEditAccess(ctx, { unitId: args.id });
    const patch: Partial<Doc<"units">> = {};

    if (args.essentialQuestions !== undefined) {
      patch.essentialQuestions = mergeKeyedGranules(
        args.essentialQuestions,
        unit.essentialQuestions,
        "eq",
      );
    }
    if (args.enduringUnderstandings !== undefined) {
      patch.enduringUnderstandings = mergeKeyedGranules(
        args.enduringUnderstandings,
        unit.enduringUnderstandings,
        "eu",
      );
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch);
    }
  },
});

export const deactivate = authedMutation({
  args: { id: v.id("units") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.id });
    await ctx.db.patch(args.id, { isActive: false });
  },
});

/** Un-archive: flip a deactivated unit back to active (reversible
 *  counterpart to `deactivate`). Same edit gate. */
export const reactivate = authedMutation({
  args: { id: v.id("units") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.id });
    await ctx.db.patch(args.id, { isActive: true });
  },
});

/** Flip a catalog unit's publication (TRA-490). Independent Study units are
 *  private to their scholar already, so publication has no meaning there. */
async function setUnitPublished(
  ctx: MutationCtx,
  unit: Doc<"units">,
  published: boolean,
) {
  if (unit.authorScholarId) {
    throw new Error("Independent Study units are private to their scholar.");
  }
  if (published === isUnitPublished(unit)) return;
  await ctx.db.patch(unit._id, { unpublished: published ? undefined : true });
}

/** Let scholars find and start a catalog unit on their own (TRA-490).
 *  Same edit gate as archive. Assigning a unit also publishes it. */
export const publish = authedMutation({
  args: { id: v.id("units") },
  handler: async (ctx, args) => {
    const { unit } = await requireUnitEditAccess(ctx, { unitId: args.id });
    await setUnitPublished(ctx, unit, true);
  },
});

/** Take a catalog unit back to teachers only (TRA-490). Scholars who already
 *  hold an assignment to it keep access to that assigned work. */
export const unpublish = authedMutation({
  args: { id: v.id("units") },
  handler: async (ctx, args) => {
    const { unit } = await requireUnitEditAccess(ctx, { unitId: args.id });
    await setUnitPublished(ctx, unit, false);
  },
});

/** The aide's `publish_unit` tool: the same flip under the caller's own
 *  curriculum-edit gate. */
export const aideSetUnitPublished = internalMutation({
  args: {
    callerUserId: v.id("users"),
    unitId: v.id("units"),
    published: v.boolean(),
  },
  handler: async (ctx, { callerUserId, unitId, published }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller) throw new Error("Caller not found");
    const { unit } = await requireUnitEditAccessForUser(ctx, caller, {
      unitId,
    });
    await setUnitPublished(ctx, unit, published);
    return { title: unit.title, published };
  },
});

/**
 * Pre-delete impact + gate for the Curriculum delete affordance.
 * Returns the unit's child-content counts plus whether a HARD delete is
 * allowed. Delete is blocked (archive instead) the moment the unit has
 * any assignments or any real (non-test-drive) scholar projects — so
 * scholar work / learning records are never cascaded away by a delete.
 * Read-then-gate so a stale unit id returns null instead of throwing.
 */
export const deletionImpact = authedQuery({
  args: { id: v.id("units") },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.id);
    if (!unit) return null;
    await requireUnitEditAccess(ctx, { unitId: args.id });

    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.id))
      .collect();
    let activityCount = 0;
    for (const l of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      activityCount += acts.length;
    }
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", args.id))
      .collect();
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_unit", (q) => q.eq("unitId", args.id))
      .collect();
    const sessionCount = sessions.filter((p) => !p.isTestDrive).length;

    return {
      title: unit.title,
      isActive: unit.isActive,
      // Publication (TRA-490): the lifecycle actions show the Unpublished
      // badge and the Publish / Unpublish control from this. Scholar-owned
      // Independent Study units have no publication state.
      unpublished: unit.unpublished === true,
      isIndependentStudy: !!unit.authorScholarId,
      lessonCount: lessons.length,
      activityCount,
      assignmentCount: assignments.length,
      sessionCount,
      canDelete: assignments.length === 0 && sessionCount === 0,
    };
  },
});

/**
 * Hard-delete a unit and its OWN design content. Safe by construction:
 * refuses if the unit has any assignments or any real (non-test-drive)
 * scholar projects — a unit that's been RUN must be archived
 * (`deactivate`), never deleted, so scholar projects / completions /
 * mastery records are never cascaded away. For a never-run unit this
 * cleanly removes: its lessons + activities, its Curriculum Bot threads
 * (curriculumMessages + chats scoped to it), any leftover
 * test-drive projects (fully purged via the shared per-project
 * cascade), defensive badge/completion sweeps, then the unit row.
 */
export const remove = authedMutation({
  args: { id: v.id("units") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.id });

    // Guard 1 — no assignments (active OR archived) may reference it.
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", args.id))
      .collect();
    if (assignments.length > 0) {
      throw new Error(
        `Can't delete: this unit has ${assignments.length} assignment${assignments.length === 1 ? "" : "s"}. Archive it instead.`,
      );
    }

    // Guard 2 — no real scholar work. Test-drive projects (the teacher's
    // own throwaway sessions) are fine; we purge those below.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_unit", (q) => q.eq("unitId", args.id))
      .collect();
    const realSessions = sessions.filter((p) => !p.isTestDrive);
    if (realSessions.length > 0) {
      throw new Error(
        `Can't delete: this unit has ${realSessions.length} scholar project${realSessions.length === 1 ? "" : "s"}. Archive it instead.`,
      );
    }

    // Purge leftover test-drive projects (full per-project cascade).
    for (const p of sessions) {
      if (p.isTestDrive) await deleteSessionInner(ctx, p._id);
    }

    // Cascade design content: lessons + their activities.
    const removedPlacements: Doc<"schedulePlacements">[] = [];
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.id))
      .collect();
    for (const l of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      for (const a of acts) {
        await deleteActivityCascade(ctx, a._id, { skipWorkGuard: true, removedPlacements });
      }
      await ctx.db.delete(l._id);
    }
    await syncClassesForPlacements(ctx, removedPlacements);

    // Curriculum Bot threads scoped to this unit. No unit-only index on
    // either table (both key on teacherId+unitId); these are small
    // design-side tables, so a filtered scan is fine.
    for (const m of await ctx.db
      .query("curriculumMessages")
      .filter((q) => q.eq(q.field("unitId"), args.id))
      .collect()) {
      await ctx.db.delete(m._id);
    }
    for (const s of await ctx.db
      .query("chats")
      .filter((q) => q.eq(q.field("unitId"), args.id))
      .collect()) {
      await ctx.db.delete(s._id);
    }

    // Defensive sweeps — empty given the guards above, but belt-and-
    // suspenders so a delete never leaves a dangling unitId.
    for (const b of await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_unit", (q) => q.eq("unitId", args.id))
      .collect()) {
      await ctx.db.delete(b._id);
    }
    for (const c of await ctx.db
      .query("activityCompletions")
      .filter((q) => q.eq(q.field("unitId"), args.id))
      .collect()) {
      await ctx.db.delete(c._id);
    }

    await ctx.db.delete(args.id);
  },
});

/** What staff are told when they ask to archive a scholar's own Quest. */
export const QUEST_ARCHIVE_REFUSAL =
  "This is a scholar's own Quest, not a teacher unit, so it can't be archived here: archiving it would take it away from the scholar and lock them out of its sessions. Nothing was changed. To take a Quest back, use Retract on the Quests tab, which looks after the scholar's side.";

/**
 * Archive or un-archive a TEACHER unit for the staff aide (Slack and the
 * app's Chat tab): the same `isActive` flip as `deactivate` / `reactivate`,
 * behind the caller's own unit-edit check. Archiving hides the unit from
 * scholars and stops new sessions in it, so it is refused while any
 * assignment of the unit is still running. Finished work is kept.
 *
 * A scholar's own unit (`authorScholarId`: a Quest, or the thin "My Quest"
 * unit behind a free-form session) is refused both ways. Deactivating one is
 * how a Quest is RETRACTED, which locks the scholar out of its sessions
 * (`isRetractedQuestSession`), and reactivating one skips reopen's cleanup;
 * the Quests tab owns that lifecycle.
 */
export const aideSetUnitArchived = internalMutation({
  args: {
    callerUserId: v.id("users"),
    unitId: v.id("units"),
    archived: v.boolean(),
  },
  returns: v.object({
    title: v.string(),
    archived: v.boolean(),
    changed: v.boolean(),
  }),
  handler: async (ctx, { callerUserId, unitId, archived }) => {
    const { unit } = await requireAgentUnitEditAccess(ctx, callerUserId, unitId);
    if (unit.authorScholarId) throw new Error(QUEST_ARCHIVE_REFUSAL);
    const isArchived = unit.isActive === false;
    if (isArchived === archived) {
      return { title: unit.title, archived, changed: false };
    }
    if (archived) {
      // A scholar can't start an activity in an inactive unit
      // (`sessions.createSessionAs`), even through an assignment that is
      // still running. So a unit a class is working in stays active until
      // its assignments end.
      const live = (
        await ctx.db
          .query("assignments")
          .withIndex("by_unit", (q) => q.eq("unitId", unitId))
          .collect()
      ).filter((a) => a.archivedAt === undefined);
      if (live.length > 0) {
        const names = live
          .slice(0, 5)
          .map((a) => `"${a.title ?? unit.title}"`)
          .join(", ");
        throw new Error(
          `${live.length} assignment(s) still running in this unit (${names}${live.length > 5 ? ", …" : ""}). Archiving it would stop those scholars from starting any activity they haven't opened yet. Nothing was changed. End those assignments first (Archive on the Assignments tab), or leave this unit active.`,
        );
      }
    }
    await ctx.db.patch(unitId, { isActive: !archived });
    return { title: unit.title, archived, changed: true };
  },
});

/**
 * Internal: the aide's SELF-UNDO for a unit it just created by mistake —
 * notably a `create_scholar_quest` call that should have been `create_unit`,
 * which strands a unit on a real child's Quests board (prod, 2026-07-31: the
 * teacher aide mis-scoped three cohort units to one scholar, caught itself one
 * turn later, and had no way to take them back).
 *
 * Deliberately NARROWER than `units.remove`: this refuses the moment the unit
 * has ANY content or history — lessons, assignments, sessions (test-drive
 * included), completions, earned badges, offer seeds pointing at it, a
 * recorded review, or a quality-pulse sample. It is an undo for an EMPTY
 * container, not a cascading delete in a bot's hands. Anything with content
 * gets archived (`deactivate`) or retracted (`quests.retract*`) instead —
 * notably an OFFERED quest, whose seed makes it non-empty by this rule, so
 * `retract` (which dismisses the seed) stays the only way to take it back.
 *
 * The blocker list is the full set of tables carrying a `unitId`, minus the
 * two the sweep below removes (`curriculumMessages`, `chats`) and the two
 * that hang off a required `sessionId` and so are covered transitively by the
 * sessions guard (`messages`, `granuleEvidence`). Re-derive it from
 * `schema.ts` if a new unit-keyed table appears — a missed table means this
 * deletes a unit and leaves a dangling `unitId` behind.
 */
export const aideDeleteEmptyUnit = internalMutation({
  args: {
    callerUserId: v.id("users"),
    unitId: v.id("units"),
  },
  handler: async (ctx, { callerUserId, unitId }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller) throw new Error("Caller not found");
    const unit = await ctx.db.get(unitId);
    if (!unit) throw new Error("Unit not found");

    // Same curriculum-edit gate the UI delete uses. Its institution boundary
    // (`requireUnitAccessForUser`) already refuses a scholar-owned unit to
    // anyone without access to that scholar, which is what keeps a curriculum
    // designer out of a child's Quests board. The explicit scholar check below
    // is redundant belt-and-braces on a DESTRUCTIVE path an LLM can call, and
    // mirrors the aide entry points in convex/quests.ts.
    await requireUnitEditAccessForUser(ctx, caller, { unitId });
    if (unit.authorScholarId) {
      await requireActiveScholarAccess(ctx, caller, unit.authorScholarId);
    }

    const [lessons, assignments, sessions, badges] = await Promise.all([
      ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect(),
      ctx.db
        .query("assignments")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect(),
      ctx.db
        .query("sessions")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect(),
      ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect(),
    ]);
    const completions = await ctx.db
      .query("activityCompletions")
      .filter((q) => q.eq(q.field("unitId"), unitId))
      .collect();
    const [reviews, pulseSamples] = await Promise.all([
      ctx.db
        .query("unitReviews")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect(),
      ctx.db
        .query("qualityPulseSamples")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect(),
    ]);
    // `seeds.unitId` has no index, so this is a filtered scan — same shape
    // (and same justification) as the design-side scans in `units.remove`.
    // A seed pointing here means the unit was OFFERED to a scholar; the
    // sibling `retract` path dismisses those, so deleting past one would
    // strand a broken star on their Sky.
    const offerSeeds = await ctx.db
      .query("seeds")
      .filter((q) => q.eq(q.field("unitId"), unitId))
      .collect();

    const blockers: string[] = [];
    if (lessons.length) blockers.push(`${lessons.length} lesson(s)`);
    if (assignments.length) blockers.push(`${assignments.length} assignment(s)`);
    if (sessions.length) blockers.push(`${sessions.length} session(s)`);
    if (completions.length) blockers.push(`${completions.length} completion(s)`);
    if (badges.length) blockers.push(`${badges.length} earned badge(s)`);
    if (offerSeeds.length) blockers.push(`${offerSeeds.length} offer seed(s)`);
    if (reviews.length) blockers.push(`${reviews.length} recorded review(s)`);
    if (pulseSamples.length) {
      blockers.push(`${pulseSamples.length} quality-pulse sample(s)`);
    }
    if (blockers.length > 0) {
      throw new Error(
        `Not empty — this unit has ${blockers.join(", ")}. ${
          unit.authorScholarId
            ? "Retract the quest instead of deleting it."
            : "Archive it instead of deleting it."
        }`,
      );
    }

    // Unit-scoped Curriculum Bot threads: no unit-only index on either
    // table, and both are small design-side tables, so a filtered scan is
    // fine (same approach as `units.remove`). Clearing them keeps the
    // delete from leaving a dangling unitId behind.
    for (const m of await ctx.db
      .query("curriculumMessages")
      .filter((q) => q.eq(q.field("unitId"), unitId))
      .collect()) {
      await ctx.db.delete(m._id);
    }
    for (const c of await ctx.db
      .query("chats")
      .filter((q) => q.eq(q.field("unitId"), unitId))
      .collect()) {
      await ctx.db.delete(c._id);
    }

    await ctx.db.delete(unitId);
    return {
      deleted: true as const,
      title: unit.title,
      wasScholarOwned: !!unit.authorScholarId,
    };
  },
});

/**
 * Internal: scholar IS planning tutor counterparts (called from
 * convex/http.ts /session-stream tool runner). All verify the
 * scholar is the IS unit's author before writing.
 */
export const aiUpdateIsUnitMetadata = internalMutation({
  args: {
    unitId: v.id("units"),
    scholarId: v.id("users"),
    bigIdea: v.optional(v.string()),
    description: v.optional(v.string()),
    essentialQuestions: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unit not found");
    if (unit.authorScholarId !== args.scholarId) {
      throw new Error("Forbidden: not your IS unit");
    }
    const patch: Record<string, unknown> = {};
    if (args.bigIdea !== undefined) patch.bigIdea = args.bigIdea.trim() || undefined;
    // The tutor writes this in the scholar's own Quest, so it is scholar copy
    // too: update both fields, as mintIndependentStudyUnit writes both.
    if (args.description !== undefined) {
      patch.description = args.description.trim() || undefined;
      patch.scholarDescription = patch.description;
    }
    if (args.essentialQuestions !== undefined)
      patch.essentialQuestions = toKeyedGranules(
        args.essentialQuestions, unit.essentialQuestions, "eq");
    await ctx.db.patch(args.unitId, patch);
  },
});

/** Limits on a Quest's mission (TRA-519 B5): one line plus its gate. */
export const QUEST_MISSION_LIMITS = { maxText: 140, maxGate: 240 } as const;

/**
 * Set the MISSION of a scholar's own Quest (TRA-519 B5): ONE line in their
 * words saying what they are making or finding out, plus the GATE — the first
 * thing that has to exist. Scholar-authored and locked against drift: once a
 * mission exists it changes only on the scholar's explicit ask, quoted in
 * `scholarWords` and kept as `changedBecause`. Unlike `bigIdea` (which the
 * bake and update_unit_metadata rewrite freely), nothing else writes it.
 */
export const aiSetIsUnitMission = internalMutation({
  args: {
    unitId: v.id("units"),
    scholarId: v.id("users"),
    text: v.string(),
    gate: v.string(),
    scholarWords: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unit not found");
    if (unit.authorScholarId !== args.scholarId) {
      throw new Error("Forbidden: not your IS unit");
    }
    // A proposed Quest's mission is part of its proposal: the scholar changes
    // it on the proposal while it waits (questProposals.editProposal, which
    // keeps the thread's copy in step), and it stays as answered after that.
    if (unit.questApproval) {
      throw new Error(
        "This Quest's mission is part of the proposal its teacher answered, so it stays as it is. Nothing was changed.",
      );
    }
    const text = args.text.trim().replace(/\s+/g, " ");
    const gate = args.gate.trim().replace(/\s+/g, " ");
    if (!text) throw new Error("The mission line can't be empty.");
    if (!gate) throw new Error("The mission needs a gate: the first thing that has to exist.");
    if (text.length > QUEST_MISSION_LIMITS.maxText) {
      throw new Error(
        `The mission line must be ${QUEST_MISSION_LIMITS.maxText} characters or fewer (got ${text.length}). Shorten it with the scholar.`,
      );
    }
    if (gate.length > QUEST_MISSION_LIMITS.maxGate) {
      throw new Error(
        `The gate must be ${QUEST_MISSION_LIMITS.maxGate} characters or fewer (got ${gate.length}).`,
      );
    }
    const scholarWords = args.scholarWords?.trim() || undefined;
    if (unit.mission && !scholarWords) {
      throw new Error(
        "This Quest already has a mission; only change it when the scholar asks to.",
      );
    }
    await ctx.db.patch(args.unitId, {
      mission: {
        text,
        gate,
        setAt: Date.now(),
        ...(unit.mission && scholarWords ? { changedBecause: scholarWords } : {}),
      },
    });
  },
});

export const aiSetIsUnitBadge = internalMutation({
  args: {
    unitId: v.id("units"),
    scholarId: v.id("users"),
    title: v.string(),
    icon: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unit not found");
    if (unit.authorScholarId !== args.scholarId) {
      throw new Error("Forbidden: not your IS unit");
    }
    await ctx.db.patch(args.unitId, {
      badgeOnCompletion: {
        title: args.title.trim(),
        icon: args.icon?.trim() || "🏆",
        description: args.description?.trim() || undefined,
      },
    });
  },
});

/**
 * Internal — simulate what a specific scholar would see from
 * units.list(). Only used by verification tooling. Post-refactor
 * (Apr 2026) all active, published units are visible to all scholars —
 * units no longer carry scholarId.
 */
export const listForScholarInternal = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const activeUnits = await ctx.db
      .query("units")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
    return activeUnits
      .filter((u) =>
        u.authorScholarId
          ? u.authorScholarId === args.scholarId
          : isUnitPublished(u),
      )
      .map((u) => ({ id: u._id, title: u.title }));
  },
});
