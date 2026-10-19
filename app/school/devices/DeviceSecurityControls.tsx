"use client";

/**
 * Device security controls shared by the `/school/devices` details drawer and
 * the dedicated `/school/devices/[pairedDeviceId]` settings page, plus the
 * section primitive that gives the drawer one typographic system.
 *
 * `DrawerSection` is deliberately local to this feature: heading, divider and
 * spacing live in one place so Status / Scholar / Rabbithole Lock / Freeze Mode /
 * Lost Mode / Device details / Actions cannot drift apart again.
 */

import {
  Badge,
  Box,
  Button,
  Dialog,
  Flex,
  Field,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  Camera,
  LockKey,
  LockKeyOpen,
  Siren,
  Snowflake,
} from "@phosphor-icons/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { Surface } from "@/components/ui/Surface";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { useCallback, useState, type ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";

type DisarmMode =
  | "one_time"
  | "until_midnight"
  | "until_further_notice"
  | "timed";

/**
 * The two fixed timed-disarm presets. "timed" alone isn't a selectable value
 * — the select's option value also carries the minutes, so the minutes never
 * has to travel through separate component state.
 */
const TIMED_DISARM_PRESET_MINUTES = [30, 90] as const;
type TimedDisarmPresetMinutes = (typeof TIMED_DISARM_PRESET_MINUTES)[number];
// Excludes bare "timed" (rather than `DisarmMode | ...`) so a timed selection
// with no minutes attached is unrepresentable in component state — the only
// way to select "timed" is via one of the `timed_${minutes}` members below.
type DisarmSelection =
  | Exclude<DisarmMode, "timed">
  | `timed_${TimedDisarmPresetMinutes}`;

function parseDisarmSelection(
  selection: DisarmSelection,
): { mode: DisarmMode; minutes?: number } {
  for (const minutes of TIMED_DISARM_PRESET_MINUTES) {
    if (selection === `timed_${minutes}`) return { mode: "timed", minutes };
  }
  return { mode: selection as DisarmMode };
}

const DISARM_OPTIONS: Array<{
  value: DisarmSelection;
  label: string;
  description: string;
}> = [
  {
    value: "until_midnight",
    label: "Until midnight",
    description: "The default. Re-arms at midnight in this school's timezone.",
  },
  {
    value: "one_time",
    label: "One time",
    description: "Re-arms the next time Rabbithole is entered.",
  },
  ...TIMED_DISARM_PRESET_MINUTES.map((minutes) => ({
    value: `timed_${minutes}` as const,
    label: `For ${minutes} minutes`,
    description: `Re-arms automatically ${minutes} minutes after this iPad is disarmed.`,
  })),
  {
    value: "until_further_notice",
    label: "Until further notice",
    description: "Stays disarmed until a staff member re-arms it.",
  },
];

export type LockControlDevice = {
  pairedDeviceId: Id<"pairedDevices">;
  desiredState: "armed" | "disarmed";
  disarmMode: DisarmMode | null;
  disarmExpiresAt?: number | null;
  appliedMatchesDesired: boolean;
  inSingleAppMode?: boolean | null;
  institutionTimeZone?: string;
  /** Freeze Mode holds the lock armed, so disarm is unavailable while set. */
  frozenUntil?: number | null;
};

type LostModeState = FunctionReturnType<typeof api.simplemdm.lostModeStatus>;

/**
 * What SimpleMDM last reported for this iPad, as persisted by the backend
 * (`simpleMdmDeviceSnapshots`) and delivered on the host's reactive query.
 * `null` = SimpleMDM has never been asked about this serial.
 */
export type LostModeSnapshot = {
  checkedAt: number;
  foundInSimpleMdm: boolean;
  isSupervised: boolean | null;
  lostModeEnabled: boolean | null;
} | null;

/**
 * The staff-facing message from a SimpleMDM client ConvexError, else the Error
 * message. Exported because the devices drawer sends SimpleMDM commands too:
 * a ConvexError's raw `.message` crossing the action boundary is the whole
 * `[CONVEX A(...)] ... Uncaught ConvexError: ...` blob plus a stack trace, which
 * is what staff would otherwise read in a toast mid-emergency.
 */
export function simpleMdmErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string" && data) return data;
    if (data && typeof data === "object" && "message" in data) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

type SectionProps = {
  title: string;
  icon?: ReactNode;
  /** Rendered inline after the title (status badges). */
  badge?: ReactNode;
  /** Rendered at the end of the heading row; wraps below on narrow widths. */
  action?: ReactNode;
  children: ReactNode;
};

function formatTimestamp(value: number, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(value);
  } catch {
    return new Date(value).toLocaleString();
  }
}

/**
 * The one heading scale for these sections — deliberately not configurable, so
 * a security section can never grow louder than Status / Scholar / Actions.
 * It matches the card headings on the standalone device settings page.
 */
function SectionHeading({
  title,
  icon,
  badge,
  action,
}: Omit<SectionProps, "children">) {
  return (
    <Flex justify="space-between" align="start" gap={3} wrap="wrap" mb={3}>
      <HStack gap={2} minW={0} minH={7} align="center">
        {icon && (
          <Box color="navy.500" display="flex" flexShrink={0}>
            {icon}
          </Box>
        )}
        <Text
          fontFamily="heading"
          fontSize="md"
          fontWeight="700"
          color="navy.500"
          lineHeight="short"
          truncate
        >
          {title}
        </Text>
        {badge}
      </HStack>
      {action}
    </Flex>
  );
}

/**
 * One top-level drawer section: same heading scale, same divider, same
 * rhythm. Dividers come from the section itself (`_first` drops the rule) so
 * a parent stack only has to render sections in order with `gap={0}`.
 */
export function DrawerSection({ children, ...heading }: SectionProps) {
  return (
    <Box
      borderTopWidth="1px"
      borderColor="gray.100"
      pt={5}
      pb={5}
      _first={{ borderTopWidth: 0, pt: 0 }}
      _last={{ pb: 0 }}
    >
      <SectionHeading {...heading} />
      {children}
    </Box>
  );
}

function ControlSection({
  variant,
  children,
  ...heading
}: SectionProps & { variant: "card" | "drawer" }) {
  if (variant === "drawer") {
    return <DrawerSection {...heading}>{children}</DrawerSection>;
  }
  return (
    <Surface p={6}>
      <SectionHeading {...heading} />
      {children}
    </Surface>
  );
}

export function RabbitholeLockControl({
  device,
  variant = "card",
}: {
  device: LockControlDevice;
  variant?: "card" | "drawer";
}) {
  const setDesiredState = useMutation(api.deviceLock.setRabbitholeLock);
  const [disarmSelection, setDisarmSelection] =
    useState<DisarmSelection>("until_midnight");
  const [saving, setSaving] = useState(false);
  const desiredArmed = device.desiredState === "armed";
  const lockStatus = device.appliedMatchesDesired
    ? desiredArmed
      ? "Armed"
      : "Disarmed"
    : desiredArmed
      ? "Arming"
      : "Disarming";
  const selectedOption =
    DISARM_OPTIONS.find((option) => option.value === disarmSelection) ??
    DISARM_OPTIONS[0];

  async function updateLock(
    state: "armed" | "disarmed",
    selection?: DisarmSelection,
  ) {
    const { mode, minutes } = selection
      ? parseDisarmSelection(selection)
      : { mode: undefined, minutes: undefined };
    setSaving(true);
    try {
      await setDesiredState({
        pairedDeviceId: device.pairedDeviceId,
        state,
        disarmMode: mode,
        disarmMinutes: minutes,
      });
      toaster.success({
        title:
          state === "armed"
            ? "Rabbithole Lock armed"
            : "Rabbithole Lock disarmed",
        description:
          state === "armed"
            ? "The iPad will apply the lock when it is online."
            : mode === "one_time"
              ? "The iPad will re-arm when Rabbithole is entered again."
              : mode === "until_further_notice"
                ? "The iPad will stay disarmed until staff re-arm it."
                : mode === "timed"
                  ? `The iPad will re-arm in ${minutes} minutes.`
                  : "The iPad will re-arm at midnight in its school timezone.",
      });
    } catch (error) {
      toaster.error({
        title: "Rabbithole Lock couldn't update",
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <ControlSection
      variant={variant}
      title="Rabbithole Lock"
      icon={
        desiredArmed ? (
          <LockKey size={18} weight="duotone" />
        ) : (
          <LockKeyOpen size={18} weight="duotone" />
        )
      }
      badge={
        <Badge variant="subtle" colorPalette="gray">
          {!device.appliedMatchesDesired && (
            <Spinner size="xs" borderWidth="1.5px" />
          )}
          {lockStatus}
        </Badge>
      }
      action={
        desiredArmed && device.frozenUntil ? (
          <Text fontSize="sm" color="charcoal.500">
            Unfreeze to disarm
          </Text>
        ) : desiredArmed ? (
          <HStack align="end" gap={2} wrap="wrap">
            <Box minW="180px">
              <Text
                fontSize="xs"
                fontWeight="600"
                color="charcoal.500"
                mb={1}
                id={`disarm-for-${device.pairedDeviceId}`}
              >
                Disarm for
              </Text>
              <FieldSelect
                value={disarmSelection}
                onChange={(value) =>
                  setDisarmSelection(value as DisarmSelection)
                }
                fieldProps={{
                  "aria-labelledby": `disarm-for-${device.pairedDeviceId}`,
                }}
              >
                {DISARM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </FieldSelect>
            </Box>
            <Button
              size="sm"
              variant="outline"
              loading={saving}
              onClick={() => void updateLock("disarmed", disarmSelection)}
            >
              <LockKeyOpen size={16} />
              Disarm
            </Button>
          </HStack>
        ) : (
          <Button
            size="sm"
            variant="outline"
            loading={saving}
            onClick={() => void updateLock("armed")}
          >
            <LockKey size={16} />
            Re-arm
          </Button>
        )
      }
    >
      <VStack align="stretch" gap={1}>
        <Text fontSize="sm" color="charcoal.600">
          {desiredArmed
            ? "This iPad should stay in Rabbithole."
            : device.disarmMode === "one_time"
              ? "Disarmed for one entry."
              : device.disarmMode === "until_further_notice"
                ? "Disarmed until a staff member re-arms it."
                : device.disarmMode === "timed"
                  ? "Disarmed for a limited time."
                  : "Disarmed until midnight."}
        </Text>
        {desiredArmed ? (
          !device.frozenUntil && (
            <Text fontSize="xs" color="charcoal.400">
              {selectedOption.description}
            </Text>
          )
        ) : (
          device.disarmExpiresAt && (
            <Text fontSize="xs" color="charcoal.400">
              Scheduled to re-arm{" "}
              <Text as="span" fontWeight="600">
                {formatTimestamp(
                  device.disarmExpiresAt,
                  device.institutionTimeZone,
                )}
              </Text>
              .
            </Text>
          )
        )}
        <Text aria-live="polite" fontSize="xs" color="charcoal.400">
          {device.appliedMatchesDesired
            ? "Applied on this iPad."
            : desiredArmed
              ? "Waiting for the iPad to enter Rabbithole Lock."
              : "Waiting for the iPad to leave Rabbithole Lock."}
        </Text>
      </VStack>
    </ControlSection>
  );
}

// Fixed presets for a freeze, inside the server's 5–480 minute bounds.
const FREEZE_PRESET_MINUTES = [15, 30, 60] as const;

export type FreezeControlDevice = {
  pairedDeviceId: Id<"pairedDevices">;
  frozenUntil: number | null;
  institutionTimeZone?: string;
};

/**
 * Freeze Mode — pin the iPad inside Rabbithole behind a "frozen until <time>,
 * ask a teacher to unfreeze" screen. The server arms Rabbithole Lock and thaws
 * on schedule (`deviceLock.setFreezeMode` / `thawFreeze`).
 */
export function FreezeModeControl({
  device,
  variant = "card",
}: {
  device: FreezeControlDevice;
  variant?: "card" | "drawer";
}) {
  const setFreezeMode = useMutation(api.deviceLock.setFreezeMode);
  const [minutes, setMinutes] =
    useState<(typeof FREEZE_PRESET_MINUTES)[number]>(15);
  const [saving, setSaving] = useState(false);
  const frozen = device.frozenUntil !== null;

  async function update(nextFrozen: boolean) {
    setSaving(true);
    try {
      const result = await setFreezeMode({
        pairedDeviceId: device.pairedDeviceId,
        frozen: nextFrozen,
        minutes: nextFrozen ? minutes : undefined,
      });
      toaster.success({
        title: nextFrozen ? "iPad frozen" : "iPad unfrozen",
        description: nextFrozen
          ? result.frozenUntil
            ? `It stays frozen until ${formatTimestamp(result.frozenUntil, device.institutionTimeZone)}.`
            : undefined
          : "Rabbithole Lock stays armed.",
      });
    } catch (error) {
      toaster.error({
        title: nextFrozen ? "Couldn't freeze this iPad" : "Couldn't unfreeze this iPad",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <ControlSection
      variant={variant}
      title="Freeze Mode"
      icon={<Snowflake size={18} weight="duotone" />}
      badge={
        frozen ? (
          <Badge variant="subtle" colorPalette="blue">
            Frozen
          </Badge>
        ) : null
      }
      action={
        frozen ? (
          <Button
            size="sm"
            variant="outline"
            loading={saving}
            onClick={() => void update(false)}
          >
            Unfreeze
          </Button>
        ) : (
          <HStack align="end" gap={2} wrap="wrap">
            <Box minW="160px">
              <Text
                fontSize="xs"
                fontWeight="600"
                color="charcoal.500"
                mb={1}
                id={`freeze-for-${device.pairedDeviceId}`}
              >
                Freeze for
              </Text>
              <FieldSelect
                value={String(minutes)}
                onChange={(value) =>
                  setMinutes(
                    Number(value) as (typeof FREEZE_PRESET_MINUTES)[number],
                  )
                }
                fieldProps={{
                  "aria-labelledby": `freeze-for-${device.pairedDeviceId}`,
                }}
              >
                {FREEZE_PRESET_MINUTES.map((value) => (
                  <option key={value} value={value}>
                    {value} minutes
                  </option>
                ))}
              </FieldSelect>
            </Box>
            <Button
              size="sm"
              variant="outline"
              loading={saving}
              onClick={() => void update(true)}
            >
              <Snowflake size={16} />
              Freeze
            </Button>
          </HStack>
        )
      }
    >
      <Text fontSize="sm" color="charcoal.600">
        {frozen && device.frozenUntil ? (
          <>
            Frozen until{" "}
            <Text as="span" fontWeight="600">
              {formatTimestamp(device.frozenUntil, device.institutionTimeZone)}
            </Text>
            . Once this iPad is online, Rabbithole shows the Freeze Mode screen
            and Rabbithole Lock keeps the scholar in the app.
          </>
        ) : (
          "Keeps the scholar in Rabbithole behind a screen that says the iPad is frozen until a set time and to ask a teacher to unfreeze it."
        )}
      </Text>
    </ControlSection>
  );
}

export function RoboticsCaptureStationModeControl({
  pairedDeviceId,
  variant = "card",
}: {
  pairedDeviceId: Id<"pairedDevices">;
  variant?: "card" | "drawer";
}) {
  const state = useQuery(api.captureStations.assignedDeviceCaptureControlState, {
    pairedDeviceId,
  });
  const setMode = useMutation(api.captureStations.setAssignedDeviceCaptureMode);
  const [dialog, setDialog] = useState<"start" | "stop" | null>(null);
  const [captureStationId, setCaptureStationId] =
    useState<Id<"captureStations"> | null>(null);
  const [saving, setSaving] = useState(false);
  const active = state?.active ?? null;
  const stations = state?.availableStations ?? [];
  const selectedStationId = captureStationId ?? stations[0]?.captureStationId ?? null;
  const selectedStation = stations.find(
    (station) => station.captureStationId === selectedStationId,
  );

  async function updateMode(enabled: boolean) {
    if (enabled && !selectedStationId) return;
    setSaving(true);
    try {
      await setMode(
        enabled
          ? {
              pairedDeviceId,
              captureStationId: selectedStationId!,
              enabled: true,
            }
          : { pairedDeviceId, enabled: false },
      );
      setDialog(null);
      toaster.success({
        title: enabled
          ? "Robotics capture station mode started"
          : "Robotics capture station mode stopped",
      });
    } catch (error) {
      toaster.error({
        title: enabled
          ? "Couldn't start Robotics capture station mode"
          : "Couldn't stop Robotics capture station mode",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ControlSection
        variant={variant}
        title="Robotics capture station mode"
        icon={<Camera size={18} weight="duotone" />}
        badge={
          active ? (
            <Badge variant="subtle" colorPalette="green">
              Active
            </Badge>
          ) : undefined
        }
      >
        {state === undefined ? (
          <HStack color="charcoal.400" gap={2}>
            <Spinner size="xs" />
            <Text fontSize="xs">Checking capture station mode…</Text>
          </HStack>
        ) : active ? (
          <VStack align="stretch" gap={3}>
            <Text fontSize="sm" color="charcoal.600">
              Capturing for {active.groupName}.
            </Text>
            <Text fontSize="xs" color="charcoal.400">
              Ends {formatTimestamp(active.expiresAt, state.timeZone)}.
            </Text>
            <Button
              alignSelf="start"
              size="sm"
              variant="outline"
              colorPalette="red"
              onClick={() => setDialog("stop")}
            >
              Stop capture station mode
            </Button>
          </VStack>
        ) : stations.length ? (
          <VStack align="stretch" gap={3}>
            <Text fontSize="sm" color="charcoal.600">
              Temporarily use this iPad to capture Robotics photos and videos.
            </Text>
            <Button
              alignSelf="start"
              size="sm"
              colorPalette="violet"
              onClick={() => {
                setCaptureStationId(stations[0].captureStationId);
                setDialog("start");
              }}
            >
              Start capture station mode
            </Button>
          </VStack>
        ) : (
          <Text fontSize="sm" color="charcoal.400">
            No eligible capture station is available for this iPad.
          </Text>
        )}
      </ControlSection>

      <Dialog.Root
        open={dialog !== null}
        onOpenChange={(details) => !details.open && !saving && setDialog(null)}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="440px">
              <Dialog.Header px={5} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" color="fg.default">
                  {dialog === "start"
                    ? "Start Robotics capture station mode"
                    : "Stop capture station mode"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={5} py={3}>
                <VStack align="stretch" gap={4}>
                  {dialog === "start" ? (
                    <>
                      <Text fontSize="sm" color="fg.muted">
                        This iPad will capture for {selectedStation?.groupName ?? "this program"} until
                        4:40 PM today.
                      </Text>
                      {stations.length > 1 && (
                        <Field.Root>
                          <Field.Label>Program</Field.Label>
                          <FieldSelect
                            value={selectedStationId ?? ""}
                            onChange={(value) =>
                              setCaptureStationId(value as Id<"captureStations">)
                            }
                          >
                            {stations.map((station) => (
                              <option
                                key={station.captureStationId}
                                value={station.captureStationId}
                              >
                                {station.groupName}
                              </option>
                            ))}
                          </FieldSelect>
                        </Field.Root>
                      )}
                    </>
                  ) : (
                    <Text fontSize="sm" color="fg.muted">
                      This iPad will stop capturing for {active?.groupName ?? "this program"} now.
                    </Text>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer px={5} pb={5} pt={2} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  colorPalette={dialog === "stop" ? "red" : "violet"}
                  loading={saving}
                  disabled={dialog === "start" && !selectedStationId}
                  onClick={() => void updateMode(dialog === "start")}
                >
                  {dialog === "start" ? "Start mode" : "Stop mode"}
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

export function LostModeControl({
  pairedDeviceId,
  snapshot,
  simpleMdmConfigured = true,
  variant = "card",
  onCommandApplied,
}: {
  pairedDeviceId: Id<"pairedDevices">;
  /**
   * The persisted SimpleMDM read-back for this iPad. Rendering never triggers
   * a SimpleMDM request: opening a drawer must not spend API quota, and it
   * must not fail when SimpleMDM is rate limiting. "Refresh status" is the
   * one explicit read; every command also re-reads and re-persists.
   */
  snapshot: LostModeSnapshot | undefined;
  /** False when the host already knows SimpleMDM isn't configured. */
  simpleMdmConfigured?: boolean;
  variant?: "card" | "drawer";
  /**
   * Optional: called after a Lost Mode command succeeds AND live status has
   * been re-read, so a host surface can react (e.g. close a confirmation).
   */
  onCommandApplied?: () => void;
}) {
  const fetchLostModeStatus = useAction(api.simplemdm.lostModeStatus);
  const setLostMode = useAction(api.simplemdm.setLostMode);
  // A live read-back from this session overrides the snapshot until the
  // snapshot catches up (the backend persists every read, so it does).
  const [liveStatus, setLiveStatus] = useState<LostModeState>();
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const status: LostModeState | undefined =
    liveStatus ??
    (!simpleMdmConfigured
      ? { configured: false, foundInSimpleMdm: false, isSupervised: null, lostModeEnabled: null }
      : snapshot
        ? {
            configured: true,
            foundInSimpleMdm: snapshot.foundInSimpleMdm,
            isSupervised: snapshot.isSupervised,
            lostModeEnabled: snapshot.lostModeEnabled,
          }
        : undefined);
  const statusAsOf = liveStatus ? null : snapshot?.checkedAt ?? null;

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const result = await fetchLostModeStatus({ pairedDeviceId });
      setLiveStatus(result);
      setStatusError(null);
    } catch (error) {
      const message = simpleMdmErrorMessage(error, "Please try again.");
      setStatusError(message);
      toaster.error({
        title: "Couldn't check Lost Mode status",
        description: message,
      });
    } finally {
      setStatusLoading(false);
    }
  }, [fetchLostModeStatus, pairedDeviceId]);

  async function updateLostMode(enabled: boolean) {
    setBusy(true);
    try {
      const result = await setLostMode({ pairedDeviceId, enabled });
      toaster.success({
        title: enabled
          ? "Enable Lost Mode command sent"
          : "Disable Lost Mode command sent",
        description: result.message,
      });
      setConfirming(false);
      await refreshStatus();
      onCommandApplied?.();
    } catch (error) {
      toaster.error({
        title: enabled ? "Couldn't enable Lost Mode" : "Couldn't disable Lost Mode",
        description: simpleMdmErrorMessage(error, "Please try again."),
      });
    } finally {
      setBusy(false);
    }
  }

  const showBadge =
    status?.foundInSimpleMdm === true && status.isSupervised === true;

  return (
    <ControlSection
      variant={variant}
      title="Lost Mode"
      icon={<Siren size={18} weight="duotone" />}
      badge={
        showBadge ? (
          <Badge
            variant="subtle"
            colorPalette={status.lostModeEnabled ? "red" : "gray"}
          >
            {status.lostModeEnabled
              ? "Enabled"
              : status.lostModeEnabled === false
                ? "Disabled"
                : "Not reported"}
          </Badge>
        ) : undefined
      }
      action={
        <HStack gap={2}>
          {statusAsOf !== null && (
            <Text fontSize="xs" color="charcoal.400">
              as of {formatTimestamp(statusAsOf)}
            </Text>
          )}
          <Button
            size="xs"
            variant="ghost"
            color="charcoal.500"
            loading={statusLoading}
            onClick={() => void refreshStatus()}
          >
            Refresh status
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={3}>
        <Text fontSize="sm" color="charcoal.600">
          Apple&apos;s supervised Lost Mode — leaves only Apple&apos;s lock
          screen. Separate from Rabbithole Lock.
        </Text>
        <Box aria-live="polite">
          {status === undefined && statusLoading ? (
            <HStack color="charcoal.400" gap={2}>
              <Spinner size="xs" />
              <Text fontSize="xs">Checking SimpleMDM…</Text>
            </HStack>
          ) : status === undefined ? (
            <VStack align="start" gap={2}>
              <Text fontSize="xs" color={statusError ? "red.600" : "charcoal.400"}>
                {statusError
                  ? `Couldn't check Lost Mode status: ${statusError}`
                  : "SimpleMDM hasn't been asked about this iPad yet."}
              </Text>
              <Button
                size="xs"
                variant="outline"
                loading={statusLoading}
                onClick={() => void refreshStatus()}
              >
                {statusError ? "Retry" : "Check SimpleMDM"}
              </Button>
            </VStack>
          ) : !status.configured ? (
            <Text fontSize="xs" color="charcoal.400">
              SimpleMDM isn&apos;t configured for this school.
            </Text>
          ) : !status.foundInSimpleMdm ? (
            <Text fontSize="xs" color="charcoal.400">
              This iPad isn&apos;t enrolled in SimpleMDM yet.
            </Text>
          ) : status.isSupervised !== true ? (
            <Text fontSize="xs" color="charcoal.400">
              Lost Mode needs a supervised iPad, and SimpleMDM hasn&apos;t
              confirmed this device is supervised. No action is available until
              that&apos;s verified.
            </Text>
          ) : status.lostModeEnabled === null ? (
            <Text fontSize="xs" color="charcoal.400">
              SimpleMDM didn&apos;t report a Lost Mode state for this iPad.
              Refresh to check again before taking an action.
            </Text>
          ) : status.lostModeEnabled ? (
            <VStack align="stretch" gap={3}>
              <Text fontSize="xs" color="charcoal.400">
                This iPad is currently in Lost Mode, showing only Apple&apos;s
                lock screen.
              </Text>
              <Button
                alignSelf="start"
                size="sm"
                colorPalette="green"
                loading={busy}
                onClick={() => void updateLostMode(false)}
              >
                Disable Lost Mode
              </Button>
            </VStack>
          ) : confirming ? (
            <VStack align="stretch" gap={3}>
              <Text role="alert" fontSize="xs" color="red.600" fontWeight="600">
                This sends a command to enable Lost Mode, leaving only
                Apple&apos;s lock screen once the command is applied. It queues
                until the iPad is next online. Confirm?
              </Text>
              <HStack gap={2} wrap="wrap">
                <Button
                  size="sm"
                  colorPalette="red"
                  loading={busy}
                  onClick={() => void updateLostMode(true)}
                >
                  Confirm enable Lost Mode
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </HStack>
            </VStack>
          ) : (
            <Button
              alignSelf="start"
              size="sm"
              colorPalette="red"
              onClick={() => setConfirming(true)}
            >
              <Siren size={16} />
              Enable Lost Mode
            </Button>
          )}
        </Box>
      </VStack>
    </ControlSection>
  );
}
