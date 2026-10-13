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
import { spokenWordInText } from "../../vendor/shared/beginnerReading";

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

/** The player's status interval: often enough for a word highlight. */
const PLAYBACK_UPDATE_MS = 50;

/** The utterance playing now and the player's clock, in seconds. */
export type PlaybackPosition = {
  text: string;
  currentTime: number;
  duration: number;
};

/** How many queued sentences fetch ahead of the one playing (web parity). */
const FETCH_LOOKAHEAD = 2;

/**
 * Who queued a piece of speech. Pre-reader voice mode may only reopen the mic
 * after audio IT spoke (`voice`), never after a tap-to-hear label (`label`) —
 * the engine is an app-wide singleton, so ownership has to travel with the
 * audio itself rather than live in a caller's flag (TRA-492 review).
 */
export type SpeechSource = "voice" | "label";

type QueueItem = {
  source: SpeechSource;
  /** Speech-prepared text sent to `/tts`. */
  text: string;
  /** The caller's raw text — what `currentText` reports while this plays. */
  display: string;
  /** The MP3 written to the cache dir, or null if it couldn't be fetched. */
  file?: Promise<string | null>;
};

class NativeTTSEngine {
  state: TTSState = "idle";
  /**
   * The raw text of the utterance currently loading/speaking (null when idle).
   * Lets a remounted speaker (e.g. a FlatList row that was virtualized out and
   * back while its audio kept playing) recognize the utterance as its own by
   * text match, so tapping it again stops playback instead of restarting it.
   */
  currentText: string | null = null;
  /**
   * Fires when playback drains NATURALLY — the last queued sentence finished
   * (or failed to fetch). Never fires after stop(). Pre-reader voice mode hangs
   * its hands-free "reopen the mic" step here, the same contract as web's
   * TTSEngine.onIdle (hooks/useTTSQueue.ts). Reports the SOURCE of the item
   * that drained, so a listener can tell its own audio from someone else's.
   */
  onIdle: ((drained: SpeechSource | null) => void) | null = null;
  /**
   * Source of the last NATURAL drain; null after stop() or while anything is
   * queued/playing. Lets a caller that missed the onIdle (it fired while the
   * reply was still streaming) ask afterwards whose audio finished.
   */
  lastDrainedSource: SpeechSource | null = null;
  /**
   * Where the utterance playing now is: its raw text and the player's clock.
   * Beginner-reader mode (TRA-504) lights the word being said from this — the
   * `/tts` voice returns no word timings, so the word is estimated from the
   * clock (shared/beginnerReading `spokenWordInMessage`). Null when idle or
   * before playback starts. Subscribe with `subscribePlayback`.
   */
  playback: PlaybackPosition | null = null;

  private player: AudioPlayer | null = null;
  private sub: { remove: () => void } | null = null;
  private generation = 0;
  private queue: QueueItem[] = [];
  /** The item loading/playing now (null when idle). */
  private current: QueueItem | null = null;
  /** A queue item is loading or playing (so enqueue() must not start another). */
  private active = false;
  private listeners = new Set<(s: TTSState) => void>();
  private playbackListeners = new Set<() => void>();

  subscribePlayback(fn: () => void): () => void {
    this.playbackListeners.add(fn);
    return () => this.playbackListeners.delete(fn);
  }

  private setPlayback(p: PlaybackPosition | null): void {
    if (p === null && this.playback === null) return;
    this.playback = p;
    this.playbackListeners.forEach((fn) => fn());
  }

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
    this.setPlayback(null);
  }

  stop(): void {
    this.finishWord(false);
    this.generation++; // invalidate any in-flight fetch / queued playback
    this.queue = [];
    this.active = false;
    this.current = null;
    this.lastDrainedSource = null;
    this.teardownPlayer();
    this.currentText = null;
    this.setState("idle");
  }

  /**
   * Drop everything ONE source queued — playing or waiting — and leave the
   * rest. A new tutor reply cancels the old reply's voice this way without
   * cutting off a tap-to-hear label someone else started. Never fires onIdle.
   */
  cancelSource(source: SpeechSource): void {
    this.queue = this.queue.filter((item) => item.source !== source);
    if (this.current?.source !== source) return;
    if (this.queue.length === 0) {
      this.stop();
      return;
    }
    this.generation++;
    void this.playNext(this.generation);
  }

  /**
   * Freeze the current utterance mid-sentence — the tap-to-read pause. Only
   * valid while actually speaking; expo-audio's player pauses in place. The
   * generation token is untouched, so the in-flight audio stays "ours": a
   * later resume() continues it, while any new speak() calls stop() first and
   * supersedes it cleanly. A paused player never reports didJustFinish, so a
   * queued reply parks here and onIdle can't fire (web parity).
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

  /**
   * Manual read-aloud: replace whatever is playing with this text. Resolves
   * once playback has started (or failed).
   */
  async speak(rawText: string): Promise<void> {
    const text = prepareSpeech(rawText);
    if (!text) return;
    this.stop();
    this.queue.push({ text, display: rawText, source: "label" });
    await this.playNext(this.generation);
  }

  /**
   * Queue one sentence behind whatever is playing — the streamed voice-mode
   * path (a tutor reply is spoken sentence by sentence as it arrives). The
   * next sentences fetch ahead while the current one plays, so the gap
   * between sentences is playback-to-playback, not a fresh `/tts` round trip.
   */
  enqueue(sentence: string, source: SpeechSource = "voice"): void {
    const text = prepareSpeech(sentence);
    if (!text) return;
    this.lastDrainedSource = null;
    this.queue.push({ text, display: sentence, source });
    this.prefetch();
    if (!this.active) void this.playNext(this.generation);
  }

  /**
   * The eyes-free "your turn to talk" blip voice mode plays as the mic
   * reopens (web: TTSEngine.playListeningCue). A pre-reader can't read the
   * recording bar, so the mic opening must be audible. Fire-and-forget.
   */
  playListeningCue(): void {
    try {
      if (!cuePlayer) {
        // Lazy require keeps the asset out of node-only unit tests.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cuePlayer = createAudioPlayer(require("@/assets/sfx/listen.wav"));
      }
      void cuePlayer.seekTo(0);
      cuePlayer.play();
    } catch {
      // A missing cue never blocks listening.
    }
  }

  private prefetch(): void {
    for (const item of this.queue.slice(0, FETCH_LOOKAHEAD)) {
      if (!item.file) item.file = this.loadFile(item.text);
    }
  }

  private async loadFile(text: string): Promise<string | null> {
    try {
      await ensureAudioMode();
      const res = await fetch(`${convexSiteUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!cacheDirectory) throw new Error("no cache directory");
      const uri = `${cacheDirectory}${ttsFileName(text)}`;
      await writeAsStringAsync(uri, bytesToBase64(bytes), {
        encoding: EncodingType.Base64,
      });
      return uri;
    } catch {
      // Skip the sentence rather than kill the whole reply (web parity).
      return null;
    }
  }

  /**
   * Play the head of the queue; when it finishes, recurse. An empty queue is
   * a NATURAL drain → idle + onIdle. Every await re-checks the generation so a
   * stop()/speak() mid-flight unwinds silently.
   */
  /** A tapped word is playing in a gap in the queue (see `interject`). */
  private interjecting = false;
  /** A queued item became ready while a word played; start it after. */
  private resumeAfterWord = false;
  private wordPlayer: AudioPlayer | null = null;
  /** Bumped per tapped word, so a slow fetch can't play after a newer tap. */
  private wordGen = 0;

  /**
   * Play one short text (a tapped word, TRA-504) WITHOUT losing the queue: if
   * a reply is being read, it pauses at that point, the word plays, and the
   * reply carries on from where it stopped. Idle, it's an ordinary `speak`.
   * While the word plays, `playback` reports the word, so its bubble can light
   * it.
   */
  async interject(rawText: string): Promise<void> {
    const text = prepareSpeech(rawText);
    if (!text) return;
    if (this.state === "idle") return this.speak(rawText);
    const wasSpeaking = this.state === "speaking";
    if (wasSpeaking) {
      try {
        this.player?.pause();
      } catch {
        // player already gone
      }
    }
    // A word tapped during another word replaces it.
    const keepResume = this.resumeAfterWord;
    this.finishWord(false);
    const myGen = ++this.wordGen;
    this.interjecting = true;
    this.resumeAfterWord = wasSpeaking || keepResume;
    const uri = await this.loadFile(text);
    if (myGen !== this.wordGen || !this.interjecting) return; // superseded
    if (!uri) {
      this.finishWord(true);
      return;
    }
    try {
      const word = createAudioPlayer({ uri }, { updateInterval: PLAYBACK_UPDATE_MS });
      this.wordPlayer = word;
      word.addListener("playbackStatusUpdate", (status) => {
        if (this.wordPlayer !== word || myGen !== this.wordGen) return;
        if (status.isLoaded && status.duration > 0) {
          this.setPlayback({
            text: rawText,
            currentTime: status.currentTime,
            duration: status.duration,
          });
        }
        if (status.didJustFinish) this.finishWord(true);
      });
      word.play();
    } catch {
      this.finishWord(true);
    }
  }

  /** End a tapped word; with `resume`, carry the reply on where it paused. */
  private finishWord(resume: boolean): void {
    if (!this.interjecting) return;
    this.interjecting = false;
    try {
      this.wordPlayer?.remove();
    } catch {
      // already gone
    }
    this.wordPlayer = null;
    if (resume && this.resumeAfterWord && this.player && this.state !== "paused") {
      try {
        this.player.play();
      } catch {
        // player already gone
      }
    }
    this.resumeAfterWord = false;
  }

  private async playNext(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    this.teardownPlayer();
    const item = this.queue.shift();
    if (!item) {
      const drained = this.current?.source ?? null;
      this.active = false;
      this.current = null;
      this.currentText = null;
      this.lastDrainedSource = drained;
      this.setState("idle");
      this.onIdle?.(drained);
      return;
    }
    this.active = true;
    this.current = item;
    this.currentText = item.display;
    // Between streamed sentences stay "speaking" — no loading flicker.
    if (this.state !== "speaking") this.setState("loading");
    if (!item.file) item.file = this.loadFile(item.text);
    this.prefetch();
    const uri = await item.file;
    if (gen !== this.generation) return; // superseded/stopped while fetching
    if (!uri) {
      await this.playNext(gen);
      return;
    }
    try {
      // Frequent status updates so a highlighted word keeps pace with speech.
      const player = createAudioPlayer({ uri }, { updateInterval: PLAYBACK_UPDATE_MS });
      this.player = player;
      this.sub = player.addListener("playbackStatusUpdate", (status) => {
        if (gen !== this.generation || this.player !== player) return;
        if (status.playing) voiceMark("firstAudio");
        // While a tapped word plays, the paused reply doesn't own `playback`.
        if (status.isLoaded && status.duration > 0 && !this.interjecting) {
          this.setPlayback({
            text: item.display,
            currentTime: status.currentTime,
            duration: status.duration,
          });
        }
        if (status.didJustFinish) void this.playNext(gen);
      });
      this.setState("speaking");
      // A tapped word is playing: hold this sentence until it's done.
      if (this.interjecting) this.resumeAfterWord = true;
      else player.play();
    } catch {
      // A player that can't start fails silently, not by crashing the screen.
      if (gen === this.generation) this.stop();
    }
  }
}

let cuePlayer: AudioPlayer | null = null;

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
 * Speak a text no SpeakableLabel/SpeakableBubble owns — a beginner's tapped
 * word (TRA-504). Drops any label's ownership first, so the bubble the word
 * sits in doesn't show its own loading/speaking state for the word.
 */
export function speakUnowned(text: string): Promise<void> {
  if (ownerToken) {
    ownerToken = null;
    notifyOwner();
  }
  return getNativeTTS().interject(text);
}

/**
 * Which word of `shown` the voice is saying right now (an index into
 * `wordTokens(shown)`), or null — the read-along highlight for text whose
 * spoken form differs from what's on screen, like a practice question read
 * through `stemToSpeech` (TRA-514). Same playback clock as the tutor reply's
 * highlight (BeginnerReplyText); re-renders only when the lit word changes.
 * An empty `shown` turns it off.
 */
export function useSpokenWordIn(shown: string): number | null {
  const engine = getNativeTTS();
  const get = useCallback((): number => {
    const pb = engine.playback;
    if (!shown || !pb) return -1;
    return spokenWordInText(shown, pb.text, pb.currentTime, pb.duration) ?? -1;
  }, [engine, shown]);
  const lit = useSyncExternalStore(
    (fn) => engine.subscribePlayback(fn),
    get,
    () => -1,
  );
  return lit < 0 ? null : lit;
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

  /** Speak the text from the top, whatever is playing — an auto-read
   *  (a listener's practice question, TRA-514). */
  const play = useCallback(() => {
    if (!text) return;
    claimOwner(token);
    void engine.speak(text);
  }, [engine, text, token]);

  /** Stop this label's speech, if it is still this label's (an auto-read
   *  whose question was answered, or that unmounted). */
  const stopIfMine = useCallback(() => {
    // Owner token only (no text match): a next question with the same words
    // has claimed the voice by now and must keep it.
    if (ownerToken !== token) return;
    engine.stop();
    releaseOwner(token);
  }, [engine, token]);

  return { speaking, loading, paused, toggle, play, stopIfMine };
}
