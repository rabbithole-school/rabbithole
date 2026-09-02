"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
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
  Spinner,
  Table,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  BatteryFull,
  BatteryHigh,
  BatteryLow,
  BatteryMedium,
  CaretDown,
  Check,
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
  Plus,
  Prohibit,
  SignOut,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
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
import { registrationFeedback } from "./importFeedback";
import {
  getSimpleMdmActionPolicy,
  type SimpleMdmActionPolicy,
} from "./simpleMdmActionPolicy";
import {
  DrawerSection,
  LostModeControl,
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
type VerifyStatus = FunctionReturnType<
  typeof api.simplemdm.verifySimpleMdmClaims
>["results"][number]["status"];
type SimpleMdmInventory = FunctionReturnType<
  typeof api.simplemdm.verifySimpleMdmClaims
>["inventory"][number];

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

function simpleMdmActionError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    message.match(
      /SimpleMDM (?:API key not configured[^\n]*|provisioning isn't configured for your school)/,
    )?.[0] ?? "SimpleMDM push failed. Please try again."
  );
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

function managedNeedsAttention(
  device: ManagedDevice,
  pushResult?: PushResult,
  verifyStatus?: VerifyStatus,
  inventory?: SimpleMdmInventory,
) {
  if (inventory?.lostModeEnabled === true) return true;
  if (device.claimState === "revoked") return false;
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
  if (!device.scholarId) {
    return { primary: "—", secondary: null, attention: false };
  }
  if (device.claimState === "revoked") {
    return { primary: "Disabled", secondary, attention: false };
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

function rowSearchText(
  row: UnifiedDevice,
  inventory?: SimpleMdmInventory,
) {
  return [
    row.kind === "managed" ? row.device.serial : row.device.deviceId,
    row.kind === "managed" ? inventory?.simpleMdmName : row.device.deviceLabel,
    row.device.scholarName,
    row.device.scholarUsername,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function rowDeviceName(
  row: UnifiedDevice,
  inventory?: SimpleMdmInventory,
) {
  return row.kind === "managed"
    ? inventory?.simpleMdmName ?? row.device.serial
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
  const scholars = useQuery(
    api.devicePairing.listPairableScholars,
    allowed ? { institutionScope: scopeParam } : "skip",
  );
  const pairedDevices = useQuery(
    api.devicePairing.listPairedDevices,
    allowed ? { institutionScope: scopeParam } : "skip",
  );
  const managedDevices = useQuery(
    api.managedDeviceClaims.listManagedDevices,
    allowed ? { institutionScope: scopeParam } : "skip",
  );
  const simpleMdmStatus = useQuery(
    api.simplemdm.integrationStatus,
    allowed ? {} : "skip",
  );
  const simpleMdmPolicy = getSimpleMdmActionPolicy(simpleMdmStatus?.configured);
  const assign = useMutation(api.managedDeviceClaims.assignScholarToManagedDevice);
  const autoAssign = useMutation(api.managedDeviceClaims.autoAssignManagedDevices);
  const pushClaim = useAction(api.simplemdm.pushClaimToSimpleMdm);
  const pushAllPending = useAction(api.simplemdm.pushAllPendingClaims);
  const verifyClaims = useAction(api.simplemdm.verifySimpleMdmClaims);
  const renameDevice = useAction(api.simplemdm.renameManagedDevice);

  const [addOpen, setAddOpen] = useState(false);
  const [autoAssignOpen, setAutoAssignOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const [pushResults, setPushResults] = useState<Record<string, PushResult>>({});
  const [verifyStatuses, setVerifyStatuses] = useState<Record<string, VerifyStatus>>({});
  const [simpleMdmInventory, setSimpleMdmInventory] = useState<
    Record<string, SimpleMdmInventory>
  >({});
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
  const autoAssignableDevices = useMemo(
    () => unassignedDevices.filter((device) => !device.autoAssignExcluded),
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
  const managedDeviceIds = managedDevices?.map((device) => device._id).join("|") ?? null;

  const verifySeqRef = useRef(0);
  const runVerify = useCallback(async () => {
    if (!allowed || simpleMdmStatus?.configured !== true) return;
    const sequence = ++verifySeqRef.current;
    try {
      const { results, inventory } = await verifyClaims({});
      if (sequence !== verifySeqRef.current) return;
      setVerifyStatuses(Object.fromEntries(results.map((result) => [result.managedDeviceId, result.status])));
      setSimpleMdmInventory(
        Object.fromEntries(inventory.map((device) => [device.managedDeviceId, device])),
      );
    } catch {
      if (sequence !== verifySeqRef.current) return;
      setVerifyStatuses({});
      setSimpleMdmInventory({});
    }
  }, [allowed, simpleMdmStatus?.configured, verifyClaims]);

  useEffect(() => {
    if (managedDeviceIds !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- this is the silent external SimpleMDM reconciliation on mount.
      void runVerify();
    }
  }, [managedDeviceIds, runVerify]);

  function clearPushResult(managedDeviceId: ManagedDevice["_id"]) {
    setPushResults((current) => {
      if (!(managedDeviceId in current)) return current;
      const next = { ...current };
      delete next[managedDeviceId];
      return next;
    });
    setVerifyStatuses((current) => {
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
      if (result.status === "pushed") void runVerify();
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
    const result = await renameDevice({ managedDeviceId, name });
    setSimpleMdmInventory((current) => {
      const inventory = current[managedDeviceId];
      if (!inventory) return current;
      return {
        ...current,
        [managedDeviceId]: {
          ...inventory,
          simpleMdmName: result.simpleMdmName,
        },
      };
    });
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
      if (results.some((result) => result.status === "pushed")) void runVerify();
      if (!results.length) {
        const staleCount = Object.values(verifyStatuses).filter((status) => status === "stale").length;
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
      rowDeviceName(
        a,
        a.kind === "managed" ? simpleMdmInventory[a.device._id] : undefined,
      ).localeCompare(
        rowDeviceName(
          b,
          b.kind === "managed" ? simpleMdmInventory[b.device._id] : undefined,
        ),
      ),
    );
  }, [managedDevices, pairedDevices, simpleMdmInventory]);
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
        !(
          row.kind === "managed" &&
          managedNeedsAttention(
            row.device,
            pushResults[row.device._id],
            verifyStatuses[row.device._id],
            simpleMdmInventory[row.device._id],
          )
        )
      ) {
        return false;
      }
      if (filter === "signed-in" && status !== "Signed in") return false;
      return (
        !query ||
        rowSearchText(
          row,
          row.kind === "managed"
            ? simpleMdmInventory[row.device._id]
            : undefined,
        ).includes(query)
      );
    });
  }, [
    filter,
    pushResults,
    search,
    simpleMdmInventory,
    unifiedDevices,
    verifyStatuses,
  ]);

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
              <Button size="sm" variant="outline" loading={pushingAll}
                disabled={!pendingPushCount || managedDevices === undefined}
                onClick={() => void handlePushAll()}>
                <CloudArrowUp size={16} />
                Push all pending
              </Button>
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
                        pushResult={row.kind === "managed" ? pushResults[row.device._id] : undefined}
                        verifyStatus={row.kind === "managed" ? verifyStatuses[row.device._id] : undefined}
                        inventory={row.kind === "managed" ? simpleMdmInventory[row.device._id] : undefined}
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
                    inventory={row.kind === "managed" ? simpleMdmInventory[row.device._id] : undefined}
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

      <AddDeviceDialog open={addOpen} onClose={() => setAddOpen(false)} scholars={scholars ?? []} />
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
        pushResult={selectedDevice?.kind === "managed" ? pushResults[selectedDevice.device._id] : undefined}
        verifyStatus={selectedDevice?.kind === "managed" ? verifyStatuses[selectedDevice.device._id] : undefined}
        inventory={selectedDevice?.kind === "managed" ? simpleMdmInventory[selectedDevice.device._id] : undefined}
        pairedDevice={selectedPairedDevice}
        onAssign={handleAssign} onPush={pushDevice} onRename={renameManagedDevice}
        onClaimInvalidated={clearPushResult}
        onReverify={() => void runVerify()} onRevealed={(result) => setRevealed((current) => [result, ...current])} />
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
  const managedName = inventory?.simpleMdmName;
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
            <Text fontFamily={inventory?.simpleMdmName || row.kind === "manual" ? "heading" : "mono"} fontWeight="600" truncate>
              {inventory?.simpleMdmName ?? (managedDevice ? managedDevice.serial : manualDevice?.deviceLabel ?? "iPad")}
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
              <Text fontSize="sm" color="charcoal.500">
                No scholar assigned
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
        <HStack gap={1}>
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
}: {
  open: boolean;
  onClose: () => void;
  scholars: PairableScholar[];
}) {
  const [pane, setPane] = useState<"register" | "pair">("register");
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
            {open && (
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
                  <RegisterSerialsPane onClose={onClose} />
                ) : (
                  <PairWithCodePane scholars={scholars} />
                )}
              </>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function RegisterSerialsPane({ onClose }: { onClose: () => void }) {
  const register = useMutation(api.managedDeviceClaims.registerManagedDeviceSerials);
  const [pasteText, setPasteText] = useState("");
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
  onReverify,
  onRevealed,
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
  onReverify: () => void;
  onRevealed: (result: MintResult) => void;
}) {
  const unpair = useMutation(api.devicePairing.unpairDevice);
  const revokeSession = useMutation(api.devicePairing.revokeDeviceSession);
  const rotate = useMutation(api.managedDeviceClaims.rotateManagedDeviceClaim);
  const revokeClaim = useMutation(api.managedDeviceClaims.revokeManagedDeviceClaim);
  const unassign = useMutation(api.managedDeviceClaims.unassignManagedDevice);
  const remove = useMutation(api.managedDeviceClaims.removeManagedDevice);
  const setAutoAssignExcluded = useMutation(api.managedDeviceClaims.setManagedDeviceAutoAssignExcluded);
  const [confirming, setConfirming] = useState<
    "unpair" | "session" | "restore" | "rotate" | "unassign" | "revoke" | "remove" | null
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
  const device = managedDevice;
  const pairedDeviceId = managedDevice?.pairedDeviceId ?? manualDevice?._id ?? null;
  const managedName = inventory?.simpleMdmName;
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
        toaster.success({ title: result.sessionRevoked ? "Device signed out" : "No active device session" });
      });
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
      onReverify();
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
    restore: "Restore automatic sign-in? This sends a fresh enrollment key to this iPad. The current key remains valid until the iPad receives and exchanges the replacement.",
    rotate: "Issue a new enrollment key? The current key will stop working until the replacement is pushed.",
    unassign: "Unassign this iPad? It will be signed out of Rabbithole and no longer linked to the scholar. It will remain managed and on the device roster.",
    revoke: "Disable this device? It will be signed out and cannot enroll again until a new key is issued.",
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
                      variant="drawer"
                      onCommandApplied={onReverify}
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
                    {device && !device.scholarId && (
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
                    {pairedDeviceId && (
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
                          description="Sign out this iPad and invalidate its enrollment key. It stays in the roster."
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
