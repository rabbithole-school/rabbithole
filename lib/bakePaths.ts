// Client-side helpers for the live "choose your path" menu. The options
// themselves are NO LONGER fixed — they're proposed per-topic at open time by
// the Curriculum Bot (`api.bakePaths.suggestBakePaths`). This file just carries
// the shared shape + the visual accents the menu cycles through.

import type { Id } from "@/convex/_generated/dataModel";
import { BUILD_SIMULATION_PATH } from "@/shared/missionCopy";

export interface SuggestedPath {
  emoji: string;
  title: string;
  blurb: string;
  /** "build" marks the fixed "Build a simulation" card; the bake keys on it. */
  shape?: "build";
}

/**
 * Sentinel for the "Endless chat" option — the old ad-lib free exploration with
 * no curated path. The chat stays open: it is never held behind "building your
 * quest" nor upgraded in place into a baked activity (a topic star skips the
 * bake entirely via `createFromSeed({ endlessChat })`).
 */
export const ENDLESS_CHAT = "endless-chat" as const;

/**
 * The Convex client queues a call while its socket is down and never gives up
 * on it; past this deadline the picker shows FALLBACK_PATHS instead of
 * placeholders (and, on web, a Start button disabled) forever. Mirrored in
 * native/src/components/BakePathPicker.tsx.
 */
export const PATH_SUGGEST_TIMEOUT_MS = 15_000;

/** What the scholar picked in the path menu: a curated path or endless chat. */
export type PathChoice = SuggestedPath | typeof ENDLESS_CHAT;

/** The always-offered build path (TRA-519 B4), as a pickable path. */
export const BUILD_PATH: SuggestedPath = { ...BUILD_SIMULATION_PATH };

/** The `bakePath` argument a launch sends for a choice; none for endless chat.
 * Carries `shape` so the bake can key on it (never on the title). Native twin:
 * `bakePathArg` in native/src/components/BakePathPicker.tsx. */
export function bakePathArg(
  choice: PathChoice,
): { title: string; blurb: string; shape?: "build" } | undefined {
  if (choice === ENDLESS_CHAT) return undefined;
  return {
    title: choice.title,
    blurb: choice.blurb,
    ...(choice.shape ? { shape: choice.shape } : {}),
  };
}

/**
 * Where the path picker sources its suggestions. A topic SEED the scholar owns
 * (star-map / ChoosePathDialog), or a FREE-TEXT topic the scholar just typed in
 * the Custom Quest dialog (no seed exists yet). One picker, both flows.
 */
export type BakePathSource =
  | { kind: "seed"; seedId: Id<"seeds"> }
  | { kind: "topic"; topic: string; rationale?: string };

/** Options threaded when launching a seed from a UI entry point. */
export interface ExploreSeedOptions {
  /** The path the scholar picked inline (topic seeds only). */
  path?: SuggestedPath;
  /** The caller already showed the path picker — don't pop the fallback dialog. */
  skipMenu?: boolean;
}

// Accent stripe/badge hues, cycled by card index (the bot picks the content,
// we pick the colors so the menu stays visually consistent).
const ACCENTS = ["#0ea5e9", "#f59e0b", "#10b981", "#8b5cf6"];
export function accentForIndex(i: number): string {
  return ACCENTS[i % ACCENTS.length];
}

// Shown only if the live suggestion call errors/times out, so the menu never
// dead-ends. Kept concrete (not the old abstract archetypes). The old third
// entry ("Make something that shows it") is replaced by the fixed BUILD_PATH
// card the picker always renders after the list (TRA-519 B4).
export const FALLBACK_PATHS: SuggestedPath[] = [
  { emoji: "🔍", title: "Get to the bottom of it", blurb: "Chase the one big 'why' behind it until it really clicks." },
  { emoji: "🔗", title: "Find the surprising links", blurb: "See what this secretly connects to in your own world." },
];
