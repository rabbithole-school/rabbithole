"use client";

/**
 * CheckpointBandControl — the checkpoint, authored where the teacher is already
 * looking. A clicked scholar × skill cell carries a whole band (domain ×
 * optional strand × grade), so the panel that click opens states whether that
 * band IS this scholar's checkpoint, and offers the one action that follows.
 *
 * Invariants it exists to keep visible (see
 * `review/math-checkpoint-interaction-refinements.html`):
 *  • A cell is a skill; a checkpoint is a BAND — so the sibling count is stated
 *    before the write, not discovered afterwards as stray flags.
 *  • Mode is DERIVED, never chosen. Nothing here offers to set it, and nothing
 *    predicts it: the mode pill and the announcement read the plan row after
 *    the server resolved it.
 *  • Practice scope is the runtime boundary. An out-of-scope band is a refusal
 *    with ONE named exit that spells out what it adds, riding the same atomic
 *    save so scope and checkpoint can never be written out of step.
 *  • One checkpoint per scholar, so moving one names the band being left.
 *
 * Deliberately NOT optimistic: both visible outcomes (the mode hue, and which
 * sibling cells gain a flag) are server derivations, and a wrong-hue flash on a
 * policy mark is worse than one round trip. The button disables while saving.
 *
 * The repair for a conflicted or empty-scope plan stays the modal — duplicating
 * its three named exits in a row would fork the repair.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { Box, Button, chakra, Flex, Stack, Text } from "@chakra-ui/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { humanizeStrand } from "@/shared/practiceDomainLabels";
import { toaster } from "@/lib/toaster";
import {
  CheckpointBandChip,
  CheckpointMark,
  CheckpointModePill,
} from "@/components/practice/MathPlanMarks";
import {
  CHECKPOINT_MODE_LABEL,
  bandForNode,
  checkpointBandState,
  checkpointLabel,
  checkpointSourceLabel,
  widenScopeToAdmit,
  type CheckpointBandNode,
  type CheckpointCornerState,
  type MathPlanCheckpoint,
  type MathPlanRow,
  type PracticeScope,
} from "@/components/practice/mathPlanProjection";

type Payload = {
  practiceScope: PracticeScope;
  checkpoint: MathPlanCheckpoint | null;
};

/**
 * What the last write asked for, and how to say it once the reactive plan row
 * catches up. `expected` is the BAND the server should be holding — not the
 * whole payload, because the server normalises the scope it stores.
 */
type WriteResult = {
  /** Scholar × band identity; a different selection throws this away. */
  key: string;
  expected: string;
  kind: "set" | "move" | "clear" | "widen" | "undo";
  settled: boolean;
  /** Only a move or a widen offers an undo — a set or a clear IS its own inverse. */
  undo?: { payload: Payload; line: string };
};

function bandSignature(
  checkpoint: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade"> | null,
) {
  return checkpoint
    ? `${checkpoint.domain}|${checkpoint.strand ?? ""}|${checkpoint.grade}`
    : "none";
}

/** The stored checkpoint as a bare band — the effective row carries its source. */
function bandOf(plan: MathPlanRow | undefined): MathPlanCheckpoint | null {
  if (!plan?.checkpoint) return null;
  return {
    domain: plan.checkpoint.domain,
    grade: plan.checkpoint.grade,
    ...(plan.checkpoint.strand === undefined
      ? {}
      : { strand: plan.checkpoint.strand }),
  };
}

export function CheckpointBandControl({
  scholarId,
  scholarName,
  plan,
  domain,
  domainLabel,
  domainLabelFor,
  node,
  bandSkillCount,
  domainStrands,
  onOpenPlan,
}: {
  scholarId: string;
  scholarName: string;
  /** The scholar's row from `api.mathPlans.forScholars`, as the matrix holds it. */
  plan: MathPlanRow | undefined;
  domain: string;
  domainLabel: string;
  /** Domain key → label, for naming a checkpoint that lives in another domain. */
  domainLabelFor: (domain: string) => string;
  /** The clicked skill, which is what names the band. */
  node: CheckpointBandNode;
  /** How many skills the band holds, counted from the UNFILTERED domain nodes. */
  bandSkillCount: number;
  /** Every strand in this domain, so a widen can collapse to the whole domain. */
  domainStrands: string[];
  /**
   * Opens the Math plan editor. Absent on mounts that must not author (the map
   * drawer), and the control renders nothing without it.
   */
  onOpenPlan?: () => void;
}) {
  const save = useMutation(api.mathPlans.saveForScholar);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [result, setResult] = useState<WriteResult | null>(null);

  const reading = checkpointBandState(plan, domain, node);
  const identity = `${scholarId}|${domain}|${node.strand ?? ""}|${node.grade ?? ""}`;
  const storedBand = bandOf(plan);

  // Adjust the write memory during render rather than in an effect: a new
  // selection throws it away, and a plan that moves anywhere else (another
  // teacher, the modal, the group) retires the undo it no longer inverts.
  //
  // Settling is deliberately one-way. The expected plan row ARRIVING is what
  // makes the announcement (and the undo) truthful, so it must not also be read
  // as "the plan changed" and clear them — only a later divergence does that.
  if (result) {
    const matches = bandSignature(storedBand) === result.expected;
    if (result.key !== identity) setResult(null);
    else if (matches && !result.settled) setResult({ ...result, settled: true });
    else if (!matches && result.settled) setResult(null);
  }

  // The rail above carries the loading state; a second skeleton would be noise.
  if (!plan || !reading || !onOpenPlan) return null;

  const firstName = scholarName.split(" ")[0] ?? scholarName;
  const strandLabel = node.strand ? humanizeStrand(node.strand) : null;
  const labels = { domainLabel: domainLabelFor, strandLabel: humanizeStrand };

  /** The band in words. The panel is already scoped to ITS domain, so a band in
   *  this domain names only strand · grade; one in another domain (a checkpoint
   *  being left, or an undo target) always names its domain too. */
  const bandLine = (band: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade">) =>
    band.strand && band.domain === domain
      ? `${humanizeStrand(band.strand)} · grade ${band.grade}`
      : checkpointLabel(band, labels);

  const countSentence = `${bandSkillCount} ${
    bandSkillCount === 1 ? "skill" : "skills"
  } in this band. Setting it here flags ${
    bandSkillCount === 1 ? "it" : `all ${bandSkillCount}`
  } for ${firstName}.`;

  const commit = async (
    payload: Payload,
    next: Omit<WriteResult, "key" | "expected" | "settled">,
  ) => {
    setSaving(true);
    setError(null);
    try {
      await save({
        scholarId: scholarId as Id<"users">,
        practiceScope: payload.practiceScope,
        checkpoint: payload.checkpoint,
      });
      setResult({
        ...next,
        key: identity,
        expected: bandSignature(payload.checkpoint),
        settled: false,
      });
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Could not save the math plan.";
      setError({ key: identity, message });
      toaster.create({ description: message, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const previousPayload: Payload = {
    practiceScope: plan.practiceScope,
    checkpoint: storedBand,
  };

  // ── The row's state, in the order the projection resolves it ──────────────
  let chipCorner: CheckpointCornerState | null = null;
  let chipOutOfScope = false;
  let bandLabel: string | null = null;
  let label = "";
  let ariaLabel = "";
  let disabled = false;
  let onClick: (() => void) | undefined;
  const notes: string[] = [];
  let modePill: React.ReactNode = null;

  if (reading.kind === "no-grade") {
    label = "No band";
    ariaLabel = `This skill has no grade, so it cannot anchor a checkpoint for ${scholarName}.`;
    disabled = true;
    notes.push(
      "This skill has no grade, so it cannot anchor a checkpoint. Pick a graded skill in this strand, or set the band in the math plan.",
    );
  } else if (reading.kind === "blocked") {
    label = "Open math plan";
    ariaLabel = `Open the math plan for ${scholarName} to repair it.`;
    onClick = onOpenPlan;
    notes.push(
      reading.reason === "conflict"
        ? `${firstName}\u2019s checkpoint is suspended. Open the math plan to repair it.`
        : `${firstName}\u2019s practice scope is limited to nothing, so no band can hold a checkpoint. Open the math plan to fix it.`,
    );
  } else if (reading.kind === "out-of-scope") {
    // The subject is the band's OWN axis, because that is exactly what the save
    // adds: a strand band admits that one strand — even when the whole domain
    // is currently unserved — and only a whole-domain band admits the domain.
    const subject =
      reading.widen === "domain" ? domainLabel : (strandLabel ?? domainLabel);
    const band = reading.checkpoint;
    bandLabel = bandLine(band);
    chipOutOfScope = true;
    label = `Add ${subject} to scope, then set checkpoint`;
    ariaLabel = `Add ${subject} to ${scholarName}\u2019s practice scope and set the checkpoint to ${bandLabel}. ${countSentence}`;
    notes.push(
      "A checkpoint has to sit inside practice scope, so this band cannot hold one yet.",
      `Adds one ${reading.widen} to practice scope. Everything else stays as it is.`,
    );
    onClick = () =>
      void commit(
        {
          practiceScope: widenScopeToAdmit(
            plan.practiceScope,
            band,
            domainStrands,
          ),
          checkpoint: band,
        },
        {
          kind: "widen",
          undo: {
            payload: previousPayload,
            line: `Added ${subject} to practice scope.`,
          },
        },
      );
  } else if (
    reading.kind === "current" ||
    reading.kind === "inherited-current"
  ) {
    bandLabel = bandLine(reading.checkpoint);
    chipCorner = plan.conflict ? "conflict" : reading.mode;
    modePill = (
      <CheckpointModePill mode={reading.mode} suspended={plan.conflict} />
    );
    const inherited = reading.kind === "inherited-current";
    label = inherited ? `Clear for ${firstName}` : "Clear checkpoint";
    ariaLabel = inherited
      ? `Clear the inherited checkpoint at ${bandLabel} for ${scholarName}. The math group keeps its own.`
      : `Clear the checkpoint at ${bandLabel} for ${scholarName}.`;
    notes.push(
      inherited && plan.checkpoint
        ? `Inherited from ${checkpointSourceLabel(plan.checkpoint)}. Clearing it here affects ${firstName} only — the group keeps its own.`
        : `${firstName}\u2019s checkpoint. Mode is derived from band fluency and cannot be set here.`,
    );
    onClick = () =>
      void commit(
        { practiceScope: plan.practiceScope, checkpoint: null },
        { kind: "clear" },
      );
  } else {
    // settable · elsewhere — the same write, with different words.
    const band = bandForNode(domain, node)!;
    bandLabel = bandLine(band);
    const moving = reading.kind === "elsewhere";
    const previousLabel = moving ? bandLine(reading.checkpoint) : null;
    label = moving ? "Move checkpoint here" : "Set checkpoint here";
    ariaLabel = moving
      ? `Move ${scholarName}\u2019s checkpoint to ${bandLabel}, off ${previousLabel}. ${countSentence}`
      : `Set ${scholarName}\u2019s checkpoint to ${bandLabel}. ${countSentence}`;
    notes.push(countSentence);
    if (moving) {
      notes.push(
        `${firstName} has one checkpoint, so this moves it off ${previousLabel}.`,
      );
    }
    onClick = () =>
      void commit(
        { practiceScope: plan.practiceScope, checkpoint: band },
        moving
          ? {
              kind: "move",
              // A group target may change while this scholar override is active,
              // and the effective plan row does not expose that hidden update.
              // Re-saving the captured group band could therefore pin stale group
              // policy as a scholar override instead of restoring inheritance.
              ...(reading.inherited
                ? {}
                : {
                    undo: {
                      payload: previousPayload,
                      line: `Moved from ${previousLabel}.`,
                    },
                  }),
            }
          : { kind: "set" },
      );
  }

  const settled = result?.settled ? result : null;
  const undoPayload = settled?.undo?.payload;
  // Read from the SETTLED plan row, never from what the write asked for: the
  // mode is the server's derivation, and "cleared" is whatever the row says
  // (clearing an override can leave a math group's own target standing).
  const announcement = !settled
    ? ""
    : storedBand
      ? `Checkpoint set to ${bandLine(storedBand)}. ${
          plan.conflict ? "Suspended" : CHECKPOINT_MODE_LABEL[plan.mode]
        }.`
      : `Cleared the checkpoint for ${firstName}.`;

  return (
    <Box mb={4} data-testid="checkpoint-band-control">
      <Flex align="center" gap={2} mb={2}>
        {reading.kind !== "no-grade" && node.grade && (
          <CheckpointBandChip
            label={`G${node.grade}`}
            corner={chipCorner}
            outOfScope={chipOutOfScope}
          />
        )}
        <Box minW={0}>
          <Flex align="center" gap={2} flexWrap="wrap">
            <Text fontSize="sm" fontWeight="700" color="charcoal.700" lineClamp={2}>
              {bandLabel ?? "No band"}
            </Text>
            {modePill}
          </Flex>
          <Stack gap={0.5} mt={0.5}>
            {notes.map((note) => (
              <Text key={note} fontSize="2xs" color="charcoal.400" lineHeight="1.5">
                {note}
              </Text>
            ))}
          </Stack>
        </Box>
      </Flex>

      <Button
        size="sm"
        w="100%"
        minH="44px"
        cursor={disabled ? "not-allowed" : "pointer"}
        variant="outline"
        colorPalette="violet"
        loading={saving}
        disabled={disabled || saving}
        onClick={onClick}
        aria-label={ariaLabel}
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "violet.500",
          outlineOffset: "1px",
        }}
        data-testid="checkpoint-band-action"
      >
        {reading.kind === "settable" ||
        reading.kind === "elsewhere" ||
        reading.kind === "out-of-scope" ? (
          // The cells’ own mark, matching the group-altitude twin. The button’s
          // words carry the meaning, so the mark is decorative.
          <CheckpointMark size={14} />
        ) : null}
        {label}
      </Button>

      {error?.key === identity && (
        <Text
          fontSize="xs"
          color="red.600"
          mt={1}
          data-testid="checkpoint-band-error"
        >
          {error.message}
        </Text>
      )}

      {/* The result is announced only once the reactive plan row carries it, so
          the derived mode in the sentence is the server's, never a guess. */}
      <Text
        as="span"
        display="block"
        aria-live="polite"
        fontSize="2xs"
        color="charcoal.400"
        mt={1}
        data-testid="checkpoint-band-status"
      >
        {announcement}
      </Text>

      {settled?.undo && (
        <Flex align="center" gap={2} mt={0.5}>
          <Text fontSize="2xs" color="charcoal.400">
            {settled.undo.line}
          </Text>
          <chakra.button
            type="button"
            fontSize="2xs"
            fontWeight="700"
            color="violet.600"
            cursor="pointer"
            textDecoration="underline"
            disabled={saving}
            _focusVisible={{
              outline: "2px solid",
              outlineColor: "violet.500",
              outlineOffset: "1px",
            }}
            onClick={() => void commit(undoPayload!, { kind: "undo" })}
            aria-label={`Undo — restore ${scholarName}\u2019s previous math plan`}
            data-testid="checkpoint-band-undo"
          >
            Undo
          </chakra.button>
        </Flex>
      )}
    </Box>
  );
}
