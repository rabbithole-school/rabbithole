// Where a session came from, for the observer's "## Origin:" line — the one
// fact that lets it tell "the scholar chose this topic" from "the topic was
// assigned". Computed from the session doc (assignmentId / seedId / unit), never
// from the transcript, so the model can't talk itself into a different origin.
// Shared by the live observer (observer.ts) and the mastery re-derive replay
// (masteryReDerive.ts) so the two can never drift.

import { classifySessionOrigin } from "./sessionOrigin";
import { ONBOARDING_UNIT_SLUG } from "../onboardingData";
import type { Id } from "../_generated/dataModel";

export type ObserverOrigin = {
  kind: "assigned" | "seed" | "scholarStarted" | "onboarding";
  label: string;
};

export const OBSERVER_ORIGIN_LABELS: Record<ObserverOrigin["kind"], string> = {
  assigned:
    "Teacher-assigned activity. The session's topic was given to the scholar; enthusiasm inside it is NOT an interest unless they say so in their own words.",
  seed:
    'The scholar picked this exploration themselves from their Sky (a suggested star). Treat the session topic as "picked".',
  scholarStarted:
    'The scholar started this session on their own and chose the topic. Treat the session topic as "picked".',
  onboarding:
    'The Welcome quest\'s interest conversation. Anything the scholar names that pulls them in is "said".',
};

export function resolveObserverOrigin(session: {
  unitSlug?: string | null;
  assignmentId?: Id<"assignments"> | null;
  seedId?: Id<"seeds"> | null;
  activityId?: Id<"activities"> | null;
  unitId?: Id<"units"> | null;
  unitForOrigin?: { authorScholarId?: Id<"users"> | null } | null;
}): ObserverOrigin {
  let kind: ObserverOrigin["kind"];
  if (session.unitSlug === ONBOARDING_UNIT_SLUG) {
    kind = "onboarding";
  } else {
    const classified = classifySessionOrigin(
      {
        assignmentId: session.assignmentId ?? undefined,
        seedId: session.seedId ?? undefined,
        activityId: session.activityId ?? undefined,
        unitId: session.unitId ?? undefined,
      },
      session.unitForOrigin ?? null,
    );
    kind =
      classified.origin === "assigned"
        ? "assigned"
        : classified.fromSeed && session.seedId
          ? "seed"
          : "scholarStarted";
  }
  return { kind, label: OBSERVER_ORIGIN_LABELS[kind] };
}
