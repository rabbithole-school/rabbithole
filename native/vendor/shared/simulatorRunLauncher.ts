export type SimulatorRunLifecycleStatus =
  | "queued"
  | "ticking"
  | "completed"
  | "halted"
  | "crashed";

export type SimulatorRunLauncherSummary = {
  status: SimulatorRunLifecycleStatus;
  latestCommittedTick: number;
  targetTicks: number;
};

export const START_SIMULATION_LABEL = "Start simulation";
export const DECK_DIRTY_HINT = "Save your deck to run the new prompts.";

export function firstRunHint(deckVersion: number): string {
  return deckVersion === 1
    ? "Start with the starter deck. This first simulation becomes your baseline."
    : "Start this simulation to set a baseline for your deck.";
}

export function findActiveSimulatorRun<T extends SimulatorRunLauncherSummary>(
  runs: readonly T[],
): T | null {
  return runs.find((run) => run.status === "queued" || run.status === "ticking") ?? null;
}

export function activeSimulatorRunLabel(run: SimulatorRunLauncherSummary): string {
  return run.status === "queued"
    ? "Queued"
    : `Running · day ${run.latestCommittedTick} of ${run.targetTicks}`;
}
