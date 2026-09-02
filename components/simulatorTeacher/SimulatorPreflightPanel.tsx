"use client";

/**
 * The PREFLIGHT tab for a World (plan §8). Two checks before a World meets kids:
 * (a) Achievability — a BUDGETED batch of short sims with starter-hint and
 * deterministic degenerate decks, run through the same engine a scholar's bench
 * uses. (b) Criterion red-team — calibrated separation verdicts whose noise band
 * comes from the duplicate starter runs, plus the remaining human-judgment check.
 *
 * The run button is rate-limited: disabled while a batch is active and while the
 * per-block allowance is spent, so a click can never enqueue unbounded paid work.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, SimpleGrid, Spinner, Stack, Text } from "@chakra-ui/react";
import { CaretDown, CaretUp, Play, Robot } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { fmt, metricLabel } from "./helpers";

type Spread = { count: number; min: number; max: number; mean: number } | null;
type Variant = {
  total: number;
  completed: number;
  running: number;
  crashed: number;
  spread: Spread;
  invalidRate: number | null;
  fallbackToNeutralCount: number | null;
};
type Reference = {
  summary: string;
  facts: Variant;
};
type Separation = {
  verdict: "separated" | "close" | "degenerate-wins";
  referenceAdvantage: number;
  noiseBand: number;
};
type Reading = {
  state: "not-run" | "running" | "incomplete" | "attention" | "clear";
  verdict: string;
  title: string;
  summary: string;
  nextStep: string;
  evidence: {
    intendedLabel: string;
    intendedMean: number;
    referenceMean: number | null;
    shortcutMinMean: number;
    shortcutMaxMean: number;
    story: {
      setup: string;
      clearTemplate: string;
    } | null;
  } | null;
};

const VARIANT_LABELS = {
  empty: "Empty deck",
  noop: "Pure noop",
  greedy: "Greedy rule",
} as const;

const VARIANT_SUBTITLES = {
  empty: "no authored instructions",
  noop: "always takes the neutral action",
  greedy: "always takes the template's greedy action",
} as const;

const VERDICT_STYLES = {
  separated: { color: "green.700", borderColor: "green.200", bg: "green.50" },
  close: { color: "orange.700", borderColor: "orange.200", bg: "orange.50" },
  "degenerate-wins": { color: "red.700", borderColor: "red.200", bg: "red.50" },
} as const;

const READING_STYLES: Record<
  Reading["state"],
  { borderColor: string; bg: string; color: string }
> = {
  "not-run": { borderColor: "gray.200", bg: "gray.50", color: "navy.500" },
  running: { borderColor: "blue.200", bg: "blue.50", color: "blue.700" },
  incomplete: { borderColor: "orange.200", bg: "orange.50", color: "orange.700" },
  attention: { borderColor: "orange.200", bg: "orange.50", color: "orange.700" },
  clear: { borderColor: "green.200", bg: "green.50", color: "green.700" },
};

function VariantCard({ name, sub, variant, metricKey }: { name: string; sub: string; variant: Variant; metricKey: string | null }) {
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
      <Text fontFamily="heading" fontWeight="800" fontSize="sm" color="navy.500">
        {name}
      </Text>
      <Text fontSize="2xs" color="charcoal.400" mb={2}>
        {sub}
      </Text>
      <Stack gap={0.5}>
        <ReadRow label={`${metricLabel(metricKey)} — mean`} value={fmt(variant.spread?.mean)} />
        <ReadRow label="range" value={variant.spread ? `${fmt(variant.spread.min)} – ${fmt(variant.spread.max)}` : "—"} />
        <ReadRow
          label="invalid actions"
          value={
            variant.invalidRate === null
              ? "—"
              : `${Math.round(variant.invalidRate * 100)}%`
          }
        />
        <ReadRow
          label="runs"
          value={`${variant.completed}/${variant.total} done${variant.running ? ` · ${variant.running} running` : ""}${variant.crashed ? ` · ${variant.crashed} crashed` : ""}`}
        />
      </Stack>
    </Box>
  );
}

function ReferenceCard({
  reference,
  metricKey,
}: {
  reference: Reference;
  metricKey: string | null;
}) {
  return (
    <Box borderWidth="1px" borderColor="violet.200" borderRadius="md" bg="violet.50" p={3}>
      <Text fontFamily="heading" fontWeight="800" fontSize="sm" color="navy.500">
        Authored reference strategy
      </Text>
      <Text fontSize="2xs" color="charcoal.500" mb={2} lineHeight="1.4">
        {reference.summary}
      </Text>
      <Stack gap={0.5}>
        <ReadRow label={`${metricLabel(metricKey)} — mean`} value={fmt(reference.facts.spread?.mean)} />
        <ReadRow
          label="range"
          value={
            reference.facts.spread
              ? `${fmt(reference.facts.spread.min)} – ${fmt(reference.facts.spread.max)}`
              : "—"
          }
        />
        <ReadRow
          label="runs"
          value={`${reference.facts.completed}/${reference.facts.total} done${reference.facts.running ? ` · ${reference.facts.running} running` : ""}${reference.facts.crashed ? ` · ${reference.facts.crashed} crashed` : ""}`}
        />
      </Stack>
    </Box>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <HStack justify="space-between" gap={3}>
      <Text fontSize="2xs" color="charcoal.400">
        {label}
      </Text>
      <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="charcoal.600">
        {value}
      </Text>
    </HStack>
  );
}

function resultNarrative(reading: Reading, metricKey: string | null): string {
  if (!reading.evidence || reading.state === "running" || reading.state === "incomplete") {
    return reading.summary;
  }
  const {
    intendedLabel,
    intendedMean,
    referenceMean,
    shortcutMinMean,
    shortcutMaxMean,
  } = reading.evidence;
  const shortcutRange =
    shortcutMinMean === shortcutMaxMean
      ? fmt(shortcutMinMean)
      : `${fmt(shortcutMinMean)}–${fmt(shortcutMaxMean)}`;
  const numbers =
    `${intendedLabel} averaged ${fmt(intendedMean)} ${metricLabel(metricKey)}; ` +
    `tested shortcuts averaged ${shortcutRange}.`;
  const referenceContext =
    referenceMean === null
      ? ""
      : ` The authored reference strategy averaged ${fmt(referenceMean)}.`;
  const storyTemplate = reading.evidence.story?.clearTemplate;
  if (
    reading.state === "clear" &&
    typeof storyTemplate === "string" &&
    referenceMean !== null
  ) {
    return storyTemplate
      .replace("{referenceMean}", fmt(referenceMean))
      .replace("{starterMean}", fmt(intendedMean))
      .replace("{shortcutRange}", shortcutRange);
  }
  return `${reading.summary} ${numbers}${referenceContext}`;
}

function VerdictRow({
  variant,
  comparison,
  separation,
  hasRun,
  complete,
  crashed,
  calibrationUnavailable,
  fallbackToNeutralCount,
}: {
  variant: keyof typeof VARIANT_LABELS;
  comparison: string;
  separation: Separation | null;
  hasRun: boolean;
  complete: boolean;
  crashed: boolean;
  calibrationUnavailable: boolean;
  fallbackToNeutralCount: number | null;
}) {
  return (
    <Flex
      justify="space-between"
      align={{ base: "flex-start", sm: "center" }}
      direction={{ base: "column", sm: "row" }}
      gap={2}
      py={2.5}
      borderTopWidth="1px"
      borderColor="gray.100"
    >
      <Box>
        <Text fontSize="xs" fontFamily="heading" fontWeight="700" color="charcoal.600">
          {VARIANT_LABELS[variant]}
        </Text>
        {separation ? (
          <Text fontSize="2xs" color="charcoal.400">
            {comparison} advantage: {fmt(separation.referenceAdvantage)}
          </Text>
        ) : crashed ? (
          <Text fontSize="2xs" color="red.600">
            Compiled probe failed. Run Preflight again.
          </Text>
        ) : calibrationUnavailable && complete ? (
          <Text fontSize="2xs" color="charcoal.400">
            Compiled probe complete. Starter calibration is unavailable at this population size.
          </Text>
        ) : hasRun ? (
          <Text fontSize="2xs" color="charcoal.400">
            Runs in progress.
          </Text>
        ) : (
          <Text fontSize="2xs" color="charcoal.400">
            Run Preflight again to add this probe.
          </Text>
        )}
        {fallbackToNeutralCount !== null && fallbackToNeutralCount > 0 && (
          <Text fontSize="2xs" color="orange.700">
            {fallbackToNeutralCount} greedy actions fell back to neutral.
          </Text>
        )}
      </Box>
      {separation && (
        <Text
          px={2}
          py={0.5}
          borderWidth="1px"
          borderRadius="full"
          fontSize="2xs"
          fontFamily="heading"
          fontWeight="800"
          flexShrink={0}
          {...VERDICT_STYLES[separation.verdict]}
        >
          {separation.verdict}
        </Text>
      )}
    </Flex>
  );
}

function preflightBotPrompt({
  activityTitle,
  metricKey,
  reading,
  rows,
}: {
  activityTitle: string;
  metricKey: string | null;
  reading: Reading;
  rows: Array<{
    variant: keyof typeof VARIANT_LABELS;
    separation: Separation | null;
  }>;
}) {
  const shortcutChecks = rows
    .map(
      (row) =>
        `${VARIANT_LABELS[row.variant]}: ${row.separation?.verdict ?? "incomplete"}`,
    )
    .join("; ");
  const request =
    reading.state === "attention"
      ? "Propose the smallest concrete revision to the Simulator configuration, criterion, or starter hint that would preserve the intended decision while making the shortcuts less competitive. Explain what to rehearse next."
      : reading.state === "clear"
        ? "Explain why this balance supports the intended decision, name the evidence a teacher should keep watching, and say plainly if no revision is warranted."
        : "Explain what evidence is missing and what to rehearse next before changing the activity.";
  return (
    `Review the Simulator activity "${activityTitle}". Its Preflight reading is ` +
    `"${reading.title}: ${reading.summary}" The activity's criterion is ` +
    `"${metricLabel(metricKey)}". Shortcut checks: ${shortcutChecks}. ` +
    `${request} Do not make changes until I approve.`
  );
}

export function SimulatorPreflightPanel({
  activityId,
  activityTitle,
  askAi,
}: {
  activityId: Id<"activities">;
  activityTitle: string;
  askAi?: (prompt: string) => void;
}) {
  const status = useQuery(api.simulatorTeacher.preflightStatus, { activityId });
  const start = useMutation(api.simulatorTeacher.startPreflight);
  const [running, setRunning] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    try {
      await start({ activityId });
      toaster.success({ title: "Preflight launched — sims are running." });
    } catch (e) {
      toaster.error({ title: e instanceof Error ? e.message : "Preflight failed" });
    } finally {
      setRunning(false);
    }
  };

  if (status === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Loading…
        </Text>
      </Flex>
    );
  }
  if (status === null) {
    return (
      <Flex h="full" align="center" justify="center" p={8}>
        <Text fontSize="sm" color="charcoal.400" textAlign="center">
          This activity has no Simulator configured yet. Set one up on the Edit tab first.
        </Text>
      </Flex>
    );
  }

  const metricKey = status.criterion.metricKey;
  const remaining = Math.max(0, status.allowancePerBlock - status.batchesThisBlock);
  const canRun = !status.active && remaining > 0 && !running;
  const redTeam = status.redTeam;
  const reading = status.reading as Reading;
  const progressFacts = status.variants
    ? [
        status.variants.reasonable,
        ...(status.variants.reference ? [status.variants.reference] : []),
        ...status.variants.probes.map((probe) => probe.facts),
      ]
    : [];
  const completedChecks = progressFacts.reduce((total, facts) => total + facts.completed, 0);
  const totalChecks = progressFacts.reduce((total, facts) => total + facts.total, 0);
  const progressPercent =
    totalChecks > 0 ? Math.round((completedChecks / totalChecks) * 100) : 0;
  // `verdict` can be briefly absent while a reactive response from an older
  // backend build is still in flight, so fall back to a neutral heading.
  const summaryHeading =
    typeof reading.verdict === "string" && reading.verdict.length > 0
      ? reading.verdict
      : reading.state === "running"
        ? "Rehearsal in progress"
        : "Preflight summary";
  const canAskBot =
    askAi !== undefined &&
    (reading.state === "attention" || reading.state === "incomplete");
  const botLabel =
    reading.state === "attention"
      ? "Ask Bot to suggest a revision"
      : "Ask Bot what to rehearse next";

  return (
    <Box h="full" overflowY="auto" p={5}>
      <Stack gap={4} maxW="820px" mx="auto">
        <Box
          borderWidth="1px"
          borderRadius="lg"
          p={4}
          {...READING_STYLES[reading.state]}
        >
          <Flex justify="space-between" align="flex-start" gap={4} wrap="wrap">
            <Stack gap={1} maxW="580px">
              <Text fontFamily="heading" fontWeight="800" fontSize="sm">
                {summaryHeading}
              </Text>
              <Text fontSize="sm" color="charcoal.600" lineHeight="1.5">
                <Box as="span" fontWeight="700">
                  {reading.title}.
                </Box>{" "}
                {resultNarrative(reading, metricKey)}
              </Text>
              <Text fontSize="xs" color="charcoal.600" lineHeight="1.5">
                <Box as="span" fontFamily="heading" fontWeight="700">
                  Recommended next step:{" "}
                </Box>
                {reading.nextStep}
              </Text>
            </Stack>
            <Stack gap={2} align={{ base: "stretch", sm: "flex-end" }} flexShrink={0}>
              <Button
                size="sm"
                bg="green.600"
                color="white"
                fontFamily="heading"
                fontWeight="700"
                _hover={{ bg: "green.700" }}
                loading={running}
                disabled={!canRun}
                onClick={handleRun}
              >
                <Play size={14} weight="fill" style={{ marginRight: 4 }} />
                {status.active ? "Rehearsing…" : status.batch ? "Rehearse again" : "Run Preflight"}
              </Button>
              <Text fontSize="2xs" color="charcoal.500" textAlign="right">
                {remaining}/{status.allowancePerBlock} batches left this block
              </Text>
            </Stack>
          </Flex>
          {reading.state === "running" && (
            <Box mt={4} maxW="580px">
              <HStack gap={2} mb={2}>
                <Spinner size="xs" color="blue.600" />
                <Text fontSize="xs" fontFamily="heading" fontWeight="700" color="blue.700">
                  {totalChecks > 0
                    ? `${completedChecks} of ${totalChecks} simulation checks complete`
                    : "Preparing simulation checks"}
                </Text>
              </HStack>
              <Box
                h="6px"
                borderRadius="full"
                overflow="hidden"
                bg="blue.100"
                role="progressbar"
                aria-label="Preflight rehearsal progress"
                aria-valuemin={0}
                aria-valuemax={totalChecks || undefined}
                aria-valuenow={totalChecks > 0 ? completedChecks : undefined}
              >
                <Box
                  h="full"
                  w={totalChecks > 0 ? `${progressPercent}%` : "18%"}
                  bg="blue.500"
                  borderRadius="full"
                  transition="width 0.2s ease"
                />
              </Box>
              <Text fontSize="2xs" color="charcoal.500" mt={2}>
                Checking the authored reference, starter behavior, and each shortcut.
              </Text>
            </Box>
          )}
          {(canAskBot || status.variants) && (
            <HStack mt={4} gap={2} flexWrap="wrap">
              {canAskBot && (
                <Button
                  size="xs"
                  variant="outline"
                  colorPalette="violet"
                  fontFamily="heading"
                  fontWeight="700"
                  onClick={() =>
                    askAi?.(
                      preflightBotPrompt({
                        activityTitle,
                        metricKey,
                        reading,
                        rows: redTeam?.rows ?? [],
                      }),
                    )
                  }
                >
                  <Robot weight="duotone" style={{ marginRight: 4 }} />
                  {botLabel}
                </Button>
              )}
              {status.variants && (
                <Button
                  size="xs"
                  variant="ghost"
                  color="charcoal.600"
                  fontFamily="heading"
                  fontWeight="700"
                  aria-expanded={showEvidence}
                  onClick={() => setShowEvidence((current) => !current)}
                >
                  {showEvidence ? <CaretUp style={{ marginRight: 4 }} /> : <CaretDown style={{ marginRight: 4 }} />}
                  {showEvidence ? "Hide evidence" : "Show evidence"}
                </Button>
              )}
            </HStack>
          )}
        </Box>

        {showEvidence && (
          <>
            <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" p={4}>
              <Text fontFamily="heading" fontWeight="800" fontSize="sm" color="navy.500" mb={1}>
                Rehearsal evidence
              </Text>
              <Text fontSize="xs" color="charcoal.500" mb={3}>
                Starter duplicates calibrate the noise band. Fixed-seed reference runs and
                compiled shortcuts use this activity&apos;s existing criterion.
              </Text>
              {status.variants ? (
                <SimpleGrid columns={{ base: 1, md: 2 }} gap={3}>
                  <VariantCard name="Reasonable deck" sub="the template's starter hints" variant={status.variants.reasonable} metricKey={metricKey} />
                  {status.variants.reference && status.reference.available && (
                    <ReferenceCard
                      reference={{
                        summary: status.reference.summary ?? "",
                        facts: status.variants.reference,
                      }}
                      metricKey={metricKey}
                    />
                  )}
                  {status.variants.probes.map(({ variant, facts }) => (
                    <VariantCard
                      key={variant}
                      name={VARIANT_LABELS[variant]}
                      sub={VARIANT_SUBTITLES[variant]}
                      variant={facts}
                      metricKey={metricKey}
                    />
                  ))}
                </SimpleGrid>
              ) : (
                <Text fontSize="xs" color="charcoal.400">
                  No Preflight run yet.
                </Text>
              )}
            </Box>

            <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" p={4}>
              <Text fontFamily="heading" fontWeight="800" fontSize="sm" color="navy.500" mb={1}>
                Criterion red-team
              </Text>
              <Text fontSize="xs" color="charcoal.500" mb={3}>
                Does the criterion distinguish authored effort from deterministic shortcuts?
              </Text>
              {redTeam ? (
                <>
                  <Text fontSize="2xs" color="charcoal.400" mb={1}>
                    Starter duplicate spread: {fmt(redTeam.noiseBand)}
                  </Text>
                  <Box>
                    {redTeam.rows.map((row) => {
                      const facts = status.variants?.probes.find(
                        (probe) => probe.variant === row.variant,
                      )?.facts;
                      return (
                        <VerdictRow
                          key={row.variant}
                          variant={row.variant}
                          comparison={row.comparison}
                          separation={row.separation}
                          hasRun={(facts?.total ?? 0) > 0}
                          complete={
                            (facts?.total ?? 0) > 0 &&
                            facts?.completed === facts?.total
                          }
                          crashed={(facts?.crashed ?? 0) > 0}
                          calibrationUnavailable={
                            redTeam.calibrationUnavailable
                          }
                          fallbackToNeutralCount={row.fallbackToNeutralCount}
                        />
                      );
                    })}
                  </Box>
                </>
              ) : (
                <Text fontSize="xs" color="charcoal.400">
                  Run Preflight to compare the degenerate decks.
                </Text>
              )}
              {status.probeNote && (
                <Text fontSize="xs" color="charcoal.500" mt={3}>
                  {status.probeNote}
                </Text>
              )}
            </Box>

            {status.humanChecklist.length > 0 && (
              <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" p={4}>
                <Text fontFamily="heading" fontWeight="800" fontSize="sm" color="navy.500" mb={1}>
                  Human review
                </Text>
                <Text fontSize="xs" color="charcoal.500" mb={3}>
                  This check still depends on reading the shape of the run, not only its final score.
                </Text>
                <Stack gap={2}>
                  {status.humanChecklist.map((note) => (
                    <Box key={note.title}>
                      <Text fontSize="xs" fontFamily="heading" fontWeight="700" color="charcoal.600">
                        {note.title}
                      </Text>
                      <Text fontSize="xs" color="charcoal.500" lineHeight="1.5">
                        {note.detail}
                      </Text>
                    </Box>
                  ))}
                </Stack>
              </Box>
            )}
          </>
        )}
      </Stack>
    </Box>
  );
}
