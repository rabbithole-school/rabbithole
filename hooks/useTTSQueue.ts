"use client";

import { useEffect, useState } from "react";
import {
  SentenceAccumulator,
  stripMarkdownForSpeech,
} from "@/lib/sentenceStream";
import { voiceMark } from "@/lib/voicePerf";
import { convexSiteUrl } from "@/lib/convexUrls";

/**
 * Sentence-queue TTS engine on Web Audio.
 *
 * Replaces the MediaSource streaming path (hooks/useTTS.ts): each sentence
 * is fetched from the Convex /tts action as a small MP3, decoded with
 * AudioContext, and played strictly in order with a fetch lookahead. Why:
 *
 *  - Latency: in voice mode the first sentence of a streaming reply starts
 *    speaking while the rest is still being generated — latency-to-first-
 *    audio is one short TTS call, not the full response.
 *  - Compatibility: no MediaSource dependency, so it works in WKWebView
 *    (the iPad shell) and every desktop browser alike.
 *
 * Module-level singleton: one voice at a time across the whole app, same
 * contract the old engine had.
 */

type EngineState = "idle" | "speaking" | "paused";

const FETCH_LOOKAHEAD = 2;

interface QueueItem {
  text: string;
  buffer?: Promise<AudioBuffer | null>;
}

// Exported for unit tests (lib/__tests__/ttsEngine.test.ts overrides the
// fetch/play seams); app code goes through getTTSEngine()/useTTSQueue.
export class TTSEngine {
  state: EngineState = "idle";
  /** Fires when the queue drains naturally (not via stop()). */
  onIdle: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private queue: QueueItem[] = [];
  private current: AudioBufferSourceNode | null = null;
  private playing = false;
  private generation = 0;
  private stopped = false;
  private paused = false;
  private listeners = new Set<(s: EngineState) => void>();

  subscribe(fn: (s: EngineState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Call from a user gesture (e.g. the voice-mode toggle) so iOS lets the
   * AudioContext start. Safe to call repeatedly.
   */
  unlock(): void {
    if (this.paused) return;
    const ctx = this.ensureCtx();
    if (ctx && ctx.state === "suspended") void ctx.resume();
  }

  /**
   * Soft two-note rising blip — the eyes-free "your turn to talk" cue when
   * voice mode opens the mic. Synthesized (no asset) on the same
   * AudioContext the speech uses.
   */
  playListeningCue(): void {
    // This is an immediate turn-taking signal; replaying it after resume would
    // be stale, so drop it while speech has the shared context paused.
    if (this.paused) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [freq, start] of [
      [660, 0],
      [880, 0.09],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(0.08, t0 + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + start + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + 0.14);
    }
  }

  /** Queue one sentence (already markdown-stripped). */
  enqueue(sentence: string): void {
    const text = sentence.trim();
    if (!text) return;
    this.stopped = false;
    this.queue.push({ text });
    this.pumpFetch();
    void this.pumpPlay();
  }

  /** Manual read-aloud: replace whatever is playing with this full text. */
  speak(fullText: string): void {
    this.stop();
    const acc = new SentenceAccumulator();
    const sentences = acc.push(stripMarkdownForSpeech(fullText) + " ");
    const rest = acc.flush();
    if (rest) sentences.push(rest);
    for (const s of sentences) this.enqueue(s);
  }

  stop(): void {
    this.generation++;
    this.stopped = true;
    this.paused = false;
    this.queue = [];
    try {
      this.current?.stop();
    } catch {
      // already stopped
    }
    this.current = null;
    // If we were paused the context is suspended; resume it so a stopped
    // source's `onended` can fire and the parked pump loop unwinds (else
    // `playing` would stay true and block the next speak()).
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
    this.setState("idle");
  }

  /**
   * Freeze the tutor's voice mid-sentence — the tap-to-read pause. Only valid
   * while actually speaking. Suspends the AudioContext (instant + clean for a
   * BufferSource, which can't be paused natively); the pump loop parks on the
   * current source's `onended`, which can't fire while suspended, so the queue
   * never drains and `onIdle` never fires (the voice-mode auto-listen contract).
   */
  pause(): void {
    if (this.state !== "speaking") return;
    this.paused = true;
    if (this.ctx && this.ctx.state === "running") void this.ctx.suspend();
    this.setState("paused");
  }

  /** Resume a paused utterance from exactly where it froze. */
  resume(): void {
    if (this.state !== "paused") return;
    this.paused = false;
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
    this.setState("speaking");
  }

  private setState(s: EngineState): void {
    if (this.state === s) return;
    this.state = s;
    this.listeners.forEach((fn) => fn(s));
  }

  private ensureCtx(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    return this.ctx;
  }

  /** Start fetches for the first few unfetched items (strict play order). */
  protected pumpFetch(): void {
    for (const item of this.queue.slice(0, FETCH_LOOKAHEAD)) {
      if (!item.buffer) item.buffer = this.fetchBuffer(item.text);
    }
  }

  protected async fetchBuffer(text: string): Promise<AudioBuffer | null> {
    try {
      const convexUrl = convexSiteUrl();
      const res = await fetch(`${convexUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return null;
      const bytes = await res.arrayBuffer();
      const ctx = this.ensureCtx();
      if (!ctx) return null;
      return await ctx.decodeAudioData(bytes);
    } catch {
      return null; // skip the sentence rather than kill the whole reply
    }
  }

  private async pumpPlay(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length > 0) {
        const gen = this.generation;
        const item = this.queue[0];
        this.pumpFetch();
        if (!this.paused) this.setState("speaking");
        const buffer = await (item.buffer ??
          (item.buffer = this.fetchBuffer(item.text)));
        if (gen !== this.generation) continue; // stopped — queue already cleared
        this.queue.shift();
        if (buffer) {
          await this.playBuffer(buffer);
        }
      }
    } finally {
      this.playing = false;
      this.setState("idle");
      if (!this.stopped) this.onIdle?.();
    }
  }

  protected playBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const ctx = this.ensureCtx();
      if (!ctx) return resolve();
      if (ctx.state === "suspended" && !this.paused) void ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      voiceMark("firstAudio"); // no-op unless a voice-perf cycle is armed
      src.start();
    });
  }
}

const engine = typeof window === "undefined" ? null : new TTSEngine();

/** The app-wide TTS engine (null during SSR). */
export function getTTSEngine(): TTSEngine | null {
  return engine;
}

/**
 * React view of the engine for buttons that need speak/stop + a state dot.
 * Multiple components can use this; they all reflect the one engine.
 */
export function useTTSQueue() {
  const [state, setState] = useState<EngineState>(engine?.state ?? "idle");
  useEffect(() => engine?.subscribe(setState), []);
  return {
    state,
    speak: (text: string) => engine?.speak(text),
    stop: () => engine?.stop(),
    pause: () => engine?.pause(),
    resume: () => engine?.resume(),
    toggle: (text: string) => {
      if (!engine) return;
      if (engine.state === "idle") engine.speak(text);
      else engine.stop();
    },
  };
}
