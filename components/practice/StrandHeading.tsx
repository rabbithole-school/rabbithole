import { useMemo, useRef } from "react";
import { Box, Button, Menu, Portal, Text, Tooltip } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";

import { CheckpointMark } from "@/components/practice/MathPlanMarks";

import { humanizeStrand } from "@/shared/practiceDomainLabels";
import {
  formatGradeRange,
  gradeLabelFromRank,
  gradeRangeLabel,
  gradeRank,
} from "@/shared/gradeRange";

/**
 * The shared strand-heading treatment for the Math Skills studio. Both lenses
 * render a strand the same way — the humanized name over a gray "N skills ·
 * Grade X–Y" meta line — so the Mastery matrix's sticky strand rows and the
 * Content pool's strand groups stay in lockstep instead of drifting (Content
 * used to show the raw, un-humanized slug with no count/grade). Callers own the
 * surrounding container (Mastery's sticky positioned box, Content's flex row
 * with its coverage badge); this owns only the two stacked text lines.
 *
 * The Mastery lens additionally renders an interactive checkpoint pill
 * (`CheckpointGradePill`, exported separately) at both domain and strand
 * altitude. Both mutate the SAME checkpoint row as the per-skill flag in
 * `MathSkillsMasteryView` — alternate INPUT surfaces, not new checkpoint
 * concepts. Content never renders it, so its subtext is unchanged.
 *
 * The pill AUTHORS nothing itself: a grade pick (or Clear) raises a request the
 * view answers with `ConfirmGroupCheckpointDialog`, because at group altitude
 * one pick rewrites policy for every member. It hands its own trigger button
 * back so focus returns here when that dialog closes.
 */

/** "12 skills · Grade 4–5" (or just "1 skill" when no grade hints exist). */
export function strandSkillMeta(nodes: { grade: string | null }[]): string {
  const count = nodes.length;
  const skills = `${count} ${count === 1 ? "skill" : "skills"}`;
  const grade = gradeRangeLabel(nodes.map((n) => n.grade));
  return grade ? `${skills} · ${grade}` : skills;
}

/** The actual distinct grades on a domain or strand, in natural K→8 order.
 * Missing grade bands are not valid checkpoint targets and must not be offered. */
export function checkpointGradesInNodes(
  nodes: { grade: string | null }[],
): string[] {
  const gradesByRank = new Map<number, string>();
  for (const node of nodes) {
    const rank = gradeRank(node.grade);
    if (rank !== null) gradesByRank.set(rank, gradeLabelFromRank(rank));
  }
  return [...gradesByRank.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, grade]) => grade);
}

/** "Grades K–4" for a real range, "Grade 4" when the strand sits on one grade
 *  only — the pill's compact label, replacing "N skills · Grade X–Y". */
function pillGradeLabel(nodes: { grade: string | null }[]): string | null {
  const ranks = nodes
    .map((n) => gradeRank(n.grade))
    .filter((rank): rank is number => rank !== null);
  if (ranks.length === 0) return null;
  const lo = Math.min(...ranks);
  const hi = Math.max(...ranks);
  const label = formatGradeRange(lo, hi);
  return label && lo !== hi ? label.replace(/^Grade\b/, "Grades") : label;
}

/** The interactive checkpoint context a caller (Mastery only) threads into a
 *  strand header. Absent ⇒ the plain, non-interactive subtext (Content, and
 *  any Mastery caller that hasn't wired this yet). */
export type StrandCheckpointContext = {
  /** The grade currently checked for THIS domain+strand — i.e. the group's (or
   *  focused scholar's) current checkpoint has this exact strand, at this
   *  grade. Null when the current checkpoint isn't in this strand, or there
   *  is none. */
  currentGrade: string | null;
  /** Whether a group or focused scholar is in scope, so a grade pick has
   *  somewhere to land. False degrades the pill to a disabled, non-interactive
   *  hint instead of hiding the affordance outright. */
  canSet: boolean;
  /** Tooltip shown when `canSet` is false. */
  disabledHint: string;
  /** Ask to set the checkpoint to (this strand × the picked grade). The pill's
   *  own trigger comes back with it so the confirmation can return focus. */
  onSetGrade: (grade: string, trigger: HTMLElement | null) => void;
  /** Ask to clear the current checkpoint (only offered when this strand holds
   *  it). */
  onClear: (trigger: HTMLElement | null) => void;
};

export function StrandHeading({
  strand,
  nodes,
  metaOverride,
}: {
  strand: string;
  nodes: { grade: string | null }[];
  /** Replaces the default "N skills · Grade X–Y" meta line: a string renders
   *  as THE single meta line (Content thread rail: "3 of 5 skills have
   *  manipulatives" — computed from the UNFILTERED strand so a filtered rail
   *  can't misreport the denominator); `null` renders NO meta line at all
   *  (Instruction thread — its segment row carries the status, and the grade
   *  lives in the right-aligned pill); `undefined` keeps the default (Mastery
   *  unchanged). Never two stacked lines. */
  metaOverride?: string | null;
}) {
  return (
    <Box minW={0}>
      <Text
        fontSize="xs"
        fontWeight="700"
        color="charcoal.500"
        textTransform="uppercase"
        letterSpacing="0.04em"
        lineClamp={1}
      >
        {humanizeStrand(strand)}
      </Text>
      {metaOverride !== null && (
        <Text fontSize="2xs" color="charcoal.400" lineClamp={1}>
          {metaOverride ?? strandSkillMeta(nodes)}
        </Text>
      )}
    </Box>
  );
}

// Colour discipline: the checkpoint is NOT mastery (no green/amber/teal), NOT
// access (no gray lock glyph), NOT serving (no navy ring), and NOT selection
// (no violet — that's `selectionStyle.ts`'s ink). The pill's chrome is neutral
// gray/charcoal, and the ONE coloured thing on it is the canonical
// `CheckpointMark` — the same tile the matrix cells corner themselves with, so
// this pill and the cells read as ONE vocabulary rather than a flag glyph that
// happens to be nearby. Current vs. settable is carried by the pill's own
// chrome (soft gray wash + darker border when this IS the checkpoint), never by
// re-weighting or re-colouring the mark.
export function CheckpointGradePill({
  nodes,
  altitude,
  currentGrade,
  canSet,
  disabledHint,
  onSetGrade,
  onClear,
}: {
  nodes: { grade: string | null }[];
  altitude: "domain" | "strand";
} & StrandCheckpointContext) {
  const gradeOptions = useMemo(() => checkpointGradesInNodes(nodes), [nodes]);
  const label = pillGradeLabel(nodes) ?? strandSkillMeta(nodes);
  const isCurrent = currentGrade != null;
  // The pill's own button, handed to whatever the pick opens so focus can come
  // back to the control the teacher was on (the menu item itself is gone by
  // then).
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!canSet || gradeOptions.length === 0) {
    return (
      <Tooltip.Root openDelay={350} closeDelay={0}>
        <Tooltip.Trigger asChild>
          <Box
            display="inline-flex"
            alignItems="center"
            gap={1}
            mr={3}
            color="charcoal.300"
            cursor="default"
          >
            {/* No mark here: the checkpoint mark MEANS "a checkpoint lives on,
                or can be set on, this row". A disabled pill is just the grade
                range. */}
            <Text fontSize="xs" lineClamp={1}>
              {label}
            </Text>
          </Box>
        </Tooltip.Trigger>
        <Portal>
          <Tooltip.Positioner>
            <Tooltip.Content maxW="220px" px={3} py={2} fontSize="xs">
              {gradeOptions.length === 0
                ? `No graded skills in this ${altitude}.`
                : disabledHint}
            </Tooltip.Content>
          </Tooltip.Positioner>
        </Portal>
      </Tooltip.Root>
    );
  }

  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button
          ref={triggerRef}
          size="xs"
          variant="outline"
          borderRadius="full"
          h="auto"
          minH={0}
          py="2px"
          px={2}
          gap={1}
          fontSize="xs"
          fontWeight="600"
          flexShrink={0}
          mr={3}
          borderColor={isCurrent ? "gray.400" : "gray.200"}
          bg={isCurrent ? "gray.100" : "transparent"}
          color={isCurrent ? "charcoal.700" : "charcoal.400"}
          _hover={{ bg: "gray.100", color: "charcoal.700" }}
          aria-label={
            isCurrent
              ? `Current checkpoint: Grade ${currentGrade} in this ${altitude}. Choose a different grade.`
              : `Set the current checkpoint in this ${altitude} — ${label}`
          }
        >
          <CheckpointMark size={13} />
          {label}
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="180px">
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel color="charcoal.400" fontSize="2xs" px={3} pt={1}>
                Choose a grade to set checkpoint …
              </Menu.ItemGroupLabel>
              {gradeOptions.map((grade) => {
                const selected = grade === currentGrade;
                return (
                  <Menu.Item
                    key={grade}
                    value={grade}
                    cursor="pointer"
                    onClick={() => onSetGrade(grade, triggerRef.current)}
                    justifyContent="space-between"
                  >
                    <Text fontWeight={selected ? "700" : "400"}>
                      Grade {grade}
                    </Text>
                    {/* The same mark the cells carry, so "this grade is the
                        checkpoint" reads identically wherever it is stated. The
                        row’s bolded grade already says it in words. */}
                    {selected && <CheckpointMark size={13} />}
                  </Menu.Item>
                );
              })}
            </Menu.ItemGroup>
            {isCurrent && (
              <>
                <Menu.Separator />
                <Menu.Item
                  value="__clear__"
                  cursor="pointer"
                  onClick={() => onClear(triggerRef.current)}
                  color="charcoal.500"
                >
                  <X size={13} />
                  Clear checkpoint
                </Menu.Item>
              </>
            )}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
