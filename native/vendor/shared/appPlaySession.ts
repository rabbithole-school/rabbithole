// Play history for a scholar's own app (a session `code` artifact): one row
// per continuous on-screen interval, recorded by the Rabbithole host around
// the app (web CodeArtifactViewer, native CodeArtifactWebView) so it works
// whether or not the app ever saves state. Server half: convex/appPlaySessions.ts.
//
// This file holds the timing policy both halves share, plus the host-side
// tracker. It is pure (timers and mutations are injected) so web and native
// drive the same lifecycle and one test covers both. Native reads it through
// native/vendor/ — re-run `node native/scripts/sync-vendor.js` after editing.

/** How often a host checks in while the app is on screen. */
export const APP_PLAY_HEARTBEAT_MS = 60_000;

/** A check-in this long after the previous one means the host went quiet
 *  (backgrounded, killed, asleep, offline). The row is closed at its LAST
 *  check-in — the silence is never counted as play — and the host starts a
 *  fresh interval. Three missed check-ins plus jitter. */
export const APP_PLAY_STALE_GAP_MS = 3 * APP_PLAY_HEARTBEAT_MS + 30_000;

/** A start() this soon after the same app's previous interval ended reopens
 *  that interval instead of minting a new one, so a remount, an Edit → Play
 *  toggle, or a quick app switch reads as one sitting. */
export const APP_PLAY_RESUME_GAP_MS = 30_000;

/** Check-ins closer together than this are a no-op on the server. */
export const APP_PLAY_MIN_HEARTBEAT_INTERVAL_MS = 20_000;

/** Rows older than this are pruned a few at a time on start(). */
export const APP_PLAY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// ── Interaction: on screen is not the same as in use ─────────────────────
//
// "In the foreground" is a weak signal on a BunnyPad. Locked into Rabbithole
// (Single App Mode), iPadOS bounces the app background → active as the screen
// locks and wakes it early each morning (mdm/README.md, "display policy"), so
// a host gated only on AppState kept checking in with the folio closed. A
// touch, key press, or scroll in the app cannot happen on a sleeping iPad, so
// hosts that can see them (`tracksInteraction`) report them, the server keeps
// active time beside on-screen time, and the interval ends once nobody has
// touched it for a while.

/** A touch, key press, pointer press, or scroll counts the next this-many ms
 *  as active use. Ten minutes, the same rule the BunnyPad screen-time counter
 *  uses (PRESENCE_IDLE_TIMEOUT_MS in native/src/lib/deviceActivityQueue.ts),
 *  so "time in their own app" and "time on Rabbithole" never disagree about
 *  the same minute. It covers reading a screen or watching something in the
 *  app, and matches the 10 minutes a BunnyPad in Rabbithole Lock stays awake
 *  after a touch (ASAM_AWAKE_WINDOW_MS, PR #4818). */
export const APP_PLAY_ACTIVE_IDLE_MS = 10 * 60_000;

/** With no interaction for this long, an interaction-tracking host ends the
 *  interval at its last interaction + APP_PLAY_ACTIVE_IDLE_MS (an interval
 *  that was never touched ends where it started) and opens a new one only on
 *  the next interaction. Equal to APP_PLAY_ACTIVE_IDLE_MS, so an interval ends
 *  exactly when its last touch stops vouching for it. */
export const APP_PLAY_UNATTENDED_MS = 10 * 60_000;

/** What an interaction-tracking host adds to a check-in or end(): the active
 *  ms since its previous report, and its last interaction on the server's
 *  clock. The server clamps both to what the interval's own times allow. */
export type AppPlayActivityReport = {
  activeMs: number;
  lastInteractionAt?: number;
};

/**
 * Active time from interaction timestamps, reported in slices: each
 * interaction makes [t, t + idleMs) active, overlapping windows merge, and
 * `take(until)` returns the active ms between the previous take and `until`
 * (so no millisecond is reported twice). Pure; the tracker owns one per
 * interval.
 */
export type AppPlayActivityMeter = {
  note: (at: number) => void;
  take: (until: number) => number;
  lastInteractionAt: () => number | null;
  /** When the meter began (the interval's open request), host clock. */
  startedAt: number;
};

export function createAppPlayActivityMeter(
  startedAt: number,
  idleMs: number = APP_PLAY_ACTIVE_IDLE_MS,
  /** An interaction from before this meter whose window is still open (the
   *  host paused briefly, or the server closed the last interval as stale).
   *  Its remaining window counts here, from `startedAt` on. */
  carriedInteractionAt?: number,
): AppPlayActivityMeter {
  const windows: { start: number; end: number }[] = [];
  let cursor = startedAt;
  let last: number | null = null;
  if (
    carriedInteractionAt !== undefined &&
    carriedInteractionAt + idleMs > startedAt
  ) {
    windows.push({ start: startedAt, end: carriedInteractionAt + idleMs });
    last = carriedInteractionAt;
  }
  return {
    startedAt,
    note(at) {
      const t = Math.max(at, cursor);
      last = last === null ? t : Math.max(last, t);
      const tail = windows[windows.length - 1];
      if (tail && t <= tail.end) tail.end = Math.max(tail.end, t + idleMs);
      else windows.push({ start: t, end: t + idleMs });
    },
    take(until) {
      if (until <= cursor) return 0;
      let total = 0;
      for (const w of windows) {
        total += Math.max(0, Math.min(w.end, until) - Math.max(w.start, cursor));
      }
      while (windows.length > 0 && windows[0].end <= until) windows.shift();
      cursor = until;
      return total;
    },
    lastInteractionAt: () => last,
  };
}

/** Where a host's interactions come from (the app frame's activity pings,
 *  touches on the host view). Hosts create one, wire their sources to
 *  `emit`, and hand it to the play-session hook, which subscribes. */
export type AppPlayInteractionSource = {
  emit: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createAppPlayInteractionSource(): AppPlayInteractionSource {
  const listeners = new Set<() => void>();
  return {
    emit: () => listeners.forEach((listener) => listener()),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Active ms in [from, to) for a set of interaction times — the meter's rule
 *  in one call, for tests and server-side reasoning. */
export function activeMsFromInteractions(
  interactions: readonly number[],
  from: number,
  to: number,
  idleMs: number = APP_PLAY_ACTIVE_IDLE_MS,
): number {
  const meter = createAppPlayActivityMeter(from, idleMs);
  for (const at of [...interactions].sort((a, b) => a - b)) {
    if (at < to) meter.note(at);
  }
  return meter.take(to);
}

export type AppPlaySurface = "web" | "native";

/** The minutes an interval was on screen: start → last check-in (or its
 *  explicit end). Never "now": an open row is only as long as its last proof. */
export function appPlayDurationMs(row: {
  startedAt: number;
  lastActiveAt: number;
  endedAt?: number | null;
}): number {
  return Math.max(0, (row.endedAt ?? row.lastActiveAt) - row.startedAt);
}

/** The active part of an interaction-tracked interval: never more than its
 *  on-screen length. Callers check `interactionTracked` first; 0 otherwise. */
export function appPlayActiveMs(row: {
  startedAt: number;
  lastActiveAt: number;
  endedAt?: number | null;
  activeMs?: number | null;
}): number {
  return Math.min(appPlayDurationMs(row), Math.max(0, row.activeMs ?? 0));
}

/** An interaction-tracked interval nobody touched: the app came to the
 *  foreground on its own (a locked BunnyPad does this as it locks and at
 *  its early-morning wake). Not a sitting, so readers skip it. An open one
 *  counts as untouched only once it has gone stale; with no `now`, only a
 *  closed one does (reactive queries that must not read the clock). */
export function isUntouchedAppPlay(
  row: {
    interactionTracked?: true;
    lastInteractionAt?: number;
    endedAt?: number;
    lastActiveAt: number;
  },
  now?: number,
): boolean {
  if (row.interactionTracked !== true || row.lastInteractionAt !== undefined) {
    return false;
  }
  if (row.endedAt !== undefined) return true;
  return now !== undefined && now - row.lastActiveAt > APP_PLAY_STALE_GAP_MS;
}

/** How many newest rows a "latest play" read looks through for one that
 *  was not an untouched foreground bounce. Nights of a locked BunnyPad
 *  bouncing fit well inside it. */
export const LATEST_APP_PLAY_SCAN = 50;

/** The newest row of `rows` (newest first) that is real play — skipping
 *  closed untouched rows (isUntouchedAppPlay, no clock) — within
 *  LATEST_APP_PLAY_SCAN rows; null if none. */
export async function firstPlayedRow<
  Row extends Parameters<typeof isUntouchedAppPlay>[0],
>(rows: AsyncIterable<Row>): Promise<Row | null> {
  let scanned = 0;
  for await (const row of rows) {
    if (!isUntouchedAppPlay(row)) return row;
    if (++scanned >= LATEST_APP_PLAY_SCAN) break;
  }
  return null;
}

/** What start() hands a host: the interval, the reopen count that `end()`
 *  must echo (so an end from a superseded start cannot close an interval a
 *  newer start reopened), and the server clock for `end()`'s timestamp. */
export type AppPlayHandle<Id> = { playSessionId: Id; resumes: number; serverNow: number };

export type AppPlayTrackerDeps<Id> = {
  /** Resolves null when this viewer is not tracked (not the owner, a test
   *  drive, an archived app): the tracker then stays idle until the app is
   *  shown again. */
  start: () => Promise<AppPlayHandle<Id> | null>;
  /** Resolves false when the server closed the interval as stale. `report`
   *  is passed only when `tracksInteraction` is set. */
  heartbeat: (
    playSessionId: Id,
    report?: AppPlayActivityReport,
  ) => Promise<boolean>;
  /** `endedAt` is when the app left the screen, on the server's clock. It is
   *  computed when end() is CALLED, so a call queued while iOS suspended the
   *  app still reports the moment it went to the background. `report` is
   *  passed only when `tracksInteraction` is set. */
  end: (
    handle: AppPlayHandle<Id>,
    endedAt: number,
    report?: AppPlayActivityReport,
  ) => Promise<unknown>;
  /** The host forwards interactions through `noteInteraction()` (and tells
   *  the server so in its start() call). Without it the tracker behaves as
   *  before: on screen while active, no active time. */
  tracksInteraction?: boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now?: () => number;
  onError?: (error: unknown) => void;
  heartbeatMs?: number;
  /** Overrides for tests. */
  activeIdleMs?: number;
  unattendedMs?: number;
};

export type AppPlayTracker = {
  /** True while the app is on screen and the host is in the foreground. */
  setActive: (active: boolean) => void;
  /** A touch, key press, pointer press, or scroll in the app. Ignored unless
   *  the tracker was built with `tracksInteraction`. */
  noteInteraction: () => void;
  dispose: () => void;
};

/**
 * Drives start → heartbeat → end for one app on one host. Every async result
 * is checked against a generation counter, so an end() that lands while a
 * start() is still in flight closes the interval that start() opens rather
 * than leaving it to go stale.
 *
 * With `tracksInteraction`, each interval also meters active time from
 * `noteInteraction()` and ends itself once unattended for
 * APP_PLAY_UNATTENDED_MS — closed at the last interaction plus the active
 * window, not at the moment the tracker noticed — then waits for the next
 * interaction before opening another. Being made active is not an
 * interaction: a locked iPad in Single App Mode does that on its own.
 */
export function createAppPlayTracker<Id>(
  deps: AppPlayTrackerDeps<Id>,
): AppPlayTracker {
  const heartbeatMs = deps.heartbeatMs ?? APP_PLAY_HEARTBEAT_MS;
  const activeIdleMs = deps.activeIdleMs ?? APP_PLAY_ACTIVE_IDLE_MS;
  const unattendedMs = deps.unattendedMs ?? APP_PLAY_UNATTENDED_MS;
  const tracking = deps.tracksInteraction === true;
  const clock = deps.now ?? Date.now;
  const report = (error: unknown) => deps.onError?.(error);
  let active = false;
  let disposed = false;
  let generation = 0;
  let current: AppPlayHandle<Id> | null = null;
  // Server clock minus host clock, measured on the latest start() reply.
  let clockOffset = 0;
  let timer: unknown = null;
  // Interaction tracking: the open interval's meter, and whether the tracker
  // closed the last interval as unattended and is waiting for a touch.
  let meter: AppPlayActivityMeter | null = null;
  let unattended = false;
  // The latest interaction across intervals, so a new interval opened while
  // its window is still running (after a brief pause or a stale close) keeps
  // the rest of that window instead of reading as untouched.
  let lastTouch: number | null = null;

  const stopTimer = () => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };
  const activityReport = (
    m: AppPlayActivityMeter,
    until: number,
  ): AppPlayActivityReport => {
    const last = m.lastInteractionAt();
    return {
      activeMs: m.take(until),
      ...(last !== null ? { lastInteractionAt: last + clockOffset } : {}),
    };
  };
  const endAt = (
    handle: AppPlayHandle<Id>,
    at: number,
    m: AppPlayActivityMeter | null,
  ) => {
    const ended =
      tracking && m !== null
        ? deps.end(handle, at + clockOffset, activityReport(m, at))
        : deps.end(handle, at + clockOffset);
    void ended.catch(report);
  };
  /** When an unattended interval ends: its last interaction plus the active
   *  window, or where it began if nobody touched it. */
  const unattendedEnd = (m: AppPlayActivityMeter) => {
    const last = m.lastInteractionAt();
    return last === null ? m.startedAt : last + activeIdleMs;
  };
  const isUnattended = (m: AppPlayActivityMeter, at: number) =>
    at - (m.lastInteractionAt() ?? m.startedAt) >= unattendedMs;

  const closeUnattended = () => {
    const m = meter;
    generation++;
    stopTimer();
    const handle = current;
    current = null;
    meter = null;
    unattended = true;
    if (handle !== null && m !== null) endAt(handle, unattendedEnd(m), m);
  };

  const begin = () => {
    const myGeneration = ++generation;
    const myMeter = tracking
      ? createAppPlayActivityMeter(clock(), activeIdleMs, lastTouch ?? undefined)
      : null;
    meter = myMeter;
    unattended = false;
    void deps.start().then(
      (handle) => {
        if (handle == null) return;
        clockOffset = handle.serverNow - clock();
        if (myGeneration !== generation || !active || disposed) {
          endAt(handle, clock(), myMeter);
          return;
        }
        current = handle;
        stopTimer();
        timer = deps.setInterval(() => {
          const beat = current;
          if (beat == null) return;
          const now = clock();
          if (tracking && meter !== null && isUnattended(meter, now)) {
            closeUnattended();
            return;
          }
          const sent =
            tracking && meter !== null
              ? deps.heartbeat(beat.playSessionId, activityReport(meter, now))
              : deps.heartbeat(beat.playSessionId);
          void sent.then((alive) => {
            if (alive || current !== beat || !active || disposed) return;
            current = null;
            stopTimer();
            if (tracking && meter !== null && isUnattended(meter, clock())) {
              meter = null;
              unattended = true;
              return;
            }
            begin();
          }, report);
        }, heartbeatMs);
      },
      report,
    );
  };

  const finish = () => {
    generation++;
    stopTimer();
    const handle = current;
    const m = meter;
    current = null;
    meter = null;
    unattended = false;
    if (handle !== null) endAt(handle, clock(), m);
  };

  return {
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (active) begin();
      else finish();
    },
    noteInteraction() {
      if (!tracking || disposed || !active) return;
      const at = clock();
      lastTouch = at;
      if (unattended) begin();
      meter?.note(at);
    },
    dispose() {
      if (disposed) return;
      active = false;
      finish();
      disposed = true;
    },
  };
}
