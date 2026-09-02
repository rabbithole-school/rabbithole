/**
 * Phase 0 prototype types for the self-improving-curricula loop.
 * See review/self-improving-curricula-plan.md.
 *
 * Deliberately a thin subset of the real schema — just enough to drive the
 * Scholar Simulator + the production tutor and capture a transcript. The
 * product version reads these off `activities` / `syntheticScholarProfiles`.
 */

import type {
  SimProfile as ScholarProfile,
  SimTurn,
  StopReason,
} from "../../../convex/lib/curriculumSimShared";

export type { SimActivity } from "../../../convex/lib/curriculumSimShared";
export type {
  SimProfile as ScholarProfile,
  SimRole,
  SimTurn,
  StopReason,
} from "../../../convex/lib/curriculumSimShared";

export type SessionResult = {
  profile: ScholarProfile;
  turns: SimTurn[];
  stopReason: StopReason;
};
