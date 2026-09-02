/**
 * Tiny external-store for the native manipulative practice-item host — the
 * launch seam any native surface that serves a practice item can call. It
 * mirrors `externalAppHost.ts` (the keep-alive WebView host store): a single
 * open request lives here, `NativeManipulativeHost` (mounted once at the app
 * root) renders it, and the item card decides inline-native vs. WebView-embed
 * fallback per the served spec's kind.
 *
 * There is no native practice-playlist surface yet (the homegrown practice
 * engine — `api.practiceSkills.practiceSession` / components/practice — is
 * web-only today), so `openNativeManipulativeItem` is the ready integration
 * point: a future native practice surface hands it a served `{ itemId,
 * scholarId }` and gets the full inline-or-fallback experience.
 */
import { useSyncExternalStore } from "react";

import type { Id } from "@/lib/convex";

export type NativeManipulativeRequest = {
  /** A served practice-item id, e.g. `gen#<practiceItems _id>`. */
  itemId: string;
  /** The scholar being graded (usually the signed-in user). */
  scholarId: Id<"users">;
};

let current: NativeManipulativeRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Open a served manipulative practice item in the root host. */
export function openNativeManipulativeItem(request: NativeManipulativeRequest) {
  current = request;
  emit();
}

/** Dismiss the current manipulative practice item, if any. */
export function closeNativeManipulativeItem() {
  current = null;
  emit();
}

export function useNativeManipulativeRequest(): NativeManipulativeRequest | null {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => current,
    () => current,
  );
}
