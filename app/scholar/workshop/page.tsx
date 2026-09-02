"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Box, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { ScholarPrepShell } from "@/components/ScholarPrepShell";
import { WorkshopView } from "@/components/WorkshopView";
import { workshopMissionLine } from "@/shared/workshopSparks";

/**
 * The Workshop view — the ideas board alone (the shipped WorkshopView, reused
 * as-is). A standing place: reached from the Scholar's-Prep chooser AND anytime
 * from the account menu. Its idea chips open the standing Ask Rabbithole chat
 * seeded with the phrase.
 * review/prep-time-chooser.html.
 */
function WorkshopPageBody() {
  const router = useRouter();
  const params = useSearchParams();
  const fromPrep = params.get("from") === "prep";
  // Name the mission line to the scholar's OWN school, mirroring the native
  // MissionSubhead: the SAME query, no scope arg (a scholar isn't a multi-
  // institution teacher, so the ?inst= lens doesn't apply). Reading the query
  // directly rather than via useActiveInstitution keeps this page free of
  // useSearchParams — which would need a Suspense boundary to prerender.
  const activeInstitution = useQuery(api.memberships.resolveActiveInstitution, {});

  const seedAsk = (phrase: string) =>
    router.push(
      `/scholar/workshop/ask?seed=${encodeURIComponent(phrase)}&n=${Date.now()}`,
    );

  return (
    <ScholarPrepShell
      title="The Workshop"
      backHref={fromPrep ? "/scholar?tab=prep" : "/scholar"}
      preferBackHref={fromPrep}
    >
      <Box h="full" display="flex" flexDirection="column">
        {/* The mission line — a Workshop-LEVEL subhead, quiet register. */}
        <Box
          px={{ base: 4, md: 6 }}
          py={2.5}
          bg="gray.50"
          borderBottomWidth="1px"
          borderColor="gray.100"
          flexShrink={0}
        >
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.5">
            {workshopMissionLine(activeInstitution?.institutionName)}
          </Text>
        </Box>
        <Box flex={1} minH={0} overflowY="auto" bg="gray.50">
          <WorkshopView onSpark={seedAsk} />
        </Box>
      </Box>
    </ScholarPrepShell>
  );
}

export default function ScholarWorkshopPage() {
  return (
    <Suspense fallback={null}>
      <WorkshopPageBody />
    </Suspense>
  );
}
