/**
 * Single source of truth for how an activity's kind
 * ("online" | "offline" | "shareBack") is presented across teacher +
 * scholar surfaces. If you add a new kind, add it here, then update
 * every consumer (search the repo for `ACTIVITY_KIND` or
 * `ActivityKindIcon`).
 *
 * UI surfaces should use the `<ActivityKindIcon />` component from
 * `components/ActivityKindIcon.tsx` rather than the raw emoji — it renders
 * subtle Phosphor icons that don't visually overwhelm surrounding text.
 * The `emoji` field is kept for non-React contexts (AI prompt strings).
 */

import { effectiveActivityKind } from "../shared/appSurface";

export type ActivityKind =
  | "online"
  | "offline"
  | "shareBack"
  | "web"
  | "problem_set"
  | "game"
  | "simulator"
  | "vibecode";

export const SESSION_ACTIVITY_KINDS = [
  "online",
  "simulator",
  "vibecode",
] as const satisfies ReadonlyArray<ActivityKind>;

export type SessionActivityKind = (typeof SESSION_ACTIVITY_KINDS)[number];

export function sessionModeForActivityKind(kind: ActivityKind | undefined) {
  if (kind === "simulator") return "workbench" as const;
  if (kind === "vibecode") return "vibecode" as const;
  return undefined;
}

/** The session mode an activity opens in, for either app-activity shape
 * (TRA-519: { kind: "online", appActivity: true } or legacy "vibecode"). */
export function sessionModeForActivity(
  activity: { kind: ActivityKind; appActivity?: boolean | null } | null | undefined,
) {
  if (!activity) return undefined;
  return sessionModeForActivityKind(effectiveActivityKind(activity));
}

export const ACTIVITY_KIND = {
  online: {
    emoji: "💻",
    label: "Online",
    longLabel: "Online activity",
    /** "Scholar opens this in Rabbithole. Needs a system prompt." */
    description:
      "Scholar opens this in Rabbithole. Needs a system prompt.",
  },
  offline: {
    emoji: "✋",
    label: "Offline",
    longLabel: "Offline activity",
    description:
      "Classroom task — discussion, lab, worksheet. Not picked in Rabbithole.",
  },
  shareBack: {
    emoji: "👥",
    label: "Share Back",
    longLabel: "Share Back activity",
    description:
      "Teacher-facilitated discussion of earlier work — the AI collates submissions into a digest you facilitate full-screen.",
  },
  web: {
    emoji: "🌐",
    label: "Web",
    longLabel: "Web assignment",
    description:
      "External website (e.g. a math-fluency platform) opened in a locked webview on the iPad. The scholar works on the site; progress is captured back into Rabbithole.",
  },
  problem_set: {
    emoji: "🧮",
    label: "Problem Set",
    longLabel: "Problem set",
    description:
      "Adaptive math fluency practice — the scholar works problems drawn from the homegrown knowledge graph; mastery + retention update automatically.",
  },
  game: {
    emoji: "🎮",
    label: "Game",
    longLabel: "Game",
    description:
      "A bespoke educational game, played in the Rabbithole app on the iPad. The game records what the scholar tried; it never grades them.",
  },
  simulator: {
    emoji: "🌍",
    label: "Simulator",
    longLabel: "Simulator activity",
    description:
      "A simulator activity: the scholar authors a prompt deck over code-owned physics and iterates runs at the bench. Criterion scores describe the deck, never the scholar.",
  },
  // The effective kind of an app activity (TRA-519): an online activity with
  // app settings, or a row still stored with the legacy kind "vibecode".
  // Teachers make one with the online editor's "Scholars build or use an app"
  // switch, so this entry labels app activities but is never a kind to pick.
  vibecode: {
    emoji: "🛠️",
    label: "App",
    longLabel: "App activity",
    description:
      "An online activity where scholars build or use an app. The scholar describes what to build and directs the AI to make and refine a live web app; the build brief drives the AI builder, and the app is the deliverable.",
  },
} as const satisfies Record<
  ActivityKind,
  { emoji: string; label: string; longLabel: string; description: string }
>;

export const COMPLETED_EMOJI = "✅";

/**
 * Single source of truth for the "this online activity has no system prompt"
 * warning copy. Used by the outline tree's hover tooltip + the activity
 * editor's inline warning. Change once.
 */
export const NO_PROMPT_WARNING =
  "No system prompt yet — the AI tutor won't have activity-specific instructions.";
