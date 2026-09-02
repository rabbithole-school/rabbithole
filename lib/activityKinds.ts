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
  vibecode: {
    emoji: "🛠️",
    label: "Vibecode",
    longLabel: "Vibecode workshop",
    description:
      "A full-screen app-builder workshop: the scholar describes what to build and directs the AI to generate + iterate a live web app. The build brief drives the AI builder; the app is the artifact.",
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
