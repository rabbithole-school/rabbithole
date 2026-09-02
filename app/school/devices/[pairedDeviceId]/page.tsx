"use client";

import {
  Box,
  Button,
  Grid,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ArrowLeft, CheckCircle, DeviceTablet } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/ui/Surface";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  LostModeControl,
  RabbitholeLockControl,
  RoboticsCaptureStationModeControl,
} from "../DeviceSecurityControls";

function formatTimestamp(value: number) {
  return new Date(value).toLocaleString();
}

export default function DeviceSettingsPage() {
  const params = useParams<{ pairedDeviceId: string }>();
  const pairedDeviceId = params.pairedDeviceId as Id<"pairedDevices">;
  const { user, isLoading } = useCurrentUser();
  const { activeInstitution, hasSchoolOperationsAccess } = useSchoolOperationsAccess(user, !!user);
  const allowed = hasSchoolOperationsAccess === true;
  const authorization = useAuthorizationGuard({
    isLoading: isLoading || activeInstitution === undefined,
    hasUser: !!user,
    isAllowed: allowed,
    unauthorizedRedirect: "/school/devices",
  });
  const detail = useQuery(
    api.deviceLock.getDeviceSettings,
    authorization === "allowed" ? { pairedDeviceId } : "skip",
  );

  if (authorization !== "allowed") return <AuthorizationPending />;
  if (detail === undefined) {
    return (
      <HStack py={12} justify="center" color="charcoal.400">
        <Spinner size="sm" />
        <Text>Loading Device settings…</Text>
      </HStack>
    );
  }
  if (detail === null) {
    return (
      <Surface p={8}>
        <VStack align="start" gap={4}>
          <PageHeader title="Device not found" />
          <Text color="charcoal.500">
            This iPad is no longer paired or is outside your school.
          </Text>
          <Button asChild variant="outline" size="sm">
            <Link href="/school/devices">
              <ArrowLeft size={16} />
              Back to devices
            </Link>
          </Button>
        </VStack>
      </Surface>
    );
  }

  const desiredArmed = detail.desiredState === "armed";
  const appliedMatches =
    detail.appliedMatchesDesired &&
    detail.inSingleAppMode === desiredArmed;
  const deviceName = detail.deviceLabel ?? detail.serial ?? "iPad";

  return (
    <VStack align="stretch" gap={6}>
      <Breadcrumb
        items={[
          { label: "Devices", href: "/school/devices" },
          { label: "Device settings" },
        ]}
      />
      <PageHeader
        eyebrow="Device settings"
        title={deviceName}
        subtitle={
          detail.scholarName
            ? `Paired to ${detail.scholarName}${
                detail.scholarUsername ? ` (@${detail.scholarUsername})` : ""
              }`
            : "Paired iPad"
        }
        leading={<DeviceTablet size={28} weight="duotone" />}
      />
      <Grid
        templateColumns={{ base: "1fr", lg: "minmax(0, 1.3fr) minmax(280px, 0.7fr)" }}
        gap={6}
      >
        <VStack align="stretch" gap={6}>
          <RabbitholeLockControl
            device={{
              pairedDeviceId: detail._id,
              desiredState: detail.desiredState,
              disarmMode: detail.disarmMode,
              disarmExpiresAt: detail.disarmExpiresAt,
              appliedMatchesDesired: detail.appliedMatchesDesired,
              inSingleAppMode: detail.inSingleAppMode,
              institutionTimeZone: detail.institutionTimeZone,
            }}
          />
          {detail.scholarName && (
            <RoboticsCaptureStationModeControl pairedDeviceId={detail._id} />
          )}
          <LostModeControl pairedDeviceId={detail._id} />
        </VStack>
        <VStack align="stretch" gap={6}>
          <Surface p={6}>
            <VStack align="stretch" gap={3}>
              <Text fontFamily="heading" fontWeight="700" color="navy.500">
                iPad acknowledgement
              </Text>
              <HStack gap={2}>
                <CheckCircle
                  size={20}
                  weight="duotone"
                  color={appliedMatches ? "#22a06b" : "#8b93a1"}
                />
                <Text fontSize="sm" fontWeight="600" color="charcoal.600">
                  {appliedMatches ? "Applied on this iPad" : "Waiting for this iPad"}
                </Text>
              </HStack>
              <Text fontSize="xs" color="charcoal.400">
                Desired state and iOS state are shown separately so a remote
                command is never mistaken for an applied lock.
              </Text>
              <Box pt={2}>
                <Text fontSize="xs" color="charcoal.400">iOS Single App Mode</Text>
                <Text fontSize="sm" color="charcoal.600">
                  {detail.inSingleAppMode === true
                    ? "Active"
                    : detail.inSingleAppMode === false
                      ? "Not active"
                      : "Not reported yet"}
                </Text>
              </Box>
              {detail.appliedAt && (
                <Text fontSize="xs" color="charcoal.400">
                  Last reported {formatTimestamp(detail.appliedAt)}
                </Text>
              )}
            </VStack>
          </Surface>
          <Surface p={6}>
            <VStack align="stretch" gap={3}>
              <Text fontFamily="heading" fontWeight="700" color="navy.500">Device</Text>
              {detail.serial && <Box><Text fontSize="xs" color="charcoal.400">Serial number</Text><Text fontFamily="mono" fontSize="sm">{detail.serial}</Text></Box>}
              <Box><Text fontSize="xs" color="charcoal.400">School timezone</Text><Text fontSize="sm">{detail.institutionTimeZone}</Text></Box>
              <Box><Text fontSize="xs" color="charcoal.400">Setting updated</Text><Text fontSize="sm">{formatTimestamp(detail.desiredUpdatedAt)}{detail.desiredUpdatedByName ? ` by ${detail.desiredUpdatedByName}` : ""}</Text></Box>
            </VStack>
          </Surface>
        </VStack>
      </Grid>
    </VStack>
  );
}
