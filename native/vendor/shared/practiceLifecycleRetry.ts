import { outboxRetryDelayMs } from "./practiceOutboxRetry";

export type BreakerLifecycleOperation =
  | "repairShown"
  | "repairUnavailable"
  | "repairStarted"
  | "repairCompleted"
  | "coachEscalated"
  | "stopped";

export type BreakerLifecycleEvent =
  | "repair_shown"
  | "repair_unavailable"
  | "repair_started"
  | "repair_completed"
  | "coach_escalated"
  | "stopped";

export type BreakerLifecycleEvidence = {
  repairShownAt?: number;
  repairUnavailableAt?: number;
  repairStartedAt?: number;
  repairCompletedAt?: number;
  coachEscalatedAt?: number;
  stoppedAt?: number;
};

export type BreakerLifecycleWriteResponse = {
  recorded: boolean;
  lifecycle?: BreakerLifecycleEvidence;
};

export const BREAKER_LIFECYCLE_MAX_ATTEMPTS = 3;

export function breakerLifecycleEvent(
  operation: BreakerLifecycleOperation,
): BreakerLifecycleEvent {
  switch (operation) {
    case "repairShown":
      return "repair_shown";
    case "repairUnavailable":
      return "repair_unavailable";
    case "repairStarted":
      return "repair_started";
    case "repairCompleted":
      return "repair_completed";
    case "coachEscalated":
      return "coach_escalated";
    case "stopped":
      return "stopped";
  }
}

export function recordedBreakerLifecycleOperations(
  lifecycle: BreakerLifecycleEvidence | undefined,
): BreakerLifecycleOperation[] {
  if (!lifecycle) return [];
  const operations: BreakerLifecycleOperation[] = [];
  if (lifecycle.repairShownAt !== undefined) operations.push("repairShown");
  if (lifecycle.repairUnavailableAt !== undefined) {
    operations.push("repairUnavailable");
  }
  if (lifecycle.repairStartedAt !== undefined) operations.push("repairStarted");
  if (lifecycle.repairCompletedAt !== undefined) {
    operations.push("repairCompleted");
  }
  if (lifecycle.coachEscalatedAt !== undefined) {
    operations.push("coachEscalated");
  }
  if (lifecycle.stoppedAt !== undefined) operations.push("stopped");
  return operations;
}

export function breakerLifecycleEvidenceIncludes(
  lifecycle: BreakerLifecycleEvidence | undefined,
  operation: BreakerLifecycleOperation,
): boolean {
  return recordedBreakerLifecycleOperations(lifecycle).includes(operation);
}

export type BreakerLifecycleRetryOutcome =
  | { status: "recorded"; attempts: number }
  | { status: "retryable-failure"; attempts: number; error: unknown };

/**
 * Retry one idempotent lifecycle write without deciding what may happen next.
 * The machine retains that causal decision; this helper only turns transport
 * ambiguity into a bounded, backoff-spaced executor result.
 */
export async function retryBreakerLifecycleWrite(options: {
  operation: BreakerLifecycleOperation;
  write: () => Promise<BreakerLifecycleWriteResponse>;
  wait?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
}): Promise<BreakerLifecycleRetryOutcome> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? BREAKER_LIFECYCLE_MAX_ATTEMPTS),
  );
  const wait =
    options.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  let lastError: unknown = new Error(
    `Breaker lifecycle ${options.operation} was not confirmed`,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await options.write();
      if (
        breakerLifecycleEvidenceIncludes(
          response.lifecycle,
          options.operation,
        )
      ) {
        return { status: "recorded", attempts: attempt };
      }
      lastError = new Error(
        `Breaker lifecycle ${options.operation} was not confirmed`,
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      await wait(outboxRetryDelayMs(attempt));
    }
  }

  return {
    status: "retryable-failure",
    attempts: maxAttempts,
    error: lastError,
  };
}
