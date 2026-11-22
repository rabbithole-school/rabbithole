// Find my BunnyPad (convex/bunnypadFind.ts): which APNs host serves this
// build's token. Each channel build is its own app with its own bundle id
// (scripts/lib/ipadRelease.mjs). The metro dev client is signed with a
// development profile, so its token lives on the sandbox host; the Ad Hoc
// channel builds (stable, canary) are production. plugins/withFindPush.js
// sets aps-environment by the same rule.
export function findPushEnvironment(
  bundleId: string,
): "production" | "development" {
  return bundleId.endsWith(".metro") ? "development" : "production";
}
