"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Whether this tab is on screen (`document.visibilityState === "visible"`).
 * For state that must reflect a person actually LOOKING — e.g. marking a
 * conversation read — rather than a background tab receiving a message.
 * Server render assumes hidden, so nothing is claimed before hydration.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState === "visible",
    () => false,
  );
}
