"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Box, Button, Heading, HStack, Text, VStack } from "@chakra-ui/react";
import { FirstAid } from "@phosphor-icons/react";

import { HealthRecordStaffView } from "@/components/HealthRecordStaffView";
import { ScholarDocumentUploadModal } from "@/components/ScholarDocumentUploadModal";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { ScholarPickerContent } from "@/components/ScholarPicker";
import type { RosterScholar } from "@/hooks/useScholarRoster";
import { noScholarMatchCopy } from "@/shared/scholarSearchCopy";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { useHealthManagementAccess } from "@/hooks/useSchoolOperationsAccess";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * The health-only extension of the canonical staff health-record view. It is
 * deliberately not a second dashboard: selection returns identity only and the
 * detail remains HealthRecordStaffView, whose server APIs enforce the same
 * target-institution health boundary.
 */
export default function SchoolHealthPage() {
  const { user, isLoading } = useCurrentUser();
  const { activeInstitution, hasHealthManagementAccess } =
    useHealthManagementAccess(user, !!user);
  const authorization = useAuthorizationGuard({
    isLoading: isLoading || hasHealthManagementAccess === undefined,
    hasUser: !!user,
    isAllowed: hasHealthManagementAccess === true,
    unauthorizedRedirect: "/",
  });
  const institutionScope =
    activeInstitution?.scope === "institution"
      ? activeInstitution.institutionSlug ?? undefined
      : undefined;
  const scholars = useQuery(
    api.scholarHealthRecords.listHealthScholarsForStaff,
    authorization === "allowed" ? { institutionScope } : "skip",
  );
  const [scholarId, setScholarId] = useState<Id<"users"> | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const selectedScholar = scholars?.find((scholar) => scholar.id === scholarId);
  // The health list is its own institution- and health-gated read, so this
  // page feeds the shared picker directly rather than through
  // useScholarRoster (whose teacher-scoped roster, groups and affinity a
  // health-only staffer has no access to).
  const pickerScholars = useMemo<RosterScholar[]>(
    () =>
      (scholars ?? []).map((scholar) => ({
        id: scholar.id,
        name: scholar.name,
        username: null,
        image: scholar.image,
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

  if (authorization !== "allowed" || !user) {
    return <AuthorizationPending />;
  }

  return (
    <VStack align="stretch" gap={5} maxW="4xl">
      <Box>
        <HStack gap={2}>
          <FirstAid size={22} />
          <Heading size="md" fontFamily="heading" color="navy.500">
            Health records
          </Heading>
        </HStack>
        <Text mt={1} fontSize="sm" color="charcoal.400">
          Select a scholar to review health information and physician documents.
        </Text>
      </Box>

      <Box borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={3}>
        <ScholarPickerContent
          mode="single"
          selected={scholarId}
          onChange={(next) => setScholarId(next ? (next as Id<"users">) : null)}
          scholars={pickerScholars}
          isLoading={scholars === undefined}
          showGroups={false}
          showAffinityToggle={false}
          showEnrollmentStanding
          emptyHint="No scholars are available in this school."
          searchMissHint={noScholarMatchCopy({
            institutionName: activeInstitution?.institutionName ?? null,
            scope: activeInstitution?.scope ?? "institution",
          })}
          maxH="320px"
        />
      </Box>
      {scholarId && (
        <Box borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={5}>
          <HStack justify="flex-end" mb={4}>
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              Add health document
            </Button>
          </HStack>
          <HealthRecordStaffView
            scholarId={scholarId}
            institutionScope={institutionScope}
          />
          <ScholarDocumentUploadModal
            scholarId={scholarId}
            scholarName={selectedScholar?.name}
            institutionScope={institutionScope}
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
          />
        </Box>
      )}
    </VStack>
  );
}
