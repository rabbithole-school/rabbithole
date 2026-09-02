const PRINT_CLAIM_CONFLICTS = [
  "Print job claim is no longer valid",
  "Print job is not owned by the relay",
] as const;

export function isPrintRelayClaimConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PRINT_CLAIM_CONFLICTS.some((conflict) => message.includes(conflict));
}
