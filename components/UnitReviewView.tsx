"use client";

/**
 * The unit-level **Review** in the Rehearse tab — the "Reviewed" rung of
 * the maturity rail (review/curriculum-rehearse-and-maturity.md).
 *
 * Reads the last durable Review (unitReviews.latestForUnit) and renders it
 * as a re-runnable EQ/EU ↔ activity coverage grid: each Essential Question
 * / Enduring Understanding with a covered / weak / uncovered verdict and
 * the activities that engage it, plus implied-but-missing items and Bloom
 * gaps. "Review this unit" pushes the canned prompt into the Curriculum
 * Bot, which performs the audit and calls record_unit_review → the query
 * below updates reactively.
 *
 * Review is intrinsically unit-level (alignment is cross-activity), so the
 * Rehearse tab shows this for unit AND lesson selections; an online
 * activity shows the sims-rehearse panel instead.
 */
import { useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { CheckCircle, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { REVIEW_UNIT_PROMPT } from "@/lib/curriculumBotPrompts";
import { formatRelative } from "@/lib/relativeTime";
import PcmCoverageCard from "@/components/PcmCoverageCard";

type Verdict = "covered" | "weak" | "uncovered";
type CoverageRow = {
  item: string;
  kind: "essentialQuestion" | "enduringUnderstanding";
  verdict: Verdict;
  activityTitles?: string[];
};

const VERDICT_STYLE: Record<
  Verdict,
  { label: string; bg: string; color: string }
> = {
  covered: { label: "Covered", bg: "green.100", color: "green.700" },
  weak: { label: "Weak", bg: "orange.100", color: "orange.700" },
  uncovered: { label: "Uncovered", bg: "red.100", color: "red.700" },
};

export function UnitReviewView({
  unitId,
  askAi,
}: {
  unitId: Id<"units">;
  /** Push the Review prompt into the Curriculum Bot (undefined → no bot,
   *  e.g. a scholar's own IS unit — then there's no way to run a review). */
  askAi?: (prompt: string) => void;
}) {
  const review = useQuery(api.unitReviews.latestForUnit, { unitId });

  if (review === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  const runReview = askAi ? () => askAi(REVIEW_UNIT_PROMPT) : undefined;

  return (
    <Box h="full" overflowY="auto">
      <Stack gap={5} p={6} maxW="760px" mx="auto">
        {/* Header: what this is + when it last ran + the re-run trigger. */}
        <Flex align="center" justify="space-between" gap={3} flexWrap="wrap">
          <Stack gap={0.5}>
            <Text fontFamily="heading" fontWeight="700" fontSize="lg" color="navy.500">
              Heuristic review
            </Text>
            <Text fontSize="xs" color="charcoal.400">
              {review
                ? `Reviewed ${formatRelative(review.reviewedAt)}`
                : "Not reviewed yet"}{" "}
              · checks every Essential Question &amp; Enduring Understanding
              against the activities that engage it
            </Text>
          </Stack>
          {runReview && (
            <Button
              size="sm"
              variant={review ? "outline" : "solid"}
              colorPalette="violet"
              bg={review ? undefined : "violet.500"}
              color={review ? undefined : "white"}
              _hover={review ? undefined : { bg: "violet.600" }}
              fontFamily="heading"
              fontWeight="600"
              onClick={runReview}
            >
              <Sparkle weight="duotone" style={{ marginRight: 4 }} />
              {review ? "Re-run heuristic review" : "Run heuristic review"}
            </Button>
          )}
        </Flex>

        {!review ? (
          <EmptyReview hasTrigger={!!runReview} />
        ) : (
          <ReviewBody review={review} />
        )}

        {/* PCM-coverage check (assessment-and-goals §2/§4) — deterministic,
            independent of a bot Review run: can scholars produce evidence for
            each PCM dimension in this unit? */}
        <PcmCoverageCard unitId={unitId} />
      </Stack>
    </Box>
  );
}

function EmptyReview({ hasTrigger }: { hasTrigger: boolean }) {
  return (
    <Flex
      direction="column"
      align="center"
      gap={2}
      py={10}
      px={6}
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderStyle="dashed"
      borderRadius="lg"
      textAlign="center"
    >
      <Text fontFamily="heading" fontWeight="600" color="charcoal.500">
        No heuristic review yet
      </Text>
      <Text fontSize="sm" color="charcoal.400" maxW="420px">
        {hasTrigger
          ? "Run a heuristic review to check, in both directions, which Essential Questions and Enduring Understandings each activity genuinely engages. A coherent unit (no uncovered EQ/EU) clears the Heuristic review gate on the readiness strip."
          : "This unit hasn't had a heuristic review. A teacher with curriculum access can run one from the Curriculum Bot."}
      </Text>
    </Flex>
  );
}

function ReviewBody({
  review,
}: {
  review: NonNullable<ReturnType<typeof useQuery<typeof api.unitReviews.latestForUnit>>>;
}) {
  // summary is stored as v.any() — it's the Curriculum Bot's freeform tool
  // output (unitReviews.recordInternal does NOT validate its shape), so a
  // misbehaving model could emit a non-array `coverage`, a string `missing`,
  // an object `note`, etc. Coerce EVERYTHING to the expected shape before
  // rendering so a malformed review degrades gracefully instead of throwing
  // (`.filter`/`.map` is not a function / "Objects are not valid as a React
  // child") and blanking the Rehearse tab.
  const raw = (review.summary ?? {}) as Record<string, unknown>;
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const coverage: CoverageRow[] = Array.isArray(raw.coverage)
    ? (raw.coverage.filter(
        (r) => r && typeof r === "object" && typeof (r as CoverageRow).item === "string",
      ) as CoverageRow[])
    : [];
  const missing = asStrings(raw.missing);
  const bloomGaps = asStrings(raw.bloomGaps);
  const note = typeof raw.note === "string" ? raw.note : undefined;
  const eqs = coverage.filter((r) => r.kind === "essentialQuestion");
  const eus = coverage.filter((r) => r.kind === "enduringUnderstanding");
  const coherent = review.openGapCount === 0;

  return (
    <Stack gap={4}>
      {/* Verdict banner — coherent vs. N gaps. */}
      <HStack
        gap={2}
        px={4}
        py={3}
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
      >
        {coherent ? (
          <CheckCircle size={20} weight="duotone" color="var(--chakra-colors-green-500)" />
        ) : (
          <WarningCircle size={20} weight="duotone" color="var(--chakra-colors-orange-500)" />
        )}
        <Stack gap={0}>
          <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.500">
            {coherent
              ? "Coherent — every EQ/EU is engaged"
              : `${review.openGapCount} coverage gap${review.openGapCount === 1 ? "" : "s"}`}
          </Text>
          {note && (
            <Text fontSize="xs" color="charcoal.500">
              {note}
            </Text>
          )}
        </Stack>
      </HStack>

      {coverage.length > 0 && (
        <Stack gap={3}>
          {eqs.length > 0 && (
            <CoverageGroup title="Essential Questions" rows={eqs} />
          )}
          {eus.length > 0 && (
            <CoverageGroup title="Enduring Understandings" rows={eus} />
          )}
        </Stack>
      )}

      {missing.length > 0 && (
        <ListSection
          title="Implied but not listed"
          hint="The activities imply these, but the unit's EQ/EU lists don't name them."
          items={missing}
        />
      )}

      {bloomGaps.length > 0 && (
        <ListSection
          title="Bloom's-level gaps"
          hint="Cognitive levels the activities don't reach."
          items={bloomGaps}
        />
      )}
    </Stack>
  );
}

function CoverageGroup({ title, rows }: { title: string; rows: CoverageRow[] }) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" overflow="hidden">
      <Text
        px={4}
        pt={3}
        pb={2}
        fontSize="2xs"
        fontFamily="heading"
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="0.05em"
        color="charcoal.400"
      >
        {title}
      </Text>
      <Stack gap={0}>
        {rows.map((r, i) => {
          const style = VERDICT_STYLE[r.verdict] ?? VERDICT_STYLE.weak;
          return (
            <Flex
              key={`${r.item}-${i}`}
              gap={3}
              px={4}
              py={3}
              borderTopWidth="1px"
              borderColor="gray.100"
              align="flex-start"
            >
              <Badge
                bg={style.bg}
                color={style.color}
                fontFamily="heading"
                fontSize="2xs"
                flexShrink={0}
                mt={0.5}
              >
                {style.label}
              </Badge>
              <Stack gap={1} flex={1} minW={0}>
                <Text fontSize="sm" color="charcoal.600">
                  {r.item}
                </Text>
                {Array.isArray(r.activityTitles) && r.activityTitles.length > 0 && (
                  <HStack gap={1.5} flexWrap="wrap">
                    {r.activityTitles
                      .filter((t): t is string => typeof t === "string")
                      .map((t, j) => (
                      <Badge
                        key={`${t}-${j}`}
                        bg="gray.100"
                        color="charcoal.500"
                        fontSize="2xs"
                      >
                        {t}
                      </Badge>
                    ))}
                  </HStack>
                )}
              </Stack>
            </Flex>
          );
        })}
      </Stack>
    </Box>
  );
}

function ListSection({
  title,
  hint,
  items,
}: {
  title: string;
  hint: string;
  items: string[];
}) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.500" mb={0.5}>
        {title}
      </Text>
      <Text fontSize="xs" color="charcoal.400" mb={2}>
        {hint}
      </Text>
      <Stack gap={1.5}>
        {items.map((it, i) => (
          <HStack key={`${it}-${i}`} gap={2} align="flex-start">
            <Box mt={2} w="4px" h="4px" borderRadius="full" bg="charcoal.300" flexShrink={0} />
            <Text fontSize="sm" color="charcoal.600">
              {it}
            </Text>
          </HStack>
        ))}
      </Stack>
    </Box>
  );
}
