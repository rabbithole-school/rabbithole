import { describe, expect, it } from "vitest";

import {
  classifyPreviousLaunch,
  enqueueReport,
  isDue,
  recordFailedAttempt,
  REPORT_MAX_AGE_MS,
  formatHst,
  jsCrashReport,
  MAX_PENDING_REPORTS,
  stallGapMs,
  stallReport,
  type LaunchJournal,
  type PendingHealthReport,
} from "./appHealth";

const BUILD = "canary 1.0.70 (70) abc123def";
// 2026-10-16 01:46:10 UTC = 2026-10-15 15:46:10 HST
const T0 = Date.UTC(2026, 9, 16, 1, 46, 10);

function journal(overrides: Partial<LaunchJournal> = {}): LaunchJournal {
  return {
    launchId: "launch-1",
    startedAt: T0 - 60_000,
    lastAliveAt: T0,
    appState: "active",
    stateSince: T0 - 60_000,
    uptimeAtLastAliveMs: 3_600_000,
    everActive: true,
    route: "/session/abc",
    build: BUILD,
    ...overrides,
  };
}

describe("classifyPreviousLaunch", () => {
  it("reports a launch that ended on screen", () => {
    const report = classifyPreviousLaunch(journal(), T0 + 10_000, BUILD, 3_700_000);
    expect(report).toMatchObject({
      id: "launch-1:unclean_exit",
      trigger: "unclean_exit",
      route: "/session/abc",
    });
    expect(report?.description).toContain("15:46:10 HST");
    expect(report?.description).not.toContain("JS hung");
  });

  it("calls out a JS hang when the relaunch came long after the last tick", () => {
    const report = classifyPreviousLaunch(journal(), T0 + 9 * 60_000, BUILD, 4_200_000);
    expect(report?.description).toContain("9 min later");
    expect(report?.description).toContain("JS hung");
  });

  it("ignores a clean background exit, a reported crash, an update, and no history", () => {
    const at = (j: LaunchJournal | null, build = BUILD) =>
      classifyPreviousLaunch(j, T0, build, null);
    expect(at(journal({ appState: "background" }))).toBeNull();
    expect(at(journal({ fatalAt: T0 }))).toBeNull();
    expect(at(journal(), "canary 1.0.71 (71) fff")).toBeNull();
    expect(at(null)).toBeNull();
  });

  it("ignores a brief inactive (app-switcher quit) but reports a stuck one", () => {
    const brief = journal({ appState: "inactive", stateSince: T0 - 3_000 });
    expect(classifyPreviousLaunch(brief, T0 + 5_000, BUILD, null)).toBeNull();
    const stuck = journal({ appState: "inactive", stateSince: T0 - 40_000 });
    const report = classifyPreviousLaunch(stuck, T0 + 5_000, BUILD, null);
    expect(report?.description).toContain("TRA-331");
    expect(report?.description).toContain("system overlay or alert");
    expect(report?.description).toContain("40s");
  });

  it("reports a death during launch, before the app ever reached the screen", () => {
    const launching = journal({
      appState: "inactive",
      stateSince: T0 - 2_000,
      everActive: false,
    });
    const report = classifyPreviousLaunch(launching, T0 + 5_000, BUILD, null);
    expect(report?.description).toContain("died while launching");
  });

  it("dates a reboot by the boot, and never calls a powered-off gap a definite hang", () => {
    // Battery died right after the last tick; the iPad booted 3 h later and
    // the app opened 2 min after boot (uptime 120s < 3600s at launch).
    const report = classifyPreviousLaunch(
      journal(),
      T0 + 3 * 3_600_000 + 120_000,
      BUILD,
      120_000,
    );
    expect(report?.description).toContain("The iPad restarted");
    expect(report?.description).toContain("or the iPad was off");
    expect(report?.description).not.toContain("JS hung");
  });

  it("a reboot long after JS stopped still reads as a freeze", () => {
    // JS froze; 9 min later someone restarted the iPad; app open 1 min after boot.
    const report = classifyPreviousLaunch(
      journal(),
      T0 + 10 * 60_000,
      BUILD,
      60_000,
    );
    expect(report?.description).toContain("The iPad restarted");
    expect(report?.description).toContain("9 min before the iPad booted again");
  });
});

describe("stallGapMs", () => {
  it("flags a foreground gap at the threshold", () => {
    expect(stallGapMs(100_000, 105_000, true, 60_000)).toBe(5_000);
    expect(stallGapMs(100_000, 104_999, true, 60_000)).toBeNull();
  });

  it("never flags a gap that spanned the background or the cold start", () => {
    expect(stallGapMs(100_000, 700_000, false, 60_000)).toBeNull();
    expect(stallGapMs(0, 8_000, true, 8_000)).toBeNull();
  });
});

describe("reports", () => {
  it("a stall report names the duration and a per-launch id", () => {
    const report = stallReport(journal(), 12_000, T0, 2);
    expect(report.id).toBe("launch-1:stall:2");
    expect(report.description).toContain("froze for 12s");
  });

  it("a JS crash report carries the message and a bounded stack", () => {
    const error = new TypeError("undefined is not an object");
    error.stack = `TypeError: undefined\n${"at frame\n".repeat(1_000)}`;
    const report = jsCrashReport(journal(), error, T0);
    expect(report.id).toBe("launch-1:js_crash");
    expect(report.description).toContain("TypeError: undefined is not an object");
    expect(report.description.length).toBeLessThan(4_000);
  });

  it("a non-Error throw still reports", () => {
    expect(jsCrashReport(journal(), "boom", T0).description).toContain("boom");
  });
});

describe("enqueueReport", () => {
  const item = (id: string): PendingHealthReport => ({
    id,
    trigger: "stall",
    createdAt: T0,
    route: "/",
    description: id,
  });

  it("keeps the newest reports and replaces a same-id duplicate", () => {
    let queue: PendingHealthReport[] = [];
    for (let i = 0; i < MAX_PENDING_REPORTS + 2; i += 1) {
      queue = enqueueReport(queue, item(`r${i}`));
    }
    expect(queue.map((r) => r.id)).toEqual(["r2", "r3", "r4", "r5", "r6"]);
    expect(enqueueReport(queue, item("r4")).map((r) => r.id)).toEqual([
      "r2",
      "r3",
      "r5",
      "r6",
      "r4",
    ]);
  });
});

it("recordFailedAttempt backs off and expires by age, not attempt count", () => {
  let report: PendingHealthReport | null = {
    id: "r",
    trigger: "stall",
    createdAt: T0,
    route: "/",
    description: "r",
  };
  report = recordFailedAttempt(report, T0);
  expect(report).toMatchObject({ attempts: 1, nextAttemptAt: T0 + 60_000 });
  expect(isDue(report!, T0 + 59_999)).toBe(false);
  expect(isDue(report!, T0 + 60_000)).toBe(true);
  for (let i = 0; i < 20; i += 1) report = recordFailedAttempt(report!, T0);
  // Many failures still keep it; the backoff caps at an hour.
  expect(report?.nextAttemptAt).toBe(T0 + 60 * 60_000);
  expect(recordFailedAttempt(report!, T0 + REPORT_MAX_AGE_MS)).toBeNull();
});

it("formatHst uses the fixed Hawaii offset", () => {
  expect(formatHst(T0)).toBe("2026-10-15 15:46:10 HST");
});
