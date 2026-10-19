// The MISSION of a session (TRA-519 B1/B5/B6): what this session's one job is,
// and what steers the tutor's help. One pure derivation shared by prompt
// assembly, the park-tool offer, the off-mission alert and free play, so they
// can never disagree about which sessions have a mission.
//
// Vocabulary:
//   • A mission is the scholar-facing name for the activity's existing
//     `buildContract` { invariants, freedoms, gate }. Non-app activities carry
//     only gate + freedoms; their "must be true" items live in the deliverable's
//     criteria (lib/buildContract.ts enforces this).
//   • GATE: the first thing that has to exist before side ideas get built.
//     Authored on the activity, else DEFAULTED from the deliverable kind, else
//     (a Quest planning chat) the Quest mission's gate.
//   • Exploration has NO mission: open chat, seed explorations, discussion
//     (advanceRubric-only) activities, free play, non-online kinds.
//   • LEARN BEFORE YOU BUILD (B6): in a scholar's own Quest, an app activity is
//     locked until the nearest preceding learning step (a non-app online
//     activity with a deliverable) is complete.
import { isAppActivity } from "../../shared/appSurface";

export type MissionActivity = {
  _id?: string;
  title?: string;
  kind: string;
  appActivity?: boolean | null;
  deliverable?: { kind?: string | null } | null;
  advanceRubric?: unknown;
  buildContract?: {
    invariants: string[];
    freedoms: string[];
    gate?: string;
  } | null;
};

export type MissionSession = {
  freePlay?: boolean | null;
  activityId?: unknown;
};

export type MissionUnit = {
  authorScholarId?: unknown;
  /** "inspired" = designed by someone else for the scholar (a teacher offer). */
  authorRole?: string | null;
  mission?: { text: string; gate?: string } | null;
};

export type SessionMission = {
  source: "authored" | "default" | "quest";
  /** Always resolved: the authored gate, the kind's default, or the Quest's. */
  gate: string;
  freedoms: string[];
  /** App activities only; [] otherwise. */
  invariants: string[];
  /** The scholar's own Quest mission line, when the unit has one. */
  questLine: string | null;
  /** The session is in the scholar's own Quest (a scholar-authored unit). Its
   *  contract was written by the Quest bake, not by a teacher or the scholar,
   *  so the builder follows the scholar and offers the model rather than
   *  enforcing it (prompts.ts buildDesignerContractSteering). */
  ownQuest: boolean;
  /** B6: this session is a step of the scholar's own Quest (a learning step,
   * or the planning chat) while the Quest's build step (this title) is still
   * locked. App/game requests wait for it, with the unlock framing, and no
   * app-creating tool is offered (lib/mission.ts lockedQuestBuildTitle). */
  unlocksBuild: string | null;
  /** B6: the build step named by `unlocksBuild` is already open — the app is
   *  built there now, not here. False while it is locked. */
  buildStepOpen: boolean;
};

const DEFAULT_GATES: Record<string, string> = {
  // A COMPLETE first draft: start to finish, rough. A fragment ("a beginning
  // and a problem") opened the gate in the mission-steer smoke run and the
  // side app then took over the session (TRA-519 eval, S1).
  text: "A complete first draft of their writing exists in the document: their own words, start to finish. Rough is fine; a beginning on its own is not.",
  slides: "A first version of all their slides exists, made by them. Rough is fine; a first slide on its own is not.",
  photo: "They have taken or uploaded a first photo of their work.",
  audio: "They have made a first recording.",
  map: "Their map exists with their own first marks on it.",
  artifact: "A first version of the thing they are making exists.",
};

export const DEFAULT_APP_GATE =
  "A first working version of the app exists and has been run once.";

/** The gate an activity gets when none is authored, or null for exploration
 * (no deliverable) and non-online kinds. */
export function defaultGateFor(activity: MissionActivity): string | null {
  if (isAppActivity(activity)) return DEFAULT_APP_GATE;
  if (activity.kind !== "online") return null;
  const kind = activity.deliverable?.kind;
  if (!kind) return null;
  return DEFAULT_GATES[kind] ?? DEFAULT_GATES.artifact;
}

/** Whether the unit is a scholar's own Quest (scholar-authored). */
export function isQuestUnit(unit: MissionUnit | null | undefined): boolean {
  return !!unit?.authorScholarId;
}

/**
 * The session's mission, or null for exploration. `unlocksBuild` is supplied
 * by the caller (it needs the unit's activity order and the scholar's
 * completions — see `lockedQuestBuildTitle`); pass null when not computed.
 */
export function resolveSessionMission(
  session: MissionSession,
  activity: MissionActivity | null | undefined,
  unit: MissionUnit | null | undefined,
  opts: { unlocksBuild?: string | null; buildStepOpen?: boolean } = {},
): SessionMission | null {
  if (session.freePlay) return null;
  const questLine = isQuestUnit(unit) ? (unit?.mission?.text?.trim() || null) : null;
  if (!activity) {
    // The planning chat of the scholar's own Quest, once its mission is set.
    if (questLine && unit?.mission?.gate?.trim()) {
      return {
        source: "quest",
        gate: unit.mission.gate.trim(),
        freedoms: [],
        invariants: [],
        questLine,
        ownQuest: true,
        unlocksBuild: opts.unlocksBuild ?? null,
        buildStepOpen: opts.buildStepOpen === true,
      };
    }
    return null;
  }
  const fallback = defaultGateFor(activity);
  if (fallback == null) return null;
  const app = isAppActivity(activity);
  const contract = activity.buildContract ?? null;
  const authoredGate = contract?.gate?.trim();
  return {
    source: contract ? "authored" : "default",
    gate: authoredGate || fallback,
    freedoms: contract?.freedoms ?? [],
    invariants: app ? (contract?.invariants ?? []) : [],
    questLine,
    ownQuest: isQuestUnit(unit),
    unlocksBuild: app ? null : (opts.unlocksBuild ?? null),
    buildStepOpen: app ? false : opts.buildStepOpen === true,
  };
}

// ── B6: learn before you build ───────────────────────────────────────────

/** A learning step: a non-app online activity with a deliverable. */
export function isLearningStep(activity: MissionActivity): boolean {
  return (
    activity.kind === "online" &&
    !isAppActivity(activity) &&
    !!activity.deliverable?.kind
  );
}

/**
 * The prerequisite of a Quest build step: the nearest PRECEDING learning step
 * in unit order. `ordered` is the unit's activities in scholar-visible order
 * (lesson order, then activity order). Returns null when the target is not an
 * app activity or no learning step precedes it (nothing to learn first, so it
 * is not locked). Away-from-screen and discussion steps never block.
 */
export function questBuildPrerequisite<A extends MissionActivity & { _id: string }>(
  ordered: readonly A[],
  targetId: string,
): A | null {
  const idx = ordered.findIndex((a) => a._id === targetId);
  if (idx < 0 || !isAppActivity(ordered[idx])) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (isLearningStep(ordered[i])) return ordered[i];
  }
  return null;
}

export type QuestBuildLock = { locked: false } | { locked: true; prerequisiteId: string; prerequisiteTitle: string };

/** Lock state of one activity in a scholar's own Quest. Non-Quest units and
 * non-app activities are never locked. */
export function questBuildLock<A extends MissionActivity & { _id: string }>(
  unit: MissionUnit | null | undefined,
  ordered: readonly A[],
  targetId: string,
  isComplete: (activityId: string) => boolean,
  /** A build step the scholar already started (it has their session) stays
   *  open: the lock gates new building, never work they already have. */
  isStarted: (activityId: string) => boolean = () => false,
): QuestBuildLock {
  if (!isQuestUnit(unit)) return { locked: false };
  if (isStarted(targetId)) return { locked: false };
  const prereq = questBuildPrerequisite(ordered, targetId);
  if (!prereq || isComplete(prereq._id)) return { locked: false };
  return {
    locked: true,
    prerequisiteId: prereq._id,
    prerequisiteTitle: prereq.title ?? "the step before",
  };
}

/**
 * The title of a LOCKED build step in a scholar's own Quest (B6), for the hard
 * lock (no app-creating tool while one is locked) and the "it unlocks later"
 * framing. Returns the first locked build step AFTER `fromId` in unit order, so
 * EVERY learning step before a locked build step names it (not only its
 * nearest prerequisite); else the first locked build step anywhere (the
 * planning chat passes `fromId: null`). Null for a teacher's unit or when no
 * build step is locked. The UNLOCK condition stays `questBuildLock`'s: the
 * nearest preceding learning step is complete.
 */
export function lockedQuestBuildTitle<A extends MissionActivity & { _id: string }>(
  unit: MissionUnit | null | undefined,
  ordered: readonly A[],
  fromId: string | null,
  isComplete: (activityId: string) => boolean,
  isStarted: (activityId: string) => boolean = () => false,
): string | null {
  if (!isQuestUnit(unit)) return null;
  const from = fromId == null ? -1 : ordered.findIndex((a) => a._id === fromId);
  let earlier: string | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (!isAppActivity(a)) continue;
    if (!questBuildLock(unit, ordered, a._id, isComplete, isStarted).locked) continue;
    const title = a.title ?? "the build step";
    if (i > from) return title;
    earlier ??= title;
  }
  return earlier;
}

// ── BUILD FIRST: the scholar build kickoff ──────────────────────────────

/**
 * Whether a session opens by BUILDING the scholar's app: the scholar described
 * a specific thing to make, so their Quest starts at its build step (the
 * build-first bake) and the builder makes the first version from their words
 * instead of asking them to retype the idea. ONE rule, read by
 * `sessions.getWithMessages` (the clients' kickoff) and the stream's kickoff
 * instruction (`getSessionContext`), so the two cannot disagree. It lives here
 * beside the B6 helpers because it is B6's complement: a Quest that is ONLY
 * its build, so there is no learning step to lock it behind. A build step
 * after other steps (B6, or a B4 build-last bake) keeps the ordinary opening.
 *
 * True iff: not a test drive; the unit is the session owner's own Quest and
 * not one a teacher designed for them (`authorRole: "inspired"`); and the
 * activity is an app activity that is the Quest's ONLY activity (`ordered` is
 * the unit's activities in scholar-visible order) — the shape the build-first
 * bake produces.
 */
export function isScholarBuildKickoff<A extends MissionActivity & { _id: string }>(args: {
  isTestDrive: boolean;
  /** The session's owner. The Quest must be theirs. */
  ownerId: unknown;
  unit: MissionUnit | null | undefined;
  activity: A | null | undefined;
  ordered: readonly A[];
}): boolean {
  const { unit, activity, ordered } = args;
  if (args.isTestDrive || !isQuestUnit(unit)) return false;
  if (unit?.authorScholarId !== args.ownerId) return false;
  if (unit?.authorRole === "inspired") return false;
  if (!activity || !isAppActivity(activity)) return false;
  return ordered.length === 1 && ordered[0]._id === activity._id;
}
