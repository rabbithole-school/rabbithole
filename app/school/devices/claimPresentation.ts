/**
 * "Pushed" is not "taken".
 *
 * Assigning a scholar to a managed iPad rotates its claim token and hands the
 * new one to SimpleMDM. Until the DEVICE presents that token, it is still
 * signed in as whoever it served before — so the console must not report a
 * successful push as a completed hand-over. The `unclaimed → claimed`
 * transition on the managed row is the device's own acknowledgement, and these
 * predicates are what turn it into something staff can see.
 *
 * Split out of the page so the thresholds are unit-testable without a rendered
 * table or a configured SimpleMDM tenant.
 */

/**
 * How long a pushed-but-never-presented claim counts as ordinary in-flight MDM
 * latency before the console calls it out. A device that is awake and on wifi
 * picks a new claim up within a minute; ten minutes means it is asleep, off the
 * network, or not running the app — all of which need a human.
 */
export const CLAIM_PRESENTATION_GRACE_MS = 10 * 60 * 1000;

export type ClaimPresentationInput = {
  scholarId: string | null;
  claimState: string;
  /** `pendingSimplemdmPushedAt` when a replacement is staged, else `simplemdmPushedAt`. */
  pushedAt: number | null;
};

/** The claim reached SimpleMDM but the iPad has not exchanged it yet. */
export function awaitingClaimPresentation(device: ClaimPresentationInput): boolean {
  return (
    !!device.scholarId &&
    device.claimState === "unclaimed" &&
    device.pushedAt !== null
  );
}

/** Waited past the point where in-flight MDM latency explains it. */
export function claimPresentationOverdue(
  device: ClaimPresentationInput,
  now: number,
): boolean {
  return (
    awaitingClaimPresentation(device) &&
    device.pushedAt !== null &&
    now - device.pushedAt > CLAIM_PRESENTATION_GRACE_MS
  );
}
