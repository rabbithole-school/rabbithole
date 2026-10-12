/**
 * Workshop mode (Edit | Play) — the single screen-mode axis for the App
 * designer surface (review/teacher-build-flow.html §2/§4). Framework-free so
 * the web Workshop and its unit tests share one source of truth; the native
 * twin (PR 3) reuses the same derivation.
 *
 * Edit talks to the designer and versions the app; Play runs the app and talks
 * to the tutor. The mode is URL-persisted (a `?mode=` search param) so a reload
 * keeps the teacher/scholar where they were.
 */

export type WorkshopMode = "edit" | "play";

/** The search param that persists the mode across a reload. */
export const WORKSHOP_MODE_PARAM = "mode";

/**
 * Per-activity edit policy. The field itself lands in PR 4
 * (`activities.editAccess`); PR 2 only wires the rendering it gates, so callers
 * pass `"always"` today. "never" hides the Edit segment entirely (Play is the
 * only mode); "afterCompletion" locks Edit until the scholar finishes.
 */
export type EditAccess = "always" | "never" | "afterCompletion";

/**
 * The SERVER's verdict on Edit for the current viewer of one session
 * (`sessions.getWithMessages` → `effectiveEditAccess`), derived from the
 * activity's `editAccess`, the caller's role, and the scholar's completion:
 *  - `allowed`: both segments live;
 *  - `locked`: the Edit segment is disabled with a lock icon + tooltip
 *    (`afterCompletion` before the completion row exists);
 *  - `hidden`: no Edit | Play control at all — Play is the only state.
 * Clients render this; they never re-derive the policy.
 */
export type EffectiveEditAccess = "allowed" | "locked" | "hidden";

/** Which chat thread a mode talks to: Edit → the designer, Play → the tutor. */
export type WorkshopThread = "designer" | "tutor";

export function threadForMode(mode: WorkshopMode): WorkshopThread {
  return mode === "play" ? "tutor" : "designer";
}

/**
 * The thread a stored message belongs to. `thread` is stamped server-side per
 * turn; a message without one predates the field, and every such vibecode turn
 * was a designer turn (there was no Play then), so absent reads as "designer".
 */
export function messageThread(message: {
  thread?: WorkshopThread | null;
}): WorkshopThread {
  return message.thread ?? "designer";
}

/**
 * Whether a stored turn should show in the chat for the given screen mode. A
 * turn is hidden ONLY when it is EXPLICITLY stamped with the other thread
 * (designer turns never show in Play; tutor turns never show in Edit). An
 * unstamped legacy turn (pre-`thread`) stays visible in BOTH modes — this is
 * deliberately more permissive than `messageThread`'s designer default: if a
 * teacher flips a live activity to `never` after PR 4, pinning the scholar to
 * Play, that scholar's earlier unstamped turns must NOT vanish from their view
 * (native never filtered them out; this keeps web consistent).
 */
export function messageVisibleInMode(
  message: { thread?: WorkshopThread | null },
  mode: WorkshopMode,
): boolean {
  const stamped = message.thread ?? null;
  return stamped === null || stamped === threadForMode(mode);
}

/**
 * The mode a turn actually runs in: the client's `mode` is a REQUEST, clamped
 * by the server's verdict. Only `allowed` honors an Edit request; a locked or
 * hidden Edit runs the turn as Play (tutor thread, no code tools, no version).
 */
export function effectiveWorkshopMode(
  requested: WorkshopMode,
  access: EffectiveEditAccess,
): WorkshopMode {
  return requested === "edit" && access === "allowed" ? "edit" : "play";
}

export type WorkshopModeSession = {
  /** A teacher build hand-off (`getWithMessages` → `teacherBuildKickoff`). */
  teacherBuildKickoff?: boolean;
  /** The session's activity carries an `appRequest` (a coached app). */
  hasAppRequest?: boolean;
  /**
   * The SERVER's opening mode for this caller (`getWithMessages` →
   * `defaultWorkshopMode`, `workshopOpeningFor` in convex/lib/workshopPolicy).
   * A server "play" wins: a teacher rehearsing an app scholars only play opens
   * where the scholar does (TRA-477).
   */
  serverDefault?: WorkshopMode | null;
};

/**
 * The default mode for a fresh session, before any `?mode=` override:
 *  - the server said Play (`serverDefault`) → Play;
 *  - a teacher build session (`teacherBuildKickoff`) opens in Edit — the build
 *    is already running and the teacher is shaping the app;
 *  - a scholar coached session (an `appRequest` app they did not build) opens
 *    in Play — they use the app with the tutor;
 *  - a scholar vibecode / blank session opens in Edit — building is the point.
 */
export function defaultWorkshopMode(session: WorkshopModeSession): WorkshopMode {
  if (session.serverDefault === "play") return "play";
  if (session.teacherBuildKickoff) return "edit";
  if (session.hasAppRequest) return "play";
  return "edit";
}

/**
 * Project the server's verdict onto the two rendering booleans the Workshop
 * uses: whether the Edit | Play control renders at all, and whether the Edit
 * segment is live (vs. the locked lock-icon segment).
 */
export function editControlFor(access: EffectiveEditAccess): {
  showControl: boolean;
  editUnlocked: boolean;
} {
  return {
    showControl: access !== "hidden",
    editUnlocked: access === "allowed",
  };
}

/**
 * Resolve the live mode from the URL param and the derived default, clamped by
 * whether Edit is available. An `edit` request with Edit unavailable falls back
 * to Play — the honest state when the segment is locked or absent.
 */
export function resolveWorkshopMode({
  param,
  fallback,
  editSelectable = true,
}: {
  param: string | null | undefined;
  fallback: WorkshopMode;
  editSelectable?: boolean;
}): WorkshopMode {
  const requested: WorkshopMode =
    param === "edit" || param === "play" ? param : fallback;
  if (requested === "edit" && !editSelectable) return "play";
  return requested;
}

/**
 * Switching to Play makes the code viewer read-only (no `onSave`), so a pending
 * Edit draft must first be persisted through the still-live Edit save. Flush,
 * and only enter Play when it succeeds. If the flush rejects — typically an
 * unresolved "changed somewhere else" conflict or a network failure — STAY in
 * Edit and surface the error: flipping to Play would let the read-only viewer
 * silently drop the teacher's unsaved edit. Framework-free so the branch is
 * unit-testable without the client-only Workshop.
 */
export async function switchToPlayMode({
  flush,
  setPlay,
  onFlushError,
}: {
  /** Persist any pending Edit draft (`flushAllArtifactSaves`). */
  flush: () => Promise<void>;
  /** Commit the mode to Play — called ONLY after a successful flush. */
  setPlay: () => void;
  /** Surface a failed flush; the mode is left in Edit. */
  onFlushError: (error: unknown) => void;
}): Promise<void> {
  try {
    await flush();
  } catch (error) {
    onFlushError(error);
    return;
  }
  setPlay();
}

/**
 * The saved-at readout in the Edit bar. `null` before the first autosave reads
 * "not saved yet"; a save under a minute old reads "Saved just now"; older
 * saves read "Saved 2:14 pm" (lowercase meridiem, no leading zero on the hour).
 * Formatted by hand so the output is deterministic across locales/timezones —
 * `now` and `savedAt` are already local wall-clock milliseconds.
 */
export function formatSavedAt(
  savedAt: number | null | undefined,
  now: number,
): string {
  if (savedAt == null) return "not saved yet";
  if (now - savedAt < 60_000) return "Saved just now";
  return `Saved ${formatClockTime(savedAt)}`;
}

/**
 * The App designer's one clock: `h:mm am/pm` from local wall-clock
 * milliseconds, no leading zero on the hour, lowercase meridiem. The saved-at
 * readout and every History row (web panel, native sheet) print this same
 * string, so a revision's time and the bar's time can never disagree by
 * format. Hand-formatted so it is deterministic across locales and runtimes.
 */
export function formatClockTime(ms: number): string {
  const date = new Date(ms);
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const meridiem = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const mm = minutes < 10 ? `0${minutes}` : String(minutes);
  return `${hours}:${mm} ${meridiem}`;
}

/**
 * What a viewer's Play surface carries beyond the app itself (TRA-477). A
 * scholar who only PLAYS an app (Edit hidden or locked: a Play-only or starter
 * app) gets the app and nothing else: no "Reset app state" (it wipes their
 * saved progress in an app they cannot rebuild) and no viewer chrome (the lone
 * Preview pill and the language label are builder furniture). Staff keep both,
 * since a teacher rehearsing wants a clean slate on demand, and so does a
 * scholar with Edit live, since the app is their own build.
 *
 * Reset also needs the session's owner: `appStates.clearSessionState` is
 * owner-gated, so anyone else would only see an error toast (TRA-317).
 */
export function playSurfaceFor({
  mode,
  access,
  isStaff,
  isSessionOwner,
}: {
  mode: WorkshopMode;
  access: EffectiveEditAccess;
  isStaff: boolean;
  isSessionOwner: boolean;
}): { showResetAppState: boolean; showViewerChrome: boolean } {
  const buildsThisApp = isStaff || access === "allowed";
  return {
    showResetAppState: mode === "play" && isSessionOwner && buildsThisApp,
    showViewerChrome: mode === "edit" || buildsThisApp,
  };
}

/**
 * An app scholars only play: the activity has a starter app and its edit
 * policy is "never". Rehearsal copy for such an activity talks about playing
 * the app, never about building one.
 */
export function isPlayOnlyApp(activity: {
  editAccess?: EditAccess | null;
  hasStarter: boolean;
}): boolean {
  return activity.hasStarter && activity.editAccess === "never";
}
