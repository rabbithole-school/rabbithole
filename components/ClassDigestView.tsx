"use client";

/**
 * ClassDigestView — the full view of a class digest. One component, both
 * scopes (DRY): scope="activity" (assignmentId+activityId) or
 * scope="cohort" (assignmentId).
 *
 * Reading layout, not card-soup: a header, then sections separated by
 * smallcaps eyebrows + whitespace + hairline rules. No nested filled
 * panels. Key moments are divider-separated rows with a colored kind dot,
 * not boxes. Per-moment triage is MomentActions.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Skeleton, Spinner, Stack, Text } from "@chakra-ui/react";
import { ArrowClockwise, ArrowRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { MomentActions } from "@/components/MomentActions";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

export type MomentKind =
  | "breakthrough"
  | "misconception"
  | "offTask"
  | "insight"
  | "needsHelp";

// Color carries the kind identity (a small dot + a label), no filled box.
export const MOMENT_CONFIG: Record<MomentKind, { label: string; color: string }> = {
  breakthrough: { label: "Breakthrough", color: "green.600" },
  insight: { label: "Insight", color: "violet.600" },
  misconception: { label: "Misconception", color: "orange.600" },
  offTask: { label: "Off task", color: "yellow.700" },
  needsHelp: { label: "Needs help", color: "red.600" },
};

const rule = { borderTopWidth: "1px", borderColor: "gray.100" } as const;

export function ClassDigestView({
  scope,
  assignmentId,
  activityId,
}: {
  scope: "activity" | "cohort";
  assignmentId?: Id<"assignments">;
  activityId?: Id<"activities">;
}) {
  const router = useRouter();
  const { scopeParam } = useActiveInstitution();
  const activityRes = useQuery(
    api.classDigests.getActivityDigest,
    scope === "activity" && activityId && assignmentId
      ? { assignmentId, activityId, scope: scopeParam }
      : "skip",
  );
  const cohortRes = useQuery(
    api.classDigests.getCohortDigest,
    scope === "cohort" && assignmentId
      ? { assignmentId, scope: scopeParam }
      : "skip",
  );
  const res = scope === "activity" ? activityRes : cohortRes;

  const requestActivity = useMutation(api.classDigests.requestActivityDigest);
  const requestCohort = useMutation(api.classDigests.requestCohortDigest);
  const createDebrief = useMutation(api.classDigests.createDebriefFromDigest);
  const [busy, setBusy] = useState(false);
  const [debriefing, setDebriefing] = useState(false);
  const digest = res?.digest;
  const themeItems = useMemo(
    () =>
      digest?.themes?.map((theme, index) => ({
        ...theme,
        key: `${index}:${theme.title}`,
      })) ?? [],
    [digest?.themes],
  );
  const momentItems = useMemo(() => {
    const moments = digest?.moments ?? [];
    return moments.map((moment, index) => ({
      ...moment,
      cfg: MOMENT_CONFIG[moment.kind as MomentKind] ?? MOMENT_CONFIG.insight,
      isLast: index === moments.length - 1,
      key: `${moment.kind}:${moment.scholarId}:${moment.headline}`,
    }));
  }, [digest?.moments]);
  const discussionPromptItems = useMemo(
    () =>
      digest?.discussionPrompts?.map((prompt, index) => ({
        prompt,
        key: `${index}:${prompt}`,
      })) ?? [],
    [digest?.discussionPrompts],
  );

  const regenerate = async () => {
    setBusy(true);
    try {
      if (scope === "activity" && activityId && assignmentId) {
        await requestActivity({ assignmentId, activityId });
      } else if (scope === "cohort" && assignmentId) {
        await requestCohort({ assignmentId });
      }
    } finally {
      setBusy(false);
    }
  };
  const makeDebrief = async () => {
    if (scope !== "activity" || !activityId || !assignmentId) return;
    setDebriefing(true);
    try {
      const { shareBackActivityId } = await createDebrief({ assignmentId, activityId });
      router.push(`/teacher/shareback/${shareBackActivityId}/${assignmentId}`);
    } finally {
      setDebriefing(false);
    }
  };

  if (res === undefined) {
    return (
      <Box maxW="760px" mx="auto" px={6} py={6} aria-hidden>
        <Box pb={5} {...rule} borderTopWidth="0">
          <Skeleton height="10px" w="108px" borderRadius="sm" mb={2} />
          <Flex justify="space-between" align="flex-start" gap={4} mt={1}>
            <Skeleton height="30px" w="52%" borderRadius="md" />
            <Skeleton height="32px" w="96px" borderRadius="md" flexShrink={0} />
          </Flex>
          <Skeleton height="10px" w="44%" borderRadius="sm" mt={3} />
        </Box>
        <Stack gap={3} mt={5}>
          <Skeleton height="16px" w="92%" borderRadius="sm" />
          <Skeleton height="16px" w="74%" borderRadius="sm" />
        </Stack>
        <Box mt={8}>
          <Skeleton height="10px" w="76px" borderRadius="sm" mb={3} />
          <Stack gap={4}>
            <Skeleton height="44px" borderRadius="md" />
            <Skeleton height="44px" borderRadius="md" />
          </Stack>
        </Box>
      </Box>
    );
  }
  if (res === null) {
    return (
      <Text py={16} textAlign="center" color="charcoal.400" fontSize="sm">
        Digest not available — you may not have access to this assignment.
      </Text>
    );
  }

  const current = res.current;
  const generating = busy || digest?.status === "pending";
  const meta =
    scope === "activity"
      ? `${current.completedCount} done · ${current.startedCount} started · ${current.deliverableCount} submitted`
      : `${current.completedCount} activities done · ${current.startedCount} active`;

  return (
    <Box maxW="760px" mx="auto" px={6} py={6}>
      {/* Header — no box, just type + a hairline under it */}
      <Box pb={5} {...rule} borderTopWidth="0">
        <SectionEyebrow>
          {scope === "activity" ? "Class digest" : "Class digest · today's read"}
        </SectionEyebrow>
        <Flex justify="space-between" align="flex-start" gap={4} mt={1}>
          <Text fontFamily="heading" fontWeight="700" fontSize="2xl" color="navy.500" lineHeight="1.25">
            {digest?.status === "ready" && digest.headline
              ? digest.headline
              : scope === "activity"
                ? "Activity digest"
                : "Today's read"}
          </Text>
          <Button
            size="sm"
            variant="ghost"
            color="charcoal.500"
            fontFamily="heading"
            flexShrink={0}
            onClick={regenerate}
            loading={generating}
          >
            <ArrowClockwise size={13} style={{ marginRight: 5 }} />
            {digest ? "Regenerate" : "Generate"}
          </Button>
        </Flex>
        <HStack gap={2} mt={1} color="charcoal.400" flexWrap="wrap">
          <Text fontSize="xs" fontFamily="heading">{meta}</Text>
          {digest?.status === "ready" && digest.generatedAt && (
            <Text fontSize="xs">· generated {new Date(digest.generatedAt).toLocaleString()}</Text>
          )}
          {digest?.stale && (
            <Text fontSize="xs" color="orange.600">
              · {digest.newSince} new since — regenerate for the latest
            </Text>
          )}
          {res.lensNarrowed && (
            <Text fontSize="xs" color="charcoal.400">
              · counts &amp; synthesis cover the full cohort
            </Text>
          )}
        </HStack>
      </Box>

      {!digest && (
        <Stack gap={1} align="center" textAlign="center" py={14}>
          <Text fontFamily="heading" fontWeight="700" color="navy.500">
            No digest yet
          </Text>
          <Text fontSize="sm" color="charcoal.400" maxW="sm">
            Once the class has done some work here, Rabbithole writes a glanceable read
            of how it landed — or generate one now.
          </Text>
        </Stack>
      )}

      {digest?.status === "error" && (
        <Text py={10} color="charcoal.400" fontSize="sm">
          Digest generation failed{digest.error ? `: ${digest.error}` : "."} Try Regenerate.
        </Text>
      )}

      {digest?.status === "pending" && (
        <HStack gap={2} color="charcoal.400" justify="center" py={12}>
          <Spinner size="sm" />
          <Text fontSize="sm" fontFamily="heading">Writing the digest…</Text>
        </HStack>
      )}

      {digest?.status === "ready" && (
        <Box>
          {digest.summary && (
            <Text fontSize="md" color="navy.600" lineHeight="1.65" mt={5}>
              {digest.summary}
            </Text>
          )}

          {themeItems.length > 0 && (
            <Box mt={8}>
              <SectionEyebrow>Themes</SectionEyebrow>
              <Stack gap={4} mt={3}>
                {themeItems.map((t) => (
                  <Box key={t.key}>
                    <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
                      {t.title}
                    </Text>
                    <Text fontSize="sm" color="charcoal.500" mt={0.5} lineHeight="1.55">
                      {t.body}
                    </Text>
                  </Box>
                ))}
              </Stack>
            </Box>
          )}

          {momentItems.length > 0 && (
            <Box mt={8}>
              <SectionEyebrow>Key moments</SectionEyebrow>
              <Box mt={1}>
                {momentItems.map((m) => (
                  // Content-based key so a Regenerate remounts the row and
                  // resets MomentActions' form/"Logged" state.
                  <Box
                    key={m.key}
                    py={4}
                    borderBottomWidth={m.isLast ? "0" : "1px"}
                    borderColor="gray.100"
                  >
                    <HStack gap={2} mb={1}>
                      <Box w="7px" h="7px" borderRadius="full" bg={m.cfg.color} flexShrink={0} />
                      <Text
                        fontSize="2xs"
                        fontFamily="heading"
                        fontWeight="700"
                        textTransform="uppercase"
                        letterSpacing="0.05em"
                        color={m.cfg.color}
                      >
                        {m.cfg.label}
                      </Text>
                      <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="charcoal.500">
                        {m.scholarName}
                      </Text>
                    </HStack>
                    <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm">
                      {m.headline}
                    </Text>
                    <Text fontSize="sm" color="charcoal.500" lineHeight="1.55" mt={0.5}>
                      {m.detail}
                    </Text>
                    <Box mt={2}>
                      <MomentActions
                        scholarId={m.scholarId}
                        scholarName={m.scholarName}
                        sessionId={m.sessionId as Id<"sessions">}
                        momentHeadline={m.headline}
                        momentDetail={m.detail}
                        kind={m.kind as MomentKind}
                      />
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {discussionPromptItems.length > 0 && (
            <Box mt={8}>
              <SectionEyebrow>Discussion prompts</SectionEyebrow>
              <Stack gap={3} mt={3}>
                {discussionPromptItems.map((p) => (
                  <HStack key={p.key} gap={2.5} align="flex-start">
                    <Text color="violet.400" fontWeight="700" lineHeight="1.55" flexShrink={0}>
                      ·
                    </Text>
                    <Text fontSize="sm" color="navy.600" lineHeight="1.55">
                      {p.prompt}
                    </Text>
                  </HStack>
                ))}
              </Stack>
            </Box>
          )}

          {scope === "activity" && (
            <Flex mt={10} pt={6} {...rule} justify="space-between" align="center" gap={4} flexWrap="wrap">
              <Box>
                <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
                  Turn this into a debrief
                </Text>
                <Text fontSize="xs" color="charcoal.400" mt={0.5}>
                  Spin up a Share Back, pre-shaped by what this digest found.
                </Text>
              </Box>
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                flexShrink={0}
                onClick={makeDebrief}
                loading={debriefing}
              >
                Make debrief
                <ArrowRight size={13} style={{ marginLeft: 5 }} />
              </Button>
            </Flex>
          )}
        </Box>
      )}
    </Box>
  );
}
