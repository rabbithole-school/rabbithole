import { handoffMessage, handoffTitle } from "../nativeAppLaunch";
import { describe, it, expect } from "vitest";

import {
  decideNativeLaunchWatch,
  interpretNativeOpenResult,
  notInstalledMessage,
  openFailedTitle,
  stillLockedMessage,
  type NativeLaunchWatchState,
} from "../nativeAppLaunch";

describe("interpretNativeOpenResult", () => {
  it("treats a resolved `false` as not-opened (app not installed)", () => {
    expect(interpretNativeOpenResult(false)).toBe(false);
  });

  it("treats undefined/true/anything-else resolved as opened", () => {
    expect(interpretNativeOpenResult(undefined)).toBe(true);
    expect(interpretNativeOpenResult(true)).toBe(true);
    expect(interpretNativeOpenResult(null)).toBe(true);
  });
});

describe("alert copy", () => {
  it("titles the failure with the app name, sentence case", () => {
    expect(openFailedTitle("Google Sheets")).toBe("Couldn't open Google Sheets");
  });

  it("does not over-claim not-installed (a refusal can also be policy)", () => {
    expect(notInstalledMessage()).toBe(
      "It may not be installed on this iPad yet.",
    );
  });

  it("has distinct copy for a lock that failed to release", () => {
    expect(stillLockedMessage()).toBe(
      "This iPad's lock didn't release. Try again, or ask a teacher.",
    );
  });
});

describe("decideNativeLaunchWatch", () => {
  const watching: NativeLaunchWatchState = {
    mode: "watching",
    sawBackground: false,
  };

  it("ignores every event while idle (stale/superseded flow, no launch in flight)", () => {
    const idle: NativeLaunchWatchState = { mode: "idle", sawBackground: false };
    expect(
      decideNativeLaunchWatch(idle, {
        kind: "appstate",
        previous: "active",
        next: "background",
      }),
    ).toEqual({ action: "none", mode: "idle", sawBackground: false });
    expect(decideNativeLaunchWatch(idle, { kind: "timer" })).toEqual({
      action: "none",
      mode: "idle",
      sawBackground: false,
    });
  });

  it("remembers a real background transition (the switch happened)", () => {
    const result = decideNativeLaunchWatch(watching, {
      kind: "appstate",
      previous: "active",
      next: "background",
    });
    expect(result).toEqual({
      action: "none",
      mode: "watching",
      sawBackground: true,
    });
  });

  it("does NOT count 'inactive' as leaving — no restore, no background mark", () => {
    // A screen interruption (notification banner / Control Center peek).
    const toInactive = decideNativeLaunchWatch(watching, {
      kind: "appstate",
      previous: "active",
      next: "inactive",
    });
    expect(toInactive).toEqual({
      action: "none",
      mode: "watching",
      sawBackground: false,
    });

    // …and returning to active from that interruption still does not restore
    // (we never actually left, so nothing to re-arm here).
    const backToActive = decideNativeLaunchWatch(
      { mode: "watching", sawBackground: false },
      { kind: "appstate", previous: "inactive", next: "active" },
    );
    expect(backToActive).toEqual({
      action: "none",
      mode: "watching",
      sawBackground: false,
    });
  });

  it("restores on a direct background→active re-entry, then returns to idle", () => {
    const result = decideNativeLaunchWatch(
      { mode: "watching", sawBackground: true },
      { kind: "appstate", previous: "background", next: "active" },
    );
    expect(result).toEqual({
      action: "restore",
      mode: "idle",
      sawBackground: false,
    });
  });

  it("restores on return to active when iOS routed through an intermediate inactive", () => {
    // background (marked) → inactive → active: still a re-entry.
    const result = decideNativeLaunchWatch(
      { mode: "watching", sawBackground: true },
      { kind: "appstate", previous: "inactive", next: "active" },
    );
    expect(result).toEqual({
      action: "restore",
      mode: "idle",
      sawBackground: false,
    });
  });

  it("timer restores ONLY when the app never backgrounded (silent openURL)", () => {
    const result = decideNativeLaunchWatch(
      { mode: "watching", sawBackground: false },
      { kind: "timer" },
    );
    expect(result).toEqual({
      action: "restore",
      mode: "idle",
      sawBackground: false,
    });
  });

  it("timer NEVER restores while backgrounded (scholar is inside the other app)", () => {
    const result = decideNativeLaunchWatch(
      { mode: "watching", sawBackground: true },
      { kind: "timer" },
    );
    expect(result).toEqual({
      action: "none",
      mode: "watching",
      sawBackground: true,
    });
  });

  it("a stale-generation timer fires against an already-restored (idle) flow → no restore", () => {
    // A superseded/completed launch leaves the watch in `idle`; a leftover timer
    // that slips through the hook's genRef guard is a pure no-op here too.
    const result = decideNativeLaunchWatch(
      { mode: "idle", sawBackground: false },
      { kind: "timer" },
    );
    expect(result).toEqual({
      action: "none",
      mode: "idle",
      sawBackground: false,
    });
  });

  it("background seen by flow A, flow B starts, then re-entry → restore happens exactly once", () => {
    // Flow A opens an app and the OS backgrounds Rabbithole.
    let state: NativeLaunchWatchState = { mode: "watching", sawBackground: false };
    let step = decideNativeLaunchWatch(state, {
      kind: "appstate",
      previous: "active",
      next: "background",
    });
    expect(step.action).toBe("none");
    state = { mode: step.mode, sawBackground: step.sawBackground };
    expect(state).toEqual({ mode: "watching", sawBackground: true });

    // Flow B "starts": the hook resets the per-launch flags but the continuous
    // listener still holds previous === "background".
    state = { mode: "watching", sawBackground: false };

    // The scholar returns to Rabbithole → re-entry restores via previous=background.
    step = decideNativeLaunchWatch(state, {
      kind: "appstate",
      previous: "background",
      next: "active",
    });
    expect(step).toEqual({
      action: "restore",
      mode: "idle",
      sawBackground: false,
    });
    state = { mode: step.mode, sawBackground: step.sawBackground };

    // A duplicate/late "active" now finds the flow idle → does not restore again.
    step = decideNativeLaunchWatch(state, {
      kind: "appstate",
      previous: "active",
      next: "active",
    });
    expect(step.action).toBe("none");
  });
});

describe("the watch survives a superseded launch (kiosk-escape regression)", () => {
  // The hole finding #1 found: a Home-Screen handoff leaves the scholar INSIDE
  // Rabbithole, free to tap a second tile. If that second launch aborts before
  // its commit point, a generation-guarded timer from the FIRST launch wakes up
  // stale and exits without restoring — ASAM stays released with nothing left
  // to re-arm it. The state machine itself is not what broke; the fix is that
  // the timer is guarded by this state rather than by a launch generation, so
  // these assertions pin the contract the armer now relies on.
  it("still owes a restore after a release with no background", () => {
    const afterRelease = { mode: "watching" as const, sawBackground: false };
    // Whoever fires the timer — original launch or a re-armed one — restores.
    expect(decideNativeLaunchWatch(afterRelease, { kind: "timer" }).action).toBe(
      "restore",
    );
  });

  it("cannot double-restore once it has restored", () => {
    const afterRelease = { mode: "watching" as const, sawBackground: false };
    const first = decideNativeLaunchWatch(afterRelease, { kind: "timer" });
    expect(first.action).toBe("restore");
    expect(first.mode).toBe("idle");
    // A second timer (a re-arm racing the original) must be inert — this is
    // what makes dropping the generation guard safe.
    const second = decideNativeLaunchWatch(
      { mode: first.mode, sawBackground: first.sawBackground },
      { kind: "timer" },
    );
    expect(second.action).toBe("none");
  });

  it("hands the restore to the re-entry path once the scholar really leaves", () => {
    const left = decideNativeLaunchWatch(
      { mode: "watching", sawBackground: false },
      { kind: "appstate", previous: "active", next: "background" },
    );
    expect(left.sawBackground).toBe(true);
    // A timer firing while they are inside the other app must NOT re-enter
    // ASAM from the background.
    expect(
      decideNativeLaunchWatch(
        { mode: left.mode, sawBackground: left.sawBackground },
        { kind: "timer" },
      ).action,
    ).toBe("none");
    expect(
      decideNativeLaunchWatch(
        { mode: left.mode, sawBackground: left.sawBackground },
        { kind: "appstate", previous: "background", next: "active" },
      ).action,
    ).toBe("restore");
  });
});

describe("handoff copy makes no claim it cannot back", () => {
  // This path has no readiness proof, so the copy must work whether or not the
  // app has landed yet. A regression here is not cosmetic: it is telling a
  // six-year-old something false about their own iPad.
  it("instructs rather than asserting the app is already there", () => {
    expect(handoffTitle("Mentava Reading")).toBe(
      "Open Mentava Reading from your Home Screen",
    );
    expect(handoffTitle("Mentava Reading")).not.toMatch(/\bis on\b/);
  });

  it("names the gesture the fleet iPads actually have", () => {
    const body = handoffMessage("Mentava Reading");
    expect(body).toMatch(/swipe up/i);
    // The fleet is iPad A16 — no Home button to press.
    expect(body).not.toMatch(/home button/i);
  });

  it("promises no specific duration", () => {
    expect(handoffMessage("Mentava Reading")).not.toMatch(/\d+\s*(sec|second|min)/i);
  });
});
