import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DeviceActivityQueue,
  MAX_FLUSH_ATTEMPTS,
  MAX_QUEUED_EVENTS,
  STUCK_INACTIVE_REPEAT_MS,
  STUCK_INACTIVE_THRESHOLD_MS,
  StuckInactiveWatch,
  deviceActivityQueue,
  recordAsamTransition,
  PENDING_LAUNCH_MAX_AGE_MS,
  PRESENCE_IDLE_TIMEOUT_MS,
  recordInteraction,
  setInteractionSink,
  shouldEmitHeartbeat,
} from "../deviceActivityQueue";

const T0 = 1_760_000_000_000;

describe("DeviceActivityQueue", () => {
  test("records the ordinary foreground/background lifecycle", () => {
    const queue = new DeviceActivityQueue();
    queue.recordForeground(T0);
    queue.recordHeartbeat(T0 + 60_000);
    queue.recordBackground(T0 + 120_000);
    expect(queue.drain(10).map((e) => e.kind)).toEqual([
      "app_foreground",
      "heartbeat",
      "app_background",
    ]);
  });

  test("the first foreground after a launch is that launch's return", () => {
    const queue = new DeviceActivityQueue();
    queue.recordExternalLaunch("spike", T0);
    queue.recordBackground(T0 + 100); // iOS backgrounds us as the app takes over
    queue.recordForeground(T0 + 600_000);
    queue.recordForeground(T0 + 900_000);

    const events = queue.drain(10);
    expect(events.map((e) => e.kind)).toEqual([
      "external_launch",
      "app_background",
      "external_return",
      "app_foreground",
    ]);
    // The return carries the app id, so the server can close the interval.
    expect(events[2].externalAppId).toBe("spike");
    expect(events[3].externalAppId).toBeUndefined();
  });

  test("a stale pending launch does not capture a much later foreground", () => {
    const queue = new DeviceActivityQueue();
    queue.recordExternalLaunch("spike", T0);
    queue.recordForeground(T0 + PENDING_LAUNCH_MAX_AGE_MS + 1);
    const events = queue.drain(10);
    expect(events[1].kind).toBe("app_foreground");
    expect(events[1].externalAppId).toBeUndefined();
  });

  test("a launch with no app id is still recorded", () => {
    const queue = new DeviceActivityQueue();
    queue.recordExternalLaunch(undefined, T0);
    queue.recordForeground(T0 + 60_000);
    const events = queue.drain(10);
    expect(events.map((e) => e.kind)).toEqual([
      "external_launch",
      "external_return",
    ]);
    expect(events[0].externalAppId).toBeUndefined();
  });

  test("drain removes what it returns and leaves the rest in order", () => {
    const queue = new DeviceActivityQueue();
    for (let index = 0; index < 5; index += 1) {
      queue.recordHeartbeat(T0 + index);
    }
    expect(queue.drain(2)).toHaveLength(2);
    expect(queue.size).toBe(3);
    expect(queue.drain(10).map((e) => e.clientAt)).toEqual([
      T0 + 2,
      T0 + 3,
      T0 + 4,
    ]);
  });

  test("a failed flush is re-queued at the front, preserving order", () => {
    const queue = new DeviceActivityQueue();
    queue.recordForeground(T0);
    queue.recordHeartbeat(T0 + 60_000);
    const batch = queue.drain(10);
    queue.recordHeartbeat(T0 + 120_000);
    queue.requeueFront(batch);
    expect(queue.drain(10).map((e) => e.clientAt)).toEqual([
      T0,
      T0 + 60_000,
      T0 + 120_000,
    ]);
  });

  test("an offline afternoon drops the OLDEST events, never grows unbounded", () => {
    const queue = new DeviceActivityQueue();
    for (let index = 0; index < MAX_QUEUED_EVENTS + 50; index += 1) {
      queue.recordHeartbeat(T0 + index);
    }
    expect(queue.size).toBe(MAX_QUEUED_EVENTS);
    // The newest events survive; the first 50 were evicted.
    expect(queue.drain(1)[0].clientAt).toBe(T0 + 50);
  });

  test("re-queuing more than the ceiling also stays bounded", () => {
    const queue = new DeviceActivityQueue();
    const oversized = Array.from({ length: MAX_QUEUED_EVENTS + 10 }, (_, i) => ({
      kind: "heartbeat" as const,
      clientAt: T0 + i,
    }));
    queue.requeueFront(oversized);
    expect(queue.size).toBe(MAX_QUEUED_EVENTS);
  });
});

const HEARTBEAT_MS = 60_000;

// Models the heartbeat interval callback in useDeviceActivity: on each 60s tick
// it records a heartbeat only when shouldEmitHeartbeat allows it. `touchesAt`
// is the set of tick indices at which a human interaction lands just before the
// tick fires (advancing the presence clock to that tick's time).
function simulateHeartbeats(options: {
  ticks: number;
  isForeground?: boolean;
  touchesAt?: number[];
  initialLastInteraction?: number;
}): number {
  const { ticks, isForeground = true, touchesAt = [] } = options;
  const touchSet = new Set(touchesAt);
  let lastInteractionAt = options.initialLastInteraction ?? 0;
  let heartbeats = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const now = T0 + tick * HEARTBEAT_MS;
    if (touchSet.has(tick)) lastInteractionAt = now;
    if (shouldEmitHeartbeat(isForeground, lastInteractionAt, now)) {
      heartbeats += 1;
    }
  }
  return heartbeats;
}

describe("shouldEmitHeartbeat — presence gating", () => {
  test("foreground with NO interaction produces NO heartbeats (the regression)", () => {
    // An MDM-triggered relaunch lands the app frontmost with nobody present.
    // lastInteraction stays at its initial 0, so nothing is ever emitted.
    expect(shouldEmitHeartbeat(true, 0, T0)).toBe(false);
    expect(
      simulateHeartbeats({ ticks: 60 /* ~1 hour */, touchesAt: [] }),
    ).toBe(0);
  });

  test("a touch inside the window keeps heartbeats flowing", () => {
    // Interaction at every tick: presence never goes stale.
    const ticks = 10;
    const heartbeats = simulateHeartbeats({
      ticks,
      touchesAt: Array.from({ length: ticks }, (_, i) => i),
    });
    expect(heartbeats).toBe(ticks);
  });

  test("one touch vouches until, but not past, the idle timeout", () => {
    // A single touch at tick 0, then no further interaction. Heartbeats keep
    // flowing while the touch is still recent and stop once it goes stale.
    const withinWindow = PRESENCE_IDLE_TIMEOUT_MS; // still <= timeout
    expect(shouldEmitHeartbeat(true, T0, T0 + withinWindow)).toBe(true);
    expect(shouldEmitHeartbeat(true, T0, T0 + withinWindow + 1)).toBe(false);
  });

  test("an idle stretch past the timeout stops producing heartbeats", () => {
    // Touch once at tick 0, then go idle for a full hour. Only the ticks within
    // PRESENCE_IDLE_TIMEOUT_MS of that touch emit.
    const heartbeats = simulateHeartbeats({ ticks: 60, touchesAt: [0] });
    const expected = Math.floor(PRESENCE_IDLE_TIMEOUT_MS / HEARTBEAT_MS) + 1;
    expect(heartbeats).toBe(expected);
    expect(heartbeats).toBeLessThan(60);
  });

  test("a touch after an idle stretch resumes heartbeats", () => {
    // Touch at tick 0, go idle long enough to fall silent, then touch again at
    // tick 40 — heartbeats resume for the fresh window.
    const withoutResume = simulateHeartbeats({ ticks: 60, touchesAt: [0] });
    const withResume = simulateHeartbeats({ ticks: 60, touchesAt: [0, 40] });
    expect(withResume).toBeGreaterThan(withoutResume);
    // Confirm silence really happened at tick 39 (idle) then resumed at tick 40.
    const idleTickTime = T0 + 39 * HEARTBEAT_MS;
    const resumeTickTime = T0 + 40 * HEARTBEAT_MS;
    expect(shouldEmitHeartbeat(true, T0, idleTickTime)).toBe(false);
    expect(shouldEmitHeartbeat(true, resumeTickTime, resumeTickTime)).toBe(true);
  });

  test("backgrounded never heartbeats, even with a very recent interaction", () => {
    expect(shouldEmitHeartbeat(false, T0, T0)).toBe(false);
    expect(simulateHeartbeats({ ticks: 10, isForeground: false, touchesAt: [0, 1, 2, 3] })).toBe(0);
  });
});

describe("presence clock — recordInteraction / setInteractionSink", () => {
  afterEach(() => setInteractionSink(null));

  test("recordInteraction is a safe no-op before any sink is installed", () => {
    setInteractionSink(null);
    expect(() => recordInteraction()).not.toThrow();
  });

  test("an installed sink receives the interaction timestamp", () => {
    const seen: number[] = [];
    setInteractionSink((now) => seen.push(now));
    recordInteraction();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
  });

  test("clearing the sink stops delivery (unmount must not leak)", () => {
    const seen: number[] = [];
    setInteractionSink((now) => seen.push(now));
    recordInteraction();
    setInteractionSink(null);
    recordInteraction();
    expect(seen).toHaveLength(1);
  });
});

describe("flush failures — a refused batch cannot wedge the queue", () => {
  test("requeues until MAX_FLUSH_ATTEMPTS refusals in a row, then drops", () => {
    const queue = new DeviceActivityQueue();
    queue.recordForeground(T0);
    for (let attempt = 1; attempt < MAX_FLUSH_ATTEMPTS; attempt += 1) {
      const batch = queue.drain(10);
      expect(queue.handleFlushFailure(batch)).toBe(false);
      expect(queue.size).toBe(1);
    }
    const batch = queue.drain(10);
    queue.recordHeartbeat(T0 + 60_000); // queued behind the refused batch
    expect(queue.handleFlushFailure(batch)).toBe(true);
    // The refused event is gone; the one behind it is next in line.
    expect(queue.drain(10).map((e) => e.kind)).toEqual(["heartbeat"]);
  });

  test("sheds diagnostics first, giving usage events one more try", () => {
    const queue = new DeviceActivityQueue();
    queue.recordForeground(T0);
    queue.enqueue({ kind: "asam_exit", reason: "offline", ok: true, clientAt: T0 + 1 });
    queue.recordHeartbeat(T0 + 60_000);
    for (let attempt = 1; attempt < MAX_FLUSH_ATTEMPTS; attempt += 1) {
      expect(queue.handleFlushFailure(queue.drain(10))).toBe(false);
    }
    expect(queue.handleFlushFailure(queue.drain(10))).toBe(true);
    const usageOnly = queue.drain(10);
    expect(usageOnly.map((e) => e.kind)).toEqual(["app_foreground", "heartbeat"]);
    // Refused again as usage-only: now dropped, so the queue cannot wedge.
    expect(queue.handleFlushFailure(usageOnly)).toBe(true);
    expect(queue.size).toBe(0);
  });

  test("a success in between resets the count", () => {
    const queue = new DeviceActivityQueue();
    queue.recordForeground(T0);
    for (let attempt = 1; attempt < MAX_FLUSH_ATTEMPTS; attempt += 1) {
      queue.handleFlushFailure(queue.drain(10));
    }
    queue.handleFlushSuccess();
    expect(queue.handleFlushFailure(queue.drain(10))).toBe(false);
    expect(queue.size).toBe(1);
  });
});

describe("StuckInactiveWatch (TRA-331)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  function setUp() {
    const queue = new DeviceActivityQueue();
    const onEmit = vi.fn();
    return { queue, onEmit, watch: new StuckInactiveWatch(queue, onEmit) };
  }

  test("a short inactive blip (Control Center, app switch) reports nothing", () => {
    const { queue, onEmit, watch } = setUp();
    watch.update("inactive");
    vi.advanceTimersByTime(STUCK_INACTIVE_THRESHOLD_MS - 1);
    watch.update("active");
    vi.advanceTimersByTime(STUCK_INACTIVE_REPEAT_MS * 3);
    expect(queue.size).toBe(0);
    expect(onEmit).not.toHaveBeenCalled();
  });

  test("reports at the threshold, re-reports while stuck, then records the end", () => {
    const { queue, onEmit, watch } = setUp();
    watch.update("inactive");
    // A repeated inactive value must not restart the clock.
    vi.advanceTimersByTime(30_000);
    watch.update("inactive");
    vi.advanceTimersByTime(STUCK_INACTIVE_THRESHOLD_MS - 30_000);

    expect(queue.drain(10)).toEqual([
      {
        kind: "app_stuck_inactive",
        clientAt: T0,
        durationMs: STUCK_INACTIVE_THRESHOLD_MS,
      },
    ]);
    vi.advanceTimersByTime(STUCK_INACTIVE_REPEAT_MS - 1);
    expect(queue.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(queue.drain(10)).toEqual([
      {
        kind: "app_stuck_inactive",
        clientAt: T0,
        durationMs: STUCK_INACTIVE_THRESHOLD_MS + STUCK_INACTIVE_REPEAT_MS,
      },
    ]);

    vi.advanceTimersByTime(60_000);
    watch.update("active");
    const total = STUCK_INACTIVE_THRESHOLD_MS + STUCK_INACTIVE_REPEAT_MS + 60_000;
    expect(queue.drain(10)).toEqual([
      { kind: "app_stuck_inactive_end", clientAt: T0 + total, durationMs: total },
    ]);
    expect(onEmit).toHaveBeenCalledTimes(3);
    // Over: no more reports.
    vi.advanceTimersByTime(STUCK_INACTIVE_REPEAT_MS * 3);
    expect(queue.size).toBe(0);
  });

  test("background is not timed — iOS suspends it, so a timer there means nothing", () => {
    const { queue, watch } = setUp();
    watch.update("background");
    vi.advanceTimersByTime(STUCK_INACTIVE_REPEAT_MS * 3);
    expect(queue.size).toBe(0);

    // inactive → background (the ordinary lock/Home path) ends the stretch.
    watch.update("inactive");
    vi.advanceTimersByTime(1_000);
    watch.update("background");
    vi.advanceTimersByTime(STUCK_INACTIVE_REPEAT_MS);
    expect(queue.size).toBe(0);
  });

  test("a reported stretch that ends in background still records its end", () => {
    const { queue, watch } = setUp();
    watch.update("inactive");
    vi.advanceTimersByTime(STUCK_INACTIVE_THRESHOLD_MS);
    watch.update("background");
    expect(queue.drain(10).map((e) => e.kind)).toEqual([
      "app_stuck_inactive",
      "app_stuck_inactive_end",
    ]);
  });

  test("stop() cancels without emitting an end", () => {
    const { queue, watch } = setUp();
    watch.update("inactive");
    vi.advanceTimersByTime(STUCK_INACTIVE_THRESHOLD_MS);
    queue.drain(10);
    watch.stop();
    vi.advanceTimersByTime(STUCK_INACTIVE_REPEAT_MS * 2);
    expect(queue.size).toBe(0);
  });
});

describe("recordAsamTransition", () => {
  afterEach(() => {
    deviceActivityQueue.reset();
    vi.useRealTimers();
  });

  test("queues the lock change with its reason and result", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    recordAsamTransition("asam_exit", "offline", true);
    expect(deviceActivityQueue.drain(10)).toEqual([
      { kind: "asam_exit", reason: "offline", ok: true, clientAt: T0 },
    ]);
  });
});
