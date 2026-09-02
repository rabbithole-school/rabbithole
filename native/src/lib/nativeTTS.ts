/**
 * Native tap-to-hear engine — the RN counterpart of the web TTSEngine
 * (hooks/useTTSQueue.ts). Speaks a short label through the EXISTING Convex
 * `/tts` HTTP action, the same endpoint the web app uses. No new backend.
 *
 * Why a bespoke fetch→file→play path (vs. pointing a player at the URL):
 * expo-audio's player loads a source URI with GET, but `/tts` is POST-only
 * ({ text } → MP3). So we POST, get the MP3 bytes, base64-write them to a temp
 * file (expo-file-system), and hand the file to expo-audio. The base64 +
 * filename helpers are pure and unit-tested (lib/ttsAudio.ts); the Expo wiring
 * lives here.
 *
 * Contract (mirrors web):
 *  - Module singleton → one utterance app-wide, audio never overlaps.
 *  - `speak()` stops whatever is playing first.
 *  - A module-level owner token lets exactly one SpeakableLabel show the
 *    speaking/loading state (see useNativeSpeaker), not every mounted instance.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import {
  writeAsStringAsync,
  cacheDirectory,
  EncodingType,
} from "expo-file-system/legacy";

import { convexSiteUrl } from "@/lib/convex";
import { bytesToBase64, prepareSpeech, ttsFileName } from "@/lib/ttsAudio";
import { voiceMark } from "@/lib/voicePerf";

export type TTSState = "idle" | "loading" | "speaking" | "paused";

let audioModeReady = false;
async function ensureAudioMode(): Promise<void> {
  if (audioModeReady) return;
  try {
    // iPads have no silent switch to worry about, but this also lets a label
    // speak when the ringer is muted (matching the web read-aloud affordance).
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch {
    // Non-fatal: playback still works with the default session.
  }
  audioModeReady = true;
}

class NativeTTSEngine {
  state: TTSState = "idle";
  /**
   * The raw text of the utterance currently loading/speaking (null when idle).
   * Lets a remounted speaker (e.g. a FlatList row that was virtualized out and
   * back while its audio kept playing) recognize the utterance as its own by
   * text match, so tapping it again stops playback instead of restarting it.
   */
  currentText: string | null = null;

  private player: AudioPlayer | null = null;
  private sub: { remove: () => void } | null = null;
  private generation = 0;
  private listeners = new Set<(s: TTSState) => void>();

  subscribe(fn: (s: TTSState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setState(s: TTSState): void {
    if (this.state === s) return;
    this.state = s;
    this.listeners.forEach((fn) => fn(s));
  }

  private teardownPlayer(): void {
    try {
      this.sub?.remove();
    } catch {
      // subscription already gone
    }
    this.sub = null;
    try {
      this.player?.remove();
    } catch {
      // player already removed
    }
    this.player = null;
  }

  stop(): void {
    this.generation++; // invalidate any in-flight fetch
    this.teardownPlayer();
    this.currentText = null;
    this.setState("idle");
  }

  /**
   * Freeze the current utterance mid-sentence — the tap-to-read pause. Only
   * valid while actually speaking; expo-audio's player pauses in place. The
   * generation token is untouched, so the in-flight audio stays "ours": a
   * later resume() continues it, while any new speak() calls stop() first and
   * supersedes it cleanly.
   */
  pause(): void {
    if (this.state !== "speaking") return;
    try {
      this.player?.pause();
    } catch {
      // player already gone — fall through to the state flip
    }
    this.setState("paused");
  }

  /** Resume a paused utterance from exactly where it froze. */
  resume(): void {
    if (this.state !== "paused") return;
    try {
      this.player?.play();
    } catch {
      // player already gone
    }
    this.setState("speaking");
  }

  async speak(rawText: string): Promise<void> {
    const text = prepareSpeech(rawText);
    if (!text) return;

    this.stop();
    const gen = this.generation;
    this.currentText = rawText;
    this.setState("loading");

    try {
      await ensureAudioMode();

      const res = await fetch(`${convexSiteUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (gen !== this.generation) return; // superseded/stopped while fetching

      if (!cacheDirectory) throw new Error("no cache directory");
      const uri = `${cacheDirectory}${ttsFileName(text)}`;
      await writeAsStringAsync(uri, bytesToBase64(bytes), {
        encoding: EncodingType.Base64,
      });
      if (gen !== this.generation) return;

      const player = createAudioPlayer({ uri });
      this.player = player;
      this.sub = player.addListener("playbackStatusUpdate", (status) => {
        if (status.playing && gen === this.generation) {
          voiceMark("firstAudio");
        }
        if (status.didJustFinish && gen === this.generation) this.stop();
      });
      this.setState("speaking");
      player.play();
    } catch {
      // Swallow: a label that can't speak should fail silently, not crash the
      // screen. Reset so the affordance returns to its resting state.
      if (gen === this.generation) this.stop();
    }
  }
}

let engine: NativeTTSEngine | null = null;
export function getNativeTTS(): NativeTTSEngine {
  if (!engine) engine = new NativeTTSEngine();
  return engine;
}

// ── Per-instance ownership ──────────────────────────────────────────────────
// The engine is shared, so its state is global. Track which SpeakableLabel owns
// the current utterance so only that one shows the speaking/loading affordance.
let ownerToken: symbol | null = null;
const ownerListeners = new Set<() => void>();
function notifyOwner(): void {
  ownerListeners.forEach((fn) => fn());
}
function subscribeOwner(fn: () => void): () => void {
  ownerListeners.add(fn);
  return () => ownerListeners.delete(fn);
}
function claimOwner(token: symbol): void {
  ownerToken = token;
  notifyOwner();
}
function releaseOwner(token: symbol): void {
  if (ownerToken === token) {
    ownerToken = null;
    notifyOwner();
  }
}

/**
 * React view of the engine for a single SpeakableLabel. Returns whether THIS
 * instance is the one speaking/loading, plus a `toggle` that speaks the text
 * (stealing playback from any other label) or stops if it's already speaking.
 */
export function useNativeSpeaker(text: string) {
  const engine = getNativeTTS();
  const [token] = useState(() => Symbol("speakable"));

  const state = useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.state,
    () => "idle" as TTSState,
  );
  const isOwner = useSyncExternalStore(
    subscribeOwner,
    () => ownerToken === token,
    () => false,
  );
  // Text match backstops the owner token: a virtualized-out list row loses its
  // token on unmount while the audio keeps playing, so on remount it must still
  // recognize the utterance as its own — else a re-tap would restart the audio
  // instead of stopping it. (Two mounted speakers with identical text both
  // light up and either stops — harmless.)
  const isCurrent = useSyncExternalStore(
    (fn) => engine.subscribe(() => fn()),
    () => text !== "" && engine.currentText === text,
    () => false,
  );

  // Release ownership when the engine drains.
  useEffect(() => {
    if (state === "idle") releaseOwner(token);
  }, [state, token]);

  // Release on unmount so a stale token can't keep the affordance lit.
  useEffect(() => () => releaseOwner(token), [token]);

  const mine = isOwner || isCurrent;
  const speaking = mine && state === "speaking";
  const loading = mine && state === "loading";
  const paused = mine && state === "paused";

  const toggle = useCallback(() => {
    // Cancel a still-loading utterance (nothing to pause yet).
    if (mine && state === "loading") {
      engine.stop();
      releaseOwner(token);
      return;
    }
    // Tapping the active speaker toggles pause/resume; ownership is retained
    // (the engine stays non-idle), so this label stays lit. Starting any OTHER
    // utterance stops this one via speak()→stop().
    if (mine && state === "speaking") {
      engine.pause();
      return;
    }
    if (mine && state === "paused") {
      engine.resume();
      return;
    }
    claimOwner(token); // steal from any other label; serialize audio
    void engine.speak(text);
  }, [engine, mine, state, text, token]);

  return { speaking, loading, paused, toggle };
}
