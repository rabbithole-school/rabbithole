"use client";

/**
 * The ONE canonical rendering of a teacher-only "recent misses" card — the
 * missed problem's snapshotted stem, what the scholar wrote vs. the expected
 * answer, the classified error-pattern phrasing (if any), and the retained
 * scratchpad working (if any). Reuses NodeDrawer's existing white-card visual
 * vocabulary — the raw per-instance evidence card, distinct from the yellow
 * aggregate-flag callout — rather than inventing a new one (necessity bar).
 *
 * This subsumes what used to be two independently-implemented "their working"
 * (image-only) cards — one inline in `NodeDrawer`, one as `ReportSkillWorking`
 * in `ScholarDomainReport` — both of which called the query now named
 * `recentMissesForNode`. Both call sites now render through here, and a third
 * — `SkillDetailPanel` — mounts it for the first time.
 *
 * Backed by `convex/practiceSkills.ts`'s `recentMissesForNode`
 * (teacher/self-only; empty for anyone else — never a throw).
 */

import { useQuery } from "convex/react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StemText } from "@/components/practice/StemText";
import { FractionText } from "@/components/FractionText";

export type RecentMiss = {
  nodeKey: string;
  at: number;
  stemSnapshot?: string;
  answerText?: string;
  expectedAnswer?: string;
  workImageUrl?: string;
  errorPattern?: string;
};

function formatMissDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** The one canonical per-miss render. `skillLabel` is only passed by the
 *  domain-level digest (where a miss can be on any of several skills); the
 *  node-scoped card omits it since the whole card is already about one skill.
 *  Exported for `RecentPracticeFeed`'s attempt-detail dialog, which reuses
 *  this exact stem/wrote-expected/pattern/working vocabulary (it fits correct
 *  attempts too — they simply have no expected answer or pattern). */
export function RecentMissEntry({
  miss,
  skillLabel,
  onJumpToNode,
}: {
  miss: RecentMiss;
  skillLabel?: string;
  onJumpToNode?: (nodeKey: string) => void;
}) {
  return (
    <Box _notLast={{ mb: 3, pb: 3, borderBottom: "1px solid #edf2f7" }}>
      <Flex align="baseline" justify="space-between" gap={2} mb={1}>
        {skillLabel ? (
          <Text
            as={onJumpToNode ? "button" : "span"}
            fontSize="2xs"
            fontWeight="700"
            color="violet.600"
            textTransform="uppercase"
            letterSpacing="0.03em"
            lineClamp={1}
            onClick={onJumpToNode ? () => onJumpToNode(miss.nodeKey) : undefined}
            cursor={onJumpToNode ? "pointer" : undefined}
            _hover={onJumpToNode ? { textDecoration: "underline" } : undefined}
          >
            {skillLabel}
          </Text>
        ) : (
          <Box />
        )}
        <Text fontSize="2xs" color="gray.500" flexShrink={0}>
          {formatMissDate(miss.at)}
        </Text>
      </Flex>
      {miss.stemSnapshot && (
        <Box mb={1}>
          {/* Bucket A: a per-miss evidence card, so the stem renders as the real
              table the scholar saw (via StemText) rather than raw pipes. */}
          <StemText value={miss.stemSnapshot} fontSize={14} align="left" color="charcoal.700" weight={400} lineHeight={1.4} />
        </Box>
      )}
      {(miss.answerText || miss.expectedAnswer) && (
        <Text fontSize="xs" color="charcoal.500" lineHeight="1.5">
          {miss.answerText && <>Wrote <b><FractionText value={miss.answerText} inline fontSize={12} color="inherit" align="left" /></b></>}
          {miss.answerText && miss.expectedAnswer && " · "}
          {miss.expectedAnswer && <>Expected <b><FractionText value={miss.expectedAnswer} inline fontSize={12} color="inherit" align="left" /></b></>}
        </Text>
      )}
      {miss.errorPattern && (
        <Text fontSize="xs" color="charcoal.500" mt={1} lineHeight="1.5">
          {miss.errorPattern}
        </Text>
      )}
      {miss.workImageUrl && (
        <Box maxW="220px" mt={2}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={miss.workImageUrl}
            alt="The scholar's handwritten working on this missed practice item"
            style={{
              width: "100%",
              borderRadius: 8,
              border: "1px solid #e2e8f0",
              display: "block",
            }}
          />
        </Box>
      )}
    </Box>
  );
}

/** The shared white-card wrapper (NodeDrawer's existing "Their working"
 *  vocabulary), now titled generically since it can hold text-only misses. */
function RecentMissesCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Box mb={4} bg="white" border="1px solid" borderColor="gray.200" borderRadius="10px" p={3}>
      <Text
        fontSize="xs"
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="0.04em"
        color="gray.600"
        mb={2}
      >
        {title}
      </Text>
      <Text fontSize="xs" color="gray.600" mb={2.5} lineHeight="1.5">
        {description}
      </Text>
      {children}
    </Box>
  );
}

/**
 * Recent misses on ONE node (scholar × skill). Mounted in `NodeDrawer` and
 * `SkillDetailPanel`. Owns its own query; renders nothing while loading with no
 * misses, and nothing once loaded if there are none (parity with the prior
 * `ReportSkillWorking` UX, now applied everywhere).
 */
export function RecentMissesForNode({
  scholarId,
  nodeKey,
  showLoading = false,
}: {
  scholarId: string;
  nodeKey: string;
  /** Show a small loading line while the query resolves. NodeDrawer's prior
   *  inline card had no loading state (nothing rendered until data arrived);
   *  `ScholarDomainReport`'s did. Default false preserves NodeDrawer's UX;
   *  pass true for a surface that wants the spinner. */
  showLoading?: boolean;
}) {
  const data = useQuery(api.practiceSkills.recentMissesForNode, {
    scholarId: scholarId as Id<"users">,
    nodeKey,
  });
  if (data === undefined) {
    if (!showLoading) return null;
    return (
      <Flex align="center" gap={2} mb={3}>
        <Text fontSize="2xs" color="charcoal.400">
          Loading recent misses…
        </Text>
      </Flex>
    );
  }
  if (data.misses.length === 0) return null;
  return (
    <RecentMissesCard
      title="Recent misses"
      description="What they wrote before missing here — the stem, what they typed, and the expected answer, in their own hand where captured."
    >
      <Flex direction="column" gap={0}>
        {data.misses.map((miss) => (
          <RecentMissEntry key={`${miss.nodeKey}-${miss.at}`} miss={miss} />
        ))}
      </Flex>
    </RecentMissesCard>
  );
}

/**
 * The teacher-only "I haven't learned this yet" strip for ONE node — the
 * counterpart to the misses card above, backed by `dontKnowsForNode`. A cluster
 * of don't-knows means "never taught → teach it", the OPPOSITE intervention from
 * a miss ("misconception → diagnose it"), yet the two render identically today.
 *
 * NEVER red: an honest "I don't know" is not a failure (this is the
 * redaction-safe legibility win), so it uses the same neutral white-card
 * vocabulary as the misses card, led by 🤷 and distinct from the ✗ misses — no
 * error colour. The `teachOutcome` rungs (solved / hint / stuck) read HOW DEEP
 * the scaffold got before the scholar left the teaching moment; "stuck" is the
 * strongest "teach this from scratch" signal the engine has, so it's emphasised
 * when present.
 *
 * Teacher-only by construction: the query redacts (empty for a scholar/parent,
 * throws for an unrelated caller) and NodeDrawer mounts this only for
 * `audience === "teacher"`. Renders nothing while loading and nothing once
 * loaded if there are no don't-knows (parity with the misses card).
 */
export function DontKnowStripForNode({
  scholarId,
  nodeKey,
}: {
  scholarId: string;
  nodeKey: string;
}) {
  const data = useQuery(api.practiceSkills.dontKnowsForNode, {
    scholarId: scholarId as Id<"users">,
    nodeKey,
  });
  if (data === undefined || data.count === 0) return null;
  const { count, teachOutcomes } = data;
  const rungs = ["solved", "hint", "stuck"] as const;
  return (
    <Box mb={4} bg="white" border="1px solid" borderColor="gray.200" borderRadius="10px" p={3}>
      <Flex align="flex-start" gap={2.5}>
        <Text fontSize="lg" lineHeight="1.2" flexShrink={0} aria-hidden="true">
          🤷
        </Text>
        <Box flex="1" minW={0}>
          <Flex align="baseline" justify="space-between" gap={2} mb={0.5}>
            <Text fontSize="sm" fontWeight="700" color="charcoal.700">
              Hasn&rsquo;t been taught yet
            </Text>
            <Text fontSize="sm" fontWeight="700" color="charcoal.600" flexShrink={0}>
              {count}
            </Text>
          </Flex>
          <Text fontSize="xs" color="charcoal.500" lineHeight="1.5">
            Tapped &ldquo;I haven&rsquo;t learned this yet&rdquo; {count === 1 ? "once" : `${count} times`} —
            honest confusion, not a misconception
          </Text>
          <Flex gap={3} mt={1.5}>
            {rungs.map((rung) => {
              const strong = rung === "stuck" && teachOutcomes.stuck > 0;
              return (
                <Text
                  key={rung}
                  fontSize="2xs"
                  fontWeight={strong ? "700" : "600"}
                  textTransform="uppercase"
                  letterSpacing="0.03em"
                  color={strong ? "charcoal.700" : "gray.500"}
                >
                  {rung} {teachOutcomes[rung]}
                </Text>
              );
            })}
          </Flex>
        </Box>
      </Flex>
    </Box>
  );
}
