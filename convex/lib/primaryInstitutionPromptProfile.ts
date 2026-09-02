import type { InstitutionPromptProfile } from "./institutionPromptProfile";

/**
 * Foundation's honest fallback for guests and missing institutions. Adopters
 * can replace this generated configuration with their own primary identity.
 */
export const PRIMARY_INSTITUTION_PROMPT_PROFILE: InstitutionPromptProfile = {
  schoolName: "Rabbithole",
  shortName: "Rabbithole",
  baseLocation: null,
  observerLocation: null,
  timeZone: "UTC",
  timeZoneAbbrev: "UTC",
  clockRegion: "UTC",
  timeZoneOffsetNote: ", UTC+0",
};
