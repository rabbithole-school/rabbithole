import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The launch COMMIT invariant, pinned at the only layer that can break it.
 *
 * `runAppReadyGate` is pure and has no ASAM handle, so it structurally cannot
 * release Single App Mode. The other half lives here: the cold-path sheet's
 * Cancel bumps the launch generation, and every post-release path bails early
 * on `isStale()` — skipping the ASAM restore. A Cancel that lands after the
 * release therefore strands the iPad unlocked with nothing opened. That was the
 * round-one blocker on this feature (#3321).
 *
 * Note what this file does NOT assert, and why. "Sheet dismissed before the
 * release" is unassertable as a render ORDER: `setReadyUi(null)` only queues an
 * unmount, and React is free to commit it after the synchronous release — so a
 * correct implementation and a broken one produce the same render timeline.
 * The mechanism is a LATCH instead (`committedGenRef` in the provider), and the
 * tests below hit it directly: they fire a Cancel at the exact moment of the
 * release and assert the launch is unaffected. Delete the latch and they fail.
 *
 * The gate's own warm/cold/cancel/timeout behavior is covered as pure logic in
 * lib/asam/__tests__/appUnlockGate.test.ts.
 */

// react-test-renderer only flushes state updates from inside `act(...)` when it
// knows it is in an act environment; without this the sheet's mount/unmount
// never renders and the timeline this whole file asserts on would be empty.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const h = vi.hoisted(() => ({
  timeline: [] as string[],
  canOpenURL: vi.fn<(scheme: string) => Promise<boolean>>(),
  openURL: vi.fn<(scheme: string) => Promise<boolean>>(),
  alert: vi.fn(),
  releaseForSystemUI: vi.fn(),
  restoreAfterSystemUI: vi.fn(),
  nudgeDeviceAppProjection: vi.fn<() => Promise<boolean>>(),
  readManagedSerial: vi.fn<() => string | null>(),
  /** The sheet's Cancel handler — stable, and live whenever the sheet is up. */
  cancel: null as null | (() => void),
  /** Whether the sheet is currently rendered, and for which app. */
  sheetMounted: false,
  sheetApp: null as string | null,
  /** Fired from inside releaseForSystemUI, to simulate a tap landing there. */
  onRelease: null as null | (() => void),
  /** The app's lifecycle state, and the provider's AppState listeners. */
  appState: "active" as string,
  appStateListeners: [] as Array<(next: string) => void>,
}));

vi.mock("react-native", () => ({
  Alert: { alert: h.alert },
  AppState: {
    get currentState() {
      return h.appState;
    },
    addEventListener: (_event: string, listener: (next: string) => void) => {
      h.appStateListeners.push(listener);
      return {
        remove: () => {
          h.appStateListeners = h.appStateListeners.filter((l) => l !== listener);
        },
      };
    },
  },
  Linking: {
    canOpenURL: (scheme: string) => h.canOpenURL(scheme),
    openURL: (scheme: string) => {
      h.timeline.push("openURL");
      return h.openURL(scheme);
    },
  },
}));

vi.mock("convex/react", () => ({ useConvex: () => ({ mutation: vi.fn() }) }));

vi.mock("@/contexts/AsamControllerContext", () => ({
  usePresentationAsam: () => ({
    releaseForSystemUI: () => {
      h.timeline.push("release");
      h.releaseForSystemUI();
      // A tap landing at the exact instant of the release — the race the latch
      // exists for. Real React can still have the old sheet on screen here.
      h.onRelease?.();
    },
    restoreAfterSystemUI: h.restoreAfterSystemUI,
  }),
}));

vi.mock("@/lib/appUnlockClient", () => ({
  nudgeDeviceAppProjection: () => h.nudgeDeviceAppProjection(),
}));
vi.mock("@/lib/deviceIdentity", () => ({
  getStableDeviceId: async () => "device-uuid",
}));
vi.mock("@/lib/managedClaim", () => ({
  readManagedSerial: () => h.readManagedSerial(),
}));
vi.mock("@/lib/singleAppMode", () => ({
  isSingleAppModeActive: () => false,
  exitSingleAppMode: async () => true,
}));

// Stand-in for the sheet: records every render, tracks whether it is currently
// mounted and for which app, and captures the Cancel handler — the thing the
// invariant is about. The handler is captured on EVERY render, mounted or not,
// because it is a stable useCallback and a real late tap would invoke exactly
// that function.

vi.mock("@/components/AppUnlockingOverlay", () => ({
  AppUnlockingOverlay: (props: {
    app: { name: string } | null;
    onCancel: () => void;
  }) => {
    h.timeline.push(props.app ? "sheet:open" : "sheet:closed");
    h.sheetMounted = props.app !== null;
    h.sheetApp = props.app?.name ?? null;
    h.cancel = props.onCancel;
    return null;
  },
}));

import {
  NativeAppLaunchProvider,
  useNativeAppLauncher,
  type LaunchNativeApp,
} from "@/contexts/NativeAppLaunchContext";

const SHEETS = "googlesheets://";
/** A tile whose scheme the projection never mediates. */
const UNMANAGED = "readingapp://";

function Probe({ onReady }: { onReady: (launch: LaunchNativeApp) => void }) {
  onReady(useNativeAppLauncher());
  return null;
}

let lastRenderer: ReturnType<typeof create> | null = null;

async function mountLauncher(): Promise<LaunchNativeApp> {
  let launch: LaunchNativeApp | undefined;
  await act(async () => {
    lastRenderer = create(
      createElement(
        NativeAppLaunchProvider,
        null,
        createElement(Probe, {
          onReady: (value: LaunchNativeApp) => (launch = value),
        }) as ReactNode,
      ),
    );
  });
  if (!launch) throw new Error("provider did not publish a launch function");
  return launch;
}

const tap = (nativeUrlScheme: string, appName = "Google Sheets") => ({
  nativeUrlScheme,
  appName,
});

beforeEach(() => {
  h.timeline.length = 0;
  h.cancel = null;
  h.sheetMounted = false;
  h.sheetApp = null;
  h.onRelease = null;
  h.appState = "active";
  h.appStateListeners = [];
  h.canOpenURL.mockReset();
  h.openURL.mockReset().mockResolvedValue(true);
  h.alert.mockReset();
  h.releaseForSystemUI.mockReset();
  h.restoreAfterSystemUI.mockReset();
  h.nudgeDeviceAppProjection.mockReset().mockResolvedValue(true);
  h.readManagedSerial.mockReset().mockReturnValue("SERIAL-1");
});

describe("the commit invariant: a Cancel at the handoff cannot strand ASAM", () => {
  it("is a no-op when it lands at the moment of the release", async () => {
    // The observable: `openURL` rejects, so the launch MUST unwind through
    // failOpen — restoring ASAM and telling the scholar. Without the latch the
    // late Cancel bumps the generation, the catch block reads `isStale()` and
    // returns early, and the iPad is left released with no alert and no
    // restore. That is the round-one blocker, reproduced exactly.
    h.canOpenURL.mockResolvedValue(true);
    h.openURL.mockRejectedValue(new Error("no such app"));
    h.onRelease = () => h.cancel?.();
    const launch = await mountLauncher();

    await act(async () => {
      await launch(tap(SHEETS));
    });

    expect(h.timeline).toContain("release");
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when it lands at the release after a COLD wait", async () => {
    // Same latch, reached through the path that actually mounts a sheet — so
    // the Cancel being fired is one a scholar could really have been looking at.
    h.canOpenURL.mockResolvedValueOnce(false).mockResolvedValue(true);
    h.openURL.mockRejectedValue(new Error("no such app"));
    h.onRelease = () => h.cancel?.();
    const launch = await mountLauncher();

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = launch(tap(SHEETS));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(h.timeline).toContain("sheet:open");

    await act(async () => {
      await pending;
    });

    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it("dismisses the sheet as part of committing, not as an afterthought", async () => {
    // Fails if the handoff's `closeReadyUi()` is deleted: nothing else takes
    // the sheet down on a successful cold launch, so it would still be mounted
    // over the app the scholar just switched to.
    h.canOpenURL.mockResolvedValueOnce(false).mockResolvedValue(true);
    const launch = await mountLauncher();

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = launch(tap(SHEETS));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(h.sheetMounted).toBe(true);

    await act(async () => {
      await pending;
    });

    expect(h.sheetMounted).toBe(false);
    expect(h.timeline).toContain("release");
    expect(h.timeline.indexOf("release")).toBeLessThan(
      h.timeline.indexOf("openURL"),
    );
    expect(h.nudgeDeviceAppProjection).toHaveBeenCalledTimes(1);
  });
});

describe("the warm path costs nothing", () => {
  it("makes no backend call and never shows the sheet", async () => {
    h.canOpenURL.mockResolvedValue(true);
    const launch = await mountLauncher();

    await act(async () => {
      await launch(tap(SHEETS));
    });

    expect(h.nudgeDeviceAppProjection).not.toHaveBeenCalled();
    expect(h.timeline).not.toContain("sheet:open");
    expect(h.openURL).toHaveBeenCalledWith(SHEETS);
  });
});


describe("only managed taps take the ready path", () => {
  it("skips the probe entirely for an unmanaged scheme", async () => {
    const launch = await mountLauncher();

    await act(async () => {
      await launch(tap(UNMANAGED));
    });

    // A `canOpenURL` false for an unmanaged app means "not installed", and
    // waiting 75 seconds to say so would be worse than the immediate alert.
    expect(h.canOpenURL).not.toHaveBeenCalled();
    expect(h.nudgeDeviceAppProjection).not.toHaveBeenCalled();
    expect(h.openURL).toHaveBeenCalledWith(UNMANAGED);
  });

  it("skips it on a device with no MDM claim", async () => {
    h.readManagedSerial.mockReturnValue(null);
    const launch = await mountLauncher();

    await act(async () => {
      await launch(tap(SHEETS));
    });

    expect(h.canOpenURL).not.toHaveBeenCalled();
    expect(h.openURL).toHaveBeenCalledWith(SHEETS);
  });
});

describe("cancel", () => {
  it("never releases ASAM and never opens anything", async () => {
    h.canOpenURL.mockResolvedValue(false);
    const launch = await mountLauncher();

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = launch(tap(SHEETS));
      await new Promise((r) => setTimeout(r, 20));
    });
    // The sheet is up and its Cancel is live — mid-wait, exactly where a
    // scholar would reach for it. Everything after must unwind untouched.
    expect(h.timeline).toContain("sheet:open");

    await act(async () => {
      h.cancel?.();
      await pending;
    });

    expect(h.timeline).not.toContain("release");
    // And the sheet is gone, not stranded behind a launch nobody is running.
    expect(h.timeline[h.timeline.length - 1]).toBe("sheet:closed");
    expect(h.openURL).not.toHaveBeenCalled();
    expect(h.releaseForSystemUI).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });
});

describe("supersession", () => {
  it("an older launch's parked continuation cannot dismiss the newer sheet", async () => {
    // The real race: launch 1 is asleep INSIDE its probe loop when launch 2
    // mounts its own sheet. When launch 1 wakes it resolves `cancelled` — and
    // its cancel branch calls closeReadyUi. If the stale check did not come
    // first, the older flow would tear down a sheet the scholar is looking at.
    h.canOpenURL.mockResolvedValue(false);
    const launch = await mountLauncher();

    let first: Promise<void> | undefined;
    await act(async () => {
      first = launch(tap(SHEETS, "Google Sheets"));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(h.sheetApp).toBe("Google Sheets");

    // Cancel frees the tile immediately so the next tap is accepted — but
    // launch 1's gate is still parked in a probe sleep, NOT unwound.
    let second: Promise<void> | undefined;
    await act(async () => {
      h.cancel?.();
      second = launch(tap(SHEETS, "LEGO SPIKE"));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(h.sheetApp).toBe("LEGO SPIKE");
    // Launch 1 is genuinely still in flight — this test is worthless otherwise.
    expect(await Promise.race([first, Promise.resolve("pending")])).toBe(
      "pending",
    );

    // Let launch 1's continuation wake and unwind while launch 2 waits.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
      await first;
    });
    expect(h.sheetMounted).toBe(true);
    expect(h.sheetApp).toBe("LEGO SPIKE");

    // And launch 2 still completes normally once the iPad catches up.
    await act(async () => {
      h.canOpenURL.mockResolvedValue(true);
      await second;
    });
    expect(h.openURL).toHaveBeenCalledTimes(1);
    expect(h.openURL).toHaveBeenCalledWith(SHEETS);
    expect(h.sheetMounted).toBe(false);
  });
});

/** Move the app to `next`, telling every AppState listener, as iOS would. */
function emitAppState(next: string) {
  h.appState = next;
  for (const listener of [...h.appStateListeners]) listener(next);
}

describe("an open refused while the lock is still releasing (TRA-331)", () => {
  // On the pilot iPad an openURL sent 51 ms after the unlock was refused by
  // SpringBoard ("Guided Access blocking workspace open app request") and the
  // scholar was told the app might not be installed. These pin the retry.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tries again instead of calling the app missing", async () => {
    h.canOpenURL.mockResolvedValue(true);
    h.openURL
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue(true);
    const launch = await mountLauncher();

    await act(async () => {
      const pending = launch(tap(SHEETS));
      await vi.advanceTimersByTimeAsync(300);
      await pending;
    });

    expect(h.openURL).toHaveBeenCalledTimes(2);
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.restoreAfterSystemUI).not.toHaveBeenCalled();
  });

  it("gives up after a short window and re-arms the lock", async () => {
    h.canOpenURL.mockResolvedValue(true);
    h.openURL.mockRejectedValue(new Error("blocked"));
    const launch = await mountLauncher();

    await act(async () => {
      const pending = launch(tap(SHEETS));
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
    });

    // Bounded: a launch that lands long after the tap is its own bug.
    expect(h.openURL.mock.calls.length).toBeGreaterThan(1);
    expect(h.openURL.mock.calls.length).toBeLessThanOrEqual(8);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once Rabbithole has left the foreground", async () => {
    h.canOpenURL.mockResolvedValue(true);
    h.openURL.mockImplementationOnce(async () => {
      // The switch happened even though the call reported a refusal.
      h.appState = "background";
      throw new Error("refused");
    });
    const launch = await mountLauncher();

    await act(async () => {
      const pending = launch(tap(SHEETS));
      await vi.advanceTimersByTimeAsync(300);
      await pending;
    });

    expect(h.openURL).toHaveBeenCalledTimes(1);
    expect(h.alert).not.toHaveBeenCalled();
  });
});

describe("the lock re-arms only once a return has settled (TRA-331)", () => {
  // Re-arming on the very AppState event can land while SpringBoard still has
  // the other app frontmost, which sends iOS down its kill-and-relaunch path.
  beforeEach(() => {
    vi.useFakeTimers();
    h.canOpenURL.mockResolvedValue(true);
    h.openURL.mockImplementation(async () => {
      emitAppState("background");
      return true;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function launchAndLeave(launch: LaunchNativeApp) {
    await act(async () => {
      await launch(tap(SHEETS));
    });
    expect(h.appState).toBe("background");
  }

  it("waits a moment after the return, then re-arms once", async () => {
    const launch = await mountLauncher();
    await launchAndLeave(launch);

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(h.restoreAfterSystemUI).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
  });

  it("still re-arms on the next return when the scholar leaves inside the window", async () => {
    const launch = await mountLauncher();
    await launchAndLeave(launch);

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(400);
      emitAppState("background");
      await vi.advanceTimersByTimeAsync(5_000);
    });
    // Never re-armed from the background.
    expect(h.restoreAfterSystemUI).not.toHaveBeenCalled();

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
  });

  it("hands the pending re-arm to a tile tapped inside the window", async () => {
    const launch = await mountLauncher();
    await launchAndLeave(launch);

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(400);
    });
    // The second launch leaves again; the first return's re-arm must not fire
    // while the scholar is in the other app.
    await act(async () => {
      await launch(tap(SHEETS));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(h.appState).toBe("background");
    expect(h.restoreAfterSystemUI).not.toHaveBeenCalled();

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
  });

  it("doesn't re-arm in the middle of a tile's open retry", async () => {
    const launch = await mountLauncher();
    await launchAndLeave(launch);

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(400);
    });
    // The second tile's open is refused while the unlock lands, and the app
    // stays in front past the point the first return's re-arm was due.
    h.openURL
      .mockImplementationOnce(async () => {
        throw new Error("refused");
      })
      .mockImplementationOnce(async () => {
        throw new Error("refused");
      })
      .mockImplementationOnce(async () => {
        throw new Error("refused");
      });
    await act(async () => {
      const pending = launch(tap(SHEETS));
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
    });
    expect(h.openURL.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(h.appState).toBe("background");
    expect(h.restoreAfterSystemUI).not.toHaveBeenCalled();

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
  });

  it("re-arms at once if the launcher unmounts inside the window", async () => {
    const launch = await mountLauncher();
    await launchAndLeave(launch);

    await act(async () => {
      emitAppState("active");
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(h.restoreAfterSystemUI).not.toHaveBeenCalled();
    await act(async () => {
      lastRenderer?.unmount();
    });
    expect(h.restoreAfterSystemUI).toHaveBeenCalledTimes(1);
  });
});
