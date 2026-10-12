import { LLM_BUSY_MESSAGE } from "../../vendor/shared/llmLimiter";

/** True when a tutor stream error is the per-user limiter's busy refusal. */
export function isTutorBusyError(error: unknown): boolean {
  return error === LLM_BUSY_MESSAGE;
}

export function tutorStreamErrorMessage(error: unknown): string {
  if (isTutorBusyError(error)) {
    return error as string;
  }
  return "Something went wrong. Please try again.";
}
