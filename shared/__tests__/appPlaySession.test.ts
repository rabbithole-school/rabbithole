import { describe, expect, test, vi } from "vitest";
import {
  APP_PLAY_ACTIVE_IDLE_MS,
  APP_PLAY_HEARTBEAT_MS,
  APP_PLAY_UNATTENDED_MS,
  activeMsFromInteractions,
  appPlayActiveMs,
  appPlayDurationMs,
  createAppPlayActivityMeter,
  createAppPlayInteractionSource,
  createAppPlayTracker,
  isUntouchedAppPlay,
  type AppPlayActivityReport,
  type AppPlayHandle,
  type AppPlayTrackerDeps,
} from "../appPlaySession";

const handle = (id: string, serverNow = 1_000): AppPlayHandle<string> => ({
  playSessionId: id,
  resumes: 0,
  serverNow,
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(overrides: Partial<AppPlayTrackerDeps<string>> = {}) {
  let tick: (() => void) | null = null;
  const calls: string[] = [];
  let nextId = 0;
  const deps: AppPlayTrackerDeps<string> = {
    start: vi.fn(async () => {
      const id = `play-${++nextId}`;
      calls.push(`start:${id}`);
      return handle(id);
    }),
    heartbeat: vi.fn(async (id: string) => {
      calls.push(`heartbeat:${id}`);
      return true;
    }),
    end: vi.fn(async (h: AppPlayHandle<string>) => {
      calls.push(`end:${h.playSessionId}`);
    }),
    setInterval: (fn) => {
      tick = fn;
      return "timer";
    },
    clearInterval: () => {
      tick = null;
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    tracker: createAppPlayTracker(deps),
    tick: () => tick?.(),
    hasTimer: () => tick !== null,
  };
}

describe("app play tracker", () => {
  test("on screen → check-ins → off screen", async () => {
    const h = harness();
    h.tracker.setActive(true);
    await flush();
    h.tick();
    h.tick();
    await flush();
    h.tracker.setActive(false);
    await flush();
    expect(h.calls).toEqual([
      "start:play-1",
      "heartbeat:play-1",
      "heartbeat:play-1",
      "end:play-1",
    ]);
    expect(h.hasTimer()).toBe(false);
  });

  test("going off screen while start() is in flight still closes the interval", async () => {
    const pending = deferred<AppPlayHandle<string> | null>();
    const h = harness({ start: () => pending.promise });
    h.tracker.setActive(true);
    h.tracker.setActive(false);
    pending.resolve(handle("play-late"));
    await flush();
    expect(h.deps.end).toHaveBeenCalledWith(handle("play-late"), expect.any(Number));
    expect(h.hasTimer()).toBe(false);
  });

  test("end() is stamped on the server's clock when it is called", async () => {
    let hostNow = 50_000;
    const h = harness({
      now: () => hostNow,
      // The server's clock runs 7 s ahead of this iPad's.
      start: async () => handle("play-1", hostNow + 7_000),
    });
    h.tracker.setActive(true);
    await flush();
    hostNow += 90_000;
    h.tracker.setActive(false);
    expect(h.deps.end).toHaveBeenCalledWith(handle("play-1", 57_000), 147_000);
  });

  test("an untracked viewer stays idle", async () => {
    const h = harness({ start: async () => null });
    h.tracker.setActive(true);
    await flush();
    expect(h.hasTimer()).toBe(false);
    h.tracker.setActive(false);
    await flush();
    expect(h.deps.end).not.toHaveBeenCalled();
  });

  test("a check-in the server closed as stale starts a fresh interval", async () => {
    const h = harness({
      heartbeat: vi.fn(async () => false),
    });
    h.tracker.setActive(true);
    await flush();
    h.tick();
    await flush();
    await flush();
    expect(h.calls).toEqual(["start:play-1", "start:play-2"]);
    expect(h.hasTimer()).toBe(true);
  });

  test("dispose ends the open interval and ignores later changes", async () => {
    const h = harness();
    h.tracker.setActive(true);
    await flush();
    h.tracker.dispose();
    h.tracker.setActive(true);
    await flush();
    expect(h.calls).toEqual(["start:play-1", "end:play-1"]);
  });

  test("a failed call is reported, not thrown", async () => {
    const onError = vi.fn();
    const h = harness({
      start: async () => {
        throw new Error("offline");
      },
      onError,
    });
    h.tracker.setActive(true);
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  test("duration runs to the explicit end, else the last check-in", () => {
    expect(
      appPlayDurationMs({ startedAt: 0, lastActiveAt: 60_000, endedAt: 90_000 }),
    ).toBe(90_000);
    expect(appPlayDurationMs({ startedAt: 0, lastActiveAt: 60_000 })).toBe(60_000);
  });
});

const MINUTE = 60_000;

describe("active time from interactions", () => {
  test("each interaction counts the next window; overlaps merge", () => {
    // With a 2-minute window, touches at 0:00, 0:30 and 5:00 in a 10-minute
    // stretch: 0:00–2:30 and 5:00–7:00 are active.
    const idle = 2 * MINUTE;
    expect(
      activeMsFromInteractions([0, 30_000, 5 * MINUTE], 0, 10 * MINUTE, idle),
    ).toBe(2.5 * MINUTE + idle);
    expect(activeMsFromInteractions([], 0, 10 * MINUTE, idle)).toBe(0);
    // A window is clipped to the end of the range.
    expect(activeMsFromInteractions([9 * MINUTE], 0, 10 * MINUTE, idle)).toBe(MINUTE);
  });

  test("the default window is the screen-time counter's ten minutes", () => {
    expect(APP_PLAY_ACTIVE_IDLE_MS).toBe(10 * MINUTE);
    expect(APP_PLAY_UNATTENDED_MS).toBe(APP_PLAY_ACTIVE_IDLE_MS);
  });

  test("the meter reports each active millisecond once, in slices", () => {
    const meter = createAppPlayActivityMeter(0, 2 * MINUTE);
    meter.note(0);
    expect(meter.take(MINUTE)).toBe(MINUTE);
    meter.note(90_000);
    // With a 2-minute window, 1:00–3:30 is active; 1:00–2:00 was not reported yet.
    expect(meter.take(2 * MINUTE)).toBe(MINUTE);
    expect(meter.take(10 * MINUTE)).toBe(1.5 * MINUTE);
    expect(meter.take(20 * MINUTE)).toBe(0);
    expect(meter.lastInteractionAt()).toBe(90_000);
  });

  test("active time never exceeds the interval it belongs to", () => {
    expect(
      appPlayActiveMs({ startedAt: 0, lastActiveAt: MINUTE, activeMs: 5 * MINUTE }),
    ).toBe(MINUTE);
    expect(appPlayActiveMs({ startedAt: 0, lastActiveAt: MINUTE })).toBe(0);
  });

  test("an interaction source fans out to its subscribers until they leave", () => {
    const source = createAppPlayInteractionSource();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    source.emit();
    unsubscribe();
    source.emit();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("app play tracker with interaction tracking", () => {
  /** A tracker on a controllable host clock, recording what it sends. */
  function tracked(overrides: Partial<AppPlayTrackerDeps<string>> = {}) {
    let hostNow = 0;
    const beats: Array<{ id: string; report?: AppPlayActivityReport }> = [];
    const ends: Array<{ id: string; endedAt: number; report?: AppPlayActivityReport }> = [];
    const h = harness({
      tracksInteraction: true,
      now: () => hostNow,
      start: vi.fn(async () => handle(`play-${beats.length + ends.length + 1}`, hostNow)),
      heartbeat: vi.fn(async (id: string, report?: AppPlayActivityReport) => {
        beats.push({ id, report });
        return true;
      }),
      end: vi.fn(async (hd: AppPlayHandle<string>, endedAt: number, report?: AppPlayActivityReport) => {
        ends.push({ id: hd.playSessionId, endedAt, report });
      }),
      ...overrides,
    });
    return {
      ...h,
      beats,
      ends,
      advance: (ms: number) => {
        hostNow += ms;
      },
      now: () => hostNow,
    };
  }

  test("a brief pause keeps the rest of the last touch's window", async () => {
    // Touch at 0:00, off screen 1:00–2:00, back on screen with no new touch.
    const h = tracked();
    h.tracker.setActive(true);
    await flush();
    h.tracker.noteInteraction();
    h.advance(MINUTE);
    h.tracker.setActive(false);
    h.advance(MINUTE);
    h.tracker.setActive(true);
    await flush();
    // The new interval still has 8 minutes of that touch's window, so it is
    // not untouched: it reports the touch and closes at touch + window.
    for (let ms = 0; ms < APP_PLAY_UNATTENDED_MS; ms += APP_PLAY_HEARTBEAT_MS) {
      h.advance(APP_PLAY_HEARTBEAT_MS);
      h.tick();
    }
    await flush();
    expect(h.ends).toHaveLength(2);
    expect(h.ends[0]).toMatchObject({ endedAt: MINUTE, report: { activeMs: MINUTE } });
    expect(h.ends[1].endedAt).toBe(APP_PLAY_ACTIVE_IDLE_MS);
    const secondActive =
      h.beats.reduce((sum, b) => sum + (b.report?.activeMs ?? 0), 0) +
      (h.ends[1].report?.activeMs ?? 0);
    // 2:00 → 10:00: the paused minute is not counted.
    expect(secondActive).toBe(APP_PLAY_ACTIVE_IDLE_MS - 2 * MINUTE);
    expect(h.beats[0].report?.lastInteractionAt).toBe(0);
  });

  test("a stale close keeps the rest of the last touch's window in the new interval", async () => {
    let alive = true;
    const h = tracked({
      heartbeat: vi.fn(async () => alive),
    });
    h.tracker.setActive(true);
    await flush();
    h.tracker.noteInteraction();
    alive = false;
    h.advance(MINUTE);
    h.tick();
    await flush();
    await flush();
    // The tracker reopened, and the new meter still carries the touch.
    expect(h.deps.start).toHaveBeenCalledTimes(2);
    alive = true;
    h.advance(MINUTE);
    h.tick();
    await flush();
    const last = (h.deps.heartbeat as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(last[1]).toEqual({ activeMs: MINUTE, lastInteractionAt: 0 });
  });

  test("a touch whose window has run out is not carried", () => {
    const meter = createAppPlayActivityMeter(20 * MINUTE, APP_PLAY_ACTIVE_IDLE_MS, 0);
    expect(meter.lastInteractionAt()).toBeNull();
    expect(meter.take(25 * MINUTE)).toBe(0);
    const carried = createAppPlayActivityMeter(5 * MINUTE, APP_PLAY_ACTIVE_IDLE_MS, 0);
    expect(carried.take(20 * MINUTE)).toBe(APP_PLAY_ACTIVE_IDLE_MS - 5 * MINUTE);
  });

  test("check-ins carry active time since the last report and the last touch", async () => {
    // A 2-minute window, so the third check-in has nothing left to report.
    const h = tracked({ activeIdleMs: 2 * MINUTE });
    h.tracker.setActive(true);
    await flush();
    h.tracker.noteInteraction();
    h.advance(APP_PLAY_HEARTBEAT_MS);
    h.tick();
    h.advance(APP_PLAY_HEARTBEAT_MS);
    h.tick();
    h.advance(APP_PLAY_HEARTBEAT_MS);
    h.tick();
    await flush();
    expect(h.beats.map((b) => b.report)).toEqual([
      { activeMs: MINUTE, lastInteractionAt: 0 },
      { activeMs: MINUTE, lastInteractionAt: 0 },
      { activeMs: 0, lastInteractionAt: 0 },
    ]);
  });

  test("becoming active is not an interaction: an untouched interval ends where it began", async () => {
    // A BunnyPad locked into Rabbithole goes "active" by itself as the folio
    // closes. Nobody touches it, so nothing is counted.
    const h = tracked();
    h.tracker.setActive(true);
    await flush();
    for (let ms = 0; ms < APP_PLAY_UNATTENDED_MS; ms += APP_PLAY_HEARTBEAT_MS) {
      h.advance(APP_PLAY_HEARTBEAT_MS);
      h.tick();
    }
    await flush();
    expect(h.ends).toEqual([
      { id: "play-1", endedAt: 0, report: { activeMs: 0 } },
    ]);
    expect(h.hasTimer()).toBe(false);
    // And it stays closed all night: no new interval without a touch.
    h.advance(6 * 60 * MINUTE);
    h.tick();
    await flush();
    expect(h.deps.start).toHaveBeenCalledTimes(1);
  });

  test("folio closed mid-game: the interval ends one window after the last touch", async () => {
    // The 7:41 PM → 2:24 AM report: play for 20 minutes, then the folio
    // closes and a Single App Mode BunnyPad keeps the app "active" all night.
    const h = tracked();
    h.tracker.setActive(true);
    await flush();
    for (let ms = 0; ms < 20 * MINUTE; ms += APP_PLAY_HEARTBEAT_MS) {
      h.tracker.noteInteraction();
      h.advance(APP_PLAY_HEARTBEAT_MS);
      h.tick();
    }
    const lastTouch = 19 * MINUTE;
    // Hours of "active" with nobody there.
    for (let ms = 0; ms < 6.75 * 60 * MINUTE; ms += APP_PLAY_HEARTBEAT_MS) {
      h.advance(APP_PLAY_HEARTBEAT_MS);
      h.tick();
    }
    await flush();
    expect(h.ends).toHaveLength(1);
    expect(h.ends[0].endedAt).toBe(lastTouch + APP_PLAY_ACTIVE_IDLE_MS);
    // Heartbeats stopped once the app went unattended.
    const lastBeatAt = (h.beats.length) * APP_PLAY_HEARTBEAT_MS;
    expect(lastBeatAt).toBeLessThan(lastTouch + APP_PLAY_UNATTENDED_MS);
    const reported =
      h.beats.reduce((sum, b) => sum + (b.report?.activeMs ?? 0), 0) +
      (h.ends[0].report?.activeMs ?? 0);
    expect(reported).toBe(lastTouch + APP_PLAY_ACTIVE_IDLE_MS);
  });

  test("the next touch after an unattended close opens a new interval", async () => {
    const h = tracked();
    h.tracker.setActive(true);
    await flush();
    h.tracker.noteInteraction();
    for (let ms = 0; ms < APP_PLAY_UNATTENDED_MS; ms += APP_PLAY_HEARTBEAT_MS) {
      h.advance(APP_PLAY_HEARTBEAT_MS);
      h.tick();
    }
    await flush();
    expect(h.ends).toHaveLength(1);
    h.advance(60 * MINUTE);
    h.tracker.noteInteraction();
    await flush();
    expect(h.deps.start).toHaveBeenCalledTimes(2);
    expect(h.hasTimer()).toBe(true);
  });

  test("leaving the screen ends at now with the unreported active time", async () => {
    const h = tracked();
    h.tracker.setActive(true);
    await flush();
    h.advance(30_000);
    h.tracker.noteInteraction();
    h.advance(30_000);
    h.tracker.setActive(false);
    expect(h.ends).toEqual([
      {
        id: "play-1",
        endedAt: MINUTE,
        report: { activeMs: 30_000, lastInteractionAt: 30_000 },
      },
    ]);
  });

  test("interactions while off screen are ignored", async () => {
    const h = tracked();
    h.tracker.noteInteraction();
    await flush();
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  test("a host without interaction tracking sends no reports", async () => {
    const h = harness();
    h.tracker.setActive(true);
    await flush();
    h.tracker.noteInteraction();
    h.tick();
    await flush();
    expect(h.deps.heartbeat).toHaveBeenCalledWith("play-1");
  });
});

describe("untouched app play", () => {
  const base = { lastActiveAt: 1_000, interactionTracked: true as const };
  test("closed, or stale when a clock is given; never an older host's row", () => {
    expect(isUntouchedAppPlay({ ...base, endedAt: 1_000 })).toBe(true);
    expect(isUntouchedAppPlay(base)).toBe(false);
    expect(isUntouchedAppPlay(base, 1_000 + 60_000)).toBe(false);
    expect(isUntouchedAppPlay(base, 1_000 + 60 * 60_000)).toBe(true);
    expect(
      isUntouchedAppPlay({ ...base, endedAt: 1_000, lastInteractionAt: 500 }),
    ).toBe(false);
    expect(isUntouchedAppPlay({ lastActiveAt: 1_000, endedAt: 1_000 })).toBe(false);
  });
});
