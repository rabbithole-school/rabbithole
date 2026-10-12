"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import {
  Badge,
  Box,
  Button,
  Dialog,
  Drawer,
  Field,
  Flex,
  HStack,
  IconButton,
  Input,
  Popover,
  Portal,
  Progress,
  Spinner,
  Table,
  Text,
  Textarea,
  Tooltip,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  BatteryFull,
  BatteryHigh,
  BatteryLow,
  BatteryMedium,
  CalendarBlank,
  CaretDown,
  Check,
  CheckCircle,
  Clock,
  CloudArrowUp,
  Copy,
  DeviceTablet,
  DownloadSimple,
  LinkBreak,
  LockKey,
  LockKeyOpen,
  MagicWand,
  MagnifyingGlass,
  MinusCircle,
  PencilSimple,
  Question,
  Plus,
  Power,
  Prohibit,
  SignOut,
  Trash,
  WarningCircle,
  X,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNow } from "@/hooks/useNow";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import {
  closesPhrase,
  scheduleWindowsPhrase,
  throughDayPhrase,
} from "@/lib/appAccessCopy";
import { shiftDayKey } from "@/shared/institutionDay";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { toaster } from "@/lib/toaster";
import {
  awaitingClaimPresentation,
  claimPresentationOverdue,
  type ClaimPresentationInput,
} from "./claimPresentation";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/ui/Surface";
import { EmptyState } from "@/components/ui/EmptyState";
import { PaneTabs } from "@/components/ui/PaneTabs";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { PersonCell } from "@/components/PersonCell";
import { ScholarPickerContent } from "@/components/ScholarPicker";
import type { RosterScholar } from "@/hooks/useScholarRoster";
import {
  deviceBatteryBand,
  type DeviceBatteryBand,
} from "@/shared/deviceBattery";
import {
  etaLabel,
  landingProgress,
  PROJECTION_OPERATION_TIMEOUT_MS,
  PROJECTION_SWEEP_MS,
} from "@/shared/appAccessLanding";
import { registrationFeedback } from "./importFeedback";
import {
  getSimpleMdmActionPolicy,
  type SimpleMdmActionPolicy,
} from "./simpleMdmActionPolicy";
import {
  DrawerSection,
  LostModeControl,
  simpleMdmErrorMessage,
  RabbitholeLockControl,
  RoboticsCaptureStationModeControl,
} from "./DeviceSecurityControls";
import { CaptureStationsSection } from "./CaptureStationsSection";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { downloadBlob } from "@/components/downloadFile";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

type PairedDevice = FunctionReturnType<
  typeof api.devicePairing.listPairedDevices
>[number];
type PairableScholar = FunctionReturnType<
  typeof api.devicePairing.listPairableScholars
>[number];
type ManagedDevice = FunctionReturnType<
  typeof api.managedDeviceClaims.listManagedDevices
>[number];
type MintResult = FunctionReturnType<
  typeof api.managedDeviceClaims.mintManagedDeviceClaims
>["results"][number];
type RegistrationResult = FunctionReturnType<
  typeof api.managedDeviceClaims.registerManagedDeviceSerials
>["results"][number];
type PushResult = FunctionReturnType<
  typeof api.simplemdm.pushClaimToSimpleMdm
>;
/**
 * What SimpleMDM last told us about a device, as persisted by the backend
 * (`simpleMdmDeviceSnapshots`) and delivered on the reactive device query.
 * The console never asks SimpleMDM anything on its own: the snapshot is
 * refreshed hourly and by the explicit "Check now" action.
 */
type SimpleMdmInventory = NonNullable<ManagedDevice["simpleMdm"]>;
type VerifyStatus = NonNullable<SimpleMdmInventory["claimVerifyStatus"]>;

type UnifiedDevice =
  | { key: string; kind: "managed"; device: ManagedDevice }
  | { key: string; kind: "manual"; device: PairedDevice };
type DeviceFilter = "all" | "unassigned" | "attention" | "signed-in";
const DEVICE_FILTER_ITEMS: Array<{
  value: DeviceFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "unassigned", label: "Unassigned" },
  { value: "attention", label: "Needs attention" },
  { value: "signed-in", label: "Signed in" },
];
/**
 * Roster row rhythm — the single place the row heights are decided.
 *
 * Every row reserves the height of the tallest ORDINARY row so a one-line row
 * never reads as compressed beside a two-line one. On desktop the tallest is a
 * management cell carrying primary + secondary text (sm over xs inside the
 * size="sm" cell padding); the mobile card is denser still, stacking the
 * device name, the scholar, and the lock/battery line. `height` on a table row
 * behaves as a minimum, so a row with unexpectedly tall content still grows.
 */
const DEVICE_ROW_MIN_H = { desktop: "3.5rem", mobile: "6rem" } as const;
type JustPaired = {
  key: string;
  scholarName: string;
  scholarUsername: string | null;
  deviceLabel: string | null;
  at: number;
};
type ParsedSerialRow = { raw: string; serial: string; error: string | null };

function normalizeCode(raw: string) {
  return raw
    .toUpperCase()
    .split("")
    .filter((character) => CODE_ALPHABET.includes(character))
    .join("")
    .slice(0, CODE_LENGTH);
}

function formatCode(code: string) {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function relativeTime(timestamp: number) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** "in 3m" / "3m ago" for ETA-style hovers; `relativeTime` is past-only. */
function relativeClock(timestamp: number) {
  const delta = Math.round((timestamp - Date.now()) / 1000);
  if (delta <= 0) return relativeTime(timestamp);
  if (delta < 60) return "in under a minute";
  const minutes = Math.round(delta / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}

function normalizeSerial(raw: string) {
  return raw.trim().toUpperCase();
}

function parseSerialLines(text: string): ParsedSerialRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((raw) => {
      const serial = normalizeSerial(raw);
      return {
        raw,
        serial,
        error: /^[0-9A-Z]{8,14}$/.test(serial)
          ? null
          : "Serial doesn't look valid.",
      };
    });
}

function simpleMdmActionError(error: unknown, fallback = "SimpleMDM push failed. Please try again.") {
  // The SimpleMDM client throws a ConvexError whose data carries a message
  // written for this console ("SimpleMDM is rate limiting…", "…unreachable…").
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "message" in data) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  const message = error instanceof Error ? error.message : "";
  return (
    message.match(
      /SimpleMDM (?:API key not configured[^\n]*|provisioning isn't configured for your school)/,
    )?.[0] ?? fallback
  );
}

function snapshotOf(device: ManagedDevice): SimpleMdmInventory | undefined {
  return device.simpleMdm ?? undefined;
}

function verifyStatusOf(device: ManagedDevice): VerifyStatus | undefined {
  return device.simpleMdm?.claimVerifyStatus ?? undefined;
}

/**
 * The push outcome to show for a row: this session's transient result if
 * there is one, else the persisted outcome — but only when that outcome is
 * about the CURRENT claim (issued before the push), so a failure recorded
 * against an old token can't haunt a freshly minted one.
 */
function effectivePushResult(
  device: ManagedDevice,
  transient: PushResult | undefined,
): PushResult | undefined {
  if (transient) return transient;
  const snapshot = device.simpleMdm;
  if (!snapshot?.lastPushStatus || !snapshot.lastPushAt) return undefined;
  if (snapshot.lastPushAt < device.claimIssuedAt) return undefined;
  return {
    managedDeviceId: device._id,
    serial: device.serial,
    status: snapshot.lastPushStatus,
    message: snapshot.lastPushMessage ?? "",
  };
}

function payloadJson(payload: MintResult["payload"]) {
  return JSON.stringify(payload, null, 2);
}

function payloadPlist(payload: NonNullable<MintResult["payload"]>) {
  const entry = (key: string, value: string) =>
    `  <key>${key}</key>\n  <string>${value}</string>`;
  return [
    "<dict>",
    entry("claimToken", payload.claimToken),
    entry("claimSerial", payload.claimSerial),
    entry("claimVersion", payload.claimVersion),
    "</dict>",
  ].join("\n");
}

function csvExport(rows: MintResult[]) {
  const escape = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    "serial,scholarUsername,claimToken,claimVersion",
    ...rows
      .filter((row) => row.ok && row.payload)
      .map((row) =>
        [
          row.serial,
          row.scholarUsername ?? "",
          row.payload!.claimToken,
          row.payload!.claimVersion,
        ]
          .map(escape)
          .join(","),
      ),
  ].join("\n");
}

function jsonExport(rows: MintResult[]) {
  return JSON.stringify(
    rows
      .filter((row) => row.ok && row.payload)
      .map((row) => ({
        serial: row.serial,
        scholarUsername: row.scholarUsername,
        payload: row.payload,
      })),
    null,
    2,
  );
}

function downloadText(filename: string, text: string, mime: string) {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toaster.success({ title: `${label} copied` });
  } catch {
    toaster.error({ title: "Couldn't copy — select and copy manually" });
  }
}

/**
 * The one derivation of "has the claim this device is CURRENTLY meant to hold
 * reached SimpleMDM?". A staged replacement means the old timestamp no longer
 * proves delivery of the current intent, so it does not count. Every card
 * signal reads this — three separate derivations once disagreed on the same row.
 */
function effectivePushedAt(device: ManagedDevice): number | null {
  return (
    (device.hasPendingClaim
      ? device.pendingSimplemdmPushedAt
      : device.simplemdmPushedAt) ?? null
  );
}

/**
 * A deleted scholar's iPad (TRA-434). Deleting a scholar leaves their claim on
 * the roster for staff to reassign, so the row reads as unassigned but, unlike
 * a spare, still needs someone to act. A disabled one is waiting on nobody: it
 * keeps reading "Disabled".
 */
function awaitingReassignment(device: ManagedDevice): boolean {
  return device.scholarDeleted && device.claimState !== "revoked";
}

function managedNeedsAttention(
  device: ManagedDevice,
  pushResult?: PushResult,
  verifyStatus?: VerifyStatus,
  inventory?: SimpleMdmInventory,
) {
  if (inventory?.lostModeEnabled === true) return true;
  if (device.claimState === "revoked") return false;
  if (awaitingReassignment(device)) return true;
  const pushedAt = effectivePushedAt(device);
  // Computed at render like `relativeTime` above — the reactive device query
  // repaints the row the moment the iPad presents its claim, which is the
  // transition that clears this.
  if (claimPresentationOverdue(presentationInput(device), Date.now())) return true;
  return (
    verifyStatus === "stale" ||
    verifyStatus === "not-in-simplemdm" ||
    (!!device.scholarId &&
      !pushedAt &&
      verifyStatus !== "in-sync") ||
    (pushResult !== undefined && pushResult.status !== "pushed")
  );
}

function presentationInput(device: ManagedDevice): ClaimPresentationInput {
  return {
    scholarId: device.scholarId,
    claimState: device.claimState,
    pushedAt: effectivePushedAt(device),
  };
}

function deviceStatus(row: UnifiedDevice) {
  if (row.kind === "manual") {
    return row.device.hasLiveSession ? "Signed in" : "Signed out";
  }
  if (!row.device.scholarId) return "Unassigned";
  if (row.device.hasLiveSession) return "Signed in";
  if (awaitingClaimPresentation(presentationInput(row.device))) return "Waiting for iPad";
  return row.device.claimState === "claimed" ? "Signed out" : "Ready";
}

function syncSummary(
  device: ManagedDevice,
  pushResult?: PushResult,
  verifyStatus?: VerifyStatus,
) {
  if (!device.scholarId) return "—";
  if (pushResult) return pushResult.status === "pushed" ? "Pushed" : "Needs attention";
  if (verifyStatus === "in-sync") return "In sync";
  if (verifyStatus === "stale") return "Outdated";
  if (verifyStatus === "not-in-simplemdm") return "Not found";
  const pushedAt = effectivePushedAt(device);
  if (pushedAt) return `Pushed ${relativeTime(pushedAt)}`;
  return "Pending";
}

function managementSummary(
  row: UnifiedDevice,
  pushResult?: PushResult,
  verifyStatus?: VerifyStatus,
  inventory?: SimpleMdmInventory,
) {
  if (row.kind === "manual") {
    // A deleted scholar's manually paired iPad (TRA-441, the twin of the
    // managed "Needs reassignment" above): its binding outlives the scholar
    // and is freed by unpairing it.
    if (row.device.scholarDeleted) {
      return { primary: "Needs unpairing", secondary: "Scholar deleted", attention: true };
    }
    return {
      primary: "Manual pairing",
      secondary: `Paired ${relativeTime(row.device.pairedAt)}`,
      attention: false,
    };
  }
  const device = row.device;
  const secondary = inventory?.lastSeenAt
    ? `Seen ${relativeTime(inventory.lastSeenAt)}`
    : device.lastClaimedAt
      ? `Claimed ${relativeTime(device.lastClaimedAt)}`
      : null;
  // Ahead of the unassigned case: a disabled iPad whose scholar was then
  // deleted is still disabled, and says so.
  if (device.claimState === "revoked") {
    return { primary: "Disabled", secondary, attention: false };
  }
  if (!device.scholarId) {
    return awaitingReassignment(device)
      ? { primary: "Needs reassignment", secondary: "Scholar deleted", attention: true }
      : { primary: "—", secondary: null, attention: false };
  }
  if (pushResult && pushResult.status !== "pushed") {
    return { primary: "Push failed", secondary, attention: true };
  }
  if (verifyStatus === "stale") {
    return { primary: "Out of date", secondary, attention: true };
  }
  if (verifyStatus === "not-in-simplemdm") {
    return { primary: "Not in SimpleMDM", secondary, attention: true };
  }
  const pushedAt = effectivePushedAt(device);
  if (!pushedAt && verifyStatus !== "in-sync") {
    return { primary: "Pending setup", secondary, attention: true };
  }
  // "Pushed" is not "taken". Until the iPad exchanges the new claim it is still
  // signed in as whoever it served before, so say that rather than "Up to date".
  if (awaitingClaimPresentation(presentationInput(device))) {
    const overdue = claimPresentationOverdue(presentationInput(device), Date.now());
    return {
      primary: overdue ? "iPad hasn't taken the claim" : "Waiting for iPad",
      secondary: pushedAt ? `Pushed ${relativeTime(pushedAt)}` : secondary,
      attention: overdue,
    };
  }
  return { primary: "Up to date", secondary, attention: false };
}

function rowSearchText(row: UnifiedDevice) {
  const inventory = row.kind === "managed" ? snapshotOf(row.device) : undefined;
  return [
    row.kind === "managed" ? row.device.serial : row.device.deviceId,
    row.kind === "managed" ? inventory?.name : row.device.deviceLabel,
    row.device.scholarName,
    row.device.scholarUsername,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function rowDeviceName(row: UnifiedDevice) {
  const inventory = row.kind === "managed" ? snapshotOf(row.device) : undefined;
  return row.kind === "managed"
    ? inventory?.name ?? row.device.serial
    : row.device.deviceLabel ?? row.device.deviceId;
}

export default function SchoolDevicesPage() {
  const { user, isLoading } = useCurrentUser();
  const { activeInstitution, hasSchoolOperationsAccess } = useSchoolOperationsAccess(user, !!user);
  const allowed = hasSchoolOperationsAccess === true;
  const authorization = useAuthorizationGuard({
    isLoading: isLoading || activeInstitution === undefined,
    hasUser: !!user,
    isAllowed: allowed,
    unauthorizedRedirect: "/school/directory/scholars",
  });
  const { scopeParam } = useActiveInstitution(!!user && allowed);
  // Program guests are included here on purpose: an Extended Education scholar
  // who attends in person needs a school iPad like anyone else, and this console
  // is the only place a device gets assigned. The picker labels their standing.
  const scholars = useQuery(
    api.devicePairing.listPairableScholars,
    allowed
      ? { institutionScope: scopeParam, includeProgramGuests: true }
      : "skip",
  );
  const pairedDevices = useQuery(
    api.devicePairing.listPairedDevices,
    allowed ? { institutionScope: scopeParam } : "skip",
  );
  // Re-arms across the institution day boundary — the reachable-apps column
  // consults push liveness and when opened access ends. See
  // `listManagedDevices`. Smoothed, because a bare useQuery drops to
  // undefined on every minute's re-arm, which closed the open device drawer
  // and wiped whatever a staffer was entering in it (TRA-364's shape).
  const devicesMinuteNow = Math.floor(useNow(60_000) / 60_000) * 60_000;
  const managedDevices = useSmoothedQuery(
    api.managedDeviceClaims.listManagedDevices,
    allowed
      ? { institutionScope: scopeParam, now: devicesMinuteNow }
      : "skip",
  );
  const simpleMdmStatus = useQuery(
    api.simplemdm.integrationStatus,
    allowed ? {} : "skip",
  );
  const simpleMdmPolicy = getSimpleMdmActionPolicy(simpleMdmStatus?.configured);
  // The MDM -> Rabbithole direction: serials SimpleMDM is managing that this
  // roster has never heard of. Stored snapshots only (this page never calls
  // SimpleMDM on load), and skipped unless the integration is usable here --
  // the query refuses rather than showing another school the primary's fleet.
  const unrostered = useQuery(
    api.simplemdm.unrosteredSimpleMdmDevices,
    allowed && simpleMdmPolicy.showPushActions ? {} : "skip",
  );
  const assign = useMutation(api.managedDeviceClaims.assignScholarToManagedDevice);
  const autoAssign = useMutation(api.managedDeviceClaims.autoAssignManagedDevices);
  const pushClaim = useAction(api.simplemdm.pushClaimToSimpleMdm);
  const pushAllPending = useAction(api.simplemdm.pushAllPendingClaims);
  const verifyClaims = useAction(api.simplemdm.verifySimpleMdmClaims);
  const renameDevice = useAction(api.simplemdm.renameManagedDevice);

  const [addOpen, setAddOpen] = useState(false);
  const [addPrefillSerials, setAddPrefillSerials] = useState<string[]>([]);
  const [autoAssignOpen, setAutoAssignOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const [pushResults, setPushResults] = useState<Record<string, PushResult>>({});
  const [checkingSimpleMdm, setCheckingSimpleMdm] = useState(false);
  const [revealed, setRevealed] = useState<MintResult[]>([]);
  const [pushingAll, setPushingAll] = useState(false);
  const [bulkPushMessage, setBulkPushMessage] = useState<string | null>(null);

  const pickerScholars = useMemo<RosterScholar[]>(
    () =>
      (scholars ?? []).map((scholar) => ({
        id: String(scholar._id),
        name: scholar.name ?? scholar.username ?? "Unnamed scholar",
        username: scholar.username,
        image: null,
        readingLevel: null,
        gradeLevel: null,
        dateOfBirth: null,
        lastMessageAt: null,
        groupIds: [],
        isMine: false,
        enrollmentStanding: scholar.enrollmentStanding,
      })),
    [scholars],
  );
  const unassignedDevices = useMemo(
    () => (managedDevices ?? []).filter((device) => !device.scholarId),
    [managedDevices],
  );
  // A deleted scholar's iPad reads as unassigned but still holds its old
  // claim, which bulk assignment refuses; it is reassigned from its drawer.
  const autoAssignableDevices = useMemo(
    () =>
      unassignedDevices.filter(
        (device) => !device.autoAssignExcluded && !device.scholarDeleted,
      ),
    [unassignedDevices],
  );
  const availableScholars = useMemo(() => {
    const assigned = new Set(
      (managedDevices ?? [])
        .map((device) => device.scholarId)
        .filter((id): id is Id<"users"> => !!id)
        .map(String),
    );
    return pickerScholars
      .filter((scholar) => !assigned.has(scholar.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [managedDevices, pickerScholars]);
  // How many managed devices each scholar already has — drives the drawer's
  // "already assigned" secondary picker section.
  const scholarDeviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const device of managedDevices ?? []) {
      if (!device.scholarId) continue;
      const key = String(device.scholarId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [managedDevices]);
  const rosterScholarsSorted = useMemo(
    () => [...pickerScholars].sort((a, b) => a.name.localeCompare(b.name)),
    [pickerScholars],
  );
  const pendingPushCount =
    managedDevices?.filter(
      (device) =>
        device.scholarId &&
        device.claimState !== "revoked" &&
        (device.hasPendingClaim
          ? !device.pendingSimplemdmPushedAt
          : !device.simplemdmPushedAt ||
            device.simplemdmPushedAt < device.claimIssuedAt),
    ).length ?? 0;
  const simpleMdmCheckedAt = useMemo(() => {
    let latest: number | null = null;
    for (const device of managedDevices ?? []) {
      const checkedAt = device.simpleMdm?.checkedAt;
      if (checkedAt && (latest === null || checkedAt > latest)) latest = checkedAt;
    }
    return latest;
  }, [managedDevices]);

  const unrosteredSerials = unrostered?.serials ?? [];

  // The ONLY place this page talks to SimpleMDM: an explicit staff action.
  // Results land in `simpleMdmDeviceSnapshots` and arrive through the
  // reactive device query, so there is no local copy to keep in step.
  const runVerify = useCallback(async () => {
    if (!allowed || simpleMdmStatus?.configured !== true) return;
    setCheckingSimpleMdm(true);
    try {
      await verifyClaims({});
    } catch (error) {
      toaster.error({
        title: "Couldn't check SimpleMDM",
        description: simpleMdmActionError(error, "Please try again in a moment."),
      });
    } finally {
      setCheckingSimpleMdm(false);
    }
  }, [allowed, simpleMdmStatus?.configured, verifyClaims]);

  function clearPushResult(managedDeviceId: ManagedDevice["_id"]) {
    setPushResults((current) => {
      if (!(managedDeviceId in current)) return current;
      const next = { ...current };
      delete next[managedDeviceId];
      return next;
    });
  }

  async function pushDevice(
    managedDeviceId: ManagedDevice["_id"],
    serial: string,
  ): Promise<PushResult> {
    try {
      const result = await pushClaim({ managedDeviceId });
      setPushResults((current) => ({ ...current, [managedDeviceId]: result }));
      return result;
    } catch (error) {
      const result: PushResult = {
        managedDeviceId,
        serial,
        status: "api-error",
        message: simpleMdmActionError(error),
      };
      setPushResults((current) => ({ ...current, [managedDeviceId]: result }));
      return result;
    }
  }

  async function renameManagedDevice(
    managedDeviceId: ManagedDevice["_id"],
    name: string,
  ) {
    // The backend records the new name on the device's snapshot; the reactive
    // query repaints the row.
    const result = await renameDevice({ managedDeviceId, name });
    return result.simpleMdmName;
  }

  async function handleAssign(device: ManagedDevice, scholarId: Id<"users">) {
    if (!simpleMdmPolicy.canAssign) {
      throw new Error("Device management status is still loading. Try again shortly.");
    }
    const minted = await assign({ managedDeviceId: device._id, scholarId });
    clearPushResult(device._id);
    if (simpleMdmPolicy.assignmentBehavior === "fallback") {
      setRevealed((current) => [minted, ...current]);
      toaster.success({
        title: "Scholar assigned",
        description: "Enrol the iPad with the fallback payload below.",
      });
      return;
    }
    const pushed = await pushDevice(device._id, device.serial);
    if (pushed.status === "pushed") {
      toaster.success({
        title: "Scholar assigned and claim pushed",
        description:
          "The iPad switches over once it picks up the new claim — the row shows \u201CWaiting for iPad\u201D until it does.",
      });
    } else {
      if (
        pushed.status === "device-not-found-in-simplemdm" ||
        pushed.message.startsWith("SimpleMDM API key not configured")
      ) {
        setRevealed((current) => [minted, ...current]);
      }
      toaster.error({
        title: "Scholar assigned; SimpleMDM needs attention",
        description: pushed.message,
      });
    }
  }

  async function handleAutoAssign(selectedScholarIds: string[]) {
    if (!simpleMdmPolicy.canAssign) {
      throw new Error("Device management status is still loading. Try again shortly.");
    }
    if (selectedScholarIds.length > autoAssignableDevices.length) {
      throw new Error(`Select up to ${autoAssignableDevices.length} scholars.`);
    }
    const selectedScholars = selectedScholarIds
      .map((id) => availableScholars.find((scholar) => scholar.id === id))
      .filter((scholar): scholar is RosterScholar => !!scholar)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (selectedScholars.length !== selectedScholarIds.length) {
      throw new Error("One of those scholars is no longer available.");
    }
    const devices = autoAssignableDevices.slice(0, selectedScholars.length);
    const { results } = await autoAssign({
      managedDeviceIds: devices.map((device) => device._id),
      scholarIds: selectedScholars.map((scholar) => scholar.id as Id<"users">),
    });
    for (const device of devices) clearPushResult(device._id);
    if (simpleMdmPolicy.assignmentBehavior === "fallback") {
      setRevealed((current) => [...[...results].reverse(), ...current]);
      toaster.success({ title: `${results.length} devices assigned` });
      return;
    }
    const outcomes = await Promise.all(
      devices.map((device) => pushDevice(device._id, device.serial)),
    );
    const revealable = results.filter(
      (_result, index) => outcomes[index]?.status === "device-not-found-in-simplemdm",
    );
    if (revealable.length) setRevealed((current) => [...[...revealable].reverse(), ...current]);
    const pushed = outcomes.filter((result) => result.status === "pushed").length;
    toaster[pushed === outcomes.length ? "success" : "error"]({
      title:
        pushed === outcomes.length
          ? `${pushed} devices assigned and pushed`
          : `${results.length} assigned; ${outcomes.length - pushed} need attention`,
    });
  }

  async function handlePushAll() {
    setPushingAll(true);
    setBulkPushMessage(null);
    try {
      const { results } = await pushAllPending({});
      setPushResults((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.managedDeviceId, result])),
      }));
      if (!results.length) {
        const staleCount = (managedDevices ?? []).filter(
          (device) => verifyStatusOf(device) === "stale",
        ).length;
        setBulkPushMessage(
          staleCount
            ? `${staleCount} device${staleCount === 1 ? "" : "s"} still need a fresh push.`
            : "Every assigned device is already up to date.",
        );
        return;
      }
      const pushed = results.filter((result) => result.status === "pushed").length;
      setBulkPushMessage(
        `${pushed} pushed${pushed === results.length ? "" : ` · ${results.length - pushed} need attention`}`,
      );
    } catch (error) {
      setBulkPushMessage(simpleMdmActionError(error));
    } finally {
      setPushingAll(false);
    }
  }

  const unifiedDevices = useMemo<UnifiedDevice[]>(() => {
    const managed = (managedDevices ?? []).map((device) => ({
      key: `managed:${device._id}`,
      kind: "managed" as const,
      device,
    }));
    // A managed claim owns its physical paired binding. Exact FK dedupe only:
    // never guess from a scholar, serial, or label.
    const manual = (pairedDevices ?? [])
      .filter((device) => device.managedDeviceClaimId == null)
      .map((device) => ({ key: `manual:${device._id}`, kind: "manual" as const, device }));
    return [...managed, ...manual].sort((a, b) =>
      rowDeviceName(a).localeCompare(rowDeviceName(b)),
    );
  }, [managedDevices, pairedDevices]);
  const pairedDevicesById = useMemo(
    () =>
      new Map(
        (pairedDevices ?? []).map((device) => [
          String(device._id),
          device,
        ]),
      ),
    [pairedDevices],
  );
  const selectedDevice = unifiedDevices.find((row) => row.key === selectedKey) ?? null;
  const selectedPairedDevice =
    selectedDevice?.kind === "manual"
      ? selectedDevice.device
      : selectedDevice?.device.pairedDeviceId
        ? pairedDevicesById.get(String(selectedDevice.device.pairedDeviceId))
        : undefined;
  const filteredDevices = useMemo(() => {
    const query = search.trim().toLowerCase();
    return unifiedDevices.filter((row) => {
      const status = deviceStatus(row);
      if (
        filter === "unassigned" &&
        !(row.kind === "managed" && !row.device.scholarId)
      ) {
        return false;
      }
      if (
        filter === "attention" &&
        !(row.kind === "managed"
          ? managedNeedsAttention(
              row.device,
              effectivePushResult(row.device, pushResults[row.device._id]),
              verifyStatusOf(row.device),
              snapshotOf(row.device),
            )
          : row.device.scholarDeleted)
      ) {
        return false;
      }
      if (filter === "signed-in" && status !== "Signed in") return false;
      return !query || rowSearchText(row).includes(query);
    });
  }, [filter, pushResults, search, unifiedDevices]);

  if (authorization !== "allowed" || !user) return <AuthorizationPending />;

  const loading = pairedDevices === undefined || managedDevices === undefined;
  const hasDevices = unifiedDevices.length > 0;
  return (
    <VStack align="stretch" gap={6} pb={10}>
      <PageHeader
        title="Devices"
        subtitle="See who has each iPad, check its status, and open details to manage it."
      />

      <Surface p={{ base: 4, md: 6 }}>
        <Flex justify="flex-end" align={{ base: "stretch", md: "center" }} gap={4} direction={{ base: "column", md: "row" }}>
          <HStack gap={2} flexWrap="wrap">
            <Button size="sm" variant="outline" onClick={() => setAutoAssignOpen(true)}
              disabled={!simpleMdmPolicy.canAssign || !autoAssignableDevices.length || !availableScholars.length}>
              <MagicWand size={16} weight="bold" />
              Auto assign
            </Button>
            {simpleMdmPolicy.showPushActions && (
              <>
                <Button size="sm" variant="outline" loading={pushingAll}
                  disabled={!pendingPushCount || managedDevices === undefined}
                  onClick={() => void handlePushAll()}>
                  <CloudArrowUp size={16} />
                  Push all pending
                </Button>
                <Button size="sm" variant="ghost" loading={checkingSimpleMdm}
                  disabled={managedDevices === undefined || !managedDevices.length}
                  onClick={() => void runVerify()}
                  title="Ask SimpleMDM for each device's current state">
                  <ArrowClockwise size={16} />
                  Check now
                </Button>
                <Text fontSize="xs" color="charcoal.400" aria-live="polite">
                  {simpleMdmCheckedAt
                    ? `SimpleMDM checked ${relativeTime(simpleMdmCheckedAt)}`
                    : "SimpleMDM not checked yet"}
                </Text>
                {/* Reads as of that same check -- the line above dates it, so
                    this one states the fact and never claims to be live. */}
                {unrosteredSerials.length > 0 && (
                  <Button
                    size="xs"
                    variant="plain"
                    height="auto"
                    px={0}
                    fontSize="xs"
                    fontWeight="normal"
                    color="charcoal.500"
                    textDecoration="underline"
                    textUnderlineOffset="2px"
                    onClick={() => {
                      setAddPrefillSerials(unrosteredSerials);
                      setAddOpen(true);
                    }}
                    title="Register these serials"
                  >
                    {unrosteredSerials.length === 1
                      ? "1 iPad in SimpleMDM isn't on this roster"
                      : `${unrosteredSerials.length} iPads in SimpleMDM aren't on this roster`}
                  </Button>
                )}
              </>
            )}
            <Button size="sm" colorPalette="violet" onClick={() => setAddOpen(true)}>
              <Plus size={16} weight="bold" />
              Add device
            </Button>
          </HStack>
        </Flex>

        <Flex mt={5} gap={3} align={{ base: "stretch", md: "center" }} direction={{ base: "column", md: "row" }}>
          <Box position="relative" maxW={{ md: "360px" }} w="full">
            <Box position="absolute" left={3} top="50%" transform="translateY(-50%)" color="charcoal.300" pointerEvents="none">
              <MagnifyingGlass size={16} />
            </Box>
            <Input value={search} onChange={(event) => setSearch(event.target.value)}
              pl={9} placeholder="Search serial, label, or scholar" aria-label="Search devices" />
          </Box>
          <ViewToggle<DeviceFilter>
            ariaLabel="Filter devices"
            value={filter}
            onChange={setFilter}
            items={DEVICE_FILTER_ITEMS}
          />
        </Flex>
        {bulkPushMessage && (
          <Text mt={3} fontSize="sm" color="charcoal.500" aria-live="polite">
            {bulkPushMessage}
          </Text>
        )}

        <Box mt={4}>
          {loading ? (
            <HStack p={4} color="charcoal.300"><Spinner size="sm" /><Text>Loading devices…</Text></HStack>
          ) : !hasDevices ? (
            <EmptyState icon={<DeviceTablet weight="duotone" />} title="No devices yet"
              hint="Register managed serials or pair an iPad with a code."
              cta={{ label: "Add device", icon: <Plus size={16} />, onClick: () => setAddOpen(true), primary: true }} />
          ) : !filteredDevices.length ? (
            <EmptyState icon={<MagnifyingGlass weight="duotone" />} title="No devices match"
              hint="Try another search or clear the active filter."
              cta={{ label: "Clear filters", onClick: () => { setSearch(""); setFilter("all"); } }} />
          ) : (
            <>
              <Box display={{ base: "none", md: "block" }} overflowX="auto">
                <Table.Root size="sm" minW="900px">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Device</Table.ColumnHeader>
                      <Table.ColumnHeader>Scholar</Table.ColumnHeader>
                      <Table.ColumnHeader>Status</Table.ColumnHeader>
                      <Table.ColumnHeader>Lock</Table.ColumnHeader>
                      <Table.ColumnHeader>Battery</Table.ColumnHeader>
                      <Table.ColumnHeader>Management</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {filteredDevices.map((row) => (
                      <DeviceTableRow key={row.key} row={row}
                        pushResult={row.kind === "managed" ? effectivePushResult(row.device, pushResults[row.device._id]) : undefined}
                        verifyStatus={row.kind === "managed" ? verifyStatusOf(row.device) : undefined}
                        inventory={row.kind === "managed" ? snapshotOf(row.device) : undefined}
                        pairedDevice={row.kind === "manual" ? row.device : row.device.pairedDeviceId
                          ? pairedDevicesById.get(String(row.device.pairedDeviceId))
                          : undefined}
                        onOpen={() => setSelectedKey(row.key)} />
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
              <VStack display={{ base: "flex", md: "none" }} align="stretch" gap={2}>
                {filteredDevices.map((row) => (
                  <DeviceMobileRow key={row.key} row={row}
                    inventory={row.kind === "managed" ? snapshotOf(row.device) : undefined}
                    pairedDevice={row.kind === "manual" ? row.device : row.device.pairedDeviceId
                      ? pairedDevicesById.get(String(row.device.pairedDeviceId))
                      : undefined}
                    onOpen={() => setSelectedKey(row.key)} />
                ))}
              </VStack>
            </>
          )}
        </Box>
      </Surface>

      <CaptureStationsSection institutionScope={scopeParam} />

      <FallbackPayloads revealed={revealed} />

      <AddDeviceDialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          setAddPrefillSerials([]);
        }}
        scholars={scholars ?? []}
        institutionScope={scopeParam}
        prefillSerials={addPrefillSerials}
      />
      <AutoAssignDialog open={autoAssignOpen} onClose={() => setAutoAssignOpen(false)}
        scholars={availableScholars} availableDeviceCount={autoAssignableDevices.length}
        onAssign={handleAutoAssign} />
      <DeviceDetailsDrawer
        key={selectedDevice?.key ?? "closed"}
        row={selectedDevice}
        open={!!selectedDevice}
        onClose={() => setSelectedKey(null)} scholars={rosterScholarsSorted}
        assignedDeviceCounts={scholarDeviceCounts}
        simpleMdmPolicy={simpleMdmPolicy}
        pushResult={selectedDevice?.kind === "managed" ? effectivePushResult(selectedDevice.device, pushResults[selectedDevice.device._id]) : undefined}
        verifyStatus={selectedDevice?.kind === "managed" ? verifyStatusOf(selectedDevice.device) : undefined}
        inventory={selectedDevice?.kind === "managed" ? snapshotOf(selectedDevice.device) : undefined}
        pairedDevice={selectedPairedDevice}
        onAssign={handleAssign} onPush={pushDevice} onRename={renameManagedDevice}
        onClaimInvalidated={clearPushResult}
        onRevealed={(result) => setRevealed((current) => [result, ...current])}
        onCheckNow={() => void runVerify()}
        checkingSimpleMdm={checkingSimpleMdm} />
    </VStack>
  );
}

function DeviceTableRow({
  row,
  pushResult,
  verifyStatus,
  inventory,
  pairedDevice,
  onOpen,
}: {
  row: UnifiedDevice;
  pushResult?: PushResult;
  verifyStatus?: VerifyStatus;
  inventory?: SimpleMdmInventory;
  pairedDevice?: PairedDevice;
  onOpen: () => void;
}) {
  const managedDevice = row.kind === "managed" ? row.device : null;
  const manualDevice = row.kind === "manual" ? row.device : null;
  const device = row.device;
  const status = deviceStatus(row);
  const managedName = inventory?.name;
  const management = managementSummary(
    row,
    pushResult,
    verifyStatus,
    inventory,
  );
  return (
    <Table.Row
      cursor="pointer"
      h={DEVICE_ROW_MIN_H.desktop}
      // `td` inherits vertical-align from its row, so one prop centers every
      // cell in the reserved height.
      verticalAlign="middle"
      _hover={{ bg: "gray.50" }}
      onClick={onOpen}
    >
      <Table.Cell>
        <Button variant="plain" size="sm" p={0} h="auto" textAlign="left" onClick={(event) => { event.stopPropagation(); onOpen(); }}
          aria-label={`Open details for ${managedName ?? (managedDevice ? managedDevice.serial : manualDevice?.deviceLabel ?? "iPad")}`}>
          <HStack align="center" gap={2}>
            <Box color="charcoal.400" flexShrink={0}>
              <DeviceTablet size={20} weight="duotone" />
            </Box>
            <VStack align="start" gap={0}>
              <Text fontFamily={managedName || row.kind === "manual" ? "heading" : "mono"} fontWeight="600">
                {managedName ?? (managedDevice ? managedDevice.serial : manualDevice?.deviceLabel ?? "iPad")}
              </Text>
              {managedDevice && managedName && (
                <Text fontFamily="mono" fontSize="xs" color="charcoal.400">
                  {managedDevice.serial}
                </Text>
              )}
            </VStack>
          </HStack>
        </Button>
      </Table.Cell>
      <Table.Cell>
        {device.scholarId ? (
          <PersonCell
            name={device.scholarName ?? "Scholar"}
            image={device.scholarImage}
            colorKey={String(device.scholarId)}
          />
        ) : (
          <Text fontSize="sm" color="charcoal.400">—</Text>
        )}
      </Table.Cell>
      <Table.Cell>
        <HStack gap={1}>
          <LostModeBadge inventory={inventory} />
          <StatusBadge status={status} />
        </HStack>
      </Table.Cell>
      <Table.Cell><LockStatusBadge pairedDevice={pairedDevice} /></Table.Cell>
      <Table.Cell><BatteryStatus inventory={inventory} /></Table.Cell>
      <Table.Cell>
        <Text
          fontSize="sm"
          color={management.attention ? "orange.700" : "charcoal.600"}
          fontWeight={management.attention ? "600" : "400"}
        >
          {management.primary}
        </Text>
        {management.secondary && (
          <Text fontSize="xs" color="charcoal.400">
            {management.secondary}
          </Text>
        )}
      </Table.Cell>
    </Table.Row>
  );
}

function DeviceMobileRow({
  row,
  inventory,
  pairedDevice,
  onOpen,
}: {
  row: UnifiedDevice;
  inventory?: SimpleMdmInventory;
  pairedDevice?: PairedDevice;
  onOpen: () => void;
}) {
  const managedDevice = row.kind === "managed" ? row.device : null;
  const manualDevice = row.kind === "manual" ? row.device : null;
  const device = row.device;
  const reassign = managedDevice !== null && awaitingReassignment(managedDevice);
  const unpairNeeded = manualDevice?.scholarDeleted === true;
  return (
    <Box as="button" w="full" textAlign="left" borderWidth="1px" borderColor="gray.200" borderRadius="md"
      minH={DEVICE_ROW_MIN_H.mobile} display="flex" alignItems="center"
      p={3} onClick={onOpen} _hover={{ bg: "gray.50" }} _focusVisible={{ outline: "2px solid", outlineColor: "violet.500", outlineOffset: "2px" }}>
      <Flex flex="1" minW={0} justify="space-between" gap={3}>
        <HStack align="start" gap={2} minW={0}>
          <Box color="charcoal.400" mt={0.5} flexShrink={0}>
            <DeviceTablet size={20} weight="duotone" />
          </Box>
          <Box minW={0}>
            <Text fontFamily={inventory?.name || row.kind === "manual" ? "heading" : "mono"} fontWeight="600" truncate>
              {inventory?.name ?? (managedDevice ? managedDevice.serial : manualDevice?.deviceLabel ?? "iPad")}
            </Text>
            {device.scholarId ? (
              <Box mt={1}>
                <PersonCell
                  name={device.scholarName ?? "Scholar"}
                  image={device.scholarImage}
                  colorKey={String(device.scholarId)}
                />
              </Box>
            ) : (
              <Text fontSize="sm" color={reassign || unpairNeeded ? "orange.700" : "charcoal.500"}>
                {reassign
                  ? "Needs reassignment"
                  : unpairNeeded
                    ? "Needs unpairing"
                    : "No scholar assigned"}
              </Text>
            )}
            {(pairedDevice || inventory) && (
              <HStack mt={1} gap={3}>
                {pairedDevice && (
                  <LockStatusBadge pairedDevice={pairedDevice} />
                )}
                {inventory && <BatteryStatus inventory={inventory} />}
              </HStack>
            )}
          </Box>
        </HStack>
        <HStack gap={1} wrap="wrap" justify="flex-end">
          <LostModeBadge inventory={inventory} />
          <StatusBadge status={deviceStatus(row)} />
        </HStack>
      </Flex>
    </Box>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <Badge size="sm" variant="subtle" colorPalette="gray">{status}</Badge>;
}

function LostModeBadge({ inventory }: { inventory?: SimpleMdmInventory }) {
  if (inventory?.lostModeEnabled !== true) return null;
  return <Badge size="sm" variant="subtle" colorPalette="red">Lost Mode</Badge>;
}

function LockStatusBadge({
  pairedDevice,
}: {
  pairedDevice?: PairedDevice;
}) {
  if (!pairedDevice) {
    return <Text fontSize="sm" color="charcoal.400">—</Text>;
  }
  const armed = pairedDevice.rabbitholeLockDesiredState === "armed";
  const applied = pairedDevice.rabbitholeLockAppliedMatchesDesired;
  const label = applied
    ? armed
      ? "Armed"
      : "Disarmed"
    : armed
      ? "Arming"
      : "Disarming";
  return (
    <Badge
      size="sm"
      variant="subtle"
      colorPalette="gray"
    >
      {applied ? (
        armed ? <LockKey size={13} /> : <LockKeyOpen size={13} />
      ) : (
        <Spinner size="xs" borderWidth="1.5px" />
      )}
      {label}
    </Badge>
  );
}

function AddDeviceDialog({
  open,
  onClose,
  scholars,
  institutionScope,
  prefillSerials = [],
}: {
  open: boolean;
  onClose: () => void;
  scholars: PairableScholar[];
  institutionScope: string;
  /** Seeds the "Register serials" textarea (the unrostered-devices line). */
  prefillSerials?: string[];
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(event) => !event.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="lg" mx={4} borderRadius="xl">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                Add device
              </Dialog.Title>
            </Dialog.Header>
            {/* Mounted only while open, so both the pane choice and the
                textarea re-seed from a fresh mount on every open -- without
                ever remounting Dialog.Root, which leaks the body lock
                (engineering-principles.md). */}
            {open && (
              <AddDeviceBody
                onClose={onClose}
                scholars={scholars}
                institutionScope={institutionScope}
                prefillSerials={prefillSerials}
              />
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function AddDeviceBody({
  onClose,
  scholars,
  institutionScope,
  prefillSerials,
}: {
  onClose: () => void;
  scholars: PairableScholar[];
  institutionScope: string;
  prefillSerials: string[];
}) {
  const [pane, setPane] = useState<"register" | "pair">("register");
  return (
    <>
      <PaneTabs
        px={6}
        value={pane}
        onChange={setPane}
        items={[
          { value: "register", label: "Register serials" },
          { value: "pair", label: "Pair with a code" },
        ]}
      />
      {pane === "register" ? (
        <RegisterSerialsPane
          onClose={onClose}
          institutionScope={institutionScope}
          prefillSerials={prefillSerials}
        />
      ) : (
        <PairWithCodePane scholars={scholars} />
      )}
    </>
  );
}

function RegisterSerialsPane({
  onClose,
  institutionScope,
  prefillSerials,
}: {
  onClose: () => void;
  // The lens the roster is being READ at. Registering has to write into the
  // same school the operator is looking at, or the new row lands in another
  // institution and reads as a silent no-op.
  institutionScope: string;
  prefillSerials: string[];
}) {
  const register = useMutation(api.managedDeviceClaims.registerManagedDeviceSerials);
  // Seeded once per open: the pane is mounted by `{open && ...}`, so a fresh
  // open re-runs this initializer with whatever the opener supplied.
  const [pasteText, setPasteText] = useState(() => prefillSerials.join("\n"));
  const [registering, setRegistering] = useState(false);
  const [results, setResults] = useState<RegistrationResult[]>([]);
  const parsed = useMemo(() => parseSerialLines(pasteText), [pasteText]);
  const validRows = parsed.filter((row) => !row.error);

  async function submit() {
    if (!parsed.length) return;
    setRegistering(true);
    try {
      const response = await register({
        serials: parsed.map((row) => row.raw),
        institutionScope,
      });
      setResults(response.results);
      const feedback = registrationFeedback(response.results);
      toaster[feedback.status]({ title: feedback.title, description: feedback.description });
      if (feedback.added > 0) onClose();
    } catch (error) {
      toaster.error({ title: "Couldn't add those devices", description: error instanceof Error ? error.message : "Please try again." });
    } finally {
      setRegistering(false);
    }
  }

  return (
    <>
      <Dialog.Body px={6} py={4}>
        <Text fontSize="sm" color="charcoal.400" mb={4}>
          Register Apple serials now, then assign scholars from the device details.
        </Text>
        <Field.Root>
          <Field.Label>Paste serials — one per line</Field.Label>
          <Textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)}
            placeholder={"F9FZX2ABCDEF\nDMPTX1GHIJKL"} fontFamily="mono" rows={5} autoFocus />
        </Field.Root>
        {parsed.length > 0 && (
          <Text mt={3} fontSize="sm" color="charcoal.500">
            {validRows.length} ready{parsed.length !== validRows.length ? ` · ${parsed.length - validRows.length} to fix` : ""}
          </Text>
        )}
        {results.length > 0 && (
          <VStack align="stretch" mt={3} gap={1} aria-live="polite">
            {results.map((result, index) => (
              <Text key={`${result.serial}-${index}`} fontSize="xs" color={result.ok ? "green.700" : "orange.700"}>
                {result.serial || "Invalid serial"} · {result.ok ? "Added as unassigned" : result.error}
              </Text>
            ))}
          </VStack>
        )}
      </Dialog.Body>
      <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
        <Button variant="ghost" onClick={onClose}>{results.length ? "Done" : "Cancel"}</Button>
        <Button colorPalette="violet" disabled={!parsed.length || registering} loading={registering} onClick={() => void submit()}>
          <Check size={16} /> Add {validRows.length || ""} device{validRows.length === 1 ? "" : "s"}
        </Button>
      </Dialog.Footer>
    </>
  );
}

function PairWithCodePane({ scholars }: { scholars: PairableScholar[] }) {
  const approve = useMutation(api.devicePairing.approvePairingRequest);
  const [codeInput, setCodeInput] = useState("");
  const [scholarQuery, setScholarQuery] = useState("");
  const [selectedScholarId, setSelectedScholarId] = useState<Id<"users"> | null>(null);
  const [pairing, setPairing] = useState(false);
  const [justPaired, setJustPaired] = useState<JustPaired[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalized = normalizeCode(codeInput);
  const codeReady = normalized.length === CODE_LENGTH;
  const lookup = useQuery(
    api.devicePairing.lookupPairingRequestByCode,
    codeReady ? { code: normalized } : "skip",
  );
  const filteredScholars = useMemo(() => {
    const query = scholarQuery.trim().toLowerCase();
    return scholars.filter((scholar) =>
      !query ||
      (scholar.name ?? "").toLowerCase().includes(query) ||
      (scholar.username ?? "").toLowerCase().includes(query),
    );
  }, [scholarQuery, scholars]);
  const selectedScholar = scholars.find((scholar) => scholar._id === selectedScholarId) ?? null;

  function reset() {
    setCodeInput("");
    setScholarQuery("");
    setSelectedScholarId(null);
    inputRef.current?.focus();
  }
  async function pair() {
    if (!lookup || !selectedScholarId || !selectedScholar) return;
    setPairing(true);
    try {
      const result = await approve({ requestId: lookup.requestId, scholarId: selectedScholarId });
      setJustPaired((current) => [{
        key: `${lookup.requestId}-${Date.now()}`,
        scholarName: result.scholarName ?? "Scholar",
        scholarUsername: result.scholarUsername,
        deviceLabel: result.deviceLabel,
        at: Date.now(),
      }, ...current]);
      toaster.success({ title: `Paired to ${result.scholarName ?? "scholar"}`, description: "The iPad will sign in on its own." });
      reset();
    } catch (error) {
      toaster.error({ title: "Couldn't pair the device", description: error instanceof Error ? error.message : "Please try again." });
    } finally {
      setPairing(false);
    }
  }

  return (
    <>
      <Dialog.Body px={6} py={4}>
        <Field.Root>
          <Field.Label>Code shown on the iPad</Field.Label>
          <Input ref={inputRef} autoFocus value={formatCode(normalized)} onChange={(event) => setCodeInput(event.target.value)}
            placeholder="ABCD-EFGH" fontFamily="mono" fontSize="xl" letterSpacing="0.15em" maxW="sm"
            onKeyDown={(event) => {
              if (event.key === "Enter" && lookup && selectedScholarId) void pair();
            }} />
        </Field.Root>
        {codeReady && lookup === undefined && <HStack mt={3} color="charcoal.400"><Spinner size="sm" /><Text fontSize="sm">Looking up that code…</Text></HStack>}
        {codeReady && lookup === null && <Text mt={3} fontSize="sm" color="orange.700">No pending request for that code. Ask the iPad to show a fresh code.</Text>}
        {lookup && (
          <VStack align="stretch" mt={4} gap={3}>
            <Text fontSize="sm" color="charcoal.500">
              {lookup.deviceLabel ?? "iPad"} is waiting to pair.
              {lookup.existingBinding ? " Pairing again will sign the previous scholar out on this device." : ""}
            </Text>
            <Field.Root>
              <Field.Label>Pair to scholar</Field.Label>
              <Input value={scholarQuery} onChange={(event) => setScholarQuery(event.target.value)} placeholder="Search by name or username" />
            </Field.Root>
            <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" maxH="180px" overflowY="auto">
              {filteredScholars.map((scholar) => (
                <Button key={scholar._id} variant="ghost" justifyContent="space-between" w="full" borderRadius={0}
                  onClick={() => setSelectedScholarId(scholar._id)}
                  colorPalette={scholar._id === selectedScholarId ? "violet" : "gray"}>
                  <Box textAlign="left">
                    <Text fontSize="sm">{scholar.name ?? scholar.username ?? "Unnamed scholar"}</Text>
                    {scholar.username && <Text fontSize="xs">@{scholar.username}</Text>}
                  </Box>
                  {scholar._id === selectedScholarId && <Check size={16} />}
                </Button>
              ))}
            </Box>
          </VStack>
        )}
        {justPaired.length > 0 && (
          <Box mt={4} borderTopWidth="1px" borderColor="gray.100" pt={3}>
            <Text fontFamily="heading" fontWeight="600" fontSize="sm">Just paired</Text>
            {justPaired.map((entry) => (
              <Text key={entry.key} fontSize="sm" color="charcoal.500">
                {entry.deviceLabel ?? "iPad"} · {entry.scholarName}{entry.scholarUsername ? ` (@${entry.scholarUsername})` : ""} · {relativeTime(entry.at)}
              </Text>
            ))}
          </Box>
        )}
      </Dialog.Body>
      <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
        <Button variant="ghost" onClick={reset}>Clear</Button>
        <Button colorPalette="violet" disabled={!lookup || !selectedScholarId || pairing} loading={pairing} onClick={() => void pair()}>
          <Check size={16} /> {selectedScholar ? `Pair to ${selectedScholar.name ?? selectedScholar.username}` : "Pick a scholar"}
        </Button>
      </Dialog.Footer>
    </>
  );
}

function AutoAssignDialog({
  open,
  onClose,
  scholars,
  availableDeviceCount,
  onAssign,
}: {
  open: boolean;
  onClose: () => void;
  scholars: RosterScholar[];
  availableDeviceCount: number;
  onAssign: (scholarIds: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooMany = selected.size > availableDeviceCount;
  async function submit() {
    if (!selected.size || tooMany) return;
    setAssigning(true);
    setError(null);
    try {
      await onAssign([...selected]);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't auto assign those devices.");
    } finally {
      setAssigning(false);
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(event) => !event.open && onClose()} placement="center">
      <Portal><Dialog.Backdrop /><Dialog.Positioner><Dialog.Content maxW="lg" mx={4} borderRadius="xl">
        <Dialog.Header><Dialog.Title>Auto assign devices</Dialog.Title></Dialog.Header>
        <Dialog.Body>
          <Text fontSize="sm" color="charcoal.400" mb={4}>Choose scholars for the first available unassigned devices.</Text>
          <Field.Root invalid={tooMany || !!error}>
            <Box borderWidth="1px" borderColor={tooMany || error ? "red.300" : "gray.200"} borderRadius="lg" p={2}>
              <ScholarPickerContent mode="multi" selected={selected} onChange={(next) => { setSelected(next); setError(null); }}
                scholars={scholars} showGroups={false} showAffinityToggle={false} maxH="280px"
                showEnrollmentStanding
                emptyHint="Every scholar already has a managed device." />
            </Box>
            <Field.HelperText>{selected.size} selected · {availableDeviceCount} available</Field.HelperText>
            <Field.ErrorText>{tooMany ? `Select no more than ${availableDeviceCount} scholars.` : error}</Field.ErrorText>
          </Field.Root>
        </Dialog.Body>
        <Dialog.Footer><Button variant="ghost" onClick={onClose} disabled={assigning}>Cancel</Button>
          <Button colorPalette="violet" disabled={!selected.size || tooMany || assigning} loading={assigning} onClick={() => void submit()}>
            <MagicWand size={16} /> Assign {selected.size || ""}
          </Button>
        </Dialog.Footer>
      </Dialog.Content></Dialog.Positioner></Portal>
    </Dialog.Root>
  );
}

const BATTERY_APPEARANCE: Record<Exclude<DeviceBatteryBand, "unknown">, { icon: typeof BatteryLow; color: string }> = {
  low: { icon: BatteryLow, color: "red.500" },
  medium: { icon: BatteryMedium, color: "charcoal.400" },
  high: { icon: BatteryHigh, color: "charcoal.400" },
  full: { icon: BatteryFull, color: "charcoal.400" },
};

function BatteryStatus({
  inventory,
  detailed = false,
}: {
  inventory?: SimpleMdmInventory;
  detailed?: boolean;
}) {
  const band = deviceBatteryBand(inventory?.batteryLevel ?? null);
  if (band === "unknown" || inventory?.batteryLevel == null) {
    return (
      <Text fontSize="sm" color="charcoal.400">
        {detailed ? "Battery unavailable" : "—"}
      </Text>
    );
  }
  const { icon: Icon, color } = BATTERY_APPEARANCE[band];
  return (
    <HStack gap={2}>
      <Box color={color}>
        <Icon size={18} />
      </Box>
      <Text fontSize="sm">
        {detailed ? "Battery " : ""}
        {inventory.batteryLevel}%
      </Text>
    </HStack>
  );
}

type AppAccessRow = ManagedDevice["appAccess"][number];

/** One visual vocabulary for every cell in the truth panel. Colour is
 *  per-cell, never per-row: the whole point of the panel is to show *which*
 *  fact disagrees, so a row-wide tint would erase the answer. `ok` is quiet
 *  green; `off` is neutral (a fact being "no" is only a problem in context);
 *  `problem` is the page's one existing attention colour; `pending` and
 *  `unknown` are muted. */
type AppAccessCell = {
  icon: Icon;
  tone: "ok" | "off" | "problem" | "pending" | "unknown";
  label: string;
  /** Extra hover lines: timestamps, the projector's ETA, the last error. */
  detail?: string[];
};

type AppAccessProjection = ManagedDevice["appAccessProjection"];

const APP_ACCESS_TONE_COLOR: Record<AppAccessCell["tone"], string> = {
  ok: "green.700",
  off: "charcoal.400",
  problem: "orange.700",
  // In flight is its own hue, distinct from both a plain "no" and a fault:
  // a landing change is the ordinary shape of a fresh grant.
  pending: "violet.500",
  unknown: "charcoal.300",
};

/** Gentle opacity pulse for cells whose state is in flight. */
const APP_ACCESS_PULSE = "app-access-pulse 1.6s ease-in-out infinite";
const APP_ACCESS_PULSE_KEYFRAMES =
  "@keyframes app-access-pulse{0%,100%{opacity:1}50%{opacity:.35}}";

/** The PRODUCT of the four facts, rendered as the panel's primary answer.
 *  Staff arrive asking "can she open it?", not "is it in the allowlist?" —
 *  the four facts are the evidence, and this is the verdict they support. */
const APP_ACCESS_VERDICT: Record<
  AppAccessRow["onDevice"],
  { icon: Icon; color: string; word: string }
> = {
  yes: { icon: CheckCircle, color: "green.700", word: "Yes" },
  "launcher-only": { icon: WarningCircle, color: "orange.700", word: "Launcher only" },
  landing: { icon: Clock, color: "violet.500", word: "Landing" },
  no: { icon: XCircle, color: "charcoal.700", word: "No" },
  unknown: { icon: Question, color: "charcoal.400", word: "Unknown" },
};

/** A block-scoped app outside its window (the 2026-09-15 ruling). The iPad's
 *  answer is "no", and the Granted fact is "no", but the app is working as
 *  scheduled; reading that as a missing grant is how Scratch went back to
 *  24/7 on 2026-09-21 (TRA-444). So the verdict names the real state. */
function appAccessOutsideSchedule(row: AppAccessRow): boolean {
  return row.blocker === "grant" && row.schedule.length > 0;
}

const APP_ACCESS_NOT_NOW_VERDICT = {
  icon: CalendarBlank,
  color: "charcoal.700",
  word: "Not now",
};

const APP_ACCESS_VERDICT_HELP =
  "Can the scholar holding this iPad open this app right now? It is the product of the four facts to the right — click it for the reason and the fix.";

/** Why the verdict is what it is, and what to do about it. One sentence each:
 *  the reason names the blocking fact, the fix names the next action. */
/** A projection is "stalled" only once it has recorded an error or blown its
 *  own operation lease. An ordinary in-flight push is not stalled, and offering
 *  to re-send it would invite staff to hammer SimpleMDM for nothing.
 *  Reads only the projector's operation clock. `mdmAcceptedAt` and
 *  `expectedAvailableAt` belong to the device's unlock lease, which the
 *  projection never writes, so an old unlock would otherwise brand every new
 *  change as failed the moment it was made.
 *  `now` is passed in (not read from the clock) so the caller's ticking render
 *  is what makes a projection go stale on screen, rather than the panel
 *  silently keeping "nothing to do" until some unrelated update repaints it. */
function appAccessProjectionStalled(projection: AppAccessProjection, now: number): boolean {
  if (!projection) return false;
  if (projection.lastError) return true;
  return (
    projection.operationKind === "projection" &&
    !!projection.operationStartedAt &&
    projection.operationStartedAt + PROJECTION_OPERATION_TIMEOUT_MS < now
  );
}

function appAccessBlockerCopy(
  row: AppAccessRow,
  scholarName: string | null,
  overdue: boolean,
): { reason: string; fix: string } {
  const who = scholarName ?? "The assigned scholar";
  switch (row.blocker) {
    case "scholar":
      return {
        reason: "This iPad has no scholar assigned, so nobody holds a grant for it.",
        fix: "Assign a scholar first.",
      };
    case "binding":
      return {
        reason: "This iPad has no dedicated allowlist profile, so nothing can be allowed or blocked per app.",
        fix: "Provision it with scripts/provision-device-app-unlock.mjs.",
      };
    case "grant":
      // Say how the scholar does reach the app before offering more: a
      // block-scoped app outside its window is the schedule working. Not
      // "because it's outside those times" — a block its teacher wrapped up
      // early, or a day the school is closed, lands here too.
      return row.schedule.length > 0
        ? {
            reason: `${row.label} opens for ${who} during ${scheduleWindowsPhrase(row.schedule)}, and it isn't open right now.`,
            fix: "Access follows the schedule. For extra time, open it for today or until a day you pick; it closes on its own.",
          }
        : {
            reason: `${who} can't open ${row.label}: it isn't granted to them, and none of their classes' blocks opens it.`,
            fix: "Open it for today or until a day you pick. It usually lands on the iPad within a few minutes and closes on its own.",
          };
    case "allowlist":
      return row.allowed === "pending"
        ? overdue
          ? {
              // Covers both a PATCH that blew its lease and a sweep that never
              // ran. The progress block directly above names which, so this
              // sentence does not have to guess.
              reason: "A change to this iPad's allowlist has not landed when it should have.",
              fix: "Re-sync to make the projector send it again.",
            }
          : {
              reason: "A change to this iPad's allowlist is still being processed.",
              fix: "Nothing to do — it should appear on its own.",
            }
        : {
            reason: `${row.label} is granted, but the iPad's projected allowlist does not carry it — the shape of the 2026-08-31 incident.`,
            fix: "Re-sync to make the projector re-apply this iPad's allowlist.",
          };
    case "inventory":
      return {
        reason: "SimpleMDM has never reported this iPad's installed apps, so we cannot say whether it is there.",
        fix: "Use Check now above to ask SimpleMDM.",
      };
    case "install":
      return {
        reason: `${row.label} is allowed, but SimpleMDM's last inventory did not find it on this iPad.`,
        fix: "An unlicensed managed install silently does nothing — check the app's licence in Apple School Manager.",
      };
    case "tile":
      return row.tiled === null
        ? {
            reason: "No accepted home-screen projection for this iPad yet, so we cannot say whether the app has a tile.",
            fix: "Re-sync to make the projector record this iPad's home layout.",
          }
        : {
            reason: "This iPad's projected home layout has no tile for this app, so it is not on the home screen.",
            fix: `${who} can still open it from the Rabbithole launcher.`,
          };
    default:
      return {
        reason: `${row.label} is allowed, installed, and on the home screen.`,
        fix: "Nothing to do.",
      };
  }
}

const APP_ACCESS_COLUMNS: { header: string; help: string }[] = [
  {
    header: "Granted",
    help: "Can the assigned scholar use this app right now, through a grant or a class block that is open? This is the one authority; everything to the right should agree with it. A calendar means their schedule opens it at other times.",
  },
  {
    header: "Allowed",
    help: "Is the app in this iPad's projected allowlist (the per-device profile SimpleMDM last accepted)? Clock = a change is still landing. Broken link = the iPad has no allowlist binding at all.",
  },
  {
    header: "Installed",
    help: "Did SimpleMDM's last inventory show the app on this iPad? Dash = apps have not been inventoried yet (use Check now).",
  },
  {
    header: "Tiled",
    help: "Is the app in this iPad's accepted projected Home Screen layout? Dash = no projection recorded yet, so the layout is unknown; Pilot uses its committed Pilot layout.",
  },
];

function appAccessGrantedCell(row: AppAccessRow, todayDayKey: string): AppAccessCell {
  if (row.granted === null) return { icon: MinusCircle, tone: "unknown", label: "No scholar assigned" };
  if (row.granted) {
    return row.grantThroughDay
      ? {
          icon: CheckCircle,
          tone: "ok",
          label: `Granted through ${throughDayPhrase(row.grantThroughDay, todayDayKey)}`,
          detail: [closesPhrase(row.grantThroughDay, todayDayKey)],
        }
      : { icon: CheckCircle, tone: "ok", label: "Granted" };
  }
  // A fact about the grant alone, so not tied to the verdict's first blocker:
  // while the app is still leaving the iPad (a change landing), the verdict
  // says so, and this still says when the schedule opens it.
  return row.schedule.length > 0
    ? {
        icon: CalendarBlank,
        tone: "off",
        label: "Not now",
        detail: [`Opens during ${scheduleWindowsPhrase(row.schedule)}.`],
      }
    : { icon: XCircle, tone: "off", label: "Not granted" };
}

/** Downstream facts are a problem only when the grant says yes and they
 *  disagree — the exact shape of the 2026-08-31 incident. */
function appAccessAllowedCell(
  row: AppAccessRow,
  projection: AppAccessProjection,
): AppAccessCell {
  const expected = row.granted === true;
  const applied = projection?.appliedAt ?? null;
  // Projection clocks only. `mdmAcceptedAt` and `expectedAvailableAt` are the
  // unlock lease's, and an old unlock would date this change wrongly. Whether
  // a change is overdue has one home — the progress block in the verdict
  // popover — so this hover states facts and leaves the judgement there.
  const landing: string[] = [];
  if (projection?.operationStartedAt && projection.operationKind === "projection") {
    landing.push(`Sent to SimpleMDM ${relativeTime(projection.operationStartedAt)}`);
  } else if (projection?.updatedAt) {
    landing.push(`Requested ${relativeTime(projection.updatedAt)}`);
  }
  if (projection?.dueAt != null) {
    if (projection.dueAt <= 0) {
      landing.push("Projector retries immediately");
    } else if (projection.dueAt > Date.now()) {
      landing.push(`Projector retries ${relativeClock(projection.dueAt)}`);
    }
  }
  if (projection?.lastError) landing.push(`Last error: ${projection.lastError}`);
  switch (row.allowed) {
    case "yes":
      return {
        icon: CheckCircle,
        tone: "ok",
        label: "Allowed",
        detail: applied ? [`Allowlist applied ${relativeTime(applied)}`] : undefined,
      };
    case "no":
      return {
        icon: XCircle,
        tone: expected ? "problem" : "off",
        label: "Not allowed",
        detail: expected ? ["Granted but not in the projected allowlist — Re-sync should fix this."] : undefined,
      };
    case "pending":
      return {
        icon: Clock,
        tone: "pending",
        label: "Allowlist change still landing",
        detail: landing,
      };
    case "not-bound":
      return {
        icon: LinkBreak,
        tone: expected ? "problem" : "unknown",
        label: "No allowlist binding for this iPad",
        detail: ["Provisioning has not given this iPad a dedicated profile yet (scripts/provision-device-app-unlock.mjs)."],
      };
  }
}

function appAccessInstalledCell(row: AppAccessRow): AppAccessCell {
  const expected = row.granted === true;
  if (row.installed === null) {
    return { icon: MinusCircle, tone: "unknown", label: "Apps not inventoried yet", detail: ["Use Check now to ask SimpleMDM."] };
  }
  const at = row.installedCheckedAt ? [`Inventoried ${relativeTime(row.installedCheckedAt)}`] : undefined;
  return row.installed
    ? { icon: CheckCircle, tone: "ok", label: "Installed", detail: at }
    : {
        icon: XCircle,
        tone: expected ? "problem" : "off",
        label: "Not installed",
        detail: expected
          ? [...(at ?? []), "Granted and allowed but SimpleMDM has not seen it on the iPad — check the app's licence in ASM."]
          : at,
      };
}

function appAccessTiledCell(row: AppAccessRow): AppAccessCell {
  const expected = row.granted === true;
  if (row.tiled === null) {
    return {
      icon: MinusCircle,
      tone: "unknown",
      label: "Home screen not projected yet",
      detail: ["No accepted home-screen projection for this iPad, so its tiles are unknown."],
    };
  }
  return row.tiled
    ? { icon: CheckCircle, tone: "ok", label: "On the home screen", detail: ["Per this iPad's projected home layout."] }
    : {
        icon: XCircle,
        tone: expected ? "problem" : "off",
        label: "Not on the home screen",
        detail: expected
          ? ["Granted, but this iPad's projected home layout has no tile for it — the scholar can open it only from the Rabbithole launcher."]
          : undefined,
      };
}

function AppAccessCellIcon({ cell }: { cell: AppAccessCell }) {
  const Icon = cell.icon;
  return (
    <Tooltip.Root openDelay={300} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <Box
          as="span"
          display="inline-flex"
          color={APP_ACCESS_TONE_COLOR[cell.tone]}
          aria-label={cell.label}
          role="img"
          css={cell.tone === "pending" ? {
            animation: APP_ACCESS_PULSE,
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          } : undefined}
        >
          <Icon size={16} weight={cell.tone === "problem" || cell.tone === "pending" ? "fill" : "regular"} />
        </Box>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content fontFamily="heading" fontSize="xs" maxW="280px">
            <Text fontWeight="600">{cell.label}</Text>
            {cell.detail?.map((line) => (
              <Text key={line} color="whiteAlpha.800">
                {line}
              </Text>
            ))}
          </Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

/**
 * The primary cell: the verdict, plus the actions that would change it.
 * A popover rather than a tooltip because the fix belongs WITH the reason —
 * staff should not have to read the reason here and then go hunting for the
 * grant surface. Extra access goes through the ordinary scholar-app paths
 * (`scholarApps.openForScholar`, which ends on its own, and, behind a
 * warning, the standing `addToScholar`), so this adds a second door, not a
 * second authority.
 */
/** A clock that ticks only while something is actually in flight. The landing
 *  progress bar and the "has this missed its estimate?" test are both derived
 *  from the current time, so without a tick the panel would keep rendering a
 *  stale ETA — and keep saying "nothing to do" past the moment it stopped
 *  being true — until some unrelated Convex update repainted it. */
function useTick(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

function AppAccessVerdictCell({
  row,
  device,
  projection,
  onResync,
  resyncing,
  onCheckNow,
  checking,
}: {
  row: AppAccessRow;
  device: ManagedDevice;
  projection: AppAccessProjection;
  onResync: () => void;
  resyncing: boolean;
  onCheckNow: (() => void) | null;
  checking: boolean;
}) {
  const verdict = appAccessOutsideSchedule(row)
    ? APP_ACCESS_NOT_NOW_VERDICT
    : APP_ACCESS_VERDICT[row.onDevice];
  const VerdictIcon = verdict.icon;
  const landing = row.onDevice === "landing";
  const now = useTick(landing);
  const stalled = appAccessProjectionStalled(projection, now);
  // Which of the three real clocks this change is on, and how far through it
  // is. Only meaningful while landing; skipped entirely otherwise.
  const progress = landing
    ? landingProgress({
        allowed: row.allowed === "pending" ? "pending" : "settled",
        operationStartedAt: projection?.operationStartedAt ?? null,
        operationKind: projection?.operationKind ?? null,
        projectionAppliedAt: projection?.appliedAt ?? null,
        projectionDueAt: projection?.dueAt ?? null,
        installedCheckedAt: row.installedCheckedAt ?? null,
        now,
      })
    : null;
  // A push that has missed its own window, by either measure: an error or a
  // spent lease, or a sweep that never came.
  const overdue = stalled || progress?.overdue === true;
  const { reason, fix } = appAccessBlockerCopy(
    row,
    device.scholarName,
    overdue,
  );
  const openForScholar = useMutation(api.scholarApps.openForScholar);
  const addToScholar = useMutation(api.scholarApps.addToScholar);
  const resync = useMutation(api.managedDeviceClaims.resyncManagedDeviceProjection);
  const firstName = device.scholarName?.split(" ")[0] ?? "the scholar";
  const canGrant = row.blocker === "grant" && !!row.appId && !!device.scholarId;
  // Extra access ends on its own by default (TRA-444; Andy, 2026-09-28): a
  // grant that never ends sits behind its own step and warning, so a click
  // made while misreading this panel cannot leave an app open all year.
  const [extra, setExtra] = useState<"idle" | "until" | "standing">("idle");
  // Opening a step unmounts the button that opened it, and closing one
  // unmounts its controls. Focus goes with them, the drawer's focus trap moves
  // it out of this popover, and the popover closes. So focus always moves to
  // what replaced it: the date field, the warning's Cancel (a double Enter
  // must not confirm the warning unread), or back to the step's button.
  const [returnFocus, setReturnFocus] = useState<"until" | "standing" | null>(null);
  // Cancel takes focus on the warning, so both its buttons carry the warning
  // as their description: a screen reader says it before either is pressed.
  const warningId = useId();
  const openStep = (step: "until" | "standing") => {
    setReturnFocus(null);
    setExtra(step);
  };
  const closeStep = () => {
    setReturnFocus(extra === "idle" ? null : extra);
    setExtra("idle");
  };
  const [untilDay, setUntilDay] = useState(() => shiftDayKey(device.todayDayKey, 1));
  const [granting, setGranting] = useState<"today" | "until" | "standing" | null>(null);
  const grant = async (kind: "today" | "until" | "standing") => {
    if (!row.appId || !device.scholarId) return;
    const target = {
      scholarId: device.scholarId as Id<"users">,
      appId: row.appId as Id<"externalApps">,
    };
    setGranting(kind);
    setReturnFocus(null);
    try {
      let title: string;
      let description: string;
      if (kind === "standing") {
        await addToScholar(target);
        title = `${row.label} allowed at all hours`;
        description = `${firstName} should have it on this iPad within a few minutes. It stays until someone removes it.`;
      } else {
        // Opening never shortens access, so this can answer with a later day
        // than the one asked for, or none when the add is already standing.
        const { throughDay } = await openForScholar(
          kind === "until" ? { ...target, throughDay: untilDay } : target,
        );
        if (throughDay) {
          title = `${row.label} open for ${firstName} through ${throughDayPhrase(throughDay, device.todayDayKey)}`;
          description = `It lands on this iPad within a few minutes. ${closesPhrase(throughDay, device.todayDayKey)}`;
        } else {
          title = `${row.label} is already allowed at all hours`;
          description = `${firstName} has it until someone removes it.`;
        }
      }
      // Grant, then pull the projector's next pass forward, so one click
      // genuinely starts the app moving rather than waiting out a cron tick.
      await resync({ managedDeviceId: device._id }).catch(() => undefined);
      toaster.success({ title, description });
      setExtra("idle");
    } catch (error) {
      toaster.error({
        title: kind === "standing" ? "Couldn't allow it at all hours" : "Couldn't open it",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setGranting(null);
    }
  };

  return (
    <Popover.Root positioning={{ placement: "bottom-start" }}>
      <Popover.Trigger asChild>
        <Button
          size="xs"
          variant="ghost"
          px={1}
          h="auto"
          py={1}
          color={verdict.color}
          fontWeight="700"
          aria-label={`On this iPad: ${verdict.word}`}
        >
          <HStack gap={1.5}>
            <Box
              as="span"
              display="inline-flex"
              css={row.onDevice === "landing" ? {
                animation: APP_ACCESS_PULSE,
                "@media (prefers-reduced-motion: reduce)": { animation: "none" },
              } : undefined}
            >
              <VerdictIcon size={18} weight={row.onDevice === "yes" ? "regular" : "fill"} />
            </Box>
            <Text as="span" fontFamily="heading" fontSize="sm">
              {verdict.word}
            </Text>
          </HStack>
        </Button>
      </Popover.Trigger>
      {/* Not portalled: this cell lives in the device drawer, a modal Ark
          dialog that hides everything outside it from assistive tech and
          pulls focus back inside. Portalled to <body>, the "Open until…"
          date field and the "Allow at all hours" confirmation lost focus to
          that trap and closed the popover before they could be used. */}
      <Popover.Positioner>
        <Popover.Content w="320px">
          <Popover.Body p={3}>
            <VStack align="stretch" gap={2}>
              <Text fontSize="sm" fontWeight="600" color={verdict.color}>
                {row.label} — {verdict.word.toLowerCase()}
              </Text>
              <Text fontSize="xs" color="charcoal.600">
                {reason}
              </Text>
              <Text fontSize="xs" color="charcoal.500">
                {fix}
              </Text>
              {row.granted && row.grantThroughDay && (
                <Text fontSize="xs" color="charcoal.500">
                  Opened for {firstName} through{" "}
                  {throughDayPhrase(row.grantThroughDay, device.todayDayKey)}.{" "}
                  {closesPhrase(row.grantThroughDay, device.todayDayKey)}
                </Text>
              )}
              {progress && (
                <Box
                  borderWidth="1px"
                  borderColor="charcoal.100"
                  borderRadius="md"
                  p={2}
                  bg="gray.50"
                >
                  <HStack justify="space-between" gap={2} mb={1.5}>
                    <Text fontSize="xs" fontWeight="600" color="charcoal.700">
                      {progress.label}
                    </Text>
                    <Text
                      fontSize="xs"
                      color={progress.overdue ? "orange.700" : "charcoal.500"}
                      whiteSpace="nowrap"
                    >
                      {progress.overdue
                        ? "overdue"
                        : progress.phase === "sending"
                          ? ""
                          : etaLabel(progress.etaMs)}
                    </Text>
                  </HStack>
                  <Progress.Root
                    value={progress.pct}
                    size="xs"
                    colorPalette={progress.overdue ? "orange" : "violet"}
                    aria-label={`${progress.label}, ${progress.pct}% of the expected wait`}
                  >
                    <Progress.Track borderRadius="full">
                      <Progress.Range borderRadius="full" />
                    </Progress.Track>
                  </Progress.Root>
                  <Text fontSize="xs" color="charcoal.500" mt={1.5}>
                    {progress.typical}
                  </Text>
                  {progress.overdue && progress.phase !== "queued" && (
                    <Text fontSize="xs" color="charcoal.500" mt={1}>
                      The projector sweeps every{" "}
                      {Math.round(PROJECTION_SWEEP_MS / 60_000)} minutes even if nobody
                      touches it.
                    </Text>
                  )}
                </Box>
              )}
              {progress?.phase === "confirming" && onCheckNow && (
                <Button size="xs" variant="outline" loading={checking} onClick={onCheckNow}>
                  <ArrowClockwise size={14} />
                  Check now
                </Button>
              )}
              {canGrant && (
                <VStack align="stretch" gap={2} pt={1}>
                  <Button
                    size="sm"
                    colorPalette="violet"
                    loading={granting === "today"}
                    disabled={granting !== null}
                    onClick={() => void grant("today")}
                  >
                    <Plus size={14} />
                    Open all day today
                  </Button>
                  {extra === "until" ? (
                    <Box borderWidth="1px" borderColor="charcoal.100" borderRadius="md" p={2}>
                      <Field.Root>
                        <Field.Label fontSize="xs">Last day</Field.Label>
                        <Input
                          type="date"
                          size="sm"
                          autoFocus
                          min={device.todayDayKey}
                          value={untilDay}
                          onChange={(event) => setUntilDay(event.target.value)}
                        />
                        <Field.HelperText fontSize="xs">
                          It closes on its own at the end of that day.
                        </Field.HelperText>
                      </Field.Root>
                      <HStack mt={2} gap={2}>
                        <Button
                          size="sm"
                          colorPalette="violet"
                          loading={granting === "until"}
                          disabled={
                            granting !== null ||
                            !/^\d{4}-\d{2}-\d{2}$/.test(untilDay) ||
                            untilDay < device.todayDayKey
                          }
                          onClick={() => void grant("until")}
                        >
                          {/^\d{4}-\d{2}-\d{2}$/.test(untilDay)
                            ? `Open through ${throughDayPhrase(untilDay, device.todayDayKey)}`
                            : "Open through…"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={closeStep}>
                          Cancel
                        </Button>
                      </HStack>
                    </Box>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      autoFocus={returnFocus === "until"}
                      disabled={granting !== null}
                      onClick={() => openStep("until")}
                    >
                      Open until…
                    </Button>
                  )}
                  {extra === "standing" ? (
                    <Box
                      borderWidth="1px"
                      borderColor="orange.200"
                      bg="orange.50"
                      borderRadius="md"
                      p={2}
                    >
                      <HStack align="start" gap={2}>
                        <Box color="orange.700" mt={0.5} flexShrink={0}>
                          <WarningCircle size={16} weight="fill" />
                        </Box>
                        <Text id={warningId} fontSize="xs" color="orange.800">
                          This makes {row.label} available at all hours, every
                          day, until someone removes it.
                        </Text>
                      </HStack>
                      <HStack mt={2} gap={2}>
                        <Button
                          size="sm"
                          colorPalette="orange"
                          aria-describedby={warningId}
                          loading={granting === "standing"}
                          disabled={granting !== null}
                          onClick={() => void grant("standing")}
                        >
                          Allow at all hours
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          autoFocus
                          aria-describedby={warningId}
                          onClick={closeStep}
                        >
                          Cancel
                        </Button>
                      </HStack>
                    </Box>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      color="charcoal.500"
                      autoFocus={returnFocus === "standing"}
                      disabled={granting !== null}
                      onClick={() => openStep("standing")}
                    >
                      Allow at all hours…
                    </Button>
                  )}
                </VStack>
              )}
              {/* No button while a push is doing its normal work; one the
                  moment it is not. `stalled` catches a recorded error or a
                  PATCH past its lease, but a sweep that simply never ran
                  leaves the row pending with neither — which is exactly the
                  failure a human needs to nudge. */}
              {row.blocker === "allowlist" &&
                (row.allowed !== "pending" || overdue) && (
                <Button size="xs" variant="outline" loading={resyncing} onClick={onResync}>
                  <ArrowClockwise size={14} />
                  Re-sync
                </Button>
              )}
            </VStack>
          </Popover.Body>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
}

function AppAccessColumnHeader({
  header,
  help,
  secondary,
}: {
  header: string;
  help: string;
  /** Evidence columns are supporting detail for the verdict, and are set
   *  lighter so the answer reads first. */
  secondary?: boolean;
}) {
  return (
    <Table.ColumnHeader
      fontSize={secondary ? "xs" : undefined}
      color={secondary ? "charcoal.400" : undefined}
      fontWeight={secondary ? "500" : undefined}
    >
      <Tooltip.Root openDelay={300} closeDelay={0}>
        <Tooltip.Trigger asChild>
          <Text
            as="span"
            cursor="help"
            textDecoration="underline dotted"
            textDecorationColor="charcoal.300"
            textUnderlineOffset="3px"
          >
            {header}
          </Text>
        </Tooltip.Trigger>
        <Portal>
          <Tooltip.Positioner>
            <Tooltip.Content fontFamily="heading" fontSize="xs" maxW="260px">
              {help}
            </Tooltip.Content>
          </Tooltip.Positioner>
        </Portal>
      </Tooltip.Root>
    </Table.ColumnHeader>
  );
}

/**
 * "App access" — the device truth panel (TRA-241 step 1). Four stored facts
 * per managed app, side by side, so a disagreement between them (the shape of
 * the 2026-08-31 incident) is visible at a glance instead of requiring staff
 * to cross-reference three separate systems. Every cell is read from already-
 * stored state; this component never calls SimpleMDM.
 */
function AppAccessSection({
  device,
  onCheckNow,
  checking,
}: {
  device: ManagedDevice;
  onCheckNow: (() => void) | null;
  checking: boolean;
}) {
  const rows = device.appAccess;
  const projection = device.appAccessProjection;
  const checkedAt = rows.find((row) => row.installedCheckedAt !== null)
    ?.installedCheckedAt;
  const resync = useMutation(api.managedDeviceClaims.resyncManagedDeviceProjection);
  const [resyncing, setResyncing] = useState(false);
  const doResync = useCallback(async () => {
    setResyncing(true);
    try {
      const result = await resync({ managedDeviceId: device._id });
      if (result.nudged) {
        toaster.success({ title: "Re-sync requested", description: "The projector will re-apply this iPad's allowlist within a minute." });
      } else {
        toaster.error({ title: "Nothing to re-sync", description: "This iPad has no allowlist binding yet." });
      }
    } catch (error) {
      toaster.error({ title: "Couldn't re-sync", description: error instanceof Error ? error.message : undefined });
    } finally {
      setResyncing(false);
    }
  }, [resync, device._id]);
  const clocks = [
    checkedAt != null ? `Apps checked ${relativeTime(checkedAt)}` : "Apps not yet checked",
    projection?.appliedAt ? `Allowlist applied ${relativeTime(projection.appliedAt)}` : null,
  ].filter((line): line is string => line !== null);
  // A removed registration of this iPad that never finished relocking its old
  // profile. Nothing else on the console can show it: its roster row is gone.
  const teardown = device.unfinishedTeardown;
  // With no scholar, every app row's verdict stops at "no scholar", so its
  // popover never shows the projector's error (the Allowed hover does only
  // while a change is pending), yet the reset to baseline keeps retrying. A
  // deleted scholar's iPad is the case that needs it (TRA-434).
  const resetError = device.scholarId ? null : (projection?.lastError ?? null);
  return (
    <VStack align="stretch" gap={2}>
      <style>{APP_ACCESS_PULSE_KEYFRAMES}</style>
      {teardown && (
        <Text fontSize="xs" color="orange.700">
          {teardown.stopped
            ? `An earlier registration of this iPad couldn't reset its old app-access profile (SimpleMDM ${teardown.simpleMdmProfileId}) to the locked baseline, and has stopped retrying. Don't re-assign that profile: it may still allow the previous scholar's apps. If it's installed on no iPad, delete it in SimpleMDM, then ask an engineer to clear this record.`
            : `An earlier registration of this iPad is still resetting its old app-access profile (SimpleMDM ${teardown.simpleMdmProfileId}) to the locked baseline, and retries on its own. If that profile is installed on no iPad, deleting it in SimpleMDM lets the next retry finish.`}
          {teardown.lastError ? ` Last error: ${teardown.lastError}` : ""}
        </Text>
      )}
      {resetError && (
        <Text fontSize="xs" color="orange.700">
          This iPad is still resetting its app-access profile to the locked
          baseline, and retries on its own. Last error: {resetError}
        </Text>
      )}
      <Table.Root size="sm">
        <Table.Header>
          <Table.Row>
            <AppAccessColumnHeader
              header="App"
              help="Which managed app is this row describing?"
            />
            <AppAccessColumnHeader header="On this iPad" help={APP_ACCESS_VERDICT_HELP} />
            {APP_ACCESS_COLUMNS.map((col) => (
              <AppAccessColumnHeader key={col.header} {...col} secondary />
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row) => (
            <Table.Row key={row.key}>
              <Table.Cell>
                <Text fontSize="sm" fontWeight="600">
                  {row.label}
                </Text>
              </Table.Cell>
              <Table.Cell borderRightWidth="1px" borderColor="charcoal.100">
                <AppAccessVerdictCell
                  row={row}
                  device={device}
                  projection={projection}
                  onResync={() => void doResync()}
                  resyncing={resyncing}
                  onCheckNow={onCheckNow}
                  checking={checking}
                />
              </Table.Cell>
              <Table.Cell><AppAccessCellIcon cell={appAccessGrantedCell(row, device.todayDayKey)} /></Table.Cell>
              <Table.Cell><AppAccessCellIcon cell={appAccessAllowedCell(row, projection)} /></Table.Cell>
              <Table.Cell><AppAccessCellIcon cell={appAccessInstalledCell(row)} /></Table.Cell>
              <Table.Cell><AppAccessCellIcon cell={appAccessTiledCell(row)} /></Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <HStack justify="space-between" align="center">
        <Text fontSize="xs" color="charcoal.400">
          {clocks.join(" · ")}
        </Text>
        {projection && (
          <Button size="xs" variant="ghost" loading={resyncing} onClick={() => void doResync()}>
            <ArrowClockwise size={14} />
            Re-sync
          </Button>
        )}
      </HStack>
    </VStack>
  );
}

function DeviceActionContent({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <HStack as="span" align="start" gap={3} w="full">
      <Box as="span" mt={0.5} color="currentColor" flexShrink={0}>
        {icon}
      </Box>
      <Box as="span" minW={0}>
        <Text as="span" display="block" fontWeight="600" lineHeight="short">
          {title}
        </Text>
        <Text
          as="span"
          display="block"
          mt={1}
          fontSize="xs"
          fontWeight="400"
          lineHeight="short"
          color="charcoal.400"
          whiteSpace="normal"
        >
          {description}
        </Text>
      </Box>
    </HStack>
  );
}

function DeviceDetailsDrawer({
  row,
  open,
  onClose,
  scholars,
  assignedDeviceCounts,
  simpleMdmPolicy,
  pushResult,
  verifyStatus,
  inventory,
  pairedDevice,
  onAssign,
  onPush,
  onRename,
  onClaimInvalidated,
  onRevealed,
  onCheckNow,
  checkingSimpleMdm,
}: {
  row: UnifiedDevice | null;
  open: boolean;
  onClose: () => void;
  scholars: RosterScholar[];
  assignedDeviceCounts: Map<string, number>;
  simpleMdmPolicy: SimpleMdmActionPolicy;
  pushResult?: PushResult;
  verifyStatus?: VerifyStatus;
  inventory?: SimpleMdmInventory;
  pairedDevice?: PairedDevice;
  onAssign: (device: ManagedDevice, scholarId: Id<"users">) => Promise<void>;
  onPush: (id: ManagedDevice["_id"], serial: string) => Promise<PushResult>;
  onRename: (id: ManagedDevice["_id"], name: string) => Promise<string>;
  onClaimInvalidated: (id: ManagedDevice["_id"]) => void;
  onRevealed: (result: MintResult) => void;
  onCheckNow: () => void;
  checkingSimpleMdm: boolean;
}) {
  const unpair = useMutation(api.devicePairing.unpairDevice);
  const revokeSession = useMutation(api.devicePairing.revokeDeviceSession);
  const rotate = useMutation(api.managedDeviceClaims.rotateManagedDeviceClaim);
  const revokeClaim = useMutation(api.managedDeviceClaims.revokeManagedDeviceClaim);
  const unassign = useMutation(api.managedDeviceClaims.unassignManagedDevice);
  const remove = useMutation(api.managedDeviceClaims.removeManagedDevice);
  const setAutoAssignExcluded = useMutation(api.managedDeviceClaims.setManagedDeviceAutoAssignExcluded);
  const restartDevice = useAction(api.simplemdm.restartDevice);
  const [confirming, setConfirming] = useState<
    "unpair" | "session" | "restart" | "restore" | "rotate" | "unassign" | "revoke" | "remove" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Scholars who already have a device — shown in the picker's secondary
  // "already assigned" section so a device can still be double-assigned.
  const secondaryScholarIds = useMemo(
    () => new Set(assignedDeviceCounts.keys()),
    [assignedDeviceCounts],
  );

  if (!row) return null;
  const managedDevice = row.kind === "managed" ? row.device : null;
  const manualDevice = row.kind === "manual" ? row.device : null;
  const rowDevice = row.device;
  const managed = managedDevice !== null;
  // Restart is an MDM command, so it needs a MANAGED device — `inventory` is
  // undefined for a manual pairing, which reads as "unknown" but is really
  // "impossible", and would have offered a button that always throws.
  //
  // Beyond that, offer it unless the last SimpleMDM read POSITIVELY rules it
  // out. A managed device SimpleMDM has never been asked about still gets the
  // button: `restartDevice` re-reads supervision live, so a stale
  // `isSupervised: null` can still resolve to a working restart, and hiding an
  // escape hatch behind an hourly snapshot strands staff in exactly the
  // emergency it exists for. When the snapshot does rule it out we hide rather
  // than disable-with-reason, which is this list's established idiom — every
  // other action here conditionally renders; Lost Mode's explain-the-blocker
  // block belongs to a section, not to a row of buttons.
  const canRestart =
    managed &&
    inventory?.foundInSimpleMdm !== false &&
    inventory?.isSupervised !== false;
  const device = managedDevice;
  const pairedDeviceId = managedDevice?.pairedDeviceId ?? manualDevice?._id ?? null;
  const managedName = inventory?.name;
  const displayName =
    managedName ??
    managedDevice?.serial ??
    manualDevice?.deviceLabel ??
    "iPad";

  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      setConfirming(null);
    } catch (error) {
      toaster.error({ title: "Couldn't update this device", description: error instanceof Error ? error.message : "Please try again." });
    } finally {
      setBusy(false);
    }
  }
  async function doConfirm() {
    if (confirming === "unpair" && pairedDeviceId) {
      await withBusy(async () => { await unpair({ pairedDeviceId }); toaster.success({ title: "Device unpaired" }); });
    } else if (confirming === "session" && pairedDeviceId) {
      await withBusy(async () => {
        const result = await revokeSession({ pairedDeviceId });
        toaster.success({
          title: result.sessionRevoked
            ? "Device signed out"
            : "No active device session",
        });
      });
    } else if (confirming === "restart" && pairedDeviceId) {
      // Not withBusy: a SimpleMDM failure arrives as a ConvexError whose raw
      // `.message` is the transport blob plus a stack trace. Staff reading a
      // toast while a kid's iPad is frozen get the sentence instead.
      setBusy(true);
      try {
        const result = await restartDevice({ pairedDeviceId });
        setConfirming(null);
        toaster.success({ title: "Restart command sent", description: result.message });
      } catch (error) {
        toaster.error({
          title: "Couldn't restart this iPad",
          description: simpleMdmErrorMessage(error, "Please try again."),
        });
      } finally {
        setBusy(false);
      }
    } else if (device && confirming === "restore") {
      await restoreAutomaticSignIn();
    } else if (device && confirming === "rotate") {
      await replaceEnrollmentKey();
    } else if (device && confirming === "unassign") {
      await withBusy(async () => { await unassign({ managedDeviceId: device._id }); onClaimInvalidated(device._id); toaster.success({ title: "Device returned to unassigned" }); });
    } else if (device && confirming === "revoke") {
      await withBusy(async () => { await revokeClaim({ managedDeviceId: device._id }); onClaimInvalidated(device._id); toaster.success({ title: "Device disabled" }); });
    } else if (device && confirming === "remove") {
      await withBusy(async () => { await remove({ managedDeviceId: device._id }); toaster.success({ title: "Device removed from roster" }); onClose(); });
    }
  }
  async function assignScholar(scholarId: string | null) {
    if (!device || !scholarId) return;
    await withBusy(async () => { await onAssign(device, scholarId as Id<"users">); setPickerOpen(false); });
  }
  async function replaceEnrollmentKey() {
    if (!device) return;
    await withBusy(async () => {
      const result = await rotate({ managedDeviceId: device._id });
      onClaimInvalidated(device._id);
      onRevealed(result);
      toaster.success({
        title: "Enrollment key replaced",
        description: "The fallback payload is shown below the device list.",
      });
    });
  }
  async function restoreAutomaticSignIn() {
    if (!device) return;
    await withBusy(async () => {
      const result = await onPush(device._id, device.serial);
      if (result.status !== "pushed") {
        throw new Error(result.message);
      }
      toaster.success({
        title: "Automatic sign-in sent",
        description: "The iPad will sign in when it receives the new enrollment key.",
      });
    });
  }
  function startRename() {
    setNameDraft(displayName);
    setEditingName(true);
  }
  function cancelRename() {
    setEditingName(false);
    setNameDraft("");
  }
  async function renameInSimpleMdm() {
    if (!device) return;
    const name = nameDraft.trim();
    if (!name) return;
    setBusy(true);
    try {
      await onRename(device._id, name);
      setNameDraft("");
      setEditingName(false);
      toaster.success({ title: "Device renamed in SimpleMDM" });
    } catch (error) {
      toaster.error({
        title: "Couldn't rename the device",
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  async function toggleAutoAssign() {
    if (!device) return;
    await withBusy(async () => {
      await setAutoAssignExcluded({ managedDeviceId: device._id, excluded: !device.autoAssignExcluded });
      toaster.success({ title: device.autoAssignExcluded ? "Device included in auto assign" : "Device skipped from auto assign" });
    });
  }

  const confirmationText: Record<NonNullable<typeof confirming>, string> = {
    unpair: "Unpair this device? It can then be paired to someone else.",
    session: "Force sign out this device? The scholar's other sessions will stay signed in.",
    restart: "Restart this iPad? It has to be online to receive the command — if nothing happens, hold volume up, then volume down, then the top button until the Apple logo appears. Anything the scholar hasn't sent is lost. The iPad comes back to the Home Screen; they tap Rabbithole and are still signed in.",
    restore: "Restore automatic sign-in? This sends a fresh enrollment key to this iPad. The current key remains valid until the iPad receives and exchanges the replacement.",
    rotate: "Issue a new enrollment key? The current key will stop working until the replacement is pushed.",
    unassign: "Unassign this iPad? It will be signed out of Rabbithole and no longer linked to the scholar. It will remain managed and on the device roster.",
    revoke: "Disable this iPad? Its enrollment key is invalidated and its pairing to this scholar is dropped \u2014 it cannot sign in again, by hand or otherwise, until you issue a new key. Use this for a lost iPad. The serial stays on the roster.",
    remove: "Remove this device from the roster? Its current session will also be signed out.",
  };
  return (
    <Drawer.Root open={open} onOpenChange={(event) => {
      if (!event.open) {
        setConfirming(null);
        setPickerOpen(false);
        cancelRename();
        onClose();
      }
    }} placement="end" size="xl" closeOnEscape={!editingName}>
      <Portal>
        <Drawer.Backdrop bg="blackAlpha.300" />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header borderBottomWidth="1px" borderColor="gray.100">
              <Flex justify="space-between" align="center" w="full" gap={3}>
                <HStack minW={0} gap={3} flex="1" pr={8}>
                  <Box color="violet.600" flexShrink={0}>
                    <DeviceTablet size={26} weight="duotone" />
                  </Box>
                  <Box minW={0} flex="1">
                    {device && editingName ? (
                      <HStack
                        gap={2}
                        wrap="wrap"
                        onKeyDown={(event) => {
                          // Escape cancels the rename; the drawer stays open
                          // (see closeOnEscape on Drawer.Root).
                          if (event.key === "Escape") cancelRename();
                        }}
                      >
                        {/* The title stays for the dialog's accessible name. */}
                        <Drawer.Title srOnly>{displayName}</Drawer.Title>
                        <Input
                          size="sm"
                          flex="1 1 180px"
                          maxW="300px"
                          value={nameDraft}
                          maxLength={120}
                          aria-label="Device name"
                          onChange={(event) => setNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void renameInSimpleMdm();
                          }}
                          disabled={busy}
                          autoFocus
                          onFocus={(event) => event.currentTarget.select()}
                        />
                        <Button
                          size="sm"
                          colorPalette="violet"
                          loading={busy}
                          disabled={!nameDraft.trim()}
                          onClick={() => void renameInSimpleMdm()}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          color="charcoal.500"
                          disabled={busy}
                          onClick={cancelRename}
                        >
                          Cancel
                        </Button>
                      </HStack>
                    ) : (
                      <HStack gap={1} minW={0}>
                        <Drawer.Title
                          flex="0 1 auto"
                          fontFamily={managedName || !managed ? "heading" : "mono"}
                          fontSize="lg"
                          fontWeight="700"
                          color="navy.500"
                          truncate
                        >
                          {displayName}
                        </Drawer.Title>
                        {device && (
                          <IconButton
                            size="xs"
                            variant="ghost"
                            color="charcoal.400"
                            flexShrink={0}
                            aria-label={`Rename ${displayName} in SimpleMDM`}
                            onClick={startRename}
                          >
                            <PencilSimple size={14} />
                          </IconButton>
                        )}
                      </HStack>
                    )}
                    {device && managedName && (
                      <Text fontFamily="mono" fontSize="xs" color="charcoal.400" truncate>
                        {device.serial}
                      </Text>
                    )}
                  </Box>
                </HStack>
                <Drawer.CloseTrigger asChild>
                  <IconButton aria-label="Close device details" size="sm" variant="ghost"><X size={18} /></IconButton>
                </Drawer.CloseTrigger>
              </Flex>
            </Drawer.Header>
            <Drawer.Body py={5}>
              <VStack align="stretch" gap={0}>
                <DrawerSection title="Status">
                  <HStack gap={3} wrap="wrap">
                    <StatusBadge status={deviceStatus(row)} />
                    {device && (
                      <Text fontSize="sm" color="charcoal.500">
                        {syncSummary(device, pushResult, verifyStatus)}
                      </Text>
                    )}
                  </HStack>
                  {pushResult && pushResult.status !== "pushed" && pushResult.message && (
                    <Text fontSize="sm" color="charcoal.600" mt={2}>
                      {pushResult.message}
                    </Text>
                  )}
                  {/* The iPad only re-reads its assignment when it next becomes
                      active, so a reassigned device that nobody has touched keeps
                      serving the previous scholar. Staff would otherwise have to
                      know that; say it at the one moment it matters. */}
                  {device && awaitingClaimPresentation(presentationInput(device)) && (
                    <Text fontSize="sm" color="charcoal.600" mt={2}>
                      Lock and wake the iPad to finish the switch. This row turns
                      to &ldquo;Signed in&rdquo; once it takes.
                    </Text>
                  )}
                </DrawerSection>
                <DrawerSection
                  title="Scholar"
                  action={
                    rowDevice.scholarId && device && confirming !== "unassign" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        color="charcoal.500"
                        onClick={() => setConfirming("unassign")}
                      >
                        Unassign
                      </Button>
                    ) : undefined
                  }
                >
                  {device?.scholarDeleted && (
                    <Text fontSize="sm" color="charcoal.600" mb={3}>
                      This iPad&apos;s scholar was deleted. Assign it to another scholar.
                    </Text>
                  )}
                  {rowDevice.scholarId ? (
                    <>
                      <PersonCell
                        name={rowDevice.scholarName ?? "Scholar"}
                        image={rowDevice.scholarImage}
                        colorKey={String(rowDevice.scholarId)}
                        size="xs"
                      />
                      {confirming === "unassign" && (
                        <VStack align="stretch" gap={2} mt={3}>
                          <Text fontSize="sm" color="charcoal.600">{confirmationText.unassign}</Text>
                          <HStack>
                            <Button
                              size="sm"
                              colorPalette="orange"
                              loading={busy}
                              onClick={() => void doConfirm()}
                            >
                              Unassign
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setConfirming(null)}
                            >
                              Cancel
                            </Button>
                          </HStack>
                        </VStack>
                      )}
                    </>
                  ) : device ? (
                    <Popover.Root
                      open={pickerOpen}
                      onOpenChange={(event) => setPickerOpen(event.open)}
                      positioning={{ placement: "bottom-start" }}
                    >
                      <Popover.Trigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          justifyContent="space-between"
                          disabled={busy || !simpleMdmPolicy.canAssign}
                        >
                          Assign scholar <CaretDown size={14} />
                        </Button>
                      </Popover.Trigger>
                      <Portal>
                        <Popover.Positioner>
                          <Popover.Content w="320px">
                            <Popover.Body p={3}>
                              <ScholarPickerContent
                                mode="single"
                                selected={null}
                                onChange={(id) => void assignScholar(id)}
                                scholars={scholars}
                                showGroups={false}
                                showAffinityToggle={false}
                                showEnrollmentStanding
                                autoFocusSearch
                                maxH="260px"
                                emptyHint="No scholars available."
                                secondaryScholarIds={secondaryScholarIds}
                                secondaryMinQueryLength={2}
                                scholarSubtitle={(id) => {
                                  const count = assignedDeviceCounts.get(id);
                                  return count
                                    ? `${count} device${count === 1 ? "" : "s"} already assigned`
                                    : null;
                                }}
                              />
                            </Popover.Body>
                          </Popover.Content>
                        </Popover.Positioner>
                      </Portal>
                    </Popover.Root>
                  ) : manualDevice?.scholarDeleted ? (
                    <Text fontSize="sm" color="charcoal.600">
                      This iPad&apos;s scholar was deleted. Unpair it to pair it to another scholar.
                    </Text>
                  ) : (
                    <Text fontSize="sm" color="charcoal.400">No scholar assigned</Text>
                  )}
                </DrawerSection>
                {pairedDevice && (
                  <>
                    <RabbitholeLockControl
                      key={`lock:${pairedDevice._id}`}
                      variant="drawer"
                      device={{
                        pairedDeviceId: pairedDevice._id,
                        desiredState: pairedDevice.rabbitholeLockDesiredState,
                        disarmMode: pairedDevice.rabbitholeLockDisarmMode,
                        appliedMatchesDesired: pairedDevice.rabbitholeLockAppliedMatchesDesired,
                      }}
                    />
                    {pairedDevice.scholarId && (
                      <RoboticsCaptureStationModeControl
                        key={`capture-station:${pairedDevice._id}`}
                        pairedDeviceId={pairedDevice._id}
                        variant="drawer"
                      />
                    )}
                    <LostModeControl
                      key={`lost-mode:${pairedDevice._id}`}
                      pairedDeviceId={pairedDevice._id}
                      snapshot={
                        inventory && inventory.checkedAt !== null && inventory.foundInSimpleMdm !== null
                          ? {
                              checkedAt: inventory.checkedAt,
                              foundInSimpleMdm: inventory.foundInSimpleMdm,
                              isSupervised: inventory.isSupervised,
                              lostModeEnabled: inventory.lostModeEnabled,
                            }
                          : null
                      }
                      simpleMdmConfigured={simpleMdmPolicy.status !== "unconfigured"}
                      variant="drawer"
                    />
                  </>
                )}
                <DrawerSection title="Device details">
                  <VStack align="stretch" gap={2}>
                    {device ? (
                      <>
                        <BatteryStatus inventory={inventory} detailed />
                        {inventory?.lastSeenAt && (
                          <Text fontSize="sm" color="charcoal.600">
                            Last seen {relativeTime(inventory.lastSeenAt)}
                          </Text>
                        )}
                        <Text fontSize="sm" color="charcoal.600">
                          Claimed {device.claimCount} time
                          {device.claimCount === 1 ? "" : "s"} · rotation{" "}
                          {device.rotationCount}
                        </Text>
                        {device.createdByName && (
                          <Text fontSize="sm" color="charcoal.600">
                            Registered by {device.createdByName}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text fontSize="sm" color="charcoal.600">
                        Paired {relativeTime(manualDevice!.pairedAt)}
                        {manualDevice!.pairedByName
                          ? ` by ${manualDevice!.pairedByName}`
                          : ""}
                        .
                      </Text>
                    )}
                  </VStack>
                </DrawerSection>
                {device && (
                  <DrawerSection title="App access">
                    <AppAccessSection
                      device={device}
                      onCheckNow={simpleMdmPolicy.showPushActions ? onCheckNow : null}
                      checking={checkingSimpleMdm}
                    />
                  </DrawerSection>
                )}
                <DrawerSection title="Actions">
                  {confirming && confirming !== "unassign" ? (
                    <VStack align="stretch" gap={3}>
                      <Text fontSize="sm" color="charcoal.600">{confirmationText[confirming]}</Text>
                      <HStack><Button size="sm" colorPalette={confirming === "remove" ? "red" : "orange"} loading={busy} onClick={() => void doConfirm()}>Confirm</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
                      </HStack>
                    </VStack>
                  ) : (
                    <VStack align="stretch" gap={2}>
                    {device && device.scholarId && device.claimState !== "revoked" && simpleMdmPolicy.status === "configured" && (
                      <Button h="auto" py={3} px={4} variant="outline" justifyContent="flex-start" textAlign="left" loading={busy} onClick={() => setConfirming("restore")}>
                        <DeviceActionContent
                          icon={<CloudArrowUp size={18} />}
                          title="Restore automatic sign-in"
                          description="Send a fresh enrollment key so this iPad signs back in without changing the scholar's password."
                        />
                      </Button>
                    )}
                    {device && device.scholarId && (simpleMdmPolicy.status === "unconfigured" || device.claimState === "revoked") && (
                      <Button h="auto" py={3} px={4} variant="outline" justifyContent="flex-start" textAlign="left" loading={busy} onClick={() => setConfirming("rotate")}>
                        <DeviceActionContent
                          icon={<ArrowClockwise size={18} />}
                          title="Issue new enrollment key"
                          description="Replace the iPad's one-time setup key. Use this if the current key was exposed or the iPad must be enrolled again."
                        />
                      </Button>
                    )}
                    {/* Auto assign never takes a deleted scholar's iPad (see
                        autoAssignableDevices), so there is nothing to skip. */}
                    {device && !device.scholarId && !device.scholarDeleted && (
                      <Button h="auto" py={3} px={4} variant="outline" justifyContent="flex-start" textAlign="left" loading={busy} onClick={() => void toggleAutoAssign()}>
                        <DeviceActionContent
                          icon={device.autoAssignExcluded ? <ArrowCounterClockwise size={18} /> : <MinusCircle size={18} />}
                          title={device.autoAssignExcluded ? "Include in auto assign" : "Skip auto assign"}
                          description={device.autoAssignExcluded
                            ? "Let bulk assignment use this iPad again."
                            : "Keep this spare out of bulk assignment."}
                        />
                      </Button>
                    )}
                    {pairedDeviceId && simpleMdmPolicy.status === "configured" && canRestart && (
                      <Button h="auto" py={3} px={4} variant="outline" justifyContent="flex-start" textAlign="left" onClick={() => setConfirming("restart")}>
                        <DeviceActionContent
                          icon={<Power size={18} />}
                          title="Restart iPad"
                          description="Reboot this iPad over MDM when Rabbithole is stuck. The scholar stays signed in."
                        />
                      </Button>
                    )}
                    {pairedDeviceId && !managed && (
                      <Button h="auto" py={3} px={4} variant="outline" justifyContent="flex-start" textAlign="left" onClick={() => setConfirming("session")}>
                        <DeviceActionContent
                          icon={<SignOut size={18} />}
                          title="Force sign out"
                          description="End the current Rabbithole session on this iPad without signing out the scholar elsewhere."
                        />
                      </Button>
                    )}
                    {!managed && (
                      <Button h="auto" py={3} px={4} variant="outline" justifyContent="flex-start" textAlign="left" onClick={() => setConfirming("unpair")}>
                        <DeviceActionContent
                          icon={<LinkBreak size={18} />}
                          title="Unpair device"
                          description="Remove this manual pairing so the iPad can be paired to someone else."
                        />
                      </Button>
                    )}
                    {device && device.scholarId && device.claimState !== "revoked" && (
                      <Button h="auto" py={3} px={4} variant="outline" justifyContent="flex-start" textAlign="left" onClick={() => setConfirming("revoke")}>
                        <DeviceActionContent
                          icon={<Prohibit size={18} />}
                          title="Disable device"
                          description="Invalidate this iPad's enrollment key and drop its pairing to this scholar. It signs out and cannot sign in again until you issue a new key. The serial stays on the roster."
                        />
                      </Button>
                    )}
                    {device && (
                      <Button h="auto" py={3} px={4} variant="outline" colorPalette="red" justifyContent="flex-start" textAlign="left" onClick={() => setConfirming("remove")}>
                        <DeviceActionContent
                          icon={<Trash size={18} />}
                          title="Remove from roster"
                          description="Delete this serial from Rabbithole's device roster and sign out the iPad."
                        />
                      </Button>
                    )}
                    </VStack>
                  )}
                </DrawerSection>
              </VStack>
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

function FallbackPayloads({ revealed }: { revealed: MintResult[] }) {
  if (!revealed.length) return null;
  return (
    <Surface p={6}>
      <Flex justify="space-between" gap={3} align="center" wrap="wrap">
        <Box>
          <Text fontFamily="heading" fontWeight="700" fontSize="lg" color="navy.500">Fallback claim payloads</Text>
          <Text fontSize="xs" color="orange.700">Shown only for this session. Copy or export them when SimpleMDM cannot push a claim.</Text>
        </Box>
        <HStack>
          <Button size="xs" variant="outline" onClick={() => downloadText("rabbithole-managed-claims.csv", csvExport(revealed), "text/csv")}><DownloadSimple size={14} /> CSV</Button>
          <Button size="xs" variant="outline" onClick={() => downloadText("rabbithole-managed-claims.json", jsonExport(revealed), "application/json")}><DownloadSimple size={14} /> JSON</Button>
        </HStack>
      </Flex>
      <VStack align="stretch" mt={4} gap={3}>
        {revealed.map((result, index) => (
          <Box key={`${result.serial}-${index}`} borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
            <Flex justify="space-between" gap={2} wrap="wrap">
              <Text fontFamily="mono" fontWeight="600">{result.serial}</Text>
              <HStack>
                {result.payload && <Button size="xs" variant="outline" onClick={() => void copyText(payloadJson(result.payload), "JSON payload")}><Copy size={13} /> Copy JSON</Button>}
                {result.payload && <Button size="xs" variant="outline" onClick={() => void copyText(payloadPlist(result.payload!), "plist payload")}><Copy size={13} /> Copy plist</Button>}
              </HStack>
            </Flex>
            <Box as="pre" mt={2} bg="gray.50" borderRadius="sm" p={2} fontSize="xs" overflowX="auto">
              {result.payload ? payloadJson(result.payload) : "Payload unavailable"}
            </Box>
          </Box>
        ))}
      </VStack>
    </Surface>
  );
}
