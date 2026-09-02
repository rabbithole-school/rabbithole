/**
 * Scholar plate — what's on the scholar's plate right now.
 *
 * Backs the redesigned /scholar home page AND the teacher's remote view
 * (?remote=userId) so both surfaces render identically.
 *
 * Returns plate rows for the assigned lanes (classFocus | homework — one row
 * per in-progress assigned activity) plus the IS/quest lane. Each row carries:
 *   - origin: classFocus | homework | is  (mutually exclusive)
 *   - title:  activity title when there's one, project.title otherwise
 *   - isSeed: true when the project is anchorless
 *   - activity + unit context (null for anchorless)
 *   - timetable-resolved subject + schedule window metadata
 *   - unit progress summary ("N of M complete")
 *   - teacher attribution (teacherName + teacherImage) for classFocus
 *     + homework rows. UI groups by unit and renders the attribution
 *     on the unit sub-header.
 *
 * The IS lane is the canonical QUEST lane: unit-bearing IS sessions collapse to
 * ONE CARD PER (scholar, unit) — quest identity — opening the most-recently-
 * touched live session; lane membership + order come from the ONE canonical
 * derivation (`questsForScholar`), not a bespoke per-session projection here.
 * Legacy unit-LESS IS sessions (pre the Phase-2 mint invariant) have no quest
 * identity to collapse into, so each stays its own card. See the IS-lane block
 * in `buildPlateForTarget` and review/quest-lifecycle-unification.html (§3c).
 *
 * Drop rules:
 *   - Archived projects (unless `includeArchived` is true)
 *   - Test-drive projects
 *   - Projects whose activity is complete AND whose unit has no remaining
 *     incomplete online activity; otherwise they become a continuation row
 *     pointing at the next incomplete activity.
 *   - IS/quest cards whose quest is RETRACTED (deactivated unit) or otherwise
 *     no longer has a live session on an active unit (the helper's membership).
 *
 * Cap rule:
 *   - NO cap by default (`isLimit: 0`). The home shows EVERY active
 *     quest; overflow is managed by ARCHIVING, not by hiding rows (a
 *     hidden-but-present quest made "what's on my home?" ambiguous —
 *     the whole point of the plate is that it IS the home). `isLimit > 0`
 *     is still honored if a caller ever wants a bounded slice. The
 *     returned `isTotalCount` is the count of IS CARDS (quests), not sessions.
 *
 * Onboarding pin:
 *   - The "Welcome to Rabbithole" quest is self-paced, so its later beats
 *     only surface as a continuation row that sorts by lastTouched — and gets
 *     buried under each day's fresh work, stranding a first-week scholar mid-way.
 *     So onboarding is pulled OUT of the ordinary sections and returned as a
 *     dedicated `onboarding` pin the UI renders FIRST, until the unit is 4/4
 *     complete. It never locks anything — just stays visibly first.
 *
 * See review/scholar-home-activity-centric.md for the design rationale.
 */
import { v } from "convex/values";
import type { ActivityKind } from "../lib/activityKinds";
import { authedQuery, teacherQuery } from "./lib/customFunctions";
import { isTeacherRole } from "./lib/roles";
import { requireActiveScholarAccess } from "./lib/access";
import {
  hasScholarMembership,
  scholarInstitutionId,
} from "./lib/scholarEnrollment";
import { ONBOARDING_UNIT_SLUG } from "./onboardingData";
import {
  firstIncompleteLaunchableActivityInUnit,
  firstIncompleteSessionActivityInUnit,
  isSessionActivityComplete,
  suggestedQuestsForScholar,
  unitLaunchableProgressForScholar,
  unitSessionProgressForScholar,
} from "./lib/scholarReads";
import {
  resolveScholarWorkSubject,
  scholarClassFocusEntries,
  scholarTimetableContext,
} from "./assignments";
import { questsForScholar } from "./lib/questLifecycle";
import { buildCompletenessCriteria } from "./lib/unitMaturity";
import { granuleTexts } from "./lib/granules";
import { participatesInPrep } from "./lib/metaBlocks";
import { canonicalPrepWindow } from "./lib/prepBlock";
import { timeZoneForInstitution } from "./lib/institutionTime";
import { homeTitleForIndependentStudyUnit } from "./lib/independentStudy";
import { hasReadableOfflineHomeworkContent } from "./lib/activityResourceReachability";
import { pickLockingFocus } from "../shared/focusLock";
import { uniqueSubjects } from "../lib/subjects";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

export const activeForMe = authedQuery({
  args: {
    // Teacher remote mode: view as the named scholar. Defaults to the
    // calling user. Only teachers/admins may pass this for a user other
    // than themselves.
    userId: v.optional(v.id("users")),
    // Server-side cap on the IS section. 0 means "no cap" (the default —
    // overflow is managed by archiving, not hiding; #794).
    isLimit: v.optional(v.number()),
    // Include archived projects (powers the "Show archived" toggle).
    includeArchived: v.optional(v.boolean()),
    // Native can launch kind="web" activities in the embedded WebView. Web callers
    // keep the historic online-only rows until that surface branches on activityKind.
    includeWebActivities: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const caller = ctx.user;
    const isTeacher =
      isTeacherRole(caller.role);

    // Resolve which scholar's plate to render.
    const targetUserId =
      args.userId && isTeacher ? args.userId : caller._id;
    if (isTeacher && args.userId && targetUserId !== caller._id) {
      await requireActiveScholarAccess(ctx, caller, targetUserId);
    }
    const target =
      targetUserId === caller._id ? caller : await ctx.db.get(targetUserId);
    if (!target) return emptyResult();
    if (!(await hasScholarMembership(ctx, target._id))) return emptyResult();

    return await buildPlateForTarget(ctx, target, {
      isLimit: args.isLimit ?? 0,
      includeArchived: args.includeArchived === true,
      includeWebActivities: args.includeWebActivities === true,
    });
  },
});

/**
 * The shared plate-building CORE behind BOTH the scholar's own `activeForMe`
 * and the teacher-facing `homeForScholar` mirror. Given an already-resolved,
 * already-role-checked scholar plus the surface options, it returns the plate
 * rows, the IS total count, and the onboarding pin. Kept as ONE function so the
 * two surfaces can never drift — the teacher mirror is byte-for-byte the same
 * plate the iPad Home renders, just uncapped and with web activities on.
 */
export async function buildPlateForTarget(
  ctx: QueryCtx,
  target: Doc<"users">,
  opts: {
    isLimit: number;
    includeArchived: boolean;
    includeWebActivities: boolean;
  },
) {
    const { isLimit, includeArchived, includeWebActivities } = opts;
    const hasLearnerEnrollment = await hasScholarMembership(ctx, target._id);
    const firstIncompleteActivityInUnit = includeWebActivities
      ? firstIncompleteLaunchableActivityInUnit
      : firstIncompleteSessionActivityInUnit;
    const unitProgressForScholar = includeWebActivities
      ? unitLaunchableProgressForScholar
      : unitSessionProgressForScholar;
    const timetable = await scholarTimetableContext(ctx, target);
    // Resolve once for this scholar's complete plate. Each row carries this
    // read-model value so card consumers never derive or borrow a calendar.
    const learnerInstitutionId = await scholarInstitutionId(ctx, target._id);
    const timeZone = await timeZoneForInstitution(ctx, learnerInstitutionId);

    // ── Pull projects ──────────────────────────────────────────────────
    const allSessions = includeArchived
      ? await ctx.db
          .query("sessions")
          .withIndex("by_user", (q) => q.eq("userId", target._id))
          .collect()
      : await ctx.db
          .query("sessions")
          .withIndex("by_user_and_archived", (q) =>
            q.eq("userId", target._id).eq("isArchived", false),
          )
          .collect();
    const sessions = allSessions.filter(
      (p) =>
        !p.isTestDrive &&
        !p.isOffline &&
        (!learnerInstitutionId ||
          p.institutionId === learnerInstitutionId ||
          (p.institutionId === undefined && hasLearnerEnrollment)),
    );

    // ── Classify assigned work by mode (classFocus / homework) ─────────
    // Assignment rows never fall back to "Quest" when the assignment is
    // archived, no longer includes the scholar, or the activity was cleared
    // from the assignment. A session whose schedule entry merely expired keeps
    // its assigned-work mode, so a closed class/homework window never
    // masquerades as independent work. Separately, `liveAssigned` tracks
    // currently-live pushes used to surface assigned work not started yet (we
    // don't nag about closed windows).
    const now = Date.now();
    const allAssignments = await ctx.db.query("assignments").collect();
    const modeByAssignmentActivity = new Map<
      string,
      "classFocus" | "homework"
    >();
    const liveModeKeys = new Set<string>();
    const selfPacedAssignmentIds = new Set<Id<"assignments">>();
    const teacherIdByAssignment = new Map<Id<"assignments">, Id<"users">>();
    const unitIdByAssignment = new Map<Id<"assignments">, Id<"units">>();
    const scheduleEntryByAssignmentActivity = new Map<
      string,
      NonNullable<Doc<"assignments">["activitySchedule"]>[number]
    >();
    const liveAssigned: Array<{
      assignmentId: Id<"assignments">;
      activityId: Id<"activities">;
      mode: "classFocus" | "homework";
      setAt?: number;
    }> = [];

    for (const a of allAssignments) {
      if (a.archivedAt) continue;
      if (!a.scholarIds.includes(target._id)) continue;
      teacherIdByAssignment.set(a._id, a.teacherId);
      if (a.selfPaced) selfPacedAssignmentIds.add(a._id);
      // Standing (unitId-less) assignments have no unit — skip the map
      // entry; downstream code already treats a missing entry as "skip
      // this session's unit classification" (same as an archived/deleted
      // assignment today).
      if (a.unitId) unitIdByAssignment.set(a._id, a.unitId);
      for (const e of a.activitySchedule ?? []) {
        // Planned-but-never-pushed entries are invisible to scholars.
        if (e.setAt == null) continue;
        // Per-scholar targeting: an entry aimed at specific scholars is
        // invisible to everyone else — the same rule the ordering/gating
        // layer applies. Absent/empty scholarIds = cohort-wide.
        if (
          e.scholarIds != null &&
          e.scholarIds.length > 0 &&
          !e.scholarIds.some((id) => String(id) === String(target._id))
        )
          continue;
        const key = `${a._id}::${e.activityId}`;
        scheduleEntryByAssignmentActivity.set(key, e);
        const expired = e.endsAt != null && e.endsAt <= now;
        // Origin mode — a live entry's mode always wins; an expired one
        // only fills in if no live mode is known for this activity.
        if (!expired) {
          modeByAssignmentActivity.set(key, e.mode);
          liveModeKeys.add(key);
        } else if (!liveModeKeys.has(key) && !modeByAssignmentActivity.has(key)) {
          modeByAssignmentActivity.set(key, e.mode);
        }
        // Drives the "not started yet" surfacing below. A class focus counts
        // while it is SHOWING, not merely while its window is open: a teacher
        // running long has not wrapped it, so it is still what the room is on
        // and a scholar who never opened it still needs a way in. Dropping it
        // here left the iPad with nothing to render — native matches focus
        // items to plate rows and silently discards the unmatched, where the
        // web falls back to a synthetic card — so the same overrun focus
        // appeared on one surface and not the other.
        //
        // Homework deliberately keeps the window test. It carries its own
        // `dueAt` and is surfaced as overdue elsewhere; there is no "running
        // long" for work sent home.
        if (!expired || e.mode === "classFocus") {
          liveAssigned.push({
            assignmentId: a._id,
            activityId: e.activityId,
            mode: e.mode,
            setAt: e.setAt,
          });
        }
      }
    }
    const modeForAssignmentActivity = (
      assignmentId: Id<"assignments">,
      activityId: Id<"activities">,
    ) =>
      modeByAssignmentActivity.get(`${assignmentId}::${activityId}`) ??
      (selfPacedAssignmentIds.has(assignmentId) ? "classFocus" : undefined);

    // ── Pre-fetch teacher docs we'll need for attribution ──────────────
    const teacherIds = new Set(teacherIdByAssignment.values());
    const teacherById = new Map<Id<"users">, Doc<"users">>();
    for (const tid of teacherIds) {
      const t = await ctx.db.get(tid);
      if (t) teacherById.set(tid, t);
    }

    // ── Per-unit progress cache (counted once per unit, reused) ─────────
    type UnitProgress = Awaited<ReturnType<typeof unitProgressForScholar>>;
    const unitProgressCache = new Map<string, UnitProgress>();
    const getUnitProgress = async (
      unitId: Id<"units">,
      assignmentId?: Id<"assignments">,
    ): Promise<UnitProgress> => {
      const cacheKey = `${unitId}:${assignmentId ?? ""}`;
      const cached = unitProgressCache.get(cacheKey);
      if (cached) return cached;
      const result = await unitProgressForScholar(
        ctx,
        target._id,
        unitId,
        assignmentId,
      );
      unitProgressCache.set(cacheKey, result);
      return result;
    };

    // ── Onboarding pin (self-paced "Welcome to Rabbithole") ────────────
    // Resolve the welcome unit + this scholar's onboarding assignment(s). We
    // pull onboarding OUT of the ordinary sections (excluded below by
    // assignment/unit) and surface the next incomplete beat as a dedicated,
    // always-first pin — until the 4-beat unit is complete. Never a lock.
    type OnboardingPin = {
      unitId: Id<"units">;
      assignmentId: Id<"assignments"> | null;
      activityId: Id<"activities">;
      sessionId: Id<"sessions"> | null;
      nextBeatTitle: string;
      emoji: string | null;
      completedCount: number;
      totalCount: number;
    };
    const onboardingUnit = await ctx.db
      .query("units")
      .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
      .first();
    const onboardingUnitId = onboardingUnit?._id ?? null;
    const onboardingAssignmentIds = new Set<Id<"assignments">>();
    let onboardingAssignmentId: Id<"assignments"> | null = null;
    if (onboardingUnitId) {
      for (const a of allAssignments) {
        if (a.archivedAt) continue;
        if (String(a.unitId ?? "") !== String(onboardingUnitId)) continue;
        if (!a.scholarIds.includes(target._id)) continue;
        onboardingAssignmentIds.add(a._id);
        if (!onboardingAssignmentId) onboardingAssignmentId = a._id;
      }
    }
    // A session belongs to onboarding when it's stamped with the onboarding
    // assignment (the normal case) or, defensively, sits in the welcome unit.
    const isOnboardingSession = (p: Doc<"sessions">): boolean =>
      (p.assignmentId != null && onboardingAssignmentIds.has(p.assignmentId)) ||
      (onboardingUnitId != null &&
        p.unitId != null &&
        String(p.unitId) === String(onboardingUnitId));
    const sessionTouchedAt = (p: Doc<"sessions">): number =>
      Math.max(p.lastMessageAt ?? 0, p.reopenedAt ?? 0, p._creationTime);

    let onboardingPin: OnboardingPin | null = null;
    if (onboardingUnitId && onboardingAssignmentId) {
      const prog = await getUnitProgress(onboardingUnitId, onboardingAssignmentId);
      const totalCount = prog.totalOnline;
      const completedCount = prog.completedOnline;
      if (totalCount > 0 && completedCount < totalCount) {
        const next = await firstIncompleteActivityInUnit(
          ctx,
          target._id,
          onboardingUnitId,
          onboardingAssignmentId,
        );
        if (next) {
          const existing = sessions.find(
            (p) =>
              !p.isArchived &&
              p.activityId != null &&
              String(p.activityId) === String(next.activity._id) &&
              String(p.assignmentId ?? "") === String(onboardingAssignmentId),
          );
          onboardingPin = {
            unitId: onboardingUnitId,
            assignmentId: onboardingAssignmentId,
            activityId: next.activity._id,
            sessionId: existing?._id ?? null,
            nextBeatTitle: next.activity.title,
            emoji: onboardingUnit?.emoji ?? null,
            completedCount,
            totalCount,
          };
        }
      }
    }

    // ── First pass: classify projects by origin, skipping completed.
    // We *don't* fetch unit / teacher data yet — only enough to
    // categorize and pick the IS cohort that survives the cap.
    type PreRow = {
      session: Doc<"sessions">;
      origin: "classFocus" | "homework" | "is";
      lastTouched: number;
      currentComplete: boolean;
      continuationActivityId: Id<"activities"> | null;
      // A finished session the scholar chose "Keep working on this" from, whose
      // unit has no remaining incomplete activity. It stays visibly resumable on
      // the plate but is NOT owed work — surfaces must not count it as "due".
      isReopenedComplete: boolean;
    };
    const pre: PreRow[] = [];
    for (const p of sessions) {
      // Onboarding is surfaced by the dedicated pin above, never as a plate
      // row (otherwise its buried continuation double-renders).
      if (isOnboardingSession(p)) continue;
      const currentComplete = await isSessionActivityComplete(ctx, target._id, p);
      let origin: PreRow["origin"] = "is";
      const assignmentActivityKey = p.assignmentId && p.activityId
        ? `${p.assignmentId}::${p.activityId}`
        : null;
      if (p.assignmentId) {
        const assignmentUnitId = unitIdByAssignment.get(p.assignmentId);
        if (!assignmentUnitId) continue;
        if (p.unitId && String(p.unitId) !== String(assignmentUnitId)) continue;
        if (
          !currentComplete &&
          p.activityId &&
          !modeForAssignmentActivity(p.assignmentId, p.activityId)
        ) {
          continue;
        }
      }
      if (assignmentActivityKey) {
        // Assignment-anchored → always classFocus/homework, never a Quest,
        // even if the schedule window has since closed.
        const mode =
          p.assignmentId && p.activityId
            ? modeForAssignmentActivity(p.assignmentId, p.activityId)
            : undefined;
        if (mode) origin = mode;
      }
      if (currentComplete) {
        const unitId = p.unitId;
        const nextIncomplete = unitId
          ? await firstIncompleteActivityInUnit(
              ctx,
              target._id,
              unitId,
              p.assignmentId,
            )
          : null;
        if (!nextIncomplete) {
          // A scholar who explicitly chose "Keep working on this" is doing new
          // work on top of a completed badge. Keep the session visible on Home
          // without touching completion state or pretending there is a next
          // incomplete activity.
          if (!p.reopenedAt) continue;
          pre.push({
            session: p,
            origin,
            lastTouched: sessionTouchedAt(p),
            currentComplete: false,
            continuationActivityId: null,
            isReopenedComplete: true,
          });
          continue;
        }
        const continuationOrigin = p.assignmentId
          ? modeForAssignmentActivity(
              p.assignmentId,
              nextIncomplete.activity._id,
            ) ?? origin
          : origin;
        pre.push({
          session: p,
          origin: continuationOrigin,
          lastTouched: sessionTouchedAt(p),
          currentComplete,
          continuationActivityId: nextIncomplete.activity._id,
          isReopenedComplete: false,
        });
        continue;
      }
      pre.push({
        session: p,
        origin,
        lastTouched: sessionTouchedAt(p),
        currentComplete,
        continuationActivityId: null,
        isReopenedComplete: false,
      });
    }

    // A scholar can have several completed sessions in the same unit
    // (activity 1, then activity 2, ...). Once all of them point at the same
    // next incomplete activity, Home should show one continuation card, not one
    // per historical completed session.
    const nonContinuationPre: PreRow[] = [];
    const continuationPreByKey = new Map<string, PreRow>();
    for (const row of pre) {
      if (row.currentComplete && row.continuationActivityId) {
        const key = `${row.session.assignmentId ?? ""}::${row.continuationActivityId}`;
        const existing = continuationPreByKey.get(key);
        if (!existing || row.lastTouched > existing.lastTouched) {
          continuationPreByKey.set(key, row);
        }
      } else {
        nonContinuationPre.push(row);
      }
    }
    const activeSessionKeys = new Set(
      nonContinuationPre
        .filter((row) => row.session.activityId)
        .map(
          (row) =>
            `${row.session.assignmentId ?? ""}::${row.session.activityId}`,
        ),
    );
    for (const key of activeSessionKeys) {
      continuationPreByKey.delete(key);
    }
    const dedupedPre = [
      ...nonContinuationPre,
      ...continuationPreByKey.values(),
    ];

    // ── IS lane = the canonical quest lane ─────────────────────────────
    // The old IS lane was one row per live IS SESSION. It's now the QUEST lane:
    // unit-bearing IS sessions collapse to ONE CARD PER (scholar, unit) — quest
    // identity — and lane membership comes from the canonical helper
    // (`questsForScholar`), not this file's bespoke session projection.
    //
    // A card appears iff the pair has a live session on an active unit — the
    // helper's `hasLiveSession && unitIsActive`. That mirrors exactly the IS
    // sessions this first pass keeps (its completion-skip == the helper's), while
    // ALSO dropping RETRACTED quests (a deactivated unit) — the one thing the
    // session-level pass never filtered. Work reopened past completion still
    // shows (a reopen keeps `hasLiveSession` true), matching sessions.reopen,
    // even though such a quest's canonical STATE is "finished".
    //
    // The widened helper covers catalog free-starts (teacher-authored units the
    // scholar merely started) too, so those survive the membership gate instead
    // of silently vanishing. A quest that is active only via ASSIGNED sessions
    // (no independent session) produces no IS PreRow here, so it correctly stays
    // in classFocus/homework and never double-renders as a card.
    //
    // Unit-LESS IS sessions (legacy anchorless quests, from before the Phase-2
    // mint invariant) have no (scholar,unit) identity to collapse into, so each
    // stays its own card.
    const quests = await questsForScholar(ctx, target._id);
    const liveQuestUnitIds = new Set(
      quests
        .filter((q) => q.hasLiveSession && q.unitIsActive)
        .map((q) => String(q.unitId)),
    );

    const isPre = dedupedPre.filter((r) => r.origin === "is");
    const unitlessIS = isPre.filter((r) => !r.session.unitId);
    // One card per quest: the most-recently-touched live IS session for each
    // visible quest unit (its `lastTouched` becomes the card's — the helper's
    // sort). Retracted / finished-and-inert quests fall out of the id set.
    const bestQuestRowByUnit = new Map<string, PreRow>();
    for (const r of isPre) {
      const uid = r.session.unitId;
      if (!uid) continue;
      const uk = String(uid);
      if (!liveQuestUnitIds.has(uk)) continue;
      const cur = bestQuestRowByUnit.get(uk);
      if (!cur || r.lastTouched > cur.lastTouched) bestQuestRowByUnit.set(uk, r);
    }

    // Combine unit-less rows + one-per-quest rows, order by lastTouched desc,
    // then apply the optional cap (default 0 = uncapped; #794). `isTotalCount`
    // is now the count of IS CARDS (quests), not sessions.
    const isAll = [...unitlessIS, ...bestQuestRowByUnit.values()].sort(
      (a, b) => b.lastTouched - a.lastTouched,
    );
    const isTotalCount = isAll.length;
    const isKept =
      isLimit > 0 && isAll.length > isLimit ? isAll.slice(0, isLimit) : isAll;
    const kept: PreRow[] = [
      ...dedupedPre.filter((r) => r.origin !== "is"),
      ...isKept,
    ];

    // ── Second pass: hydrate the survivors with unit + teacher context ─
    type Row = {
      sessionId: Id<"sessions"> | null;
      title: string;
      lastTouched: number;
      notStarted: boolean;
      isArchived: boolean;
      origin: "classFocus" | "homework" | "is";
      isSeed: boolean;
      activityKind: ActivityKind;
      practiceSkillKey: string | null;
      activityId: Id<"activities"> | null;
      unitId: Id<"units"> | null;
      unitTitle: string | null;
      unitEmoji: string | null;
      unitCompletedCount: number | null;
      unitActivityCount: number | null;
      subject: string | null;
      dueAt: number | null;
      timeZone: string;
      endsAt: number | null;
      assignmentId?: Id<"assignments">;
      teacherName?: string;
      teacherImage?: string;
      seedId?: Id<"seeds">;
      // Card context (makes the home cards enticing, not just a timestamp):
      description: string | null; // activity hook — pulls a not-started card
      etaMinutes: number | null; // "~20 min" — bounds the ask
      lastMessagePreview: string | null; // resume cue for in-progress rows
      isContinuation: boolean;
      // True only for a reopened-completed session (see PreRow). Lets a surface
      // keep the card resumable while excluding it from any "due"/owed count.
      isReopenedComplete: boolean;
      // Activity choice: when this row's activity lives in a "choice"
      // lesson, these describe the menu so the UI can group the option
      // rows sharing a `choiceLessonId` into ONE "choose N of these" card.
      // Null on ordinary (sequence) rows.
      choiceLessonId: Id<"lessons"> | null;
      choicePickCount: number | null; // how many to complete (N)
      choicePickedCount: number | null; // how many already completed
      choiceOptionCount: number | null; // total options in the menu
    };

    // Choice-lesson tag for a row, read from the (choice-aware) unit
    // progress. Returns nulls for sequence lessons / when progress is absent.
    const choiceFieldsFor = (
      lessonId: Id<"lessons"> | null | undefined,
      prog: UnitProgress | null,
    ) => {
      const none = {
        choiceLessonId: null as Id<"lessons"> | null,
        choicePickCount: null as number | null,
        choicePickedCount: null as number | null,
        choiceOptionCount: null as number | null,
      };
      if (!lessonId || !prog) return none;
      const c = prog.choiceByLesson.get(String(lessonId));
      if (!c) return none;
      return {
        choiceLessonId: lessonId,
        choicePickCount: c.pickCount,
        choicePickedCount: c.completedCount,
        choiceOptionCount: c.optionCount,
      };
    };

    const rows: Row[] = [];
    for (const {
      session: p,
      origin,
      lastTouched,
      currentComplete,
      isReopenedComplete,
    } of kept) {
      let activity = p.activityId ? await ctx.db.get(p.activityId) : null;
      let lesson = activity?.lessonId
        ? await ctx.db.get(activity.lessonId)
        : null;
      const unitId = p.unitId ?? lesson?.unitId ?? null;
      const unit = unitId ? await ctx.db.get(unitId) : null;
      const nextIncomplete = unitId
        ? await firstIncompleteActivityInUnit(
            ctx,
            target._id,
            unitId,
            p.assignmentId,
          )
        : null;
      if (currentComplete && nextIncomplete) {
        activity = nextIncomplete.activity;
        lesson = nextIncomplete.lesson;
      }
      if (
        !includeWebActivities &&
        (activity?.kind === "web" || activity?.kind === "game")
      )
        continue;
      const isSeed = !p.activityId && !p.unitId;
      const title = activity?.title ?? p.title;

      let unitCompletedCount: number | null = null;
      let unitActivityCount: number | null = null;
      let unitProg: UnitProgress | null = null;
      if (unitId) {
        unitProg = await getUnitProgress(unitId, p.assignmentId);
        unitCompletedCount = unitProg.completedOnline;
        unitActivityCount = unitProg.totalOnline;
      }

      let teacherName: string | undefined;
      let teacherImage: string | undefined;
      if ((origin === "classFocus" || origin === "homework") && p.assignmentId) {
        const tid = teacherIdByAssignment.get(p.assignmentId);
        const teacher = tid ? teacherById.get(tid) : null;
        teacherName = teacher?.name ?? undefined;
        teacherImage = teacher?.image ?? undefined;
      }

      const rowActivityId = activity?._id ?? p.activityId ?? null;
      const scheduleEntry =
        p.assignmentId && rowActivityId
          ? scheduleEntryByAssignmentActivity.get(
              `${p.assignmentId}::${rowActivityId}`,
            )
          : undefined;

      rows.push({
        sessionId: currentComplete ? null : p._id,
        title,
        lastTouched,
        notStarted: currentComplete || p.lastMessageAt === undefined,
        isArchived: p.isArchived === true,
        origin,
        isSeed,
        activityKind: activity?.kind ?? "online",
        practiceSkillKey:
          activity?.kind === "problem_set" &&
          activity.problemSet?.targetSkillKeys.length === 1
            ? activity.problemSet.targetSkillKeys[0]
            : null,
        activityId: rowActivityId,
        unitId,
        unitTitle: unit
          ? origin === "is"
            ? await homeTitleForIndependentStudyUnit(ctx, unit)
            : unit.title
          : null,
        unitEmoji: unit?.emoji ?? null,
        unitCompletedCount,
        unitActivityCount,
        subject: resolveScholarWorkSubject(
          timetable,
          p.assignmentId,
          rowActivityId,
          unit?.subject,
        ),
        dueAt:
          origin === "homework" && scheduleEntry?.mode === "homework"
            ? scheduleEntry.dueAt ?? null
            : null,
        timeZone,
        endsAt:
          origin === "classFocus" && scheduleEntry?.mode === "classFocus"
            ? scheduleEntry.endsAt ?? null
            : null,
        assignmentId: p.assignmentId,
        teacherName,
        teacherImage,
        seedId: p.seedId,
        description:
          activity?.scholarDescription ?? unit?.scholarDescription ?? null,
        etaMinutes: activity?.durationMinutes ?? null,
        lastMessagePreview: currentComplete ? null : (p.lastMessagePreview ?? null),
        isContinuation: currentComplete,
        isReopenedComplete,
        ...choiceFieldsFor(lesson?._id ?? null, unitProg),
      });
    }

    // ── Surface assigned work the scholar hasn't STARTED yet ───────────
    // The rows above are session-driven, so a live classFocus/homework
    // push the scholar never opened would be invisible. The assignment
    // schedule — not the existence of a session — is the source of truth
    // for "what's assigned to you right now", so emit a not-started row
    // for each live assigned online/web activity with no session and no
    // completion. Clicking it starts the chat session or opens the webview.
    // The one non-launchable exception is offline HOMEWORK, whose row is a
    // read-in-place card rather than a launch — see the kind gate below.
    const startedAssignedKeys = new Set<string>();
    for (const p of sessions) {
      if (p.assignmentId && p.activityId) {
        startedAssignedKeys.add(`${p.assignmentId}::${p.activityId}`);
      }
    }
    const myCompletions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", target._id))
      .collect();
    const completedAssignedKeys = new Set<string>();
    for (const c of myCompletions) {
      if (c.assignmentId) {
        completedAssignedKeys.add(`${c.assignmentId}::${c.activityId}`);
      }
    }
    const emittedNotStarted = new Set<string>();
    for (const row of rows) {
      if (row.assignmentId && row.activityId && row.sessionId === null) {
        emittedNotStarted.add(`${row.assignmentId}::${row.activityId}`);
      }
    }
    for (const ent of liveAssigned) {
      const key = `${ent.assignmentId}::${ent.activityId}`;
      // Onboarding's live beat is owned by the pin, not the sections.
      if (onboardingAssignmentIds.has(ent.assignmentId)) continue;
      if (startedAssignedKeys.has(key)) continue;
      if (completedAssignedKeys.has(key)) continue;
      if (emittedNotStarted.has(key)) continue; // same activity, two modes
      const activity = await ctx.db.get(ent.activityId);
      // Offline/share-back activities have no scholar-launched surface here.
      // Games do (native only — a browser renders a capability notice), so
      // they ride the same `includeWebActivities` native gate as kind="web".
      const nativeLaunchable =
        activity != null &&
        includeWebActivities &&
        (activity.kind === "web" || activity.kind === "game");
      const sessionLaunchable =
        activity != null &&
        (activity.kind === "online" ||
          activity.kind === "problem_set" ||
          activity.kind === "simulator" ||
          activity.kind === "vibecode");
      // Offline HOMEWORK is the one deliberate exception. Work sent home has
      // to be READABLE at home. It needs authored instructions or at least one
      // reachable scholar-safe material. The row opens a read-only offline
      // session without creating tutor chat or completion evidence. `offline` stays OUT of
      // SCHOLAR_SOLO_STARTABLE_KINDS (convex/assignments.ts) so it can still
      // never drive the hard focus lock. Offline CLASS FOCUS and shareBack
      // stay excluded: those are run BY the teacher, in the room, and a card
      // for them would be a to-do the scholar cannot act on.
      const offlineHomework =
        activity != null &&
        activity.kind === "offline" &&
        ent.mode === "homework" &&
        (await hasReadableOfflineHomeworkContent(ctx, activity));
      if (
        !activity ||
        (!sessionLaunchable && !nativeLaunchable && !offlineHomework)
      )
        continue;
      emittedNotStarted.add(key);

      const lesson = activity.lessonId
        ? await ctx.db.get(activity.lessonId)
        : null;
      const unitId = lesson?.unitId ?? null;
      const unit = unitId ? await ctx.db.get(unitId) : null;
      let unitCompletedCount: number | null = null;
      let unitActivityCount: number | null = null;
      let unitProg: UnitProgress | null = null;
      if (unitId) {
        unitProg = await getUnitProgress(unitId, ent.assignmentId);
        unitCompletedCount = unitProg.completedOnline;
        unitActivityCount = unitProg.totalOnline;
        // Choice-aware surfacing: only nag about an activity that's still
        // "available" work. This drops the remaining options of a SATISFIED
        // choice lesson (D2 — they stay openable via the unit nav, just no
        // longer surfaced here) while leaving sequence lessons untouched
        // (every uncompleted sequence option is available).
        //
        // Offline homework is exempt: `availableActivityIds` is computed from
        // the unit's LAUNCHABLE ladder (orderedOnline/LaunchableActivitiesForUnit
        // in lib/scholarReads.ts), which offline activities are not part of —
        // so applying this gate would silently drop every unit-bearing offline
        // homework row. Its own completion check ran above.
        if (
          !offlineHomework &&
          !unitProg.availableActivityIds.has(String(ent.activityId))
        )
          continue;
      }
      const tid = teacherIdByAssignment.get(ent.assignmentId);
      const teacher = tid ? teacherById.get(tid) : null;
      const scheduleEntry = scheduleEntryByAssignmentActivity.get(key);

      rows.push({
        sessionId: null,
        title: activity.title,
        lastTouched: ent.setAt ?? now,
        notStarted: true,
        isArchived: false,
        origin: ent.mode,
        isSeed: false,
        activityKind: activity.kind,
        practiceSkillKey:
          activity.kind === "problem_set" &&
          activity.problemSet?.targetSkillKeys.length === 1
            ? activity.problemSet.targetSkillKeys[0]
            : null,
        activityId: ent.activityId,
        unitId,
        unitTitle: unit?.title ?? null,
        unitEmoji: unit?.emoji ?? null,
        unitCompletedCount,
        unitActivityCount,
        subject: resolveScholarWorkSubject(
          timetable,
          ent.assignmentId,
          ent.activityId,
          unit?.subject,
        ),
        dueAt:
          ent.mode === "homework" && scheduleEntry?.mode === "homework"
            ? scheduleEntry.dueAt ?? null
            : null,
        timeZone,
        endsAt:
          ent.mode === "classFocus" && scheduleEntry?.mode === "classFocus"
            ? scheduleEntry.endsAt ?? null
            : null,
        assignmentId: ent.assignmentId,
        teacherName: teacher?.name ?? undefined,
        teacherImage: teacher?.image ?? undefined,
        seedId: undefined,
        description: offlineHomework
          ? activity.scholarDescription ?? null
          : activity.scholarDescription ?? unit?.scholarDescription ?? null,
        etaMinutes: activity.durationMinutes ?? null,
        lastMessagePreview: null,
        isContinuation: false,
        isReopenedComplete: false,
        ...choiceFieldsFor(lesson?._id ?? null, unitProg),
      });
    }

    rows.sort((a, b) => b.lastTouched - a.lastTouched);
    const subjectTabs =
      timetable.subjectTabs.length > 0
        ? timetable.subjectTabs
        : uniqueSubjects(
            rows.filter(
              (row) =>
                row.origin === "classFocus" || row.origin === "homework",
            ),
          );
    return { rows, subjectTabs, isTotalCount, onboarding: onboardingPin };
}

function emptyResult() {
  return {
    rows: [] as Array<{
      sessionId: Id<"sessions"> | null;
      title: string;
      lastTouched: number;
      notStarted: boolean;
      isArchived: boolean;
      origin: "classFocus" | "homework" | "is";
      isSeed: boolean;
      activityKind: ActivityKind;
      practiceSkillKey: string | null;
      activityId: Id<"activities"> | null;
      unitId: Id<"units"> | null;
      unitTitle: string | null;
      unitEmoji: string | null;
      unitCompletedCount: number | null;
      unitActivityCount: number | null;
      subject: string | null;
      dueAt: number | null;
      timeZone: string;
      endsAt: number | null;
      assignmentId?: Id<"assignments">;
      teacherName?: string;
      teacherImage?: string;
      seedId?: Id<"seeds">;
      description: string | null;
      etaMinutes: number | null;
      lastMessagePreview: string | null;
      isContinuation: boolean;
      isReopenedComplete: boolean;
      choiceLessonId: Id<"lessons"> | null;
      choicePickCount: number | null;
      choicePickedCount: number | null;
      choiceOptionCount: number | null;
    }>,
    subjectTabs: [] as string[],
    isTotalCount: 0,
    onboarding: null as {
      unitId: Id<"units">;
      assignmentId: Id<"assignments"> | null;
      activityId: Id<"activities">;
      sessionId: Id<"sessions"> | null;
      nextBeatTitle: string;
      emoji: string | null;
      completedCount: number;
      totalCount: number;
    } | null,
  };
}

/**
 * Cheap per-unit provenance the teacher Home mirror stamps on each row:
 *   - `isActive`  — `units.isActive` (a scholar-facing plate read never filters
 *                   this, so a row can point at a deactivated unit).
 *   - `isDraft`   — the unit is still at maturity **Draft**, i.e. it hasn't
 *                   passed the structural-completeness bar. Computed from the
 *                   PURE `buildCompletenessCriteria` (Big Idea / EQs / EUs /
 *                   core+connections+practice lessons / all prompts) — NOT the
 *                   expensive per-node `getNodeStatuses` (no rehearsal/grounding
 *                   scan). Draft is a quality label, never a visibility gate.
 */
async function unitProvenance(
  ctx: QueryCtx,
  unitId: Id<"units">,
): Promise<{ isActive: boolean; isDraft: boolean }> {
  const unit = await ctx.db.get(unitId);
  if (!unit) return { isActive: false, isDraft: false };
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  const criteria = buildCompletenessCriteria(
    {
      bigIdea: unit.bigIdea,
      essentialQuestions: granuleTexts(unit.essentialQuestions),
      enduringUnderstandings: granuleTexts(unit.enduringUnderstandings),
    },
    lessons,
  );
  const draftDone = criteria.every((c) => c.met);
  return { isActive: unit.isActive === true, isDraft: !draftDone };
}

/**
 * TEACHER-FACING Home mirror — the exhaustive "what is on scholar X's iPad Home
 * right now" snapshot the report (§7 conclusion) identifies as the missing
 * guarantee. Backed by the SAME `buildPlateForTarget` core the native Home's
 * `activeForMe` uses, so it's the real plate, not the web approximation:
 *
 *   - Uncapped IS lane (`isLimit: 0`) — the teacher sees EVERY quest, not the
 *     scholar's 3-row cap.
 *   - `includeWebActivities: true` — the native contract (web-activity rows on).
 *   - The onboarding pin, verbatim.
 *   - The focus-lock state (`scholarClassFocusEntries` → `pickLockingFocus`),
 *     the same read-only "finish class focus first" wall the iPad computes.
 *   - The scholar's Prep-Time block (group daily block), teacher-readable.
 *   - Per-row provenance: origin, session/assignment/unit/seed ids, plus each
 *     row's unit `isActive` + maturity-`Draft` flags.
 *   - The "Suggested by your teacher" offer cards (`suggested`) — a faithful
 *     mirror of the scholar-home SuggestedQuests section, from the SAME shared
 *     seed-derived collector the scholar's home uses
 *     (`suggestedQuestsForScholar`), so the two can't drift. Includes catalog-
 *     unit offers (a teacher can offer any unit); each card carries `isAuthored`
 *     so the UI picks Retract (scholar-authored quest) vs. Remove (catalog).
 *
 * Teacher-gated + scholar-access-checked; returns an empty snapshot for a
 * missing / non-scholar target rather than throwing.
 */
export const homeForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const emptyHome = {
      rows: [] as Array<
        Awaited<ReturnType<typeof buildPlateForTarget>>["rows"][number] & {
          unitIsActive: boolean | null;
          unitIsDraft: boolean | null;
        }
      >,
      onboarding: null as
        | (NonNullable<Awaited<ReturnType<typeof buildPlateForTarget>>["onboarding"]> & {
            unitIsActive: boolean;
            unitIsDraft: boolean;
          })
        | null,
      // SUGGESTED quest offers — the teacher's mirror of the scholar-home
      // "Suggested by your teacher" cards (components/SuggestedQuests). Shares
      // the ONE seed-derived collector (suggestedQuestsForScholar) the scholar's
      // own home uses, so the two can't drift — including catalog-unit offers
      // (a teacher can offer any unit), which the quest derivation doesn't cover.
      // `isAuthored` lets the mirror pick the removal verb (Retract a scholar-
      // authored quest vs. Remove a catalog-unit suggestion).
      suggested: [] as Array<{
        unitId: Id<"units">;
        seedId: Id<"seeds">;
        title: string;
        emoji: string;
        activityCount: number;
        body: string | null;
        teacherName: string;
        teacherImage: string | null;
        isAuthored: boolean;
      }>,
      subjectTabs: [] as string[],
      isTotalCount: 0,
      focusLock: null as { unitId: string | null; label: string | null; endsAt: number | null; timeZone: string } | null,
      prep: null as Awaited<ReturnType<typeof canonicalPrepWindow>>,
    };

    const target = await ctx.db.get(args.scholarId);
    if (!target || !(await hasScholarMembership(ctx, target._id))) {
      return emptyHome;
    }
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const plate = await buildPlateForTarget(ctx, target, {
      isLimit: 0,
      includeArchived: false,
      includeWebActivities: true,
    });

    // Per-unit provenance, computed once per distinct unit.
    const provCache = new Map<string, { isActive: boolean; isDraft: boolean }>();
    const provFor = async (unitId: Id<"units">) => {
      const key = String(unitId);
      const hit = provCache.get(key);
      if (hit) return hit;
      const p = await unitProvenance(ctx, unitId);
      provCache.set(key, p);
      return p;
    };

    const rows = await Promise.all(
      plate.rows.map(async (r) => {
        const prov = r.unitId ? await provFor(r.unitId) : null;
        return {
          ...r,
          unitIsActive: prov?.isActive ?? null,
          unitIsDraft: prov?.isDraft ?? null,
        };
      }),
    );

    let onboarding = emptyHome.onboarding;
    if (plate.onboarding) {
      const prov = await provFor(plate.onboarding.unitId);
      onboarding = {
        ...plate.onboarding,
        unitIsActive: prov.isActive,
        unitIsDraft: prov.isDraft,
      };
    }

    // SUGGESTED quest offers — the teacher's mirror of the scholar-home
    // "Suggested by your teacher" cards (components/SuggestedQuests). SEED-derived
    // via the ONE shared collector the scholar's own home uses
    // (suggestedQuestsForScholar), so the two render the identical set and can't
    // drift. This is deliberately NOT questsForScholar-filtered: a teacher can
    // `offer` any unit — including a CATALOG unit with no authorScholarId, which
    // the quest derivation has no row for — and that offer IS a card on the
    // scholar's home, so it must appear here too. `isAuthored` drives the mirror's
    // removal verb (Retract vs. Remove suggestion).
    const suggested = await suggestedQuestsForScholar(ctx, args.scholarId).then(
      (cards) =>
        cards.map((c) => ({
          unitId: c.unitId,
          seedId: c.seedId,
          title: c.title,
          emoji: c.emoji,
          activityCount: c.activityCount,
          // Same body precedence the scholar card renders (description || invitation).
          body: c.description || c.rationale,
          teacherName: c.teacherName,
          teacherImage: c.teacherImage,
          isAuthored: c.isAuthored,
        })),
    );

    // Focus-lock state — identical to what the iPad Home derives.
    const focusEntries = await scholarClassFocusEntries(ctx, args.scholarId);
    const locking = pickLockingFocus(focusEntries);
    const focusLock = locking
      ? {
          unitId: locking.unitId ? String(locking.unitId) : null,
          label:
            locking.activityTitle ??
            locking.lessonTitle ??
            locking.unitTitle ??
            null,
          // "The turn, not the bell" — so a mirror surface can render the
          // same soft "with the class until ~10:25" awareness the scholar's
          // own Home shows, never a bare "paused until then".
          endsAt: locking.endsAt ?? null,
          timeZone: locking.timeZone,
        }
      : null;

    // Scholar's Prep — Move 5: the group's `prepTime` entry decides only whether
    // this scholar's pod runs the ritual; the WINDOW comes from the institution's
    // bell-schedule prep block (the single clock the scholar pin + Special
    // Delivery share). One deterministic window, never a per-group pick.
    const groups = await ctx.db.query("scholarGroups").collect();
    const scholarGroups = groups.filter((g) =>
      g.scholarIds.includes(args.scholarId),
    );
    const prep =
      participatesInPrep(scholarGroups) && target.institutionId
        ? await canonicalPrepWindow(ctx, target.institutionId)
        : null;

    return {
      rows,
      onboarding,
      suggested,
      subjectTabs: plate.subjectTabs,
      isTotalCount: plate.isTotalCount,
      focusLock,
      prep,
    };
  },
});
