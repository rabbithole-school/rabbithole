"use client";

/**
 * InstructionLaunchpadDetail — the teacher-facing render of ONE stored
 * instructional segment (a "Launchpad" row): its atom stack (story hook /
 * explain / worked example / try-it / manipulative), verify + provenance
 * metadata, and a Rehearse action that plays the exact scholar card, writing
 * nothing.
 *
 * Extracted from the Math Skills page so BOTH callers share one render:
 *   - the Instruction WORKTABLE (no skill selected → the strand list + detail),
 *     and the strand-top accordion in the skills rail;
 *   - the stage-2 unified per-skill detail pane's Instruction section, which
 *     shows the skill's STRAND segment (captioned "shared by every skill in this
 *     strand") and any NODE-grain segment for the skill (captioned skill-level).
 *
 * Keeping it caption-parametrised is what lets the same component render a
 * strand- and a node-grain segment without a fork.
 */

import { useEffect, useState } from "react";
import { Badge, Box, Button, Flex, Text } from "@chakra-ui/react";
import { Play } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { InstructionRehearseModal } from "@/components/practice/InstructionRehearseModal";
import { InstructionSegmentBodySkeleton } from "@/components/practice/MathSkillsContentSkeletons";
import { isChallenge, parseInstructionManipulative } from "@/lib/manipulative/types";
import type { InstructionAtom } from "@/convex/lib/practice/instructionEntries";
import type { InstructionMedium } from "@/convex/instruction";
import {
  INSTRUCTION_ATOM_LABEL,
  INSTRUCTION_MEDIUM_LABEL,
  instructionAtomPalette,
  instructionMediumPalette,
} from "@/components/practice/instructionVocabulary";

/**
 * The teacher inventory renders the SAME atoms the scholar gets, so it reads the
 * canonical union rather than keeping a hand-mirrored copy. A local duplicate
 * silently went stale every time an atom kind was added (it missed `video`, and
 * before that rendered a sequence as "(spec could not be read)") — the exact
 * drift the practice-engine rule warns about for this union. Aliasing makes a
 * new atom kind a COMPILE error here instead of a wrong render.
 */
export type InstructionLaunchpadAtom = InstructionAtom;

export type InstructionLaunchpadDetail = {
  key: string;
  domain: string;
  strand: string;
  status: "passed" | "failed" | "unverified";
  provenance: "authored" | "generated";
  title: string;
  subtitle: string | null;
  atoms: InstructionLaunchpadAtom[];
  atomKinds: string[];
  medium: InstructionMedium;
  hasWorkedExample: boolean;
  version: number;
  updatedAt: number;
  verifyReport: string | null;
};

/** The one badge that answers "what KIND of instruction is this?" — used by the
 *  Instruction rail, the segment detail, and the cross-domain inventory, so the
 *  answer reads identically wherever a teacher meets it.
 *
 *  It was hardcoded gray, which made the three media indistinguishable at a
 *  glance and left the label doing all the work — the whole reason a teacher
 *  could not scan a domain and see which segments are manipulative-led. */
export function InstructionMediumBadge({ medium }: { medium: InstructionMedium }) {
  return (
    <Badge
      colorPalette={instructionMediumPalette(medium)}
      variant="subtle"
      size="sm"
      flexShrink={0}
      data-testid={`instruction-medium-${medium}`}
    >
      {INSTRUCTION_MEDIUM_LABEL[medium]}
    </Badge>
  );
}

/** Read a manipulative atom's spec JSON down to its teacher-inspector summary
 *  (concept + prompt) — the same tolerant `parseInstructionManipulative` the
 *  scholar renderers use, so both accepted payloads are legible here and an
 *  unparseable spec degrades to a plain note rather than throwing.
 *
 *  A SEQUENCE summarises as its own concept plus a step census, because the
 *  teacher's question at this altitude is "what does this walk the scholar
 *  through?" — the per-step prompts are the Rehearse's job, not the inventory's. */
function manipulativeSummary(specJson: string): { concept: string; prompt: string } {
  const parsed = parseInstructionManipulative(specJson);
  if (!parsed) return { concept: "Manipulative", prompt: "(spec could not be read)" };
  if (parsed.mode === "single") {
    return { concept: parsed.spec.concept, prompt: parsed.spec.prompt };
  }
  const steps = parsed.spec.steps;
  const explore = steps.filter((s) => !isChallenge(s)).length;
  const census =
    explore > 0
      ? `Guided sequence · ${steps.length} steps (${explore} to explore, ${steps.length - explore} to solve)`
      : `Guided sequence · ${steps.length} steps`;
  return { concept: parsed.spec.concept, prompt: census };
}

function AtomKindBadge({ kind }: { kind: InstructionLaunchpadAtom["kind"] }) {
  return (
    <Badge
      colorPalette={instructionAtomPalette(kind)}
      variant="subtle"
      size="sm"
    >
      {INSTRUCTION_ATOM_LABEL[kind]}
    </Badge>
  );
}

function LaunchpadVerifyBadge({ status }: { status: InstructionLaunchpadDetail["status"] }) {
  if (status === "passed") {
    return (
      <Badge colorPalette="violet" variant="subtle" size="sm">
        verify: passed
      </Badge>
    );
  }
  return (
    <Badge colorPalette="red" variant="subtle" size="sm">
      verify: {status}
    </Badge>
  );
}

function InstructionAtomCard({ atom }: { atom: InstructionLaunchpadAtom }) {
  const isWorked = atom.kind === "worked_example";
  const summary = atom.kind === "manipulative" ? manipulativeSummary(atom.spec) : null;
  return (
    <Box
      borderWidth="1px"
      borderColor={isWorked ? "teal.100" : "charcoal.200"}
      borderRadius="12px"
      bg={isWorked ? "teal.50" : "white"}
      p={4}
    >
      <Flex align="center" gap={2} mb={2}>
        <AtomKindBadge kind={atom.kind} />
      </Flex>
      {atom.kind === "story_hook" && (
        <Text fontSize="sm" color="charcoal.700" lineHeight="1.55">
          {atom.hook}
        </Text>
      )}
      {atom.kind === "micro_explain" && (
        <Text fontSize="sm" color="charcoal.700" lineHeight="1.55">
          {atom.text}
        </Text>
      )}
      {atom.kind === "worked_example" && (
        <Box fontSize="sm" color="charcoal.700" lineHeight="1.55">
          <Text fontWeight="700" color="teal.800" mb={1}>
            {atom.strategyLabel}
          </Text>
          <Text mb={2}>{atom.examplePrompt}</Text>
          <Box as="ol" pl={5} mb={2}>
            {atom.steps.map((step, index) => (
              <Box as="li" key={`${step}-${index}`} mb={1}>
                {step}
              </Box>
            ))}
          </Box>
          <Text fontWeight="700">Answer: {atom.exampleAnswer}</Text>
        </Box>
      )}
      {atom.kind === "try_it" && (
        <Box fontSize="sm" color="charcoal.700" lineHeight="1.55">
          <Text fontWeight="700" color="green.700" mb={1}>
            {atom.strategyLabel} · interactive
          </Text>
          <Text mb={2}>{atom.examplePrompt}</Text>
          <Box as="ol" pl={5} mb={2}>
            {atom.steps.map((step, index) => (
              <Box as="li" key={`${step}-${index}`} mb={1}>
                {step}
              </Box>
            ))}
          </Box>
          <Text fontWeight="700">
            Scholar produces: {atom.exampleAnswer}
            {atom.answerType ? ` (${atom.answerType})` : ""}
          </Text>
          <Text fontSize="xs" color="charcoal.400" mt={1}>
            Faded final step · client-graded · records nothing. Rehearse to try it.
          </Text>
        </Box>
      )}
      {atom.kind === "manipulative" && summary && (
        <Box fontSize="sm" color="charcoal.700" lineHeight="1.55">
          <Text fontWeight="700" color="cyan.800" mb={1}>
            {summary.concept}
          </Text>
          <Text mb={1}>{summary.prompt}</Text>
          <Text fontSize="xs" color="charcoal.400" mt={1}>
            Ungraded manipulative · self-check only · never touches mastery. Rehearse to try it.
          </Text>
        </Box>
      )}
      {atom.kind === "video" && (
        <Box fontSize="sm" color="charcoal.700" lineHeight="1.55">
          <Text fontWeight="700" color="cyan.800" mb={1}>
            {atom.captionText}
          </Text>
          <Text mb={1}>
            {atom.sourceLabel} · clipped {formatClip(atom.startSec, atom.endSec)}
          </Text>
          <Text fontSize="xs" color="charcoal.400" mt={1}>
            Tap to play, never autoplay · always followed by a do-it step. Rehearse to watch it.
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** "1:04–2:30 (86s)" — the teacher's question about a clip is which slice of the
 *  source it plays and how long that is, since the length ceiling is a hard gate. */
function formatClip(startSec: number, endSec: number): string {
  const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return `${stamp(startSec)}–${stamp(endSec)} (${Math.round(endSec - startSec)}s)`;
}

/**
 * The render of one instructional segment. `headingLabel` + `caption` are
 * parametrised so the SAME component reads true at strand grain ("<strand> ·
 * Instructional segment", "shared by every skill in this strand") and node
 * grain ("<skill> · Instructional segment", "skill-level"). When `launchpad`
 * is undefined it is loading; null means no stored segment (a fully-Socratic
 * strand). `emptyTitle` lets the caller phrase the null state for its grain.
 */
export function InstructionLaunchpadDetailPane({
  headingLabel,
  caption = "Strand-level instruction preview for the first encounter.",
  emptyTitle = "This strand stays fully Socratic — no instructional segment yet.",
  launchpad,
}: {
  headingLabel: string;
  caption?: string;
  emptyTitle?: string;
  launchpad: InstructionLaunchpadDetail | null | undefined;
}) {
  const [rehearsing, setRehearsing] = useState(false);
  const canRehearse = !!launchpad && launchpad.atoms.length > 0;
  // Close an open Rehearse modal when the segment under it changes identity
  // (same-page navigation / history can swap `launchpad` while this component
  // stays mounted in the persistent tab) — otherwise the modal silently starts
  // showing a different segment, or reopens on the next one.
  const launchpadKey = launchpad?.key ?? null;
  useEffect(() => {
    // A bounded one-shot close on segment-identity change, not a render loop —
    // the lint rule can't see that this only fires when the key actually flips.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRehearsing(false);
  }, [launchpadKey]);
  return (
    <Box data-testid="instruction-launchpad-detail">
      <Flex align="center" justify="space-between" gap={3} mb={3} wrap="wrap">
        <Box>
          <SectionEyebrow>
            {headingLabel} · Instructional segment
          </SectionEyebrow>
          <Text fontSize="xs" color="charcoal.500" mt={1}>
            {caption}
          </Text>
        </Box>
        <Flex align="center" gap={2}>
          {launchpad && (
            <Badge colorPalette="gray" variant="subtle" size="sm">
              {launchpad.provenance} · v{launchpad.version}
            </Badge>
          )}
        </Flex>
      </Flex>

      {rehearsing && launchpad && (
        <InstructionRehearseModal
          launchpad={{
            key: launchpad.key,
            domain: launchpad.domain,
            strand: launchpad.strand,
            title: launchpad.title,
            subtitle: launchpad.subtitle,
            atoms: launchpad.atoms,
            version: launchpad.version,
          }}
          onClose={() => setRehearsing(false)}
        />
      )}

      {launchpad === undefined ? (
        <InstructionSegmentBodySkeleton />
      ) : launchpad === null ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <Flex direction="column" gap={3}>
          {/* Rehearse lives HERE, on the segment card next to its OWN title, so
              it visibly rehearses THIS segment ("Make a ten to add") and nothing
              else — not the strand-scoped header above. Same Play glyph / label
              / size as every other Rehearse in the Content view. */}
          <Flex align="flex-start" justify="space-between" gap={3}>
            <Box minW={0}>
              <Text
                fontFamily="heading"
                fontSize="md"
                fontWeight="700"
                color="charcoal.700"
                lineHeight="1.35"
                mb={1}
              >
                {launchpad.title}
              </Text>
              {launchpad.subtitle && (
                <Text fontSize="sm" color="charcoal.500" lineHeight="1.55">
                  {launchpad.subtitle}
                </Text>
              )}
            </Box>
            <Button
              variant="ghost"
              size="xs"
              color="violet.700"
              fontFamily="heading"
              fontWeight="600"
              flexShrink={0}
              _hover={{ bg: "violet.50" }}
              disabled={!canRehearse}
              onClick={() => setRehearsing(true)}
              data-testid="instruction-rehearse"
            >
              <Play weight="fill" />
              Rehearse
            </Button>
          </Flex>

          <Flex gap={2} wrap="wrap">
            <InstructionMediumBadge medium={launchpad.medium} />
            {launchpad.atomKinds.map((kind, index) => (
              <AtomKindBadge
                key={`${kind}-${index}`}
                kind={kind as InstructionLaunchpadAtom["kind"]}
              />
            ))}
            <Badge colorPalette="gray" variant="subtle" size="sm">
              {launchpad.provenance}
            </Badge>
            <Badge colorPalette="gray" variant="subtle" size="sm">
              v{launchpad.version}
            </Badge>
            <LaunchpadVerifyBadge status={launchpad.status} />
          </Flex>

          {launchpad.status !== "passed" && launchpad.verifyReport && (
            <Text fontSize="xs" color="red.600" lineHeight="1.45">
              Verify report: {launchpad.verifyReport}
            </Text>
          )}

          {launchpad.atoms.map((atom, index) => (
            <InstructionAtomCard key={`${atom.kind}-${index}`} atom={atom} />
          ))}
        </Flex>
      )}
    </Box>
  );
}
