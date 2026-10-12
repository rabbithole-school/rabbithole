/**
 * The "device truth panel" (TRA-241 step 1) derivation: for one managed
 * iPad, the four facts about each app whose disagreement caused the
 * 2026-08-31 incident (an app granted and allowlisted, but the tile was
 * missing). Pure and read-side only — every input is already-stored state
 * (a granted/pushed key set, a `deviceAppUnlockBindings`/`deviceAppUnlockStates`
 * row pair, a `simpleMdmDeviceSnapshots` row); this module never calls
 * SimpleMDM and is the one place the four facts are assembled, so the console
 * (`convex/managedDeviceClaims.ts` `listManagedDevices`) and any future
 * consumer read the same verdict.
 *
 *   1. GRANTED  — `grantedManagedAppKeysForScholar` / `pushedManagedAppKeysForScholar`
 *      (convex/lib/deviceAppProjection.ts), the teacher-facing authority.
 *   2. ALLOWED  — the device's projected allowlist, as last computed/applied
 *      by the reconciler (`deviceAppUnlockStates.desiredBundleIds` /
 *      `.appliedBundleIds`; see convex/deviceAppUnlock.ts).
 *   3. INSTALLED — `simpleMdmDeviceSnapshots.installedBundleIds`, the stored
 *      `GET /devices/{id}/installed_apps` read-back (convex/simplemdm.ts).
 *   4. TILED    — the accepted combined profile projection for an upgraded
 *      bound fleet device, with the committed group layout as rollout/unbound
 *      fallback and Pilot's committed static layout kept separate
 *      (convex/lib/homeLayoutTiles.ts).
 */
import { MANAGED_NATIVE_APPS, type ManagedNativeAppKey } from "./managedNativeApps";
import { tiledBundleIdsForDevice } from "./homeLayoutTiles";

/** Rabbithole itself is not a catalog "managed native app" grant/push target
 *  — it is the baseline app every claimed device ships with — but the same
 *  four-fact question applies to it, so it gets its own row. */
export const RABBITHOLE_BUNDLE_ID = "school.rabbithole.canary";

export const APP_ACCESS_LABELS: Record<ManagedNativeAppKey, string> = {
  "google-sheets": "Google Sheets",
  "lego-spike": "LEGO SPIKE",
  "stop-motion-studio": "Stop Motion Studio Pro",
  "mentava-reading": "Mentava Reading",
  "google-arts-culture": "Google Arts & Culture",
};

export type AppAccessAllowed = "yes" | "no" | "pending" | "not-bound";

/**
 * The PRODUCT of the four facts: can the scholar holding this iPad open this
 * app right now? This is the question staff actually arrive with; the four
 * facts are the evidence for the answer, which is why they live in the same
 * module — a console that ANDed them itself would be a second, drifting
 * definition of "on the iPad".
 *
 *   yes           — tap it on the home screen.
 *   launcher-only — allowed and installed, but no home-screen tile, so it is
 *                   reachable only through the Rabbithole launcher. Real, and
 *                   the exact shape of the 2026-08-31 incident.
 *   landing       — a change is in flight; ask again shortly.
 *   no            — not reachable, and `blocker` says which fact stops it.
 *   unknown       — we cannot tell from stored state alone (no scholar, no
 *                   allowlist binding, or apps never inventoried).
 */
export type AppAccessOnDevice = "yes" | "launcher-only" | "landing" | "no" | "unknown";

/** The FIRST fact standing between the scholar and the app — what a console
 *  should offer to fix, rather than the whole list of what is not true. */
export type AppAccessBlocker =
  | "scholar"
  | "binding"
  | "grant"
  | "allowlist"
  | "inventory"
  | "install"
  | "tile"
  | null;

/**
 * One recurring block that opens a managed app to the device's scholar: the
 * schedule placement's subject and block, the weekdays (1 = Monday) it meets
 * this week, and the app's window on those days as school-local "HH:MM" — the
 * block, opened APP_PLACEMENT_LEAD_MS before the bell and closed
 * APP_PLACEMENT_GRACE_MS after (masterSchedule.reconcilePlacement).
 */
export type AppScheduleWindow = {
  subject: string;
  block: string;
  weekdays: number[];
  opensLocal: string;
  closesLocal: string;
};

/** A placement that opens a managed app to one group on one weekday, as the
 *  console reads them for a school's iPads before keeping each scholar's. */
export type AppPlacementWindow = {
  key: ManagedNativeAppKey;
  groupId: string;
  weekday: number;
} & Omit<AppScheduleWindow, "weekdays">;

/**
 * The windows that open each managed app to a scholar in these groups: one
 * entry per subject, block and window, with the weekdays it meets, in the
 * order the placements were read. A block-scoped app reaches its scholars
 * only through these (the 2026-09-15 ruling), so the console states them in
 * place of "no grant" (TRA-444).
 */
export function scheduleByKeyForGroups(
  windows: readonly AppPlacementWindow[],
  groupIds: ReadonlySet<string>,
): Partial<Record<ManagedNativeAppKey, AppScheduleWindow[]>> {
  const byKey: Partial<Record<ManagedNativeAppKey, AppScheduleWindow[]>> = {};
  const seen = new Map<string, AppScheduleWindow>();
  for (const w of windows) {
    if (!groupIds.has(w.groupId)) continue;
    const id = [w.key, w.subject, w.block, w.opensLocal, w.closesLocal].join("\u0000");
    let entry = seen.get(id);
    if (!entry) {
      entry = {
        subject: w.subject,
        block: w.block,
        weekdays: [],
        opensLocal: w.opensLocal,
        closesLocal: w.closesLocal,
      };
      seen.set(id, entry);
      (byKey[w.key] ??= []).push(entry);
    }
    if (!entry.weekdays.includes(w.weekday)) entry.weekdays.push(w.weekday);
  }
  for (const entry of seen.values()) entry.weekdays.sort((a, b) => a - b);
  return byKey;
}

export type AppAccessRow = {
  key: ManagedNativeAppKey | "rabbithole";
  label: string;
  bundleId: string;
  /** null when the device has no scholar assigned — there is nobody to hold
   *  a grant, so the console should read this row as "no scholar", not "no". */
  granted: boolean | null;
  /** The last school day ("YYYY-MM-DD") of a grant that ends on its own —
   *  "Open all day today" or "Open until…" (TRA-444) — when that grant is the
   *  scholar's only standing authority for the app. It ends at the midnight
   *  after this day. Null when nothing granted ends on its own. */
  grantThroughDay: string | null;
  /** The blocks that open this app to the scholar this week (see
   *  AppScheduleWindow). Empty when it is on none of their groups' blocks. */
  schedule: AppScheduleWindow[];
  allowed: AppAccessAllowed;
  /** null when SimpleMDM has never reported installed apps for this device. */
  installed: boolean | null;
  /** null when no current projection records this device's home screen, so
   *  the layout is genuinely unknown rather than absent. */
  tiled: boolean | null;
  installedCheckedAt: number | null;
  /** The one-line answer, and the first fact standing in its way. */
  onDevice: AppAccessOnDevice;
  blocker: AppAccessBlocker;
  /** The catalog row whose `nativeUrlScheme` is this app, so a console can
   *  open it to the scholar through the ordinary scholar-app paths
   *  (`scholarApps.openForScholar`, or the standing `addToScholar`). Null for
   *  Rabbithole (not a catalog app) and for a managed app the catalog has no
   *  row for yet. */
  appId: string | null;
};

/**
 * "Allowed" for one bundle id, from the stored projection state alone.
 *
 * JUDGMENT CALL — the "pending" verdict: `deviceAppUnlockStates.appliedBundleIds`
 * is a HINT the schema itself documents as needing live re-verification (see
 * its "VERIFY AUTHORITY" comment) — it is never re-read here. So "desired
 * wants this bundle id, but the last durably-accepted PATCH we recorded
 * either never happened or didn't yet include it" is reported as "pending"
 * rather than "no": the projector may simply not have run its next tick yet,
 * which is the ordinary, expected shape of a fresh grant, not a fault. A
 * genuinely stuck pending row is visible via `installedCheckedAt` staying old
 * and `allowed` staying "pending" across repeated checks — this module does
 * not attempt to distinguish "about to converge" from "stuck," which would
 * need a live profile read this panel deliberately never performs.
 */
function allowedFor(
  bundleId: string,
  args: {
    hasBinding: boolean;
    desiredBundleIds: readonly string[] | null;
    appliedBundleIds: readonly string[] | null | undefined;
  },
): AppAccessAllowed {
  if (!args.hasBinding) return "not-bound";
  const desired = (args.desiredBundleIds ?? []).includes(bundleId);
  const applied = args.appliedBundleIds?.includes(bundleId) ?? null;
  if (desired) return applied === true ? "yes" : "pending";
  // Desired excludes it, but SimpleMDM last accepted an allowlist that still
  // carries it: removal is in flight, so the app is still launchable.
  return applied === true ? "pending" : "no";
}

function installedFor(
  bundleId: string,
  args: { installedBundleIds: readonly string[] | null; installedAppsAt: number | null },
): boolean | null {
  if (args.installedAppsAt === null) return null;
  return (args.installedBundleIds ?? []).includes(bundleId);
}

/**
 * The verdict, in the order a scholar meets the obstacles: an app they have no
 * grant for is not "not installed" — the grant is the fact to fix, and every
 * later fact is downstream of it. Deliberately reports `unknown` rather than
 * guessing whenever the stored state cannot answer; this module never performs
 * the live read that would.
 */
function verdictFor(row: {
  granted: boolean | null;
  allowed: AppAccessAllowed;
  installed: boolean | null;
  tiled: boolean | null;
}): { onDevice: AppAccessOnDevice; blocker: AppAccessBlocker } {
  if (row.granted === null) return { onDevice: "unknown", blocker: "scholar" };
  if (row.allowed === "not-bound") return { onDevice: "unknown", blocker: "binding" };
  if (row.allowed === "pending") return { onDevice: "landing", blocker: "allowlist" };
  if (row.allowed === "no") {
    // A missing grant is the ordinary reason an app is not allowlisted, and
    // the one staff can act on; "the projector disagrees with the grant" is
    // the incident shape, and a different fix.
    return { onDevice: "no", blocker: row.granted ? "allowlist" : "grant" };
  }
  if (row.installed === null) return { onDevice: "unknown", blocker: "inventory" };
  if (!row.installed) return { onDevice: "no", blocker: "install" };
  // No projection has recorded this device's home screen, and the retired
  // static fleet layout may not stand in for one. Reporting "launcher only"
  // here would accuse the projector of a gap we have not observed.
  if (row.tiled === null) return { onDevice: "unknown", blocker: "tile" };
  if (row.tiled) return { onDevice: "yes", blocker: null };
  // No tile: the Rabbithole launcher is the only way in, and it lists an app
  // only for a scholar who has been granted it.
  return row.granted
    ? { onDevice: "launcher-only", blocker: "tile" }
    : { onDevice: "no", blocker: "grant" };
}

export function buildAppAccessRows(args: {
  hasScholar: boolean;
  grantedKeys: ReadonlySet<ManagedNativeAppKey>;
  pushedKeys: ReadonlySet<ManagedNativeAppKey>;
  hasBinding: boolean;
  profilePayloadIdentifier?: string | null;
  /** The device's projected allowlist as the reconciler last computed it
   *  (`deviceAppUnlockStates.desiredBundleIds`), falling back to the
   *  binding's locked `baselineBundleIds` when no state row exists yet
   *  (a bound device the reconciler hasn't ticked for). Null when there is
   *  no binding at all — see `allowedFor`'s "not-bound" short-circuit. */
  desiredBundleIds: readonly string[] | null;
  appliedBundleIds: readonly string[] | null | undefined;
  projectionFormatVersion?: number;
  installedBundleIds: readonly string[] | null;
  installedAppsAt: number | null;
  /** Catalog app ids by managed-app key, so a console can offer the ordinary
   *  grant in one click. Omitted keys simply have no grant affordance. */
  catalogAppIdByKey?: Partial<Record<ManagedNativeAppKey, string>>;
  /** Per granted key, the last day of a grant that ends on its own. */
  grantThroughDayByKey?: Partial<Record<ManagedNativeAppKey, string>>;
  /** Per key, the blocks that open the app to the scholar this week. */
  scheduleByKey?: Partial<Record<ManagedNativeAppKey, AppScheduleWindow[]>>;
}): AppAccessRow[] {
  const allowedArgs = {
    hasBinding: args.hasBinding,
    desiredBundleIds: args.desiredBundleIds,
    appliedBundleIds: args.appliedBundleIds,
  };
  const installedArgs = {
    installedBundleIds: args.installedBundleIds,
    installedAppsAt: args.installedAppsAt,
  };
  const tiledBundleIds = tiledBundleIdsForDevice({
    hasBinding: args.hasBinding,
    profilePayloadIdentifier: args.profilePayloadIdentifier,
    projectionFormatVersion: args.projectionFormatVersion,
    appliedBundleIds: args.appliedBundleIds ?? undefined,
  });

  const rows: AppAccessRow[] = (
    Object.keys(MANAGED_NATIVE_APPS) as ManagedNativeAppKey[]
  ).map((key) => {
    const { bundleId } = MANAGED_NATIVE_APPS[key];
    const facts = {
      granted: args.hasScholar
        ? args.grantedKeys.has(key) || args.pushedKeys.has(key)
        : null,
      allowed: allowedFor(bundleId, allowedArgs),
      installed: installedFor(bundleId, installedArgs),
      tiled: tiledBundleIds === null ? null : tiledBundleIds.includes(bundleId),
    };
    return {
      key,
      label: APP_ACCESS_LABELS[key],
      bundleId,
      ...facts,
      grantThroughDay: args.grantThroughDayByKey?.[key] ?? null,
      schedule: args.scheduleByKey?.[key] ?? [],
      installedCheckedAt: args.installedAppsAt,
      ...verdictFor(facts),
      appId: args.catalogAppIdByKey?.[key] ?? null,
    };
  });

  const rabbitholeFacts = {
    // Rabbithole is the baseline app, not a catalog grant/push target — it is
    // "granted" whenever there is a scholar to serve it to at all.
    granted: args.hasScholar ? true : null,
    allowed: allowedFor(RABBITHOLE_BUNDLE_ID, allowedArgs),
    installed: installedFor(RABBITHOLE_BUNDLE_ID, installedArgs),
    tiled:
      tiledBundleIds === null
        ? null
        : tiledBundleIds.includes(RABBITHOLE_BUNDLE_ID),
  };
  rows.push({
    key: "rabbithole",
    label: "Rabbithole",
    bundleId: RABBITHOLE_BUNDLE_ID,
    ...rabbitholeFacts,
    grantThroughDay: null,
    schedule: [],
    installedCheckedAt: args.installedAppsAt,
    ...verdictFor(rabbitholeFacts),
    // Not a catalog app, so it is never granted through `addToScholar`.
    appId: null,
  });

  return rows;
}
