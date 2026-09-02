"use client";

/**
 * The ▶ Run control + the hypothesis light-gate. A first run is baseline
 * exploration; after a completed scholar run, later launches capture a prediction
 * — better / worse / about the same / exploring — with an optional line. The
 * prediction is frozen with the run and is never a modal to reflex past.
 *
 * This is a pure LAUNCHER — the run manifest lives in History and the media
 * transport drives playback. The same control is centered for the first run,
 * then relocates to the launch bar; it is never mounted in both places.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Box, Button, HStack, Text, Textarea } from "@chakra-ui/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { SimulatorRunListItem, WorkbenchRunId } from "@/hooks/useWorkbenchData";
import type { SimulatorSpec } from "@/lib/simulator/contract";
import { workbenchTimeNoun } from "@/lib/simulator/templates/registry";
import { toaster } from "@/lib/toaster";
import {
  activeSimulatorRunLabel,
  DECK_DIRTY_HINT,
  firstRunHint,
  START_SIMULATION_LABEL,
} from "@/shared/simulatorRunLauncher";
import { hypothesisLabel, predictionGateDecision } from "./helpers";

type Prediction = "better" | "worse" | "about_the_same" | "exploratory";
const PREDICTIONS: Prediction[] = ["better", "worse", "about_the_same", "exploratory"];

export function RunTray({
  sessionId,
  spec,
  onLaunched,
  deckDirty,
  deckVersion,
  hasCompletedRun,
  activeRun,
  placement = "dock",
}: {
  sessionId: Id<"sessions">;
  spec: SimulatorSpec;
  onLaunched: (runId: WorkbenchRunId) => void;
  deckDirty: boolean;
  deckVersion: number;
  hasCompletedRun: boolean;
  activeRun: SimulatorRunListItem | null;
  placement?: "dock" | "empty";
}) {
  const launchRun = useMutation(api.simulatorRuns.launchRun);
  const stopRun = useMutation(api.simulatorRuns.stopRun);
  const [gateOpen, setGateOpen] = useState(false);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [note, setNote] = useState("");
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const firstPredictionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!gateOpen || !hasCompletedRun) return;
    const frame = requestAnimationFrame(() => firstPredictionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [gateOpen, hasCompletedRun]);

  const doLaunch = async (hypothesis?: { prediction: Prediction; note?: string }) => {
    setLaunching(true);
    try {
      const result = await launchRun({
        sessionId,
        ...(hypothesis ? { hypothesis: { prediction: hypothesis.prediction, note: hypothesis.note || undefined } } : {}),
      });
      onLaunched(result.runId);
      setGateOpen(false);
      setPrediction(null);
      setNote("");
    } catch (error) {
      toaster.error({ title: error instanceof Error ? error.message : "Could not start the run" });
    } finally {
      setLaunching(false);
    }
  };

  const onRunClick = () => {
    if (deckDirty) return;
    const decision = predictionGateDecision({ hasCompletedRun, gateOpen, prediction });
    if (decision === "launch") {
      void doLaunch(prediction ? { prediction, note } : undefined);
      return;
    }
    if (decision === "open-gate") {
      setGateOpen(true);
    }
  };

  const timeUnit = workbenchTimeNoun(spec.templateId);
  const launchDisabled = launching || deckDirty;

  const onStopClick = async () => {
    if (!activeRun) return;
    setStopping(true);
    try {
      await stopRun({ runId: activeRun._id });
    } catch (error) {
      toaster.error({ title: error instanceof Error ? error.message : "Could not stop the run" });
    } finally {
      setStopping(false);
    }
  };

  return (
    <Box
      minH={placement === "dock" ? "52px" : undefined}
      display="flex"
      flexDir="column"
      justifyContent="center"
    >
      {placement === "empty" && !activeRun ? (
        <Text fontSize="lg" fontWeight="700" color="charcoal.600" textAlign="center" mb={3}>
          {firstRunHint(deckVersion)}
        </Text>
      ) : null}

      {activeRun ? (
        <HStack
          minH="52px"
          px={3}
          justify="space-between"
          gap={3}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="lg"
          role="status"
          aria-live="polite"
        >
          <Text fontSize="sm" fontWeight="600" color="charcoal.600">
            {stopping
              ? "Stopping…"
              : timeUnit === "day"
                ? activeSimulatorRunLabel(activeRun)
                : activeRun.status === "queued"
                  ? "Queued"
                  : `Running · round ${activeRun.latestCommittedTick} of ${activeRun.targetTicks}`}
          </Text>
          <Button
            size="sm"
            variant="outline"
            colorPalette="red"
            loading={stopping}
            onClick={() => void onStopClick()}
          >
            Stop
          </Button>
        </HStack>
      ) : (
        <>
          {deckDirty ? (
            <Text
              fontSize="xs"
              fontWeight="600"
              color="orange.700"
              textAlign="center"
              mb={2}
            >
              {DECK_DIRTY_HINT}
            </Text>
          ) : null}

          {gateOpen && hasCompletedRun ? (
            <Box
              mb={2}
              p={3}
              bg="white"
              borderRadius="lg"
              borderWidth="1px"
              borderColor="gray.200"
              role="group"
              aria-labelledby="prediction-gate-title"
            >
              <Text
                id="prediction-gate-title"
                fontSize="sm"
                fontWeight="600"
                color="charcoal.600"
                mb={2}
              >
                Before you run — what do you expect this deck to do?
              </Text>
              <HStack gap={1.5} flexWrap="wrap" mb={2}>
                {PREDICTIONS.map((option, index) => (
                  <Button
                    key={option}
                    ref={index === 0 ? firstPredictionRef : undefined}
                    size="xs"
                    variant={prediction === option ? "solid" : "outline"}
                    colorPalette="violet"
                    aria-pressed={prediction === option}
                    aria-describedby="prediction-gate-title"
                    onClick={() => setPrediction(option)}
                  >
                    {hypothesisLabel(option)}
                  </Button>
                ))}
              </HStack>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="why? (optional)"
                aria-label="Why do you expect that? Optional"
                size="xs"
                rows={2}
                resize="none"
              />
              <HStack mt={1.5} gap={2}>
                <Button
                  size="xs"
                  colorPalette="violet"
                  disabled={!prediction || launchDisabled}
                  aria-describedby="prediction-gate-title"
                  onClick={onRunClick}
                  aria-label={START_SIMULATION_LABEL}
                >
                  {START_SIMULATION_LABEL}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setGateOpen(false)}
                >
                  Cancel
                </Button>
              </HStack>
            </Box>
          ) : (
            <Button
              disabled={launchDisabled}
              loading={launching}
              onClick={onRunClick}
              aria-label={START_SIMULATION_LABEL}
              title="Runs your current deck through the simulation"
              h="48px"
              w="full"
              colorPalette="violet"
              fontSize="sm"
              fontWeight="700"
            >
              {START_SIMULATION_LABEL}
            </Button>
          )}
        </>
      )}
    </Box>
  );
}
