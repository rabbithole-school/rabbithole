// The iPad's screen-time emitter: a small in-memory queue that every part of
// the app can push a lifecycle event onto, drained by `useDeviceActivity`.
//
// A MODULE SINGLETON on purpose. The external-app launcher
// (contexts/NativeAppLaunchContext) has to record the handoff at the exact
// instant it opens the URL scheme — inside a callback that is already juggling
// Single App Mode and a cancel latch. Threading a mutation through that path
// would put a network call on the critical section of a launch; pushing onto a
// synchronous in-memory array cannot fail, cannot await, and cannot delay the
// app switch by a frame.
//
// TELEMETRY MUST NEVER BREAK THE APP THAT EMITS IT. Nothing here throws,
// nothing here blocks, and the queue is bounded: if the iPad is offline all
// afternoon, the oldest events are dropped rather than the heap growing without
// limit. Durability across a cold start is deliberately NOT attempted in this
// first cut — losing an unsent tail is an acceptable gap in a usage report;
// writing to disk on every AppState change on a scholar's device is not an
// acceptable cost to pay for closing it.

export type DeviceActivityKind =
  | "app_foreground"
  | "app_background"
  | "heartbeat"
  | "external_launch"
  | "external_return"
  // Diagnostics for TRA-331 (an iPad frozen under Rabbithole Lock). The
  // server's usage roll-up ignores these; see StuckInactiveWatch and
  // recordAsamTransition below.
  | "app_stuck_inactive"
  | "app_stuck_inactive_end"
  | "asam_enter"
  | "asam_exit";

/** Mirrors convex/lib/deviceActivityValidators.ts asamTransitionReasonValidator. */
export type AsamTransitionReason =
  | "offline"
  | "unpaired"
  | "disarmed"
  | "system_ui_release"
  | "cold_start"
  | "back_online"
  | "armed"
  | "system_ui_restore"
  | "reassert";

export type QueuedDeviceEvent = {
  kind: DeviceActivityKind;
  /** `externalApps` row id, as a string; set on launch and its return. */
  externalAppId?: string;
  clientAt: number;
  /** app_stuck_inactive(_end): how long the app has been / was inactive. */
  durationMs?: number;
  /** asam_enter / asam_exit: why, and whether iOS accepted the request. */
  reason?: AsamTransitionReason;
  ok?: boolean;
};

/**
 * The queue ceiling. At a 60-second heartbeat this is roughly eight hours of
 * unflushed foreground time — a full school day offline — after which the
 * OLDEST events are dropped. Dropping the oldest keeps the most recent (and
 * most likely to still be flushed) history.
 */
export const MAX_QUEUED_EVENTS = 500;

/** How often the queue is drained while the app is foregrounded. */
export const DEVICE_ACTIVITY_FLUSH_INTERVAL_MS = 60_000;

/** How often a foregrounded app says "still here". Matches the server's model. */
export const DEVICE_ACTIVITY_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How long a single human interaction (a touch or keypress) keeps vouching for
 * presence. Past this, a foregrounded app is treated as UNATTENDED and stops
 * heartbeating — because on a supervised single-app-mode iPad, `AppState`
 * being "active" only means Rabbithole is frontmost, not that a scholar is
 * actually using it (an MDM-triggered relaunch lands us frontmost with the
 * screen off and nobody there).
 *
 * The number is a deliberate tension. Too SHORT and a scholar who is reading a
 * long passage or thinking without touching the screen is wrongly marked
 * absent — precisely the "walked away" false-positive the heartbeat was
 * designed to avoid. Too LONG and an unattended device keeps certifying a
 * human who is not there, which is the defect this gate closes. Twelve minutes
 * sits above any realistic no-touch reading/thinking stretch yet is far below
 * the ~50–62 minute unattended runs an automated overnight relaunch produces.
 *
 * When the timeout DOES misfire on a genuinely-present-but-still scholar, the
 * cost is bounded and honest: the missing heartbeats let the server's
 * FOREGROUND_PRESENCE_GAP_MS cap truncate the span, and the untouched minutes
 * fall into the `unattributed` bucket rather than being fabricated into a
 * `measured` foreground total. Under-counting into an explicitly-unattributed
 * bucket is the safe direction to err.
 */
export const PRESENCE_IDLE_TIMEOUT_MS = 12 * 60 * 1000;

// A module-level bridge so any interaction witness — the root view's
// capture-phase touch responder, the key-capture seam — can feed the mounted
// hook's presence clock without prop-drilling through the whole tree. The
// active hook installs a sink on mount and clears it on unmount; before it
// mounts (or after it unmounts) recordInteraction is a safe no-op.
let interactionSink: ((now: number) => void) | null = null;

/** Install (or, with null, remove) the sink the mounted hook reads. */
export function setInteractionSink(sink: ((now: number) => void) | null): void {
  interactionSink = sink;
}

/**
 * Record a real human interaction (a touch or a keypress). Deliberately the
 * ONLY thing that advances the presence clock: no lifecycle transition (mount,
 * foreground, sign-in, AppState -> "active") may call it, so an MDM-triggered
 * relaunch cannot certify that a human is present. Synchronous and
 * non-throwing — telemetry must never break the app that emits it.
 */
export function recordInteraction(): void {
  interactionSink?.(Date.now());
}

/**
 * How many times in a row one batch may be refused before it is dropped. The
 * Convex client holds a mutation (rather than rejecting it) while the socket is
 * down, so a rejection is almost always the server refusing the batch itself —
 * e.g. a newer client sending an event kind an older backend does not know.
 * Retrying that forever would wedge every later event behind it.
 */
export const MAX_FLUSH_ATTEMPTS = 3;

/** The kinds the server's screen-time roll-up is built from. */
const USAGE_KINDS: ReadonlySet<DeviceActivityKind> = new Set([
  "app_foreground",
  "app_background",
  "heartbeat",
  "external_launch",
  "external_return",
]);

/**
 * How long the app must sit in iOS's `inactive` state before it is reported
 * stuck. Ordinary `inactive` is transient (a Control Center or Notification
 * Center pull, the instant between foreground and background); TRA-331's
 * frozen iPads sat there for hours.
 */
export const STUCK_INACTIVE_THRESHOLD_MS = 2 * 60 * 1000;

/** How often a still-stuck app re-reports, so a long freeze stays visible. */
export const STUCK_INACTIVE_REPEAT_MS = 10 * 60 * 1000;

/**
 * How long after an external launch a foreground still counts as the RETURN
 * from it. Past this the scholar is simply back in Rabbithole, and pinning a
 * stale app id to it would corrupt the attribution rather than improve it.
 * Comfortably wider than the server's measurement window, so the decision of
 * what is too long to measure stays on the server where it is documented.
 */
export const PENDING_LAUNCH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export class DeviceActivityQueue {
  private events: QueuedDeviceEvent[] = [];
  private pendingLaunch: { externalAppId?: string; at: number } | null = null;
  private consecutiveFlushFailures = 0;

  /** Append one event, evicting the oldest if the queue is full. */
  enqueue(event: QueuedDeviceEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_QUEUED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_QUEUED_EVENTS);
    }
  }

  /**
   * Record the moment Rabbithole hands the iPad to a teacher-authorized app,
   * and arm the return. `externalAppId` may be absent when a call site has only
   * a URL scheme — the launch still counts; only its app attribution is lost.
   */
  recordExternalLaunch(externalAppId: string | undefined, now: number): void {
    this.pendingLaunch = { externalAppId, at: now };
    this.enqueue({ kind: "external_launch", externalAppId, clientAt: now });
  }

  /**
   * Record a foreground. The FIRST foreground after a launch is that launch's
   * `external_return` (carrying the app id, so the server can close the
   * interval); every other foreground is a plain `app_foreground`.
   */
  recordForeground(now: number): void {
    const pending = this.pendingLaunch;
    if (pending && now - pending.at <= PENDING_LAUNCH_MAX_AGE_MS) {
      this.pendingLaunch = null;
      this.enqueue({
        kind: "external_return",
        externalAppId: pending.externalAppId,
        clientAt: now,
      });
      return;
    }
    this.pendingLaunch = null;
    this.enqueue({ kind: "app_foreground", clientAt: now });
  }

  /**
   * Record a background. Does NOT clear a pending launch: backgrounding is
   * exactly what happens when the other app takes over, and the return still
   * belongs to that launch.
   */
  recordBackground(now: number): void {
    this.enqueue({ kind: "app_background", clientAt: now });
  }

  recordHeartbeat(now: number): void {
    this.enqueue({ kind: "heartbeat", clientAt: now });
  }

  /** Remove and return up to `max` events, oldest first. */
  drain(max: number): QueuedDeviceEvent[] {
    return this.events.splice(0, max);
  }

  /**
   * Put a failed flush back at the FRONT, preserving order, then re-apply the
   * ceiling. An offline iPad therefore retries the same events rather than
   * losing them, and a permanently failing flush still cannot grow the heap.
   */
  requeueFront(events: readonly QueuedDeviceEvent[]): void {
    this.events.unshift(...events);
    if (this.events.length > MAX_QUEUED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_QUEUED_EVENTS);
    }
  }

  /**
   * A flush was refused: requeue the batch for another attempt. Once it has
   * failed MAX_FLUSH_ATTEMPTS times in a row, shed the diagnostic events first
   * (the likeliest thing an older backend refuses) and give the usage events
   * one more try; a usage-only batch refused that often is dropped, so the
   * events behind it can still land. Returns true when anything was dropped.
   */
  handleFlushFailure(events: readonly QueuedDeviceEvent[]): boolean {
    this.consecutiveFlushFailures += 1;
    if (this.consecutiveFlushFailures < MAX_FLUSH_ATTEMPTS) {
      this.requeueFront(events);
      return false;
    }
    const usage = events.filter((event) => USAGE_KINDS.has(event.kind));
    if (usage.length > 0 && usage.length < events.length) {
      this.consecutiveFlushFailures = MAX_FLUSH_ATTEMPTS - 1;
      this.requeueFront(usage);
    } else {
      this.consecutiveFlushFailures = 0;
    }
    return true;
  }

  handleFlushSuccess(): void {
    this.consecutiveFlushFailures = 0;
  }

  get size(): number {
    return this.events.length;
  }

  /** Test seam only. */
  reset(): void {
    this.events = [];
    this.pendingLaunch = null;
    this.consecutiveFlushFailures = 0;
  }
}

/**
 * Reports an app that has sat in iOS's `inactive` state for minutes (TRA-331).
 * Fed every AppState value; `background` and `active` both end a stretch.
 *
 * Only `inactive` is timed. A backgrounded app is suspended by iOS, so a JS
 * timer there measures nothing — but an inactive app keeps running JS (the
 * frozen iPads refreshed an auth token mid-freeze), so a timer can witness it.
 *
 * Emits `app_stuck_inactive` once the stretch reaches
 * STUCK_INACTIVE_THRESHOLD_MS and again every STUCK_INACTIVE_REPEAT_MS while it
 * lasts — clientAt is when the stretch BEGAN, durationMs how long it has run —
 * then one `app_stuck_inactive_end` (clientAt = when it ended, durationMs =
 * total) when the app leaves `inactive`, but only for a stretch that was
 * reported. A stretch the process never leaves (killed by an MDM restart) has
 * no end event; its last report bounds it.
 */
export class StuckInactiveWatch {
  private inactiveSince: number | null = null;
  private reported = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly queue: DeviceActivityQueue,
    /** Called after each emission, so the caller can flush promptly. */
    private readonly onEmit: () => void,
  ) {}

  update(state: string): void {
    if (state === "inactive") {
      if (this.inactiveSince !== null) return;
      this.inactiveSince = Date.now();
      this.schedule(STUCK_INACTIVE_THRESHOLD_MS);
      return;
    }
    const since = this.inactiveSince;
    const reported = this.reported;
    this.stop();
    if (since !== null && reported) {
      const now = Date.now();
      this.queue.enqueue({
        kind: "app_stuck_inactive_end",
        clientAt: now,
        durationMs: now - since,
      });
      this.onEmit();
    }
  }

  /** Cancel without emitting (unmount / sign-out). */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inactiveSince = null;
    this.reported = false;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      const since = this.inactiveSince;
      if (since === null) return;
      this.reported = true;
      this.queue.enqueue({
        kind: "app_stuck_inactive",
        clientAt: since,
        durationMs: Date.now() - since,
      });
      this.onEmit();
      this.schedule(STUCK_INACTIVE_REPEAT_MS);
    }, delayMs);
  }
}

/** The app-lifetime queue every call site shares. */
export const deviceActivityQueue = new DeviceActivityQueue();

/**
 * Called by the external-app launcher at the instant of the URL-scheme open.
 * Synchronous, non-throwing, and never awaited by the launch path.
 */
export function recordExternalAppLaunch(externalAppId?: string): void {
  try {
    deviceActivityQueue.recordExternalLaunch(externalAppId, Date.now());
  } catch {
    // A telemetry failure must never abort an app switch a scholar asked for.
  }
}

/**
 * Called by the lock controller right after it asks iOS to enter or exit
 * Single App Mode (TRA-331). Synchronous and non-throwing, like the launch hook.
 */
export function recordAsamTransition(
  kind: "asam_enter" | "asam_exit",
  reason: AsamTransitionReason,
  ok: boolean,
): void {
  try {
    deviceActivityQueue.enqueue({ kind, reason, ok, clientAt: Date.now() });
  } catch {
    // Telemetry must never break the lock controller.
  }
}

/**
 * Whether a presence heartbeat should be emitted right now. Presence is
 * vouched for ONLY by recent human interaction: being foregrounded is
 * necessary but not sufficient, because a supervised iPad can be frontmost
 * with nobody present. A `lastInteractionAt` of 0 (the initial value, never
 * seeded by a lifecycle transition) therefore never heartbeats — an
 * MDM-triggered relaunch cannot self-certify a human.
 */
export function shouldEmitHeartbeat(
  isForeground: boolean,
  lastInteractionAt: number,
  now: number,
): boolean {
  if (!isForeground) return false;
  return now - lastInteractionAt <= PRESENCE_IDLE_TIMEOUT_MS;
}
