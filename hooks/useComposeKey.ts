"use client";

// ⌘/ on web: focus the composer of the AI chat on screen. The web twin of the
// iPad's compose key (native/src/lib/voiceKey.ts): each chat surface registers
// what ⌘/ does while it is mounted, and one window listener hands the key to
// the most recently registered surface. The key is consumed (preventDefault),
// so it never types a "/" into a focused field.
import { useEffect, useRef } from "react";

type Entry = { read: () => () => void };

const entries: Entry[] = [];

/** ⌘/ with no other modifier (Ctrl+/ is left to the browser and the OS). */
export function isComposeChord(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    event.key === "/" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Run the newest surface's compose action. False when none is registered. */
export function pressComposeKey(): boolean {
  const entry = entries[entries.length - 1];
  if (!entry) return false;
  entry.read()();
  return true;
}

function onKeyDown(event: KeyboardEvent) {
  if (!isComposeChord(event) || entries.length === 0) return;
  event.preventDefault();
  if (!event.repeat) pressComposeKey();
}

export function registerComposeTarget(read: () => () => void): () => void {
  const entry: Entry = { read };
  if (entries.length === 0) {
    window.addEventListener("keydown", onKeyDown, true);
  }
  entries.push(entry);
  return () => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (entries.length === 0) {
      window.removeEventListener("keydown", onKeyDown, true);
    }
  };
}

/**
 * Make ⌘/ run `compose` while this surface is mounted and `enabled`. The
 * latest `compose` is read at press time, so it is never a stale render's.
 */
export function useComposeKeyTarget(compose: () => void, enabled = true) {
  const composeRef = useRef(compose);
  useEffect(() => {
    composeRef.current = compose;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerComposeTarget(() => composeRef.current);
  }, [enabled]);
}
