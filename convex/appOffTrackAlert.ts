/**
 * "Off mission" alert for a scholar's session on any activity that has a
 * mission (TRA-481 for app builds, generalized by TRA-519 B3).
 *
 * The observer already writes an `analyses` row after each burst of a session,
 * and its prompt tells it that curriculum drift lowers `onTaskScore` (see the
 * pulse section of `buildObserverSystemPrompt`). Nothing acted on that: on
 * 2026-10-09 one build session read as drifting on every report after minute
 * 12, on-task fell to 0.15, and the teacher in the room got no nudge. Math
 * practice already pages the institution's alert channel when a scholar is
 * stuck (`practiceStuckAlert.ts`); this is the same alert fabric
 * (`raiseAlert`, convex/alerts.ts) with a second producer — no new table, no
 * new channel, no new vocabulary beyond one alert `kind`.
 *
 * WHO is checked is the mission resolver's answer (`lib/mission.ts`), the same
 * one prompt assembly and free play read: a session that resolves a mission AND
 * has an activity. Exploration (open chat, seed explorations, discussion-only
 * activities, Quest planning chats) resolves none and is never alerted.
 *
 * Called from `analysisHelpers.saveAnalysis`, in the same transaction that
 * writes the reading, so it sees exactly the rows the observer has written.
 */
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { DEDUP_WINDOW_MS, raiseAlert } from "./alerts";
import { siteUrl, sessionPath, withBase } from "./lib/channels";
import { resolveSessionMission, type SessionMission } from "./lib/mission";
import { CONCERN_ON_TASK } from "./lib/rosterPulse";
import { isTeacherRole } from "./lib/roles";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import { scholarHasCompletedActivity } from "./lib/workshopPolicy";
import { escapeSlackText } from "./lib/slackApi";

export const OFF_MISSION_ALERT_KIND = "off_mission";
/**
 * The kind this alert had while it only watched app builds. No new rows carry
 * it; it stays for historical rows and so a session already alerted under it
 * is not alerted again inside the same window.
 */
export const APP_OFF_TRACK_ALERT_KIND = "app_off_track";

/**
 * How many CONSECUTIVE off-track readings it takes to alert. One observer
 * reading is an LLM re-reading the session so far, with real judgement noise
 * (rosterPulse's TREND_MIN_POINTS note), so a single low reading must never
 * page a teacher; two in a row is the smallest run that is not one report.
 */
export const OFF_TRACK_CONSECUTIVE_READINGS = 2;

/**
 * One reading is off track when its on-task score sits below the roster's own
 * "concern" line, `CONCERN_ON_TASK` in convex/lib/rosterPulse.ts — the value at
 * which the Scholars roster already marks a scholar as needing attention. The
 * anchor is deliberate (T6): this alert and the roster must agree on what "off
 * task" means, or a teacher is paged about a scholar the roster calls fine.
 * Concern FLAGS are free text written by the model, so they are not matched
 * here; the observer is told to express drift through the score.
 */
export function isOffTrackReading(
  row: Pick<Doc<"analyses">, "onTaskScore">,
): boolean {
  return (
    typeof row.onTaskScore === "number" && row.onTaskScore < CONCERN_ON_TASK
  );
}

/**
 * True only on the reading that ENTERS the off-track state: the newest
 * `OFF_TRACK_CONSECUTIVE_READINGS` readings are off track and the one before
 * them (if any) was not. A session that stays off track therefore alerts once,
 * and alerts again only after it has cleared and come back.
 */
export function entersOffTrack(
  newestFirst: ReadonlyArray<Pick<Doc<"analyses">, "onTaskScore">>,
): boolean {
  const run = newestFirst.slice(0, OFF_TRACK_CONSECUTIVE_READINGS);
  if (run.length < OFF_TRACK_CONSECUTIVE_READINGS) return false;
  if (!run.every(isOffTrackReading)) return false;
  const before = newestFirst[OFF_TRACK_CONSECUTIVE_READINGS];
  return before === undefined || !isOffTrackReading(before);
}

/** Slack member ids are `U…` / `W…`; anything else is not mentioned. */
const SLACK_MEMBER_ID = /^[UW][A-Z0-9]+$/;

/**
 * The teacher to name in the alert: the assignment's teacher, else the unit's.
 * Only a teacher with a TEACHER-role membership in the scholar's own
 * institution is eligible — the alert posts to that institution's channel, and
 * a teacher from another school is never named in it.
 */
async function owningTeacher(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  institutionId: Id<"institutions">,
): Promise<Doc<"users"> | null> {
  const candidates: Id<"users">[] = [];
  if (session.assignmentId) {
    const assignment = await ctx.db.get(session.assignmentId);
    if (assignment) candidates.push(assignment.teacherId);
  }
  if (session.unitId) {
    const unit = await ctx.db.get(session.unitId);
    if (unit) candidates.push(unit.teacherId);
  }
  for (const teacherId of candidates) {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", teacherId))
      .collect();
    const inInstitution = memberships.some(
      (m) => isTeacherRole(m.role) && m.institutionId === institutionId,
    );
    if (!inInstitution) continue;
    const teacher = await ctx.db.get(teacherId);
    if (teacher) return teacher;
  }
  return null;
}


/** The mission line of the post: an authored gate as written, any other gate
 * (the kind's default — including an authored contract with no gate — or a
 * Quest's) marked "(default)". */
function missionLine(mission: OffMissionAlertMission): string {
  const gate = escapeSlackText(mission.gate.trim());
  return mission.gateAuthored
    ? `Mission: ${gate}`
    : `Mission: (default) ${gate}`;
}

export type OffMissionAlertMission = Pick<SessionMission, "gate"> & {
  /** The activity's own contract carries this gate. */
  gateAuthored: boolean;
};

/** The parts of the Slack post, kept pure so the shape is testable. */
export function buildOffMissionAlert(args: {
  scholarName: string;
  activityTitle: string;
  observerSummary: string;
  mission: OffMissionAlertMission;
  teacherSlackUserId?: string | null;
  parkedIdeas?: number | null;
}): { title: string; body: string } {
  const title = `${escapeSlackText(args.scholarName)} looks off mission in ${escapeSlackText(args.activityTitle)}`;
  const mention =
    args.teacherSlackUserId && SLACK_MEMBER_ID.test(args.teacherSlackUserId)
      ? `<@${args.teacherSlackUserId}> `
      : "";
  const lines = [
    `${mention}${escapeSlackText(args.observerSummary.trim())}`,
    missionLine(args.mission),
  ];
  if (args.parkedIdeas && args.parkedIdeas > 0) {
    lines.push(
      `The tutor has saved ${args.parkedIdeas} ${args.parkedIdeas === 1 ? "idea" : "ideas"} for later this session.`,
    );
  }
  return { title, body: lines.join("\n") };
}

/**
 * Raise the alert if this session just entered the off-mission state. Never
 * throws: alerting must not break the analysis write that called it.
 */
export async function maybeRaiseOffMissionAlert(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<Id<"alerts"> | undefined> {
  try {
    const session = await ctx.db.get(sessionId);
    if (
      !session ||
      !session.activityId ||
      // Teacher builds ARE test drives (isTeacherBuildContext); free play
      // counts toward nothing by design; offline and seeded rows have no
      // live scholar behind them.
      session.isTestDrive ||
      session.freePlay ||
      session.isOffline ||
      session.seedExemplar ||
      session.isArchived
    ) {
      return undefined;
    }
    const [activity, unit] = await Promise.all([
      ctx.db.get(session.activityId),
      session.unitId ? ctx.db.get(session.unitId) : null,
    ]);
    // No mission, no "off": exploration sessions are never alerted.
    const mission = activity
      ? resolveSessionMission(session, activity, unit)
      : null;
    if (!activity || !mission) return undefined;
    // The activity's work is done: there is no mission left to be off.
    if (
      await scholarHasCompletedActivity(ctx, {
        scholarId: session.userId,
        activityId: activity._id,
        assignmentId: session.assignmentId ?? null,
      })
    ) {
      return undefined;
    }

    const readings = await ctx.db
      .query("analyses")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(OFF_TRACK_CONSECUTIVE_READINGS + 1);
    if (!entersOffTrack(readings)) return undefined;

    // One window per session across BOTH kinds: a session already paged under
    // the old app-only kind stays quiet until that window passes.
    const legacyKey = `${APP_OFF_TRACK_ALERT_KIND}:${sessionId}`;
    const legacy = await ctx.db
      .query("alerts")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", legacyKey))
      .collect();
    const since = Date.now() - DEDUP_WINDOW_MS;
    if (legacy.some((a) => a.createdAt >= since)) return undefined;

    // A scholar of a resolvable institution, or nobody to tell.
    const institutionId = await scholarInstitutionId(ctx, session.userId);
    if (!institutionId) return undefined;

    const scholar = await ctx.db.get(session.userId);
    const teacher = await owningTeacher(ctx, session, institutionId);
    // "Owned" session: no teacher in the scholar's school owns it → no alert.
    if (!teacher) return undefined;

    const { title, body } = buildOffMissionAlert({
      scholarName: scholar?.name ?? "A scholar",
      activityTitle: activity.title,
      observerSummary: readings[0]?.summary ?? "",
      mission: {
        gate: mission.gate,
        gateAuthored:
          mission.source === "authored" &&
          !!activity.buildContract?.gate?.trim(),
      },
      teacherSlackUserId: teacher.slackUserId,
      parkedIdeas: session.parkingLot?.length ?? 0,
    });

    return await raiseAlert(ctx, {
      kind: OFF_MISSION_ALERT_KIND,
      severity: "warning",
      source: "observer",
      audience: "institution",
      institutionId,
      title,
      body,
      scholarId: session.userId,
      sessionId,
      deepLink: withBase(siteUrl(), sessionPath(sessionId, session.userId)),
      // The fabric's default 12h window is the "once per school day" cap: a
      // session that clears and drifts again the same day stays at one post.
      dedupKey: `${OFF_MISSION_ALERT_KIND}:${sessionId}`,
    });
  } catch (err) {
    console.error("maybeRaiseOffMissionAlert failed (ignored):", err);
    return undefined;
  }
}
