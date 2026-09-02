"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  Field,
  Flex,
  HStack,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  ArrowsClockwise,
  Check,
  Copy,
  Prohibit,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { EXTENDED_EDUCATION_LABEL } from "@/shared/scholarGroupRouting";

function formatWhen(timestamp: number | null | undefined) {
  if (!timestamp) return "Not yet";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function CaptureStationGroupSection({
  groupId,
  groupName,
  canManageStation = true,
}: {
  groupId: Id<"scholarGroups">;
  groupName: string;
  canManageStation?: boolean;
}) {
  const status = useQuery(api.captureStations.statusForGroup, {
    scholarGroupId: groupId,
  });
  const createStation = useMutation(api.captureStations.createForGroup);
  const createOrRotate = useMutation(api.captureStations.createOrRotateForGroup);
  const clearToken = useMutation(api.captureStations.clearEnrollmentToken);
  const revoke = useMutation(api.captureStations.revoke);
  const [label, setLabel] = useState(`${groupName} capture station`);
  const [enrollmentToken, setEnrollmentToken] = useState("");
  const [confirming, setConfirming] = useState<
    "rotate" | "revoke" | "clear" | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-time credential must never carry between groups.
    setEnrollmentToken("");
    setCopied(false);
    setLabel(status?.label ?? `${groupName} capture station`);
    setConfirming(null);
  }, [groupId, groupName, status?.label]);

  const issueEnrollmentToken = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      toaster.error({ title: "Station name required" });
      return;
    }

    setSaving(true);
    try {
      const result = await createOrRotate({
        scholarGroupId: groupId,
        label: trimmedLabel,
      });
      setEnrollmentToken(result.enrollmentToken);
      setConfirming(null);
      toaster.success({
        title: status ? "Enrollment token rotated" : "Capture station created",
      });
    } catch (error) {
      toaster.error({
        title: "Couldn't save capture station",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const saveStation = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      toaster.error({ title: "Station name required" });
      return;
    }
    setSaving(true);
    try {
      await createStation({ scholarGroupId: groupId, label: trimmedLabel });
      toaster.success({
        title: hasStation ? "Capture station reactivated" : "Capture station created",
      });
    } catch (error) {
      toaster.error({
        title: "Couldn't save capture station",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const clearKioskEnrollment = async () => {
    if (!status) return;
    setSaving(true);
    try {
      await clearToken({ captureStationId: status.captureStationId });
      setEnrollmentToken("");
      setConfirming(null);
      toaster.success({ title: "Kiosk enrollment cleared" });
    } catch (error) {
      toaster.error({
        title: "Couldn't clear kiosk enrollment",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const revokeStation = async () => {
    if (!status) return;
    setSaving(true);
    try {
      await revoke({ captureStationId: status.captureStationId });
      setEnrollmentToken("");
      setConfirming(null);
      toaster.success({ title: "Capture station revoked" });
    } catch (error) {
      toaster.error({
        title: "Couldn't revoke capture station",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(enrollmentToken);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      toaster.success({ title: "Enrollment token copied" });
    } catch {
      toaster.error({
        title: "Couldn't copy enrollment token",
        description: "Select and copy it from the field instead.",
      });
    }
  };

  const hasStation = status !== null && status !== undefined;
  const isEnabled = status?.enabled === true;
  // A kiosk enrollment is optional and independent of the station being live:
  // assigned-device capture mode needs no token at all.
  const hasToken = status?.hasEnrollmentToken === true;
  const confirmationIsRotate = confirming === "rotate";

  return (
    <Box
      as="section"
      aria-labelledby={`capture-station-${groupId}`}
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="lg"
      bg="bg.subtle"
      p={{ base: 3, md: 4 }}
    >
      <Stack gap={3}>
        <Flex
          direction={{ base: "column", md: "row" }}
          align={{ base: "flex-start", md: "center" }}
          justify="space-between"
          gap={2}
        >
          <Box>
            <Text
              id={`capture-station-${groupId}`}
              fontFamily="heading"
              fontWeight="600"
              color="fg.default"
            >
              {groupName}
            </Text>
            <Text fontSize="sm" color="fg.muted">
              Shared capture device for this {EXTENDED_EDUCATION_LABEL} group.
            </Text>
          </Box>
          {status === undefined ? (
            <Spinner size="sm" aria-label="Loading capture station status" />
          ) : (
            <Badge colorPalette={isEnabled ? "green" : "gray"}>
              {isEnabled ? "Active" : hasStation ? "Revoked" : "Not created"}
            </Badge>
          )}
        </Flex>

        {status !== undefined && (
          <Stack gap={1}>
            <Flex
              direction={{ base: "column", sm: "row" }}
              gap={{ base: 1, sm: 4 }}
              fontSize="sm"
              color="fg.muted"
            >
              <Text>{status?.rosterCount ?? 0} scholars</Text>
              {status && (
                <>
                  <Text>Active devices: {status.activeSessionCount}</Text>
                  <Text>Last used: {formatWhen(status.lastUsedAt)}</Text>
                </>
              )}
            </Flex>
          </Stack>
        )}

        {canManageStation && (
          <Field.Root>
            <Field.Label fontSize="sm">Station name</Field.Label>
            <Input
              size="sm"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={saving}
            />
          </Field.Root>
        )}

        {canManageStation && (
          <HStack flexWrap="wrap" gap={2}>
            {!isEnabled && (
              <Button
                size="sm"
                colorPalette="violet"
                disabled={status === undefined}
                loading={saving && confirming === null}
                onClick={saveStation}
              >
                {hasStation ? "Reactivate capture station" : "Create capture station"}
              </Button>
            )}
            {isEnabled && status && (
              <Button
                size="sm"
                variant="outline"
                colorPalette="red"
                loading={saving && confirming === "revoke"}
                onClick={() => setConfirming("revoke")}
              >
                <Prohibit />
                Revoke
              </Button>
            )}
          </HStack>
        )}

        {canManageStation && isEnabled && (
          <Box borderTopWidth="1px" borderColor="border.subtle" pt={3}>
            <Text fontSize="sm" fontWeight="600" color="fg.default">
              Dedicated kiosk device
            </Text>
            <Text fontSize="xs" color="fg.muted" mb={2}>
              Optional. Only needed for a shared iPad that stays in capture mode
              and is not signed in as a scholar. Turning a scholar&apos;s own
              assigned iPad into a capture station needs nothing here.
            </Text>
            <HStack flexWrap="wrap" gap={2}>
              <Button
                size="sm"
                variant="outline"
                colorPalette="violet"
                loading={saving && confirming === "rotate"}
                onClick={() =>
                  hasToken ? setConfirming("rotate") : issueEnrollmentToken()
                }
              >
                {hasToken ? <ArrowsClockwise /> : null}
                {hasToken ? "Rotate enrollment token" : "Set up a kiosk device"}
              </Button>
              {hasToken && (
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="red"
                  loading={saving && confirming === "clear"}
                  onClick={() => setConfirming("clear")}
                >
                  Clear kiosk enrollment
                </Button>
              )}
            </HStack>
          </Box>
        )}

        {!canManageStation && (
          <Text fontSize="xs" color="fg.muted">
            Capture-station setup is managed by school operations.
          </Text>
        )}

        {canManageStation && enrollmentToken && (
          <Field.Root>
            <Field.Label fontSize="sm">New enrollment token</Field.Label>
            <HStack align="stretch">
              <Input
                size="sm"
                value={enrollmentToken}
                readOnly
                onFocus={(event) => event.target.select()}
                aria-describedby={`capture-token-help-${groupId}`}
                fontFamily="mono"
                fontSize="xs"
              />
              <Button
                size="sm"
                variant="outline"
                flexShrink={0}
                onClick={copyToken}
                aria-label="Copy enrollment token"
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </HStack>
            <Field.HelperText id={`capture-token-help-${groupId}`}>
              Copy this now. It is shown only after creating or rotating the station.
            </Field.HelperText>
          </Field.Root>
        )}

        {hasStation && !isEnabled && !enrollmentToken && (
          <Text fontSize="xs" color="fg.muted">
            Revoked. Existing device sessions no longer work. Reactivate to use
            this group for capture again.
          </Text>
        )}

        {canManageStation && isEnabled && hasToken && (
          <Text fontSize="xs" color="fg.muted">
            Kiosk enrollment reaches the device through SimpleMDM managed app
            configuration — a locked fleet iPad has no way to accept a typed
            token.
          </Text>
        )}
      </Stack>

      <Dialog.Root
        open={confirming !== null}
        onOpenChange={(details) => !details.open && !saving && setConfirming(null)}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="440px">
              <Dialog.Header px={5} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" color="fg.default">
                  {confirming === "rotate"
                    ? "Rotate enrollment token"
                    : confirming === "clear"
                      ? "Clear kiosk enrollment"
                      : "Revoke capture station"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={5} py={3}>
                <Text fontSize="sm" color="fg.muted">
                  {confirming === "rotate"
                    ? "Rotating invalidates the current enrollment token and disconnects the kiosk device."
                    : confirming === "clear"
                      ? "The kiosk device is disconnected. Capture mode on scholars' assigned iPads keeps working."
                      : "Revoking stops this group's capture entirely, including assigned iPads. You can reactivate later."}
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={5} pb={5} pt={2} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(null)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  colorPalette={confirmationIsRotate ? "violet" : "red"}
                  loading={saving}
                  onClick={
                    confirming === "rotate"
                      ? issueEnrollmentToken
                      : confirming === "clear"
                        ? clearKioskEnrollment
                        : revokeStation
                  }
                >
                  {confirming === "rotate"
                    ? "Rotate token"
                    : confirming === "clear"
                      ? "Clear enrollment"
                      : "Revoke station"}
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
