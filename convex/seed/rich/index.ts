// ─── Rich-cohort seed: the assembled fixture ──────────────────────────────
//
// Composes the per-layer fixture files into a single `RichSeed` the inserter
// (convex/seedRichCohort.ts) consumes. Sections not yet authored for the
// current shard are empty arrays — the inserter simply inserts nothing for
// them, so growing a shard is purely additive.

import type { RichSeed } from "./types";
import {
  teachers,
  scholars,
  parents,
  groups,
  teacherAffinities,
  dossiers,
  directives,
  readingLevelHistory,
} from "./roster";
import { units } from "./curriculum";
import {
  reportingPeriods,
  scheduleBlocks,
  schedulePlacements,
  externalApps,
} from "./schedule";
import {
  assignments,
  sessions,
  deliverables,
  completions,
  badges,
  analyses,
} from "./execution";
import {
  mastery,
  granuleEvidence,
  signals,
  connections,
  seeds,
  observations,
} from "./observation";
import { practiceAttempts, practiceMastery } from "./practice";
import { chats } from "./chat";
import {
  syntheticProfiles,
  experiments,
  variants,
  simulatedSessions,
  groundedVerdicts,
  unitReviews,
  activityReflections,
  momentTriage,
} from "./sims";
import { roboticsPortfolioItems } from "./robotics";

export const richSeed: RichSeed = {
  // Roster
  teachers,
  scholars,
  parents,
  groups,
  teacherAffinities,
  dossiers,
  directives,
  readingLevelHistory,

  // Design
  units,
  reportingPeriods,
  scheduleBlocks,
  externalApps,

  // Execution
  assignments,
  schedulePlacements,
  portfolioItems: roboticsPortfolioItems,
  sessions,
  deliverables,
  completions,
  // Deferred to a later shard:
  webSessions: [],
  shareBackDigests: [],
  angles: [],

  // Observation
  analyses,
  mastery,
  practiceMastery,
  practiceAttempts,
  granuleEvidence,
  signals,
  connections,
  seeds,
  observations,
  badges,

  chats,

  // Sims
  syntheticProfiles,
  experiments,
  variants,
  simulatedSessions,
  groundedVerdicts,
  unitReviews,
  activityReflections,
  momentTriage,
};
