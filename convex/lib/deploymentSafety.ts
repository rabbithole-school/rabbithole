/**
 * Public exports treat hosted deployments as production unless an operator
 * explicitly enables a named development-only capability.
 */
export function isPublicProductionDeployment(developmentOptIn: string): boolean {
  return Boolean(process.env.CONVEX_CLOUD_URL)
    && process.env[developmentOptIn] !== "true";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * True only on the public local runner (`pnpm local:setup`): a Convex backend
 * served from this computer's loopback address, with both development opt-ins
 * the runner sets (local/setup.sh). A hosted deployment has a public
 * CONVEX_CLOUD_URL, so a dev flag left on one never makes it count.
 */
export function isLocalRunnerDeployment(): boolean {
  const cloudUrl = process.env.CONVEX_CLOUD_URL;
  if (!cloudUrl) return false;
  let hostname: string;
  try {
    hostname = new URL(cloudUrl).hostname;
  } catch {
    return false;
  }
  return (
    LOOPBACK_HOSTS.has(hostname) &&
    process.env.RABBITHOLE_ALLOW_DEV_LOGIN === "true" &&
    process.env.RABBITHOLE_ALLOW_DEV_FIXTURES === "true"
  );
}
