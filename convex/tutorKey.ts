// Whether this deployment can take an Anthropic key from the web app
// (TRA-536). Read by the local runner's /tutor-key page and its route handler,
// which 404 unless `available` is true. Only the public local runner qualifies
// (lib/deploymentSafety.isLocalRunnerDeployment), and only while it has no key:
// the page sets a missing key and can never replace one, so nobody at the
// browser can swap in a key that would route the tutor's conversations to
// another Anthropic account. Replacing a key stays a terminal job
// (`npx convex env set`). Setting a backend secret from a web request on a
// hosted deployment is a separate decision.
import { query } from "./_generated/server";
import { hasAnthropicApiKey } from "./lib/anthropic";
import { isLocalRunnerDeployment } from "./lib/deploymentSafety";

export const localRunnerKeySetup = query({
  args: {},
  handler: async () => {
    // Off the local runner, or once a key is set, say nothing more.
    if (!isLocalRunnerDeployment() || hasAnthropicApiKey()) return { available: false as const };
    return { available: true as const };
  },
});
