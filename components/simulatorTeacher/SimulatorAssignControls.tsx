"use client";

/**
 * Live classroom controls for a World assignment (plan §8 Assign — "the live
 * classroom controls the ops review demanded"). Mounted on the assignment Run
 * page when the cohort's unit contains a World. Three moves a teacher makes
 * mid-block: pause-all / resume-all the cohort's sims (a DURABLE latch that also
 * blocks new launches), read the live per-class run/spend, and grant a bench N
 * more runs. Reuses the committed engine mutations verbatim
 * (simulatorRuns.pauseAssignment / resumeAssignment, simulatorBenches.grantRuns).
 *
 * The grant targets a specific BENCH (session), not an aggregated scholar, so
 * the run it grants is the one the row names (review P1). The budget readout
 * derives its window from a per-minute client clock so it re-subscribes across
 * block/week boundaries instead of freezing (review P1 clock).
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { Pause, Play, Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import {
  SimulatorRunBudgetFields,
  isSimulatorRunBudgetValid,
  type SimulatorRunBudgetValue,
} from "./SimulatorRunBudgetFields";
import { TournamentPanel } from "./TournamentPanel";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Box>
      <Text fontSize="lg" fontFamily="heading" fontWeight="800" color="navy.500" lineHeight="1">
        {value}
      </Text>
      <Text fontSize="2xs" color="charcoal.400" textTransform="uppercase" letterSpacing="0.05em">
        {label}
      </Text>
    </Box>
  );
}

export function SimulatorAssignControls({ assignmentId }: { assignmentId: Id<"assignments"> }) {
  // A per-minute clock so the reactive readout re-derives its budget window at
  // block/week boundaries (review P1 clock). Rounded to the minute to avoid
  // needless re-subscription churn.
  const [clientNowMs, setClientNowMs] = useState(() => Math.floor(Date.now() / 60000) * 60000);
  useEffect(() => {
    const id = setInterval(() => setClientNowMs(Math.floor(Date.now() / 60000) * 60000), 60000);
    return () => clearInterval(id);
  }, []);

  const readout = useQuery(api.simulatorTeacher.assignmentReadout, { assignmentId, clientNowMs });
  const pause = useMutation(api.simulatorRuns.pauseAssignment);
  const resume = useMutation(api.simulatorRuns.resumeAssignment);
  const grant = useMutation(api.simulatorBenches.grantRuns);
  const setBudget = useMutation(api.simulatorTeacher.setAssignmentWorldBudget);
  const [busy, setBusy] = useState<string | null>(null);

  const [budget, setBudgetValue] = useState<SimulatorRunBudgetValue | null>(null);
  useEffect(() => {
    if (!readout) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBudgetValue({
      perBlock: readout.budget?.perScholarBlock ?? readout.limits.blockLimit,
      perWeek: readout.budget?.perScholarWeek ?? readout.limits.weekLimit,
      seasonTicks: readout.seasonTicks,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    readout?.budget?.perScholarBlock,
    readout?.budget?.perScholarWeek,
    readout?.seasonTicks,
    readout?.limits.blockLimit,
    readout?.limits.weekLimit,
  ]);

  if (readout === undefined || readout === null) return null;

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toaster.success({ title: ok });
    } catch (e) {
      toaster.error({ title: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={3} gap={3} wrap="wrap">
        <HStack gap={6}>
          <Text fontSize="xs" fontFamily="heading" fontWeight="800" color="charcoal.500" textTransform="uppercase" letterSpacing="0.06em">
            🌍 Simulator runs{readout.paused ? " · paused" : ""}
          </Text>
          <Stat label="active" value={readout.totals.activeRuns} />
          <Stat label="queued" value={readout.totals.queuedRuns} />
          <Stat label="model calls" value={readout.totals.totalModelCalls} />
          <Stat label="benches" value={readout.totals.benchCount} />
        </HStack>
        <HStack gap={2}>
          {readout.paused ? (
            <Button
              size="sm"
              variant="outline"
              borderColor="green.400"
              color="green.700"
              _hover={{ bg: "green.50" }}
              fontFamily="heading"
              fontWeight="700"
              loading={busy === "resume"}
              onClick={() => act("resume", () => resume({ assignmentId }), "Resumed the cohort's runs")}
            >
              <Play size={14} weight="fill" style={{ marginRight: 4 }} />
              Resume all
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              borderColor="amber.400"
              color="amber.700"
              _hover={{ bg: "amber.50" }}
              fontFamily="heading"
              fontWeight="700"
              loading={busy === "pause"}
              onClick={() => act("pause", () => pause({ assignmentId }), "Paused — new runs are blocked too")}
            >
              <Pause size={14} weight="fill" style={{ marginRight: 4 }} />
              Pause all
            </Button>
          )}
        </HStack>
      </Flex>

      {readout.rows.length > 0 && (
        <Box borderWidth="1px" borderColor="gray.100" borderRadius="md" overflow="hidden" mb={3}>
          {readout.rows.map((s, i) => (
            <Flex
              key={`${String(s.scholarId)}-${String(s.sessionId ?? "none")}`}
              justify="space-between"
              align="center"
              px={3}
              py={2}
              borderTopWidth={i === 0 ? "0" : "1px"}
              borderColor="gray.100"
              gap={3}
            >
              <Text fontSize="sm" fontFamily="heading" fontWeight="600" color="charcoal.600" flex={1} truncate>
                {s.name}
                {s.activityLabel && (
                  <Text as="span" color="charcoal.400" fontWeight="400">
                    {" "}· {s.activityLabel}
                  </Text>
                )}
              </Text>
              {s.hasBench && s.sessionId ? (
                <>
                  <Text fontSize="2xs" color="charcoal.400">
                    block {s.blockUsed}/{readout.limits.blockLimit} · week {s.weekUsed}/{readout.limits.weekLimit}
                    {s.activeRuns > 0 ? ` · ${s.activeRuns} live` : ""}
                  </Text>
                  <Button
                    size="xs"
                    variant="ghost"
                    color="violet.500"
                    fontFamily="heading"
                    fontWeight="700"
                    loading={busy === `grant-${String(s.sessionId)}`}
                    onClick={() =>
                      act(
                        `grant-${String(s.sessionId)}`,
                        () =>
                          grant({
                            sessionId: s.sessionId as Id<"sessions">,
                            scope: "block",
                            windowKey: readout.windowKeys.blockKey,
                            count: 3,
                          }),
                        `Granted ${s.name} 3 more runs this block`,
                      )
                    }
                  >
                    <Plus size={12} style={{ marginRight: 2 }} /> 3 runs
                  </Button>
                </>
              ) : (
                <Text fontSize="2xs" color="charcoal.300">
                  no bench yet
                </Text>
              )}
            </Flex>
          ))}
        </Box>
      )}

      {budget && (
        <Box borderWidth="1px" borderColor="gray.100" borderRadius="md" bg="gray.50" px={3} py={2.5}>
          <Flex justify="space-between" align="flex-end" gap={3} wrap="wrap">
            <Box>
              <Text fontSize="2xs" fontFamily="heading" fontWeight="700" color="charcoal.500" textTransform="uppercase" letterSpacing="0.05em" mb={2}>
                Run budget & season — per scholar
              </Text>
              <SimulatorRunBudgetFields value={budget} onChange={setBudgetValue} />
            </Box>
            <Button
              size="sm"
              bg="violet.500"
              color="white"
              fontFamily="heading"
              fontWeight="700"
              _hover={{ bg: "violet.600" }}
              loading={busy === "budget"}
              disabled={!isSimulatorRunBudgetValid(budget)}
              onClick={() =>
                act(
                  "budget",
                  () =>
                    setBudget({
                      assignmentId,
                      perScholarBlock: budget.perBlock,
                      perScholarWeek: budget.perWeek,
                      seasonTicks: budget.seasonTicks ?? undefined,
                    }),
                  "Run budget updated",
                )
              }
            >
              Save budget
            </Button>
          </Flex>
        </Box>
      )}
      <TournamentPanel assignmentId={assignmentId} />
    </Box>
  );
}
