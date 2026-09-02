"use client";

/**
 * The prisonersDilemma Form (see ../registry.ts). Unlike ecosystemGrid, the
 * criterion and each slot's senses are FIXED by the template (validateSpec
 * rejects anything else), so this form surfaces them as read-only facts
 * rather than editable controls, and offers a self-play/two-decks toggle
 * instead of free-form species-slot add/remove.
 */

import { Box, Button, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import {
  COMPILED_POLICY_INTERPRETER_ID,
  type PrisonersDilemmaConfig,
  type SimulatorSpec,
} from "@/lib/simulator/contract";
import { Label, NumField, SectionCard } from "./shared";
import {
  deckModeFromSlots,
  payoffOrderingIssues,
  speciesSlotsForDeckMode,
  type PrisonersDilemmaDeckMode,
} from "./prisonersDilemmaHelpers";
import type { DeepWritable, SimulatorFormEntry, SimulatorFormProps, SimulatorTemplateMeta } from "./types";

export function defaultPrisonersDilemmaSpec(templateMeta: SimulatorTemplateMeta): SimulatorSpec {
  return {
    version: 1,
    templateId: "prisonersDilemma",
    templateVersion: templateMeta.version,
    config: {
      rounds: 50,
      noiseProbability: 0.05,
      payoffMatrix: {
        mutualCooperation: 3,
        temptation: 5,
        sucker: 0,
        mutualDefection: 1,
      },
      maxAutomata: 2,
    },
    criterion: {
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    },
    speciesSlots: [
      {
        slotId: "deck_a",
        label: "Deck A",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: [{ senseId: "history" }],
        starterHint: "Cooperate first; forgive one apparent defection before retaliating.",
      },
      {
        slotId: "deck_b",
        label: "Deck B",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: [{ senseId: "history" }],
        starterHint: "Always cooperate.",
      },
    ],
    tickBudget: { iterationTicks: 1, seasonTicks: 50, absoluteMaxTicks: 50 },
    interpreter: {
      kind: "scripted",
      interpreterId: COMPILED_POLICY_INTERPRETER_ID,
    },
    microWorld: false,
  };
}

function PrisonersDilemmaForm({ draft, patch }: SimulatorFormProps) {
  if (draft.templateId !== "prisonersDilemma") return null;
  const config = draft.config as PrisonersDilemmaConfig;
  const rounds = config.rounds ?? 50;
  const mode = deckModeFromSlots(draft.speciesSlots);
  const issues = payoffOrderingIssues(config.payoffMatrix);

  const setMode = (next: PrisonersDilemmaDeckMode) => {
    if (next === mode) return;
    patch((n) => {
      n.speciesSlots = speciesSlotsForDeckMode(
        next,
        draft.speciesSlots,
      ) as DeepWritable<SimulatorSpec>["speciesSlots"];
    });
  };

  return (
    <>
      {/* Criterion — fixed by the template */}
      <SectionCard title="Criterion — the success frame">
        <Text fontSize="xs" color="charcoal.500">
          Adversarial (fixed): scores <strong>deckA.totalScore</strong> and{" "}
          <strong>deckB.totalScore</strong>. A prisoners-dilemma World is always scored this
          way — the criterion isn&apos;t editable here.
        </Text>
      </SectionCard>

      {/* Game parameters */}
      <SectionCard title="Game parameters">
        <Stack gap={3}>
          <HStack gap={3} flexWrap="wrap">
            <NumField
              label="Rounds"
              value={rounds}
              onChange={(v) => patch((n) => ((n.config as DeepWritable<PrisonersDilemmaConfig>).rounds = v))}
              min={1}
              max={500}
              w="100px"
            />
            <NumField
              label="Noise probability"
              value={config.noiseProbability}
              onChange={(v) =>
                patch((n) => ((n.config as DeepWritable<PrisonersDilemmaConfig>).noiseProbability = v))
              }
              step={0.01}
              min={0}
              max={1}
              w="140px"
            />
          </HStack>
          <Text fontSize="2xs" color="charcoal.400">
            Noise is the chance a move is misperceived by the other deck (models miscommunication).
          </Text>
          <Box>
            <Label>Payoff matrix</Label>
            <HStack gap={3} flexWrap="wrap">
              <NumField
                label="Mutual cooperation"
                value={config.payoffMatrix.mutualCooperation}
                onChange={(v) =>
                  patch(
                    (n) =>
                      ((n.config as DeepWritable<PrisonersDilemmaConfig>).payoffMatrix.mutualCooperation = v),
                  )
                }
                w="150px"
              />
              <NumField
                label="Temptation"
                value={config.payoffMatrix.temptation}
                onChange={(v) =>
                  patch(
                    (n) => ((n.config as DeepWritable<PrisonersDilemmaConfig>).payoffMatrix.temptation = v),
                  )
                }
                w="120px"
              />
              <NumField
                label="Sucker"
                value={config.payoffMatrix.sucker}
                onChange={(v) =>
                  patch((n) => ((n.config as DeepWritable<PrisonersDilemmaConfig>).payoffMatrix.sucker = v))
                }
                w="100px"
              />
              <NumField
                label="Mutual defection"
                value={config.payoffMatrix.mutualDefection}
                onChange={(v) =>
                  patch(
                    (n) =>
                      ((n.config as DeepWritable<PrisonersDilemmaConfig>).payoffMatrix.mutualDefection = v),
                  )
                }
                w="150px"
              />
            </HStack>
            <Text fontSize="2xs" color="charcoal.400" mt={1}>
              Canonical: 3 / 5 / 0 / 1. Must satisfy temptation &gt; mutual cooperation &gt; mutual
              defection &gt; sucker, and 2× mutual cooperation &gt; temptation + sucker.
            </Text>
            {issues.length > 0 && (
              <Box mt={2} borderWidth="1px" borderColor="amber.300" bg="amber.50" borderRadius="md" px={2} py={1.5}>
                <Stack gap={0.5}>
                  {issues.map((issue) => (
                    <Text key={issue} fontSize="2xs" color="amber.700">
                      {issue}
                    </Text>
                  ))}
                </Stack>
              </Box>
            )}
          </Box>
        </Stack>
      </SectionCard>

      {/* Budgets */}
      <SectionCard title="Budgets">
        <HStack gap={3} flexWrap="wrap">
          <NumField
            label="Iteration ticks"
            value={draft.tickBudget.iterationTicks}
            onChange={(v) => patch((n) => (n.tickBudget.iterationTicks = v))}
            min={1}
          />
          <NumField
            label="Season ticks"
            value={draft.tickBudget.seasonTicks}
            onChange={(v) => patch((n) => (n.tickBudget.seasonTicks = v))}
            min={1}
          />
          <NumField
            label="Absolute max"
            value={draft.tickBudget.absoluteMaxTicks}
            onChange={(v) => patch((n) => (n.tickBudget.absoluteMaxTicks = v))}
            min={1}
            max={rounds}
          />
        </HStack>
        <Text fontSize="2xs" color="charcoal.400" mt={2}>
          Season ≥ iteration, absolute max ≥ season, and absolute max ≤ rounds ({rounds}).
        </Text>
        {draft.tickBudget.absoluteMaxTicks > rounds && (
          <Text fontSize="2xs" color="amber.700" mt={1}>
            Absolute max ({draft.tickBudget.absoluteMaxTicks}) exceeds rounds ({rounds}) — lower one
            of them before saving.
          </Text>
        )}
      </SectionCard>

      {/* Decks */}
      <SectionCard title="Decks">
        <Stack gap={3}>
          <HStack gap={2}>
            <Button
              size="xs"
              variant={mode === "selfPlay" ? "solid" : "outline"}
              bg={mode === "selfPlay" ? "violet.500" : "white"}
              color={mode === "selfPlay" ? "white" : "charcoal.500"}
              _hover={{ bg: mode === "selfPlay" ? "violet.600" : "gray.50" }}
              fontFamily="heading"
              onClick={() => setMode("selfPlay")}
            >
              Self-play (one deck)
            </Button>
            <Button
              size="xs"
              variant={mode === "twoDecks" ? "solid" : "outline"}
              bg={mode === "twoDecks" ? "violet.500" : "white"}
              color={mode === "twoDecks" ? "white" : "charcoal.500"}
              _hover={{ bg: mode === "twoDecks" ? "violet.600" : "gray.50" }}
              fontFamily="heading"
              onClick={() => setMode("twoDecks")}
            >
              Two decks
            </Button>
          </HStack>
          <Text fontSize="2xs" color="charcoal.400">
            {mode === "selfPlay"
              ? "One strategy plays both seats against itself."
              : "Two distinct strategies, one seat each."}{" "}
            Every deck perceives exactly the history Sense (fixed) — no range, no channels.
          </Text>
          {draft.speciesSlots.map((slot, i) => (
            <Box key={slot.slotId} borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="gray.50" p={3}>
              <Stack gap={2}>
                <HStack gap={3} flexWrap="wrap">
                  <Box>
                    <Label>Label</Label>
                    <input
                      aria-label={`Deck ${i + 1} label`}
                      value={slot.label}
                      onChange={(e) =>
                        patch((n) => {
                          n.speciesSlots[i].label = e.target.value;
                        })
                      }
                      style={{
                        fontSize: "13px",
                        padding: "4px 8px",
                        borderRadius: "6px",
                        border: "1px solid #e2e8f0",
                        fontFamily: "var(--chakra-fonts-heading)",
                      }}
                    />
                  </Box>
                </HStack>
                <Box>
                  <Label>Starter hint (optional)</Label>
                  <Textarea
                    aria-label={`${slot.label} starter hint`}
                    size="xs"
                    rows={2}
                    value={slot.starterHint ?? ""}
                    onChange={(e) =>
                      patch((n) => {
                        n.speciesSlots[i].starterHint = e.target.value || undefined;
                      })
                    }
                    fontFamily="body"
                    fontSize="xs"
                    borderColor="gray.200"
                  />
                </Box>
              </Stack>
            </Box>
          ))}
        </Stack>
      </SectionCard>
    </>
  );
}

export const PRISONERS_DILEMMA_FORM: SimulatorFormEntry = {
  templateId: "prisonersDilemma",
  startLabel: "Start from prisoners-dilemma",
  defaultSpec: defaultPrisonersDilemmaSpec,
  Form: PrisonersDilemmaForm,
};
