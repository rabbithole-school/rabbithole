/**
 * Tiny external store for the native GAME host — the launch seam any native
 * surface that can open a `kind="game"` activity calls. Mirrors
 * `nativeManipulativeHost.ts` and `externalAppHost.ts` exactly: one open
 * request lives here, `GameHost` (mounted once at the app root) renders it.
 *
 * Deliberately dumb. It holds a request, not a session — the session lives on
 * the server and the host owns its lifecycle. Keeping the store this thin is
 * what lets a launch site be a one-line call from a row handler with no
 * knowledge of games at all.
 */
import { useSyncExternalStore } from "react";

import type { Id } from "@/lib/convex";

export type GameRequest = {
  /** The `kind="game"` activity being opened. */
  activityId: Id<"activities">;
  /** Stamped onto the session so cohort-scoped review works. */
  assignmentId?: Id<"assignments">;
  /** Shown in the host chrome while the module loads. */
  activityTitle?: string | null;
};

let current: GameRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Open a game activity in the root host. */
export function openGameActivity(request: GameRequest) {
  current = request;
  emit();
}

/** Dismiss the current game, if any. */
export function closeGame() {
  current = null;
  emit();
}

export function useGameRequest(): GameRequest | null {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => current,
    () => current,
  );
}
