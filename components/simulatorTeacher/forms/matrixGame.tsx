"use client";

/**
 * The matrixGame Form (see ../registry.ts). A matrixGame World is an authored
 * repeated 2x2 game: rounds/noise are editable like prisonersDilemma, but
 * unlike prisonersDilemma, the two action LABELS (optionA/optionB) and the
 * full asymmetric payoff table are author choices, and the criterion is a
 * choice between the fixed adversarial deck scores or a measured jointScore
 * — never a free metric picker (validateMatrixGameSpec rejects anything
 * else). Species slots follow the exact same self-play/two-decks rule as
 * prisonersDilemma, so this form reuses those deck-mode helpers.
 */

import { Box, Button, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import {
  COMPILED_POLICY_INTERPRETER_ID,
  type MatrixGameActionId,
  type MatrixGameConfig,
  type SimulatorSpec,
} from "@/lib/simulator/contract";
import { Label, NumField, SectionCard, selectStyle } from "./shared";
import {
  deckModeFromSlots,
  defaultMatrixGameCriterion,
  speciesSlotsForDeckMode,
  type MatrixGameDeckMode,
} from "./matrixGameHelpers";
import type { DeepWritable, SimulatorFormEntry, SimulatorFormProps, SimulatorTemplateMeta } from "./types";

const ACTION_IDS: readonly MatrixGameActionId[] = ["optionA", "optionB"];
const DIRECTION_LABEL: Record<string, string> = {
  maximize: "Maximize",
  minimize: "Minimize",
  target: "Hit a target",
};

export function defaultMatrixGameSpec(templateMeta: SimulatorTemplateMeta): SimulatorSpec {
  return {
    version: 1,
    templateId: "matrixGame",
    templateVersion: templateMeta.version,
    config: {
      rounds: 40,
      noiseProbability: 0.05,
      actions: [
        { actionId: "optionA", label: "Hunt stag" },
        { actionId: "optionB", label: "Hunt hare" },
      ],
      payoffs: {
        optionA: {
          optionA: { a: 4, b: 4 },
          optionB: { a: 0, b: 3 },
        },
        optionB: {
          optionA: { a: 3, b: 0 },
          optionB: { a: 2, b: 2 },
        },
      },
      maxAutomata: 2,
    },
    criterion: { kind: "measured", metricKey: "jointScore", direction: "maximize" },
    speciesSlots: [
      {
        slotId: "deck_a",
        label: "Deck A",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: [{ senseId: "history" }],
        starterHint: "Hunt stag when you expect the other hunter to coordinate.",
      },
      {
        slotId: "deck_b",
        label: "Deck B",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: [{ senseId: "history" }],
        starterHint: "Use the round history to decide whether the stag hunt is safe.",
      },
    ],
    tickBudget: { iterationTicks: 5, seasonTicks: 40, absoluteMaxTicks: 40 },
    interpreter: {
      kind: "scripted",
      interpreterId: COMPILED_POLICY_INTERPRETER_ID,
    },
    microWorld: false,
  };
}

/** action label -> lookup by fixed actionId, independent of array order. */
function actionLabel(config: MatrixGameConfig, id: MatrixGameActionId): string {
  return config.actions.find((a) => a.actionId === id)?.label ?? id;
}

function MatrixGameForm({ draft, patch }: SimulatorFormProps) {
  if (draft.templateId !== "matrixGame") return null;
  const config = draft.config as MatrixGameConfig;
  const rounds = config.rounds;
  const mode = deckModeFromSlots(draft.speciesSlots);

  const setMode = (next: MatrixGameDeckMode) => {
    if (next === mode) return;
    patch((n) => {
      n.speciesSlots = speciesSlotsForDeckMode(
        next,
        draft.speciesSlots,
      ) as DeepWritable<SimulatorSpec>["speciesSlots"];
    });
  };

  const setActionLabel = (id: MatrixGameActionId, label: string) => {
    patch((n) => {
      const cfg = n.config as DeepWritable<MatrixGameConfig>;
      const entry = cfg.actions.find((a) => a.actionId === id);
      if (entry) entry.label = label;
    });
  };

  const setPayoffCell = (row: MatrixGameActionId, col: MatrixGameActionId, field: "a" | "b", value: number) => {
    patch((n) => {
      const cfg = n.config as DeepWritable<MatrixGameConfig>;
      cfg.payoffs[row][col][field] = value;
    });
  };

  return (
    <>
      {/* Criterion */}
      <SectionCard title="Criterion — the success frame">
        <Stack gap={3}>
          <HStack gap={2}>
            {(["adversarial", "measured"] as const).map((kind) => (
              <Button
                key={kind}
                size="xs"
                variant={draft.criterion.kind === kind ? "solid" : "outline"}
                bg={draft.criterion.kind === kind ? "violet.500" : "white"}
                color={draft.criterion.kind === kind ? "white" : "charcoal.500"}
                _hover={{ bg: draft.criterion.kind === kind ? "violet.600" : "gray.50" }}
                fontFamily="heading"
                onClick={() =>
                  patch((n) => {
                    n.criterion = defaultMatrixGameCriterion(
                      kind,
                      draft.criterion,
                    ) as DeepWritable<SimulatorSpec>["criterion"];
                  })
                }
              >
                {kind === "adversarial" ? "Adversarial (deck scores)" : "Joint score (cooperative)"}
              </Button>
            ))}
          </HStack>
          {draft.criterion.kind === "adversarial" ? (
            <Text fontSize="xs" color="charcoal.500">
              Fixed: scores <strong>deckA.totalScore</strong> and <strong>deckB.totalScore</strong>{" "}
              against each other.
            </Text>
          ) : draft.criterion.kind === "measured" ? (
            <HStack gap={3} align="flex-end" flexWrap="wrap">
              <Text fontSize="xs" color="charcoal.500">
                Fixed metric: <strong>jointScore</strong> (both decks&apos; scores combined).
              </Text>
              <Box>
                <Label>Direction</Label>
                <select
                  aria-label="Criterion direction"
                  style={selectStyle}
                  value={draft.criterion.direction}
                  onChange={(e) =>
                    patch((n) => {
                      if (n.criterion.kind === "measured")
                        n.criterion.direction = e.target.value as "maximize" | "minimize" | "target";
                    })
                  }
                >
                  {(["maximize", "minimize", "target"] as const).map((d) => (
                    <option key={d} value={d}>
                      {DIRECTION_LABEL[d]}
                    </option>
                  ))}
                </select>
              </Box>
              {draft.criterion.direction === "target" && (
                <NumField
                  label="Target"
                  value={draft.criterion.target ?? 0}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.criterion.kind === "measured") n.criterion.target = v;
                    })
                  }
                />
              )}
            </HStack>
          ) : null}
        </Stack>
      </SectionCard>

      {/* Actions */}
      <SectionCard title="Actions">
        <Stack gap={2}>
          <Text fontSize="2xs" color="charcoal.400">
            The two action ids (optionA, optionB) are fixed by the template. Give them
            scenario-specific display labels — automata see both the id and the label.
          </Text>
          <HStack gap={3} flexWrap="wrap">
            {ACTION_IDS.map((id) => (
              <Box key={id}>
                <Label>{id}</Label>
                <input
                  aria-label={`${id} label`}
                  value={actionLabel(config, id)}
                  onChange={(e) => setActionLabel(id, e.target.value)}
                  style={{
                    fontSize: "13px",
                    padding: "6px 8px",
                    borderRadius: "6px",
                    border: "1px solid #e2e8f0",
                    fontFamily: "var(--chakra-fonts-heading)",
                  }}
                />
              </Box>
            ))}
          </HStack>
        </Stack>
      </SectionCard>

      {/* Payoff matrix */}
      <SectionCard title="Payoff matrix">
        <Stack gap={2}>
          <Text fontSize="2xs" color="charcoal.400">
            Rows are Deck A&apos;s choice, columns are Deck B&apos;s choice.{" "}
            <strong>a</strong> is Deck A&apos;s payoff, <strong>b</strong> is Deck B&apos;s payoff for that
            combination. Asymmetric values are allowed; each is finite from -1000 to 1000.
          </Text>
          <Box overflowX="auto">
            <Box as="table" style={{ borderCollapse: "collapse" }}>
              <Box as="thead">
                <Box as="tr">
                  <Box as="th" />
                  {ACTION_IDS.map((col) => (
                    <Box
                      as="th"
                      key={col}
                      fontSize="2xs"
                      fontFamily="heading"
                      fontWeight="700"
                      color="charcoal.500"
                      px={2}
                      pb={1}
                    >
                      Column: {actionLabel(config, col)}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box as="tbody">
                {ACTION_IDS.map((row) => (
                  <Box as="tr" key={row}>
                    <Box
                      as="td"
                      fontSize="2xs"
                      fontFamily="heading"
                      fontWeight="700"
                      color="charcoal.500"
                      pr={2}
                      whiteSpace="nowrap"
                    >
                      Row: {actionLabel(config, row)}
                    </Box>
                    {ACTION_IDS.map((col) => (
                      <Box as="td" key={col} p={1}>
                        <HStack gap={1} borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="gray.50" p={1.5}>
                          <NumField
                            label="a (Deck A)"
                            value={config.payoffs[row][col].a}
                            onChange={(v) => setPayoffCell(row, col, "a", v)}
                            min={-1000}
                            max={1000}
                            w="80px"
                          />
                          <NumField
                            label="b (Deck B)"
                            value={config.payoffs[row][col].b}
                            onChange={(v) => setPayoffCell(row, col, "b", v)}
                            min={-1000}
                            max={1000}
                            w="80px"
                          />
                        </HStack>
                      </Box>
                    ))}
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        </Stack>
      </SectionCard>

      {/* Game parameters */}
      <SectionCard title="Game parameters">
        <HStack gap={3} flexWrap="wrap">
          <NumField
            label="Rounds"
            value={rounds}
            onChange={(v) => patch((n) => ((n.config as DeepWritable<MatrixGameConfig>).rounds = v))}
            min={1}
            max={500}
            w="100px"
          />
          <NumField
            label="Noise probability"
            value={config.noiseProbability}
            onChange={(v) =>
              patch((n) => ((n.config as DeepWritable<MatrixGameConfig>).noiseProbability = v))
            }
            step={0.01}
            min={0}
            max={1}
            w="140px"
          />
        </HStack>
        <Text fontSize="2xs" color="charcoal.400" mt={2}>
          Noise is the chance a player misperceives the opponent&apos;s previous option.
        </Text>
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

export const MATRIX_GAME_FORM: SimulatorFormEntry = {
  templateId: "matrixGame",
  startLabel: "Start from matrix-game",
  defaultSpec: defaultMatrixGameSpec,
  Form: MatrixGameForm,
};
