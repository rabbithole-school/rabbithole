import type { FunctionReturnType } from "convex/server";

import type { api } from "@/lib/convex";

import type { PracticeEvent } from "../../vendor/shared/practiceMachine";

/**
 * Pure translation from the server's `activeBreakerEpisode` projection to the
 * machine's `hydrate:breaker` event — pulled out of practice.tsx into its own
 * dependency-free module so it is unit-testable (against the REAL vendored
 * reducer) without mounting the whole screen, which has no render harness and
 * would need ~15 native component mocks to import at all.
 * `recoveryAvailable: true` is a deliberate constant here (not read off the
 * episode): `activeBreakerEpisode` only ever projects a v2 lifecycle-carrying
 * attempt (see its handler doc), so a hydrated episode always has
 * server-issuable fresh/easy recovery.
 *
 * `import type { api }` keeps this module free of `@/lib/convex`'s
 * module-level side effect (it throws if `EXPO_PUBLIC_CONVEX_URL` is unset,
 * and constructs a real `ConvexReactClient`) — the reference is used only
 * inside `typeof api...` type positions below, so the whole import is erased
 * at compile time and a test can import this file with zero Convex mocking.
 */
export function breakerHydrationEvent(
  episode: NonNullable<FunctionReturnType<typeof api.practiceSkills.activeBreakerEpisode>>,
): Extract<PracticeEvent, { type: "hydrate:breaker" }> {
  return {
    type: "hydrate:breaker",
    episode: {
      triggerAttemptId: String(episode.triggerAttemptId),
      recoveryAvailable: true,
      triggerItemId: episode.triggerItemId ?? null,
      triggerNodeKey: episode.triggerNodeKey,
      domain: episode.domain,
      missStreak: episode.missStreak,
      flow: episode.flow,
      repairStepIndex: episode.repairStepIndex ?? null,
      freshItemId: episode.freshItemId ?? null,
      easyItemId: episode.easyItemId ?? null,
      confirmedLifecycle: episode.confirmedLifecycle,
    },
  };
}
