/**
 * Pure argument builder for `api.masteryObservations.flagMisconception`, split
 * out of the (now-deleted) CohortFrontier flag control so the "same args as
 * before" contract can be asserted in a unit test rather than eyeballed.
 *
 * The label resolves exactly as the original popover did: the typed label wins,
 * else the supplied default; an empty result means there is nothing to flag
 * (the caller keeps the popover open). The `domain` is omitted entirely when
 * absent, so the mutation applies its own default — the create path is
 * unchanged.
 */
export type FlagMisconceptionArgs = {
  scholarId: string;
  conceptLabel: string;
  domain?: string;
};

export function flagMisconceptionArgs(input: {
  scholarId: string;
  conceptLabel: string;
  defaultLabel?: string;
  domain?: string;
}): FlagMisconceptionArgs | null {
  const label = input.conceptLabel.trim() || (input.defaultLabel ?? "").trim();
  if (!label) return null;
  return {
    scholarId: input.scholarId,
    conceptLabel: label,
    ...(input.domain ? { domain: input.domain } : {}),
  };
}
