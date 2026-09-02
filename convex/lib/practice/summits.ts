import { accessProven, isFluent } from "./scheduler";

type DomainClimbRow = {
  skillKey: string;
  repetition: number;
  source?: string;
};

/**
 * The two completion claims for a non-empty domain.
 *
 * Access is deliberately generous: placement, acceleration, and re-probes may
 * open the frontier. A summit is stricter: every node must be demonstrated by
 * practice. `isFluent(row)` implies `accessProven(row)`, so demonstrated
 * completion always implies access completion.
 */
export function domainClimb(
  keys: Iterable<string>,
  rows: Iterable<DomainClimbRow>,
): { accessComplete: boolean; demonstratedComplete: boolean } {
  const domainKeys = [...new Set(keys)];
  if (domainKeys.length === 0) {
    return { accessComplete: false, demonstratedComplete: false };
  }

  const rowByKey = new Map<string, DomainClimbRow>();
  for (const row of rows) rowByKey.set(row.skillKey, row);

  return {
    accessComplete: domainKeys.every((key) => {
      const row = rowByKey.get(key);
      return row !== undefined && accessProven(row);
    }),
    demonstratedComplete: domainKeys.every((key) => {
      const row = rowByKey.get(key);
      return row !== undefined && isFluent(row);
    }),
  };
}
