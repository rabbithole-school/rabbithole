"use client";

/**
 * The left column: the prompt deck the scholar authors. One SpeciesCard per
 * world Species slot — a shared prompt (all automata of that Species read it),
 * a count within the slot's range, the world-GIVEN Senses (read-only badges,
 * the kid cannot grant new senses), and charm art. The deck is the ONLY writer
 * of automaton behavior; the tutor has no path here (plan §7.1).
 */

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Badge, Box, Button, Flex, HStack, Text, Textarea } from "@chakra-ui/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DeckCard, SimulatorSpec } from "@/lib/simulator/contract";
import { MAX_PROMPT_CHARS } from "@/lib/simulator/contract";
import { toaster } from "@/lib/toaster";
import { colorForSlotIndex, deckDisplayPrompt, sensesLine } from "./helpers";

type CompilationStatus = {
  slotId: string;
  status: "compiling" | "ready" | "failed";
  errorMessage: string | null;
};

const SpeciesCard = memo(function SpeciesCard({
  slotIndex,
  slot,
  card,
  icon,
  compilation,
  focused,
  sessionId,
  canRemove,
  hasUnsavedDeckChanges,
  isField,
  onChange,
}: {
  slotIndex: number;
  slot: SimulatorSpec["speciesSlots"][number];
  card: DeckCard;
  icon: string | undefined;
  compilation?: CompilationStatus;
  focused?: boolean;
  sessionId: Id<"sessions">;
  canRemove: boolean;
  hasUnsavedDeckChanges: boolean;
  isField: boolean;
  onChange: (next: DeckCard) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removeSpecies = useMutation(api.simulatorBenches.removeSpeciesFromBench);
  const color = colorForSlotIndex(slotIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const keepSpeciesRef = useRef<HTMLButtonElement>(null);
  const guidanceId = useId();
  const removePromptId = useId();

  // Tapping a species chip in the subheader opens the deck FOCUSED on that
  // species — its card auto-expands into the editor and scrolls into view so the
  // scholar lands directly on the prompt they meant to write.
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focused]);

  const onRemove = async () => {
    if (hasUnsavedDeckChanges) {
      toaster.error({ title: "Save the deck before removing a species" });
      return;
    }
    setRemoving(true);
    try {
      await removeSpecies({ sessionId, slotId: slot.slotId, acceptPromptLoss: true });
      toaster.success({ title: `${slot.label} removed` });
    } catch (error) {
      toaster.error({
        title: error instanceof Error ? error.message : "Could not remove this species",
      });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Box ref={rootRef} borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" overflow="hidden">
      <Flex align="center" gap={2} px={2.5} py={2}>
        <Box
          w="26px"
          h="26px"
          borderRadius="full"
          bg={icon ? "transparent" : color}
          flexShrink={0}
          overflow="hidden"
          display="flex"
          alignItems="center"
          justifyContent="center"
          borderWidth={icon ? "1px" : "0"}
          borderColor="gray.200"
        >
          {icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={icon} alt="" width={26} height={26} style={{ objectFit: "contain" }} />
          ) : null}
        </Box>
        <Box flex={1} minW={0}>
          <Flex align="center" gap={1}>
            <Text fontSize="sm" fontWeight="700" color="charcoal.600" lineClamp={1}>
              {slot.label}
            </Text>
            {slot.locked ? (
              <Text as="span" fontSize="2xs" aria-label="Locked" title="Locked by your teacher">
                🔒
              </Text>
            ) : null}
          </Flex>
          <Text fontSize="2xs" color="gray.500" lineClamp={1}>
            {sensesLine(slot.senses)}
          </Text>
        </Box>
        <HStack gap={1} flexShrink={0}>
          <Button
            size="2xs"
            variant="ghost"
            onClick={() => onChange({ ...card, count: Math.max(slot.countMin, card.count - 1) })}
            disabled={card.count <= slot.countMin}
            aria-label="Fewer"
          >
            −
          </Button>
          <Text fontSize="sm" fontWeight="700" minW="18px" textAlign="center">
            {card.count}
          </Text>
          <Button
            size="2xs"
            variant="ghost"
            onClick={() => onChange({ ...card, count: Math.min(slot.countMax, card.count + 1) })}
            disabled={card.count >= slot.countMax}
            aria-label="More"
          >
            +
          </Button>
        </HStack>
      </Flex>

      <Box px={2.5} pb={2}>
        {slot.locked ? (
          <Box role="group" aria-label={`${slot.label} ${isField ? "prompt" : "strategy rule"} (locked)`}>
            <Text fontSize="2xs" color="gray.500" mb={1}>
              This {isField ? "deck" : "strategy"} is locked — read it, then plan yours.
            </Text>
            <Box fontSize="xs" color="gray.700" lineClamp={3}>
              {deckDisplayPrompt(slot, card) || `No ${isField ? "prompt" : "rule"} was authored for this ${isField ? "deck" : "strategy"}.`}
            </Box>
          </Box>
        ) : expanded ? (
          <>
            {slot.starterHint ? (
              <Box
                id={guidanceId}
                bg="violet.50"
                borderWidth="1px"
                borderColor="violet.200"
                borderRadius="md"
                px={2.5}
                py={2}
                mb={2}
              >
                <Text fontSize="2xs" fontWeight="700" color="violet.700" mb={0.5}>
                  While you write
                </Text>
                <Text fontSize="xs" lineHeight="1.45" color="charcoal.600">
                  {slot.starterHint}
                </Text>
              </Box>
            ) : null}
            <Textarea
              value={card.prompt}
              onChange={(event) => onChange({ ...card, prompt: event.target.value.slice(0, MAX_PROMPT_CHARS) })}
              placeholder={isField ? "How should this species behave?" : "How should this strategy decide?"}
              aria-describedby={slot.starterHint ? guidanceId : undefined}
              rows={5}
              size="sm"
              resize="vertical"
              autoFocus
            />
            <Flex justify="space-between" align="center" mt={1}>
              <Text fontSize="2xs" color="gray.400">
                {card.prompt.length}/{MAX_PROMPT_CHARS}
              </Text>
              <Button size="2xs" variant="ghost" onClick={() => setExpanded(false)}>
                Done
              </Button>
            </Flex>
          </>
        ) : (
          <Box
            role="button"
            tabIndex={0}
            aria-label={`Edit the ${slot.label} ${isField ? "prompt" : "strategy rule"}`}
            onClick={() => setExpanded(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpanded(true);
              }
            }}
            cursor="text"
            fontSize="xs"
            color={card.prompt ? "gray.700" : "gray.400"}
            lineClamp={3}
            _hover={{ color: "charcoal.600" }}
            _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "1px" }}
          >
            {card.prompt || (isField ? "Tap to write this species' prompt →" : "Tap to write this strategy's rule →")}
          </Box>
        )}
        {compilation ? (
          <Text
            fontSize="2xs"
            color={
              compilation.status === "failed"
                ? "orange.700"
                : compilation.status === "ready"
                  ? "green.700"
                  : "gray.500"
            }
            mt={1.5}
          >
            {compilation.status === "ready"
              ? isField ? "Compiled rules ready" : "Strategy rules ready"
              : compilation.status === "failed"
                ? compilation.errorMessage ?? `Couldn't compile this ${isField ? "prompt" : "strategy rule"}.`
                : isField
                  ? "This prompt is being prepared…"
                  : "This strategy rule is being prepared…"}
          </Text>
        ) : null}
        {canRemove ? (
          <Box mt={2}>
            {confirmingRemoval ? (
              <Flex
                role="alertdialog"
                aria-modal="false"
                aria-labelledby={removePromptId}
                align={{ base: "flex-start", md: "center" }}
                direction={{ base: "column", md: "row" }}
                gap={1.5}
              >
                <Text id={removePromptId} fontSize="xs" color="gray.600">
                  Remove {slot.label} and discard its prompt?
                </Text>
                <HStack gap={1}>
                  <Button
                    ref={keepSpeciesRef}
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setConfirmingRemoval(false);
                      removeTriggerRef.current?.focus();
                    }}
                  >
                    Keep species
                  </Button>
                  <Button
                    size="xs"
                    colorPalette="red"
                    loading={removing}
                    disabled={hasUnsavedDeckChanges}
                    onClick={onRemove}
                  >
                    Remove
                  </Button>
                </HStack>
              </Flex>
            ) : (
              <Button
                ref={removeTriggerRef}
                size="xs"
                variant="ghost"
                colorPalette="red"
                onClick={() => {
                  setConfirmingRemoval(true);
                  requestAnimationFrame(() => keepSpeciesRef.current?.focus());
                }}
                disabled={hasUnsavedDeckChanges}
                aria-label={`Remove ${slot.label}`}
                title={
                  hasUnsavedDeckChanges
                    ? "Save the deck before removing a species."
                    : undefined
                }
              >
                Remove species
              </Button>
            )}
            {hasUnsavedDeckChanges ? (
              <Text fontSize="2xs" color="gray.500" mt={0.5}>
                Save the deck before removing a species.
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>

      {slot.senses.length > 0 ? (
        <HStack gap={1} px={2.5} pb={2} flexWrap="wrap">
          {slot.senses.map((sense) => (
            <Badge key={sense.senseId} size="sm" variant="subtle" colorPalette="cyan">
              {sense.senseId}
              {sense.range && sense.range > 0 ? ` ${sense.range}` : ""}
            </Badge>
          ))}
        </HStack>
      ) : null}
    </Box>
  );
});

export const PromptDeckPanel = memo(function PromptDeckPanel({
  sessionId,
  spec,
  deck,
  deckVersion,
  speciesIcons,
  compiledPolicies,
  focusedSlotId,
  onDirtyChange,
}: {
  sessionId: Id<"sessions">;
  spec: SimulatorSpec;
  deck: readonly DeckCard[];
  deckVersion: number;
  speciesIcons: Record<string, string | undefined>;
  compiledPolicies: readonly CompilationStatus[];
  focusedSlotId?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const isField = spec.templateId === "ecosystemGrid";
  const saveDeck = useMutation(api.simulatorBenches.saveDeck);
  const [draft, setDraft] = useState<DeckCard[]>(() => [...deck]);
  const [seenVersion, setSeenVersion] = useState(deckVersion);
  const [saving, setSaving] = useState(false);

  // Reset the local draft when the persisted deck version advances (a save
  // landed, or another tab edited it). Adjusting state during render — the
  // React-recommended alternative to a setState-in-effect — so in-progress
  // edits survive reactive re-renders that don't change the version.
  if (seenVersion !== deckVersion) {
    setSeenVersion(deckVersion);
    setDraft([...deck]);
  }

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify([...deck]),
    [draft, deck],
  );

  const updateCard = (slotId: string, next: DeckCard) => {
    setDraft((current) => {
      const updated = current.map((card) => (card.slotId === slotId ? next : card));
      // Notify the sibling RunTray in an event handler (never during render).
      onDirtyChange?.(JSON.stringify(updated) !== JSON.stringify([...deck]));
      return updated;
    });
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await saveDeck({ sessionId, expectedDeckVersion: deckVersion, deck: draft });
      onDirtyChange?.(false);
    } catch (error) {
      toaster.error({ title: error instanceof Error ? error.message : "Could not save the deck" });
    } finally {
      setSaving(false);
    }
  };

  const cardBySlot = new Map(draft.map((card) => [card.slotId, card]));
  const compilationBySlot = new Map(
    compiledPolicies.map((compilation) => [compilation.slotId, compilation]),
  );

  return (
    <Flex flexDir="column" h="100%" minH={0} role="region" aria-label="Prompt deck">
      <Flex align="center" justify="space-between" px={3} py={2}>
        <Text fontSize="2xs" color="gray.500" fontWeight="700" letterSpacing="0.05em">
          {isField ? "Prompt deck" : "Strategy deck"} · v{deckVersion}
        </Text>
        {dirty ? (
          <Button size="xs" colorPalette="green" onClick={onSave} loading={saving}>
            Save
          </Button>
        ) : null}
      </Flex>

      <Box flex={1} minH={0} overflowY="auto" px={3} pb={3}>
        <Flex flexDir="column" gap={2}>
          {spec.speciesSlots.map((slot, index) => {
            const card = cardBySlot.get(slot.slotId) ?? { slotId: slot.slotId, count: slot.defaultCount, prompt: "" };
            return (
              <SpeciesCard
                key={slot.slotId}
                slotIndex={index}
                slot={slot}
                card={card}
                icon={speciesIcons[slot.label]}
                focused={slot.slotId === focusedSlotId}
                sessionId={sessionId}
                canRemove={
                  spec.templateId === "ecosystemGrid" &&
                  spec.speciesSlots.length > 1 &&
                  !slot.locked &&
                  slot.countMin === 0
                }
                hasUnsavedDeckChanges={dirty}
                isField={isField}
                compilation={
                  !dirty && spec.interpreter.kind === "scripted"
                    ? compilationBySlot.get(slot.slotId)
                    : undefined
                }
                onChange={(next) => updateCard(slot.slotId, next)}
              />
            );
          })}
        </Flex>
      </Box>
    </Flex>
  );
});
