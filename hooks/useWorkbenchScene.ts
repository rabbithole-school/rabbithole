"use client";

/**
 * Replay/live cursor for one run: derive the SVG scene frame at any tick.
 *
 * The scrubber must seek "any run, any day" in O(chunk), not O(tick) — so we
 * fetch only the chunks around the target (nearest checkpoint forward) plus the
 * bootstrap page holding the tick-0 checkpoint, then let the shared,
 * framework-free `frameAtTick` (lib/simulator/scene.ts) replay deterministic
 * physics forward. Web and native call the SAME `frameAtTick`, so the two
 * renderers cannot drift.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkbenchRunId } from "@/hooks/useWorkbenchData";
import {
  CHECKPOINT_EVERY_TICKS,
  TICKS_PER_CHUNK,
  type SimulatorSpec,
} from "@/lib/simulator/contract";
import {
  frameAtTick,
  hasPopulationTraitEvidence,
  mergeSelectedRoundFrame,
  type EcosystemSenseEvidenceRequest,
  type SceneFrame,
  type StoredSimulatorRunChunk,
} from "@/lib/simulator/scene";
import { getWorkbenchRendererFamily } from "@/lib/simulator/templates/registry";

export type { SceneFrame };

/**
 * @returns the scene frame at `tick`, or `null` while the covering chunks load
 *   or when replay is not yet possible.
 */
export function useWorkbenchScene(
  runId: WorkbenchRunId | null,
  tick: number,
  spec: SimulatorSpec | undefined,
  latestCommittedTick = tick,
  senseEvidenceRequest?: EcosystemSenseEvidenceRequest,
): SceneFrame | null {
  const isRoundRenderer =
    spec !== undefined && getWorkbenchRendererFamily(spec.templateId) !== "field";
  const replayTick = isRoundRenderer ? latestCommittedTick : tick;
  // Bootstrap page carries the initial (tick-0) checkpoint; a second window
  // hugs the nearest periodic checkpoint at or before the target tick.
  const checkpointBase = Math.floor(Math.max(0, replayTick) / CHECKPOINT_EVERY_TICKS) *
    CHECKPOINT_EVERY_TICKS;
  const windowStart = Math.max(0, checkpointBase - TICKS_PER_CHUNK * 2);
  const simulatorRunId = runId as Id<"simulatorRuns"> | null;
  // The chunk endpoint caps every page at 40. Non-field renderers need every
  // completed round to calculate a durable ledger, not just a checkpoint window.
  // The largest supported game has 500 rounds: three 40-chunk pages cover that
  // even for the five-tick chunk format (compiled chunks are larger).
  const fullPageStride = TICKS_PER_CHUNK * 40;
  const needsFullHistory =
    isRoundRenderer || senseEvidenceRequest !== undefined || hasPopulationTraitEvidence(spec);
  const requiredFullPages = needsFullHistory
    ? Math.min(3, Math.max(1, Math.ceil(Math.max(1, replayTick) / fullPageStride)))
    : 1;

  const bootstrap = useQuery(
    api.simulatorRuns.chunks,
    simulatorRunId
      ? { runId: simulatorRunId, fromTick: 0, limit: needsFullHistory ? 40 : 8 }
      : "skip",
  );
  const fullBootstrapSecond = useQuery(
    api.simulatorRuns.chunks,
    simulatorRunId && needsFullHistory && requiredFullPages > 1
      ? { runId: simulatorRunId, fromTick: fullPageStride, limit: 40 }
      : "skip",
  );
  const fullBootstrapThird = useQuery(
    api.simulatorRuns.chunks,
    simulatorRunId && needsFullHistory && requiredFullPages > 2
      ? { runId: simulatorRunId, fromTick: fullPageStride * 2, limit: 40 }
      : "skip",
  );
  const around = useQuery(
    api.simulatorRuns.chunks,
    simulatorRunId && !needsFullHistory && windowStart > 0
      ? { runId: simulatorRunId, fromTick: windowStart, limit: 12 }
      : "skip",
  );

  return useMemo(() => {
    if (!runId || !spec || bootstrap === undefined) return null;
    if (
      needsFullHistory &&
      ((requiredFullPages > 1 && fullBootstrapSecond === undefined) ||
        (requiredFullPages > 2 && fullBootstrapThird === undefined))
    ) {
      return null;
    }
    const byStart = new Map<number, StoredSimulatorRunChunk>();
    for (const chunk of bootstrap.page) byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    for (const chunk of fullBootstrapSecond?.page ?? []) {
      byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    }
    for (const chunk of fullBootstrapThird?.page ?? []) {
      byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    }
    for (const chunk of around?.page ?? []) byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    const chunks = [...byStart.values()].sort((a, b) => a.startTick - b.startTick);
    if (chunks.length === 0) return null;
    try {
      const frameOptions = { ecosystemSenseEvidenceRequest: senseEvidenceRequest };
      const completeFrame = frameAtTick(chunks, Math.max(0, replayTick), spec, frameOptions);
      if (!isRoundRenderer || tick === replayTick) return completeFrame;

      const selectedFrame = frameAtTick(chunks, Math.max(0, tick), spec, frameOptions);
      return mergeSelectedRoundFrame(selectedFrame, completeFrame);
    } catch (error) {
      // A tick the loaded window can't reach yet (still committing) — the
      // caller shows the live scene instead. Never surface a physics error.
      console.error("Could not derive Workbench replay frame", {
        runId,
        tick: replayTick,
        error,
      });
      return null;
    }
  }, [
    runId,
    spec,
    tick,
    replayTick,
    bootstrap,
    fullBootstrapSecond,
    fullBootstrapThird,
    around,
    isRoundRenderer,
    needsFullHistory,
    senseEvidenceRequest,
    requiredFullPages,
  ]);
}
