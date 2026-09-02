/**
 * Public exports treat hosted deployments as production unless an operator
 * explicitly enables a named development-only capability.
 */
export function isPublicProductionDeployment(developmentOptIn: string): boolean {
  return Boolean(process.env.CONVEX_CLOUD_URL)
    && process.env[developmentOptIn] !== "true";
}
