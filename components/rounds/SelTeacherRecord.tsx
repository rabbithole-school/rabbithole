"use client";

/**
 * The teacher record, verbatim — the week's category-tagged + concern /
 * intervention observations, quoted with their author and date, unaltered.
 *
 * The SEL synthesis draws its Strengths from session signals and its Watch from
 * observer/alert/observation rows; this component sits beside it and quotes the
 * pooled teacher record itself (`rounds-two-cadence-plan.html` §Part B) so the
 * room reads the staff's own words, not a paraphrase. Grey, teacher-facing,
 * never near the tutor — the same idiom as `RoundsEvidenceList`.
 */

import { Box, Stack, Text } from "@chakra-ui/react";

import { roundsDate } from "./roundsEvidence";
import {
  selTeacherRecord,
  type SelRecordObservation,
} from "./selSynthesisView";

export type { SelRecordObservation } from "./selSynthesisView";

const CATEGORY_LABEL: Record<string, string> = {
  execFunction: "executive function",
  socialEmotional: "social-emotional",
  collaboration: "collaboration",
  passions: "passions",
  other: "note",
};

function provenance(o: SelRecordObservation): string {
  const filed = o.category ? CATEGORY_LABEL[o.category] ?? o.category : o.type;
  const who = o.teacherName ?? "a teacher";
  return `— ${who} · observation (${filed}) · ${roundsDate(o.at)}`;
}

export function SelTeacherRecord({
  observations,
  compact = false,
}: {
  observations: SelRecordObservation[];
  compact?: boolean;
}) {
  const rows = selTeacherRecord(observations);
  if (rows.length === 0) {
    return (
      <Text fontFamily="body" fontSize="sm" color="charcoal.400">
        No teacher observations filed this week.
      </Text>
    );
  }
  return (
    <Stack gap={compact ? 2.5 : 3}>
      {rows.map((o) => (
        <Box key={o._id}>
          <Text
            fontFamily="body"
            fontSize="sm"
            lineHeight="1.5"
            color="charcoal.600"
          >
            &ldquo;{o.note}&rdquo;
          </Text>
          <Text fontFamily="heading" fontSize="xs" color="charcoal.400" mt={0.5}>
            {provenance(o)}
          </Text>
        </Box>
      ))}
    </Stack>
  );
}
