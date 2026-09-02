/**
 * Replay/live cursor for one run on native: derive the scene frame at any tick.
 *
 * The scrubber must seek "any run, any day" in O(chunk), not O(tick) — so we
 * fetch only the chunks around the target (nearest checkpoint forward) plus the
 * bootstrap page holding the tick-0 checkpoint, then let the shared,
 * framework-free `frameAtTick` (vendored from lib/simulator/scene.ts) replay
 * deterministic physics forward. Native and web call the SAME `frameAtTick`, so
 * the two renderers cannot drift — this is the whole point of the shared layer.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";

import { api, type Id } from "@/lib/convex";
import type { WorkbenchRunId } from "./useWorkbenchData";
import {
  CHECKPOINT_EVERY_TICKS,
  TICKS_PER_CHUNK,
  type SimulatorSpec,
} from "../../../vendor/simulator/contract";
import {
  frameAtTick,
  hasPopulationTraitEvidence,
  mergeSelectedRoundFrame,
  type EcosystemSenseEvidenceRequest,
  type SceneFrame,
  type StoredSimulatorRunChunk,
} from "../../../vendor/simulator/scene";
import { getWorkbenchRendererFamily } from "../../../vendor/simulator/templates/registry";

export type { SceneFrame };

const FULL_PAGE_STRIDE = TICKS_PER_CHUNK * 40;

function replaySceneFrames(input: {
  chunks: StoredSimulatorRunChunk[];
  replayTick: number;
  selectedTick: number;
  spec: SimulatorSpec;
  isRoundRenderer: boolean;
  runId: WorkbenchRunId;
  senseEvidenceRequest?: EcosystemSenseEvidenceRequest;
}): SceneResult {
  try {
    const frameOptions = { ecosystemSenseEvidenceRequest: input.senseEvidenceRequest };
    const completeFrame = frameAtTick(
      input.chunks,
      Math.max(0, input.replayTick),
      input.spec,
      frameOptions,
    );
    if (!input.isRoundRenderer || input.selectedTick === input.replayTick) {
      return {
        status: "ready",
        tick: input.selectedTick,
        frame: completeFrame,
      };
    }
    const selectedFrame = frameAtTick(
      input.chunks,
      Math.max(0, input.selectedTick),
      input.spec,
      frameOptions,
    );
    return {
      status: "ready",
      tick: input.selectedTick,
      frame: mergeSelectedRoundFrame(selectedFrame, completeFrame),
    };
  } catch (error) {
    // Never success-shape an incomplete or failed replay into the live head.
    console.error("Could not derive native Workbench replay frame", {
      runId: input.runId,
      tick: input.selectedTick,
      error,
    });
    return { status: "error", tick: input.selectedTick };
  }
}

/**
 * Honest scene state for the viewport. `live` = the caller may draw the live-head
 * scene (we ARE at the head); `ready` = the replayed frame for the requested tick;
 * `loading`/`error` carry the requested `tick` so the caller can keep the last
 * honest frame + a "loading day N" label instead of silently drawing the live head
 * under a past-day label (the experiment-integrity bug, review Finding 2).
 */
export type SceneResult =
  | { status: "live" }
  | { status: "loading"; tick: number }
  | { status: "error"; tick: number }
  | { status: "ready"; tick: number; frame: SceneFrame };

export function workbenchSceneFetchPlan(
  spec: SimulatorSpec | undefined,
  tick: number,
  enabled: boolean,
  senseEvidenceRequest?: EcosystemSenseEvidenceRequest,
) {
  const rendererFamily = spec ? getWorkbenchRendererFamily(spec.templateId) : null;
  const needsRoundEvidence = rendererFamily === "match" || rendererFamily === "commons";
  const checkpointBase =
    Math.floor(Math.max(0, tick) / CHECKPOINT_EVERY_TICKS) * CHECKPOINT_EVERY_TICKS;
  const windowStart = Math.max(0, checkpointBase - TICKS_PER_CHUNK * 2);
  const needsFullHistory =
    needsRoundEvidence || senseEvidenceRequest !== undefined || hasPopulationTraitEvidence(spec);
  const requiredFullPages = needsFullHistory
    ? Math.min(3, Math.max(1, Math.ceil(Math.max(1, tick) / FULL_PAGE_STRIDE)))
    : 1;
  return {
    active: spec !== undefined && (enabled || needsFullHistory),
    bootstrapLimit: needsFullHistory ? 40 : 8,
    fullPageOffsets: needsFullHistory
      ? Array.from({ length: requiredFullPages }, (_, index) => index * FULL_PAGE_STRIDE)
      : [],
    aroundStart: needsFullHistory || windowStart === 0 ? null : windowStart,
  };
}

/**
 * Replay/live cursor. When `enabled` is false (following the live head with no
 * mind inspection needed) we skip the chunk subscriptions entirely and report
 * `live` — the viewport draws the reactive `latestSceneJson` instead, so a plain
 * watch costs zero chunk subscriptions (review Finding 5). When enabled we page
 * only the chunks around the target (bounded 8 + 12; server clamps 40).
 */
export function useWorkbenchScene(
  runId: WorkbenchRunId | null,
  tick: number,
  spec: SimulatorSpec | undefined,
  enabled: boolean,
  latestCommittedTick = tick,
  senseEvidenceRequest?: EcosystemSenseEvidenceRequest,
): SceneResult {
  // Bootstrap page carries the initial (tick-0) checkpoint; a second window
  // hugs the nearest periodic checkpoint at or before the target tick.
  // Match and commons records derive their visible ledger from persisted chunks,
  // even at the live head. The endpoint caps each page at 40 chunks, so games
  // request up to three fixed pages (0/200/400) only as their target requires.
  // Field watches retain their zero-read live-scene path unless replay or
  // inspection asks for a frame.
  const rendererFamily = spec ? getWorkbenchRendererFamily(spec.templateId) : null;
  const isRoundRenderer = rendererFamily === "match" || rendererFamily === "commons";
  const replayTick = isRoundRenderer ? latestCommittedTick : tick;
  const plan = useMemo(
    () => workbenchSceneFetchPlan(spec, replayTick, enabled, senseEvidenceRequest),
    [enabled, replayTick, senseEvidenceRequest, spec],
  );
  const active = plan.active && runId !== null;

  const bootstrap = useQuery(
    api.simulatorRuns.chunks,
    active
      ? { runId: runId as Id<"simulatorRuns">, fromTick: 0, limit: plan.bootstrapLimit }
      : "skip",
  );
  const fullBootstrapSecond = useQuery(
    api.simulatorRuns.chunks,
    active && plan.fullPageOffsets.includes(FULL_PAGE_STRIDE)
      ? { runId: runId as Id<"simulatorRuns">, fromTick: FULL_PAGE_STRIDE, limit: 40 }
      : "skip",
  );
  const fullBootstrapThird = useQuery(
    api.simulatorRuns.chunks,
    active && plan.fullPageOffsets.includes(FULL_PAGE_STRIDE * 2)
      ? { runId: runId as Id<"simulatorRuns">, fromTick: FULL_PAGE_STRIDE * 2, limit: 40 }
      : "skip",
  );
  const around = useQuery(
    api.simulatorRuns.chunks,
    active && plan.aroundStart !== null
      ? { runId: runId as Id<"simulatorRuns">, fromTick: plan.aroundStart, limit: 12 }
      : "skip",
  );

  return useMemo<SceneResult>(() => {
    if (!active || !runId || !spec) return { status: "live" };
    if (
      bootstrap === undefined ||
      (plan.fullPageOffsets.includes(FULL_PAGE_STRIDE) && fullBootstrapSecond === undefined) ||
      (plan.fullPageOffsets.includes(FULL_PAGE_STRIDE * 2) && fullBootstrapThird === undefined)
    ) {
      return { status: "loading", tick };
    }
    const byStart = new Map<number, StoredSimulatorRunChunk>();
    for (const chunk of bootstrap.page) byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    // Compiled policies use 100-tick chunks, so a page boundary can overlap a
    // chunk. Deduplicating by start tick keeps either projection safe.
    for (const chunk of fullBootstrapSecond?.page ?? []) {
      byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    }
    for (const chunk of fullBootstrapThird?.page ?? []) {
      byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    }
    for (const chunk of around?.page ?? []) byStart.set(chunk.startTick, chunk as StoredSimulatorRunChunk);
    const chunks = [...byStart.values()].sort((a, b) => a.startTick - b.startTick);
    if (chunks.length === 0) return { status: "loading", tick };
    return replaySceneFrames({
      chunks,
      replayTick,
      selectedTick: tick,
      spec,
      isRoundRenderer,
      runId,
      senseEvidenceRequest,
    });
  }, [
    active,
    runId,
    spec,
    tick,
    replayTick,
    isRoundRenderer,
    bootstrap,
    fullBootstrapSecond,
    fullBootstrapThird,
    around,
    plan.fullPageOffsets,
    senseEvidenceRequest,
  ]);
}
