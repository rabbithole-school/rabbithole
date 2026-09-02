import { describe, it, expect } from "vitest";

import {
  applyAsamAction,
  decideAsamAction,
  decideOneTimeDisarmAction,
  isManagedAsamEnabled,
  isAppReentry,
  selectAsamLockStatus,
  shouldUseOfflineRecoveryBypass,
  type AsamAction,
  type AsamInputs,
} from "../asamDecision";

describe("isManagedAsamEnabled", () => {
  it("requires the explicit MDM configuration value", () => {
    expect(isManagedAsamEnabled({ asamEnabled: "1" })).toBe(true);
    expect(isManagedAsamEnabled({ asamEnabled: true })).toBe(false);
    expect(isManagedAsamEnabled({})).toBe(false);
    expect(isManagedAsamEnabled(null)).toBe(false);
  });
});

// Exhaustive truth-table test: every one of the eight {isOnline, armed, inSam}
// combinations maps to exactly one expected action. This nails down each branch
// for a paired device and guards against a future edit flipping one.
const CASES: Array<{ input: AsamInputs; expected: AsamAction; why: string }> = [
  {
    input: { isOnline: true, paired: true, armed: true, inSam: false },
    expected: "enter",
    why: "armed + online + not locked → lock ourselves in",
  },
  {
    input: { isOnline: true, paired: true, armed: true, inSam: true },
    expected: "none",
    why: "already locked where we want to be → nothing to do",
  },
  {
    input: { isOnline: false, paired: true, armed: true, inSam: true },
    expected: "exit",
    why: "offline while locked → step out so Wi-Fi can be fixed",
  },
  {
    input: { isOnline: false, paired: true, armed: true, inSam: false },
    expected: "none",
    why: "offline + armed but not locked → don't lock while offline",
  },
  {
    input: { isOnline: false, paired: true, armed: false, inSam: true },
    expected: "exit",
    why: "offline AND remotely disarmed while locked → step out",
  },
  {
    input: { isOnline: false, paired: true, armed: false, inSam: false },
    expected: "none",
    why: "offline + disarmed + not locked → nothing to do",
  },
  {
    input: { isOnline: true, paired: true, armed: false, inSam: true },
    expected: "exit",
    why: "staff disarmed while online + locked → step out, stay out",
  },
  {
    input: { isOnline: true, paired: true, armed: false, inSam: false },
    expected: "none",
    why: "disarmed + not locked → stay out until re-armed",
  },
];

describe("decideAsamAction", () => {
  for (const { input, expected, why } of CASES) {
    it(`${JSON.stringify(input)} → "${expected}" (${why})`, () => {
      expect(decideAsamAction(input)).toBe(expected);
    });
  }

  it("enters exactly when online + armed + not already locked", () => {
    expect(
      decideAsamAction({
        isOnline: true,
        paired: true,
        armed: true,
        inSam: false,
      }),
    ).toBe("enter");
  });

  it("exits on offline while locked (the fix-Wi-Fi escape hatch)", () => {
    expect(
      decideAsamAction({
        isOnline: false,
        paired: true,
        armed: true,
        inSam: true,
      }),
    ).toBe("exit");
  });

  it("exits on a remote disarm while locked", () => {
    expect(
      decideAsamAction({
        isOnline: true,
        paired: true,
        armed: false,
        inSam: true,
      }),
    ).toBe("exit");
  });

  it("stays put (none) when online + armed + already locked", () => {
    expect(
      decideAsamAction({
        isOnline: true,
        paired: true,
        armed: true,
        inSam: true,
      }),
    ).toBe("none");
  });

  it("never enters while offline (won't lock a device that can't phone home)", () => {
    for (const armed of [true, false]) {
      for (const inSam of [true, false]) {
        expect(
          decideAsamAction({
            isOnline: false,
            paired: true,
            armed,
            inSam,
          }),
        ).not.toBe("enter");
      }
    }
  });

  it("never enters an unpaired iPad and exits one that is still locked", () => {
    expect(
      decideAsamAction({
        isOnline: true,
        paired: false,
        armed: true,
        inSam: false,
      }),
    ).toBe("none");
    expect(
      decideAsamAction({
        isOnline: true,
        paired: false,
        armed: true,
        inSam: true,
      }),
    ).toBe("exit");
  });

  it("holds the current lock state while the pairing query is loading", () => {
    expect(
      decideAsamAction({
        isOnline: true,
        paired: "unknown",
        armed: false,
        inSam: true,
      }),
    ).toBe("none");
    expect(
      decideAsamAction({
        isOnline: true,
        paired: "unknown",
        armed: false,
        inSam: false,
      }),
    ).toBe("none");
  });

  it("still exits for Wi-Fi recovery while the pairing query is loading", () => {
    expect(
      decideAsamAction({
        isOnline: false,
        paired: "unknown",
        armed: false,
        inSam: true,
      }),
    ).toBe("exit");
  });
});

describe("offline recovery status", () => {
  const armedState = { desiredState: "armed" as const, disarmMode: null };
  const disarmedState = {
    desiredState: "disarmed" as const,
    disarmMode: "until_further_notice" as const,
  };

  it.each([
    {
      input: { isOnline: false, paired: true, armed: true, inSam: false },
      expected: true,
      why: "a confirmed armed pairing stepped out for recovery",
    },
    {
      input: { isOnline: false, paired: true, armed: false, inSam: false },
      expected: false,
      why: "a confirmed disarm is not a Wi-Fi recovery bypass",
    },
    {
      input: { isOnline: false, paired: false, armed: true, inSam: false },
      expected: false,
      why: "an unpaired iPad cannot have a lock recovery bypass",
    },
    {
      input: {
        isOnline: false,
        paired: "unknown" as const,
        armed: true,
        inSam: false,
      },
      expected: false,
      why: "cached state is not a confirmed pairing",
    },
    {
      input: { isOnline: false, paired: true, armed: true, inSam: true },
      expected: false,
      why: "the iPad has not yet stepped out for recovery",
    },
  ])("$why", ({ input, expected }) => {
    expect(shouldUseOfflineRecoveryBypass(input)).toBe(expected);
  });

  it("shows ordinary disarmed and unpaired statuses instead of Wi-Fi recovery", () => {
    expect(selectAsamLockStatus(disarmedState, false, false).label).toBe(
      "Rabbithole Lock is disarmed",
    );
    expect(selectAsamLockStatus(null, false, false).label).toBe(
      "This iPad is not paired",
    );
  });

  it("shows Wi-Fi recovery only for the confirmed bypass", () => {
    expect(selectAsamLockStatus(armedState, false, true).label).toBe(
      "Lock paused for Wi-Fi recovery",
    );
  });
});

describe("selectAsamLockStatus timed disarm", () => {
  it("shows the actual re-arm time when the state carries an expiry", () => {
    const status = selectAsamLockStatus(
      {
        desiredState: "disarmed",
        disarmMode: "timed",
        disarmExpiresAt: Date.parse("2026-08-20T16:35:00.000Z"),
      },
      false,
      false,
    );
    expect(status.label).toBe("Rabbithole Lock is disarmed");
    expect(status.detail).toMatch(/^It re-arms automatically at .+\.$/);
  });

  it("falls back to a generic message when no expiry is known", () => {
    const status = selectAsamLockStatus(
      { desiredState: "disarmed", disarmMode: "timed", disarmExpiresAt: null },
      false,
      false,
    );
    expect(status.detail).toBe("It re-arms automatically soon.");
  });

  it("shows the applying status while disarming, same as other modes", () => {
    const status = selectAsamLockStatus(
      {
        desiredState: "disarmed",
        disarmMode: "timed",
        disarmExpiresAt: Date.parse("2026-08-20T16:35:00.000Z"),
      },
      true,
      false,
    );
    expect(status.label).toBe("Rabbithole Lock is disarming");
  });
});

describe("applyAsamAction", () => {
  it("surfaces an MDM permission rejection instead of silently staying arming", async () => {
    await expect(
      applyAsamAction("enter", {
        enter: async () => false,
        exit: async () => true,
      }),
    ).rejects.toThrow("not permitted by the iPad management profile");
  });

  it("does not call the OS when no transition is needed", async () => {
    let calls = 0;
    await applyAsamAction("none", {
      enter: async () => {
        calls += 1;
        return true;
      },
      exit: async () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(0);
  });

  it("accepts successful entry and exit transitions", async () => {
    const calls: string[] = [];
    const driver = {
      enter: async () => {
        calls.push("enter");
        return true;
      },
      exit: async () => {
        calls.push("exit");
        return true;
      },
    };

    await applyAsamAction("enter", driver);
    await applyAsamAction("exit", driver);
    expect(calls).toEqual(["enter", "exit"]);
  });
});

describe("decideOneTimeDisarmAction", () => {
  const base = {
    desiredUpdatedAt: 100,
    observedUpdatedAt: null,
    observedEntryVersion: null,
    appEntryVersion: 3,
    isAppActive: true,
    inSam: false,
  };

  it("clears tracking when no one-time disarm is active", () => {
    expect(
      decideOneTimeDisarmAction({
        ...base,
        desiredUpdatedAt: null,
      }),
    ).toBe("clear");
  });

  it("waits until the release is active and outside Single App Mode", () => {
    expect(
      decideOneTimeDisarmAction({
        ...base,
        isAppActive: false,
      }),
    ).toBe("wait");
    expect(
      decideOneTimeDisarmAction({
        ...base,
        inSam: true,
      }),
    ).toBe("wait");
  });

  it("observes a newly applied release without consuming it", () => {
    expect(decideOneTimeDisarmAction(base)).toBe("observe");
  });

  it("consumes only after a later app entry", () => {
    expect(
      decideOneTimeDisarmAction({
        ...base,
        observedUpdatedAt: 100,
        observedEntryVersion: 3,
      }),
    ).toBe("wait");
    expect(
      decideOneTimeDisarmAction({
        ...base,
        observedUpdatedAt: 100,
        observedEntryVersion: 3,
        appEntryVersion: 4,
      }),
    ).toBe("consume");
  });

  it("observes a newer command instead of consuming an older one", () => {
    expect(
      decideOneTimeDisarmAction({
        ...base,
        desiredUpdatedAt: 101,
        observedUpdatedAt: 100,
        observedEntryVersion: 2,
      }),
    ).toBe("observe");
  });
});

describe("isAppReentry", () => {
  it("counts only a genuine background return", () => {
    expect(isAppReentry("background", "active")).toBe(true);
    expect(isAppReentry("inactive", "active")).toBe(false);
    expect(isAppReentry("unknown", "active")).toBe(false);
    expect(isAppReentry("active", "active")).toBe(false);
  });
});
