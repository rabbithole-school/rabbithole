// Deployment configuration — see DEPLOYMENT.md (Institution brand).
/**
 * Foundation's neutral printable-form identity. Adopters can replace this
 * generated configuration with their own school branding and contact details.
 */
export const PRIMARY_INSTITUTION_BRAND = {
  schoolName: "Rabbithole",
  logoSrc: null,
  logoAlt: "",
  tagline: null,
  websiteUrl: null,
  phone: null,
  email: null,
  address: null,
  /** GA4 measurement id for the public pages; null loads no analytics. */
  analyticsMeasurementId: null as string | null,
  /** Vercel Web Analytics on the public pages; turn on if you host on Vercel. */
  vercelWebAnalytics: false as boolean,
  physicianFormLabel:
    "Rabbithole physician form — use your browser's print dialog to save as PDF or print.",
} as const;
