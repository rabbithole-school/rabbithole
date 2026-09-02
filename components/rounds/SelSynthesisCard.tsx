"use client";

/**
 * The SEL synthesis card — the written weekly synthesis of a scholar's
 * strengths (and things to watch), read on the SEL Thursday board row and pane.
 *
 * It is the presentational half of the read model shipped in PR 3
 * (`convex/selSyntheses.ts`): strengths first, then watch, each claim a plain
 * sentence with its cited sources quoted quietly beneath it, and a generation
 * timestamp so the room reads a stable text rather than a query that shifts
 * mid-meeting. A quiet week says so.
 *
 * ⚠️ CHARTER. This surface is teacher-facing only and grey all the way down —
 * it never reaches the tutor (`rounds-two-cadence-plan.html` §Part B). No
 * scores, no meters, no color-only encoding. In particular STRENGTHS ARE NOT
 * GREEN: green means "reaches the child" (guidance), and the synthesis never
 * does. Everything here is charcoal.
 */

import { Box, Button, HStack, Spinner, Stack, Text } from "@chakra-ui/react";

import { SectionEyebrow } from "@/components/ui/SectionEyebrow";

import { roundsDate, roundsDateTime } from "./roundsEvidence";
import type {
  SelSynthesisCite,
  SelSynthesisClaim,
  SelSynthesisRow,
} from "./selSynthesisView";

export type {
  SelSynthesisCite,
  SelSynthesisClaim,
  SelSynthesisRow,
} from "./selSynthesisView";

/** A quiet source label + date, per the charter's "attributable evidence"
 *  house style. The verbatim teacher record is quoted separately, so an
 *  observation cite here is just a pointer, not a re-quote. */
function citeText(cite: SelSynthesisCite): string {
  const date = roundsDate(cite.at);
  switch (cite.kind) {
    case "sessionSignal":
      return `signal “${cite.label}” · ${date}`;
    case "analysis":
      return `observer analysis · ${date}`;
    case "alert":
      return `alert · ${date}`;
    case "observation":
      return `teacher note · ${date}`;
  }
}

function ClaimList({ claims }: { claims: SelSynthesisClaim[] }) {
  return (
    <Stack gap={3}>
      {claims.map((claim, i) => (
        <Box key={i}>
          <Text
            fontFamily="body"
            fontSize="sm"
            lineHeight="1.5"
            color="charcoal.600"
          >
            {claim.text}
          </Text>
          {claim.cites.map((cite) => (
            <Text
              key={`${cite.kind}:${cite.id}`}
              fontFamily="heading"
              fontSize="xs"
              color="charcoal.300"
              mt={0.5}
            >
              {citeText(cite)}
            </Text>
          ))}
        </Box>
      ))}
    </Stack>
  );
}

export function SelSynthesisCard({
  synthesis,
  loading,
  canGenerate = false,
  onGenerate,
  generating = false,
  error,
}: {
  /** null when no synthesis has been written for this scholar/week. */
  synthesis: SelSynthesisRow | null;
  /** The batched read has not answered yet for this scholar. */
  loading: boolean;
  /** Teachers may trigger the manual batch; operations staff may not. */
  canGenerate?: boolean;
  onGenerate?: () => void;
  generating?: boolean;
  error?: string | null;
}) {
  if (loading && !synthesis) {
    return (
      <HStack gap={2} py={2} color="charcoal.300">
        <Spinner size="sm" />
        <Text fontFamily="heading" fontSize="sm">
          Reading this week&rsquo;s synthesis…
        </Text>
      </HStack>
    );
  }

  if (!synthesis) {
    return (
      <Stack gap={2}>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Not written yet.
        </Text>
        {canGenerate ? (
          <Box>
            <Button
              size="sm"
              colorPalette="violet"
              variant="solid"
              fontFamily="heading"
              onClick={onGenerate}
              disabled={generating}
              data-testid="sel-generate"
            >
              {generating ? "Writing…" : "Write this week's syntheses"}
            </Button>
            {generating ? (
              <Text
                fontFamily="heading"
                fontSize="sm"
                color="charcoal.300"
                mt={1.5}
              >
                Writing the roster&rsquo;s syntheses — this takes a moment.
              </Text>
            ) : null}
          </Box>
        ) : null}
        {error ? (
          <Text fontFamily="body" fontSize="sm" color="orange.600">
            {error}
          </Text>
        ) : null}
      </Stack>
    );
  }

  const stamp = (
    <Text fontFamily="heading" fontSize="xs" color="charcoal.300">
      Written {roundsDateTime(synthesis.generatedAt)}
    </Text>
  );

  if (synthesis.quiet) {
    return (
      <Stack gap={1.5} data-testid="sel-synthesis">
        <Text
          fontFamily="body"
          fontSize="sm"
          color="charcoal.500"
          fontStyle="italic"
        >
          Nothing observed this week.
        </Text>
        {stamp}
      </Stack>
    );
  }

  return (
    <Stack gap={4} data-testid="sel-synthesis">
      {synthesis.strengths.length > 0 ? (
        <Stack gap={2}>
          <SectionEyebrow>Strengths</SectionEyebrow>
          <ClaimList claims={synthesis.strengths} />
        </Stack>
      ) : null}
      {synthesis.watch.length > 0 ? (
        <Stack gap={2}>
          <SectionEyebrow>Watch</SectionEyebrow>
          <ClaimList claims={synthesis.watch} />
        </Stack>
      ) : null}
      {synthesis.strengths.length === 0 && synthesis.watch.length === 0 ? (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          The evidence this week supported nothing to name.
        </Text>
      ) : null}
      {stamp}
    </Stack>
  );
}
