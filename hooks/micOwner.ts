"use client";

import { useSyncExternalStore } from "react";

// ── Single-owner microphone across all dictation instances ──────────────
// Browsers grant two concurrent getUserMedia streams, so the chat composer
// (useStreamingDictation, WebRTC) and the writing-box / handoff mics
// (useVoiceDictation) could otherwise record at once. One module-level owner
// token — claimed once a recording actually starts, released on every end
// path — makes the mic single-owner across every mounted instance. (The
// native app solves the same problem with a shared registry in
// native/src/lib/appStatusBus.ts.)
let micOwner: symbol | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribeMicOwner(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Claim the mic for `owner`. Returns false if a DIFFERENT token holds it. */
export function claimMic(owner: symbol): boolean {
  if (micOwner && micOwner !== owner) return false;
  if (micOwner === owner) return true;
  micOwner = owner;
  emit();
  return true;
}

/** Release the mic if (and only if) `owner` currently holds it. Idempotent. */
export function releaseMic(owner: symbol): void {
  if (micOwner !== owner) return;
  micOwner = null;
  emit();
}

/** True only when a token OTHER than `ownToken` holds the mic — lets a paired
 *  control disable itself while another recorder is live. */
export function useIsMicBusy(ownToken: symbol): boolean {
  return useSyncExternalStore(
    subscribeMicOwner,
    () => micOwner !== null && micOwner !== ownToken,
    () => false,
  );
}
