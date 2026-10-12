import { describe, expect, test } from "vitest";
import {
  buildAppAccessRows,
  RABBITHOLE_BUNDLE_ID,
  scheduleByKeyForGroups,
  type AppPlacementWindow,
} from "../deviceAppAccess";
import { MANAGED_NATIVE_APPS } from "../managedNativeApps";
import {
  HOME_LAYOUT_PROJECTION_FORMAT_VERSION,
  PILOT_PROFILE_PAYLOAD_IDENTIFIER,
} from "../homeLayoutTiles";

const SPIKE_BUNDLE = MANAGED_NATIVE_APPS["lego-spike"].bundleId; // tiled
const SHEETS_BUNDLE = MANAGED_NATIVE_APPS["google-sheets"].bundleId; // not tiled

describe("buildAppAccessRows — device truth panel (TRA-241 step 1)", () => {
  test("fully granted + allowed + installed + tiled reads all-yes for that app", () => {
    const now = Date.now();
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(["lego-spike"]),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [RABBITHOLE_BUNDLE_ID, SPIKE_BUNDLE],
      appliedBundleIds: [RABBITHOLE_BUNDLE_ID, SPIKE_BUNDLE],
      projectionFormatVersion: HOME_LAYOUT_PROJECTION_FORMAT_VERSION,
      installedBundleIds: [RABBITHOLE_BUNDLE_ID, SPIKE_BUNDLE],
      installedAppsAt: now,
    });
    const spike = rows.find((r) => r.key === "lego-spike")!;
    expect(spike).toMatchObject({
      granted: true,
      allowed: "yes",
      installed: true,
      tiled: true,
      installedCheckedAt: now,
    });
    // Rabbithole is the baseline app: granted whenever a scholar is assigned,
    // and the projection always places it first.
    const rabbithole = rows.find((r) => r.key === "rabbithole")!;
    expect(rabbithole.bundleId).toBe(RABBITHOLE_BUNDLE_ID);
    expect(rabbithole).toMatchObject({ granted: true, tiled: true });
  });

  test("a device with no recorded projection reports its tiles as unknown", () => {
    // The static fleet layout was retired in the TRA-241 cutover, so there is
    // nothing left to fall back to. Claiming a tile either way would assert a
    // layout no installed profile places.
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(["google-sheets"]),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [SHEETS_BUNDLE],
      appliedBundleIds: [SHEETS_BUNDLE],
      installedBundleIds: [SHEETS_BUNDLE],
      installedAppsAt: Date.now(),
    });

    const sheets = rows.find((r) => r.key === "google-sheets")!;
    expect(sheets.granted).toBe(true);
    expect(sheets.allowed).toBe("yes");
    expect(sheets.tiled).toBeNull();
    expect(sheets.onDevice).toBe("unknown");
    expect(sheets.blocker).toBe("tile");
  });

  test("an upgraded bound device reads the accepted grant-derived layout", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(["google-sheets"]),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [
        RABBITHOLE_BUNDLE_ID,
        "com.apple.Preferences",
        SHEETS_BUNDLE,
      ],
      appliedBundleIds: [
        RABBITHOLE_BUNDLE_ID,
        "com.apple.Preferences",
        SHEETS_BUNDLE,
      ],
      projectionFormatVersion: HOME_LAYOUT_PROJECTION_FORMAT_VERSION,
      installedBundleIds: [SHEETS_BUNDLE],
      installedAppsAt: Date.now(),
    });

    expect(rows.find((row) => row.key === "google-sheets")!.tiled).toBe(true);
  });

  test("no scholar assigned reads granted=null (\"no scholar\"), not false", () => {
    const rows = buildAppAccessRows({
      hasScholar: false,
      grantedKeys: new Set(),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [],
      appliedBundleIds: [],
      installedBundleIds: [],
      installedAppsAt: Date.now(),
    });
    for (const row of rows) {
      expect(row.granted).toBeNull();
    }
  });

  test("no deviceAppUnlockBindings row reads allowed=\"not-bound\" for every app", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(["lego-spike"]),
      pushedKeys: new Set(),
      hasBinding: false,
      desiredBundleIds: null,
      appliedBundleIds: undefined,
      installedBundleIds: null,
      installedAppsAt: null,
    });
    for (const row of rows) {
      expect(row.allowed).toBe("not-bound");
    }
    // Granted is independent of binding — the grant is the teacher-facing
    // authority; "not-bound" is a projection-side fact.
    expect(rows.find((r) => r.key === "lego-spike")!.granted).toBe(true);
  });

  test("desired includes the bundle id but appliedBundleIds has never been recorded reads \"pending\"", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(["lego-spike"]),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [SPIKE_BUNDLE],
      appliedBundleIds: undefined, // reconciler has not ticked this device yet
      installedBundleIds: null,
      installedAppsAt: null,
    });
    expect(rows.find((r) => r.key === "lego-spike")!.allowed).toBe("pending");
  });

  test("desired includes the bundle id but the last recorded apply missed it reads \"pending\", not \"no\"", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(["lego-spike"]),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [SPIKE_BUNDLE],
      appliedBundleIds: [], // an apply was recorded, but it didn't include this app yet
      installedBundleIds: null,
      installedAppsAt: null,
    });
    expect(rows.find((r) => r.key === "lego-spike")!.allowed).toBe("pending");
  });

  test("desired excludes the bundle id but the last accepted allowlist still carries it reads \"pending\" (removal in flight)", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [],
      appliedBundleIds: [SPIKE_BUNDLE],
      installedBundleIds: null,
      installedAppsAt: null,
    });
    expect(rows.find((r) => r.key === "lego-spike")!.allowed).toBe("pending");
  });

  test("desired excludes the bundle id reads \"no\"", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [],
      appliedBundleIds: [],
      installedBundleIds: null,
      installedAppsAt: null,
    });
    expect(rows.find((r) => r.key === "lego-spike")!.allowed).toBe("no");
  });

  test("installed apps recorded, but this bundle id absent from them, reads installed=false (not null)", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(["lego-spike"]),
      pushedKeys: new Set(),
      hasBinding: true,
      desiredBundleIds: [SPIKE_BUNDLE],
      appliedBundleIds: [SPIKE_BUNDLE],
      installedBundleIds: [], // SimpleMDM reported an inventory, just an empty one
      installedAppsAt: Date.now(),
    });
    expect(rows.find((r) => r.key === "lego-spike")!.installed).toBe(false);
  });

  test("a pushed (not granted) key still reads granted=yes", () => {
    const rows = buildAppAccessRows({
      hasScholar: true,
      grantedKeys: new Set(),
      pushedKeys: new Set(["lego-spike"]),
      hasBinding: true,
      desiredBundleIds: [SPIKE_BUNDLE],
      appliedBundleIds: [SPIKE_BUNDLE],
      installedBundleIds: [SPIKE_BUNDLE],
      installedAppsAt: Date.now(),
    });
    expect(rows.find((r) => r.key === "lego-spike")!.granted).toBe(true);
  });

  describe("the On this iPad verdict", () => {
    const base: Parameters<typeof buildAppAccessRows>[0] = {
      hasScholar: true,
      grantedKeys: new Set(["lego-spike" as const]),
      pushedKeys: new Set<never>(),
      hasBinding: true,
      desiredBundleIds: [SPIKE_BUNDLE],
      appliedBundleIds: [SPIKE_BUNDLE],
      projectionFormatVersion: HOME_LAYOUT_PROJECTION_FORMAT_VERSION,
      installedBundleIds: [SPIKE_BUNDLE],
      installedAppsAt: Date.now(),
    };
    const spike = (over: Partial<Parameters<typeof buildAppAccessRows>[0]> = {}) =>
      buildAppAccessRows({ ...base, ...over }).find((r) => r.key === "lego-spike")!;

    test("every fact satisfied reads yes, with no blocker", () => {
      const row = spike();
      expect(row.onDevice).toBe("yes");
      expect(row.blocker).toBeNull();
    });

    test("no scholar is unknown, not no — we cannot yet say", () => {
      const row = spike({ hasScholar: false });
      expect(row.onDevice).toBe("unknown");
      expect(row.blocker).toBe("scholar");
    });

    test("an unbound device is unknown, blocked on binding", () => {
      const row = spike({ hasBinding: false });
      expect(row.onDevice).toBe("unknown");
      expect(row.blocker).toBe("binding");
    });

    test("desired but not yet applied reads landing, blocked on the allowlist", () => {
      const row = spike({ appliedBundleIds: [] });
      expect(row.onDevice).toBe("landing");
      expect(row.blocker).toBe("allowlist");
    });

    test("not allowed and not granted blames the missing grant", () => {
      const row = spike({
        grantedKeys: new Set(),
        desiredBundleIds: [],
        appliedBundleIds: [],
      });
      expect(row.onDevice).toBe("no");
      expect(row.blocker).toBe("grant");
    });

    test("granted but never desired blames the allowlist, not the grant", () => {
      const row = spike({ desiredBundleIds: [], appliedBundleIds: [] });
      expect(row.onDevice).toBe("no");
      expect(row.blocker).toBe("allowlist");
    });

    test("no inventory yet is unknown, not no", () => {
      const row = spike({ installedBundleIds: null, installedAppsAt: null });
      expect(row.onDevice).toBe("unknown");
      expect(row.blocker).toBe("inventory");
    });

    test("allowed but absent from inventory blames the install", () => {
      const row = spike({ installedBundleIds: [] });
      expect(row.onDevice).toBe("no");
      expect(row.blocker).toBe("install");
    });

    // Pilot keeps its own committed static layout and never receives a
    // projected Home Screen payload, so an app can be allowlisted and
    // installed there while still having no tile — the launcher-only case.
    const sheets = (over: Partial<Parameters<typeof buildAppAccessRows>[0]> = {}) =>
      buildAppAccessRows({
        ...base,
        profilePayloadIdentifier: PILOT_PROFILE_PAYLOAD_IDENTIFIER,
        grantedKeys: new Set(["google-sheets" as const]),
        desiredBundleIds: [SHEETS_BUNDLE],
        appliedBundleIds: [SHEETS_BUNDLE],
        installedBundleIds: [SHEETS_BUNDLE],
        ...over,
      }).find((r) => r.key === "google-sheets")!;

    test("installed and granted but untiled is launcher-only", () => {
      const row = sheets();
      expect(row.tiled).toBe(false);
      expect(row.onDevice).toBe("launcher-only");
      expect(row.blocker).toBe("tile");
    });

    test("installed but neither tiled nor granted is genuinely unreachable", () => {
      // The launcher only lists apps the scholar was granted, so with no grant
      // and no tile there is no door into the app at all.
      const row = sheets({ grantedKeys: new Set() });
      expect(row.onDevice).toBe("no");
      expect(row.blocker).toBe("grant");
    });

    test("the catalog app id is carried through for the one-click grant", () => {
      const rows = buildAppAccessRows({
        ...base,
        catalogAppIdByKey: { "lego-spike": "app_123" },
      });
      expect(rows.find((r) => r.key === "lego-spike")!.appId).toBe("app_123");
      expect(rows.find((r) => r.key === "rabbithole")!.appId).toBeNull();
    });
  });
});

describe("scheduleByKeyForGroups — the blocks that open an app (TRA-444)", () => {
  const window = (over: Partial<AppPlacementWindow>): AppPlacementWindow => ({
    key: "lego-spike",
    groupId: "robotics",
    weekday: 1,
    subject: "Robotics",
    block: "Block E",
    opensLocal: "14:50",
    closesLocal: "16:40",
    ...over,
  });

  test("one entry per subject, block and window, with its weekdays in order", () => {
    const byKey = scheduleByKeyForGroups(
      [
        window({ weekday: 3 }),
        window({ weekday: 1 }),
        window({ weekday: 3 }), // a recurring cell and this week's copy of it
        window({ weekday: 2, block: "Block C", opensLocal: "10:35", closesLocal: "11:55" }),
        window({ key: "stop-motion-studio", weekday: 5, subject: "Film club" }),
      ],
      new Set(["robotics"]),
    );
    expect(byKey).toEqual({
      "lego-spike": [
        { subject: "Robotics", block: "Block E", weekdays: [1, 3], opensLocal: "14:50", closesLocal: "16:40" },
        { subject: "Robotics", block: "Block C", weekdays: [2], opensLocal: "10:35", closesLocal: "11:55" },
      ],
      "stop-motion-studio": [
        { subject: "Film club", block: "Block E", weekdays: [5], opensLocal: "14:50", closesLocal: "16:40" },
      ],
    });
  });

  test("keeps only the scholar's groups", () => {
    const windows = [window({ groupId: "makers" }), window({ groupId: "robotics", weekday: 4 })];
    expect(scheduleByKeyForGroups(windows, new Set(["robotics"]))["lego-spike"]?.map((w) => w.weekdays)).toEqual([[4]]);
    expect(scheduleByKeyForGroups(windows, new Set())).toEqual({});
  });
});
