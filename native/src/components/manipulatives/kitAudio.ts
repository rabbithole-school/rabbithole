/**
 * The manipulatives' AUDIO tick engine — the felt-feedback substitute for
 * haptics on the iPad. No iPad has a Taptic engine, so every expo-haptics call
 * in kit.tsx is a silent hardware no-op there (documented in kit.tsx). This
 * plays tiny, quiet UI ticks through the SAME kit helpers so a felt-ish cue
 * fires everywhere a haptic would.
 *
 * Design:
 *   • expo-audio is ALREADY a dependency + linked native module (voice dictation
 *     / TTS use it), so this adds only JS + four small WAV assets — no new
 *     native module. The sounds are synthesized by scripts/gen-manip-sfx.mjs.
 *   • Each sound preloads a tiny ROUND-ROBIN POOL of players once (lazily, on
 *     first play). A play seeks the next player to 0 and replays it, so a fast
 *     drag never waits on a seek/cutoff and never stutters. Call frequency is
 *     already gated upstream (kit.tsx's snapTick 45 ms rate-limit).
 *   • SILENT-SWITCH BEHAVIOUR: the engine sets the app audio session to
 *     `playsInSilentMode: false` (the AMBIENT category) on init, so the iOS
 *     mute state SILENCES these ticks — a classroom can mute them (the Ring/
 *     Silent switch where a device has one; Control Center mute on iPad, which
 *     has no physical switch). (Contrast: `playsInSilentMode: true` would force
 *     playback even when muted.) NOTE: AVAudioSession is app-global; nativeTTS
 *     deliberately sets `true` for read-aloud, so whichever ran most recently
 *     wins the shared session. In practice ticks and read-aloud aren't used at
 *     the same instant, and on first manipulative interaction the ticks assert
 *     the mute-respecting mode.
 *   • Every entry point is FIRE-AND-FORGET and never throws: a missing native
 *     module or any init/playback failure is a silent no-op (matching the
 *     haptics contract in kit.tsx). The master ON/OFF switch lives in kit.tsx
 *     (MANIP_AUDIO_ENABLED) — callers guard on it, so this module stays flag-
 *     agnostic and there's no circular import.
 */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";

// require() (not import) so a missing/renamed asset can't break the TS build,
// matching the repo's asset convention (see AppLauncher.tsx / dev-hdr-stars.tsx).
const TICK = require("@/assets/sfx/tick.wav");
const THOCK = require("@/assets/sfx/thock.wav");
const SUCCESS = require("@/assets/sfx/success.wav");
const TRY_AGAIN = require("@/assets/sfx/try-again.wav");

/** Small pool size — enough that back-to-back retriggers never cut each other. */
const POOL_SIZE = 2;

let audioModeReady = false;
function ensureAudioMode(): void {
  if (audioModeReady) return;
  audioModeReady = true;
  try {
    // false → AMBIENT category → the iOS mute state silences the ticks, so a
    // classroom can turn them off (mute switch where present; Control Center
    // mute on iPad). Fire-and-forget.
    const p = setAudioModeAsync({ playsInSilentMode: false });
    if (p && typeof (p as Promise<unknown>).catch === "function") {
      (p as Promise<unknown>).catch(() => {});
    }
  } catch {
    /* no native audio module — the pooled players below will also no-op */
  }
}

/**
 * A preloaded, round-robin pool of players for one short sound. Preloads on
 * first play so module import never touches the native module (keeps tests /
 * non-native contexts safe). Replays from the start each time.
 */
class PooledSound {
  private players: AudioPlayer[] = [];
  private idx = 0;
  private loaded = false;

  constructor(
    private readonly source: number,
    private readonly volume: number,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true; // set first: a throw shouldn't retry-thrash every tick
    ensureAudioMode();
    for (let i = 0; i < POOL_SIZE; i++) {
      const player = createAudioPlayer(this.source);
      player.volume = this.volume;
      this.players.push(player);
    }
  }

  play(): void {
    try {
      this.load();
      if (this.players.length === 0) return;
      const player = this.players[this.idx];
      this.idx = (this.idx + 1) % this.players.length;
      // seekTo returns a promise; fire-and-forget, then replay from the start.
      const seek = player.seekTo(0);
      if (seek && typeof (seek as Promise<unknown>).catch === "function") {
        (seek as Promise<unknown>).catch(() => {});
      }
      player.play();
    } catch {
      /* missing native module / playback error — silent no-op */
    }
  }
}

// Volumes are kept modest on top of the already-quiet synthesized assets, so
// the whole set stays subtle. Grab reuses the snap TICK asset, a touch louder.
const snap = new PooledSound(TICK, 0.6);
const grab = new PooledSound(TICK, 0.85);
const placed = new PooledSound(THOCK, 0.7);
const successChime = new PooledSound(SUCCESS, 0.6);
const tryAgainChime = new PooledSound(TRY_AGAIN, 0.6);

/** Snap-crossing tick — paired with kit's `selectionTick()`. */
export function playSnapTick(): void {
  snap.play();
}

/** Slightly stronger tick for a handle grab — paired with `mediumImpact()`. */
export function playGrabTick(): void {
  grab.play();
}

/** The rounded "landed / committed" thock — paired with `lightImpact()`. */
export function playPlacedThock(): void {
  placed.play();
}

/** Soft success chime — paired with `successNotify()`. */
export function playSuccess(): void {
  successChime.play();
}

/** Gentle "try again" — paired with `warningNotify()`. */
export function playTryAgain(): void {
  tryAgainChime.play();
}
