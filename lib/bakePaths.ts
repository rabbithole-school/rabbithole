// Client-side helpers for the live "choose your path" menu. The options
// themselves are NO LONGER fixed — they're proposed per-topic at open time by
// the Curriculum Bot (`api.bakePaths.suggestBakePaths`). This file just carries
// the shared shape + the visual accents the menu cycles through.

import type { Id } from "@/convex/_generated/dataModel";

export interface SuggestedPath {
  emoji: string;
  title: string;
  blurb: string;
}

/**
 * Sentinel for the "Endless chat" option — the old ad-lib free exploration with
 * no curated path. Picking it launches a plain (un-shaped) bake, just like
 * before the "choose your path" menu existed.
 */
export const ENDLESS_CHAT = "endless-chat" as const;

/** What the scholar picked in the path menu: a curated path or endless chat. */
export type PathChoice = SuggestedPath | typeof ENDLESS_CHAT;

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
// dead-ends. Kept concrete (not the old abstract archetypes).
export const FALLBACK_PATHS: SuggestedPath[] = [
  { emoji: "🔍", title: "Get to the bottom of it", blurb: "Chase the one big 'why' behind it until it really clicks." },
  { emoji: "🔗", title: "Find the surprising links", blurb: "See what this secretly connects to in your own world." },
  { emoji: "🛠️", title: "Make something that shows it", blurb: "Build a little explainer or diagram that proves you get it." },
];
