// Scholar-facing copy for the mission program (TRA-519 B1–B6). Shared by web
// and native (vendored — see native/scripts/sync-vendor.js) so every label is
// byte-identical on both surfaces.

export const MISSION_COPY = {
  /** Title of the done-screen block of parked ideas. */
  savedForLater: "Saved for later",
  buildItNow: "Build it now",
  makeItAQuest: "Make it a Quest",
  /** Prefix of the one Quest-mission line on the Quest page. */
  missionPrefix: "Mission:",
  /** B6 badge moment on a Quest that finished without a build step. */
  unlockBuild: "Unlock: build a simulation of this",
} as const;

/**
 * OFF since 2026-10-27 (Andy): a scholar gets a NEW app only inside a
 * teacher-assigned activity with a clear mission. While false, Quests start no
 * new app (no "Build a simulation" card, no build-first hand-off, no unlock
 * offer, no app step from a bake or co-design) and a session outside a
 * teacher's activity (a Quest step, an open chat) gets no create_code. A
 * Quest's app step that already exists keeps working. The code behind every
 * entry point stays for a later revisit: flipping this restores it.
 */
export const SCHOLAR_LED_APP_BUILDING = false;

/** The always-offered Quest path card (B4; title ruled by Andy). The bake keys
 * on `shape`, never on the title. */
export const BUILD_SIMULATION_PATH = {
  emoji: "🛠️",
  title: "Build a simulation",
  blurb: "Figure out how it works, then build a simulation that shows it.",
  shape: "build",
} as const;

/** Never a card: the path a Custom Quest launches with when the scholar's own
 * words already describe the thing to make (the menu is skipped). The quest is
 * that one build, with no learning step in front of it. */
export const BUILD_IT_PATH = {
  emoji: "🛠️",
  title: "Build it",
  blurb: "Build the thing you described, and figure out how it works as you go.",
  shape: "buildFirst",
} as const;

/** B6: a Quest build step's row while its learning step is unfinished. */
export function questBuildLockLabel(prerequisiteTitle: string): string {
  return `Unlocks when you finish ${prerequisiteTitle}`;
}
