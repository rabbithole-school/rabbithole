import type { Doc } from "../_generated/dataModel";

/**
 * A completed, scholar-launched run is durable evidence for a later prediction
 * in the same Workbench session. Terminal physics is still a completed
 * observation; halted, queued, ticking, crashed, and tournament runs are not.
 */
export function isPredictionEvidenceRun(
  run: Pick<Doc<"simulatorRuns">, "status" | "tournamentId">,
): boolean {
  return run.status === "completed" && run.tournamentId === undefined;
}
