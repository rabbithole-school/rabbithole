"use client";

import { useQuery } from "convex/react";
import { HStack, Text, VStack } from "@chakra-ui/react";
import { Camera } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { Surface } from "@/components/ui/Surface";
import { CaptureStationGroupSection } from "@/components/CaptureStationGroupSection";
import { EXTENDED_EDUCATION_LABEL } from "@/shared/scholarGroupRouting";

export function CaptureStationsSection({
  institutionScope,
  canManageStations = true,
}: {
  institutionScope: string;
  canManageStations?: boolean;
}) {
  const groups = useQuery(api.captureStations.listForSchool, {
    institutionScope,
  });

  if (!groups) return null;

  return (
    <Surface p={6}>
      <HStack gap={2} mb={1} color="navy.500">
        <Camera size={20} weight="duotone" />
        <Text fontFamily="heading" fontWeight="700" fontSize="lg">
          Program capture stations
        </Text>
      </HStack>
      <Text fontSize="sm" color="charcoal.400" mb={4}>
        Enroll and manage the capture stations for the{" "}
        {EXTENDED_EDUCATION_LABEL} programs assigned to you. Photos and videos
        they capture arrive in the uploads queue.
      </Text>
      {groups.length ? (
        <VStack align="stretch" gap={3}>
          {groups.map((group) => (
            <CaptureStationGroupSection
              key={group.groupId}
              groupId={group.groupId}
              groupName={group.groupName}
              canManageStation={canManageStations}
            />
          ))}
        </VStack>
      ) : (
        <Text fontSize="sm" color="charcoal.400">
          No capture stations are assigned to you yet.
        </Text>
      )}
    </Surface>
  );
}
