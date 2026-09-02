"use client";

/**
 * Small platform-capability seam for the web app.
 *
 * Historically this bridged the web app to a Capacitor iPad shell; that shell
 * has been retired (the iPad app is now the Expo React Native app under
 * `native/`, which has its own native implementations and embeds web content
 * via react-native-webview, signalling the host through
 * `window.ReactNativeWebView`). What remains here are pure-web helpers so the
 * rest of the app can stay agnostic: haptics/keep-awake/output-volume degrade
 * to no-ops in a browser, and `openExternal` opens a new tab.
 */

import { useEffect, useState } from "react";

/**
 * Best-effort "is this an iPad?" check, true for iPad Safari/Chrome on the open
 * web. Used to label the passkey sign-in button "Touch ID" — "passkey" is
 * inscrutable to a lot of students, and the school's iPads use Touch ID.
 *
 * iPadOS 13+ browsers report a desktop ("Macintosh") user agent, so we treat a
 * touch-capable Mac as an iPad — a real Mac reports maxTouchPoints 0. We don't
 * try to tell Face ID iPad Pros apart (rare in the cohort; saying "Touch ID"
 * there is an accepted trade-off).
 */
export function isIPad(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return true;
  return navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
}

/**
 * Hydration-safe isIPad(). SSR and the first client render return false (so
 * they agree), then the real answer arrives after mount.
 */
export function useIsIPad(): boolean {
  const [iPad, setIPad] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check, deferred past SSR to avoid a hydration mismatch
    setIPad(isIPad());
  }, []);
  return iPad;
}

/**
 * Chrome for a full-bleed DARK screen (sign-in, share-back): the safe-area
 * inset strips are recolored to the screen's dark color so no light bar sits
 * above it. Restores the light-app default on unmount.
 *
 * Net no-op in a regular desktop browser: the safe-area strips are 0px there,
 * so --rh-shell-bg is never visible.
 *
 * Single-occupancy: --rh-shell-bg is one global property, so don't mount two
 * of these at once (sign-in vs. share-back are different app states — fine).
 */
export function useDarkShellChrome(bg = "#222656"): void {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--rh-shell-bg", bg);
    return () => {
      root.style.removeProperty("--rh-shell-bg");
    };
  }, [bg]);
}

/**
 * Hold/release the screen-sleep lock. No-op on the web — retained as a stable
 * seam so callers (e.g. voice mode) don't need to branch on platform.
 */
export function keepAwake(_on: boolean): void {
  // No native keep-awake capability on the web.
}

// ── Native audio state ──────────────────────────────────────────────────────

/**
 * iOS system output volume, 0..1. Always null on the web (no capability to
 * read the hardware output volume from a browser).
 */
export async function getOutputVolume(): Promise<number | null> {
  return null;
}

/**
 * Best-effort mute check. Always false on the web — kept as a stable seam for
 * callers that want to avoid speaking into a muted device on other surfaces.
 */
export async function isLikelyMuted(_threshold = 0.01): Promise<boolean> {
  return false;
}

/**
 * Haptic vocabulary. No-op on the web — kept as a stable, well-named seam so
 * interaction code can express intent ("light"/"success"/…) without branching.
 *
 * Fire-and-forget by design — never await it on an interaction path.
 */
export type HapticKind = "light" | "medium" | "success" | "warning" | "selection";

export function haptic(_kind: HapticKind): void {
  // No haptics capability on the web.
}

/**
 * Open a URL in a new tab (with noopener/noreferrer).
 */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
