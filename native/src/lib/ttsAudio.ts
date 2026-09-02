/**
 * Pure helpers for the native tap-to-hear path — no React, no Expo, no network.
 * Unit-tested in __tests__/ttsAudio.test.ts.
 *
 * Why base64 at all: expo-audio's player fetches a source URI with GET, but the
 * Convex `/tts` action is POST-only ({ text } → MP3). So the native
 * SpeakableLabel POSTs, gets the MP3 bytes, and writes them to a temp file for
 * the player to read — which means turning an ArrayBuffer into a base64 string
 * (expo-file-system's Base64 write encoding). Both of these are the pure,
 * testable seams; the Expo playback wiring lives in nativeTTS.ts.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Standard base64-encode a byte array. Self-contained (no `btoa`/`Buffer`,
 * neither of which Hermes guarantees) so it works identically in RN and in the
 * node/vitest test environment.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? B64[b2 & 0x3f] : "=";
  }
  return out;
}

/**
 * Deterministic short hash (djb2) → hex. Used to name the temp MP3 file per
 * utterance so repeated taps of the same label reuse the cached audio ("say it
 * again" is instant) instead of re-hitting the TTS action.
 */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33) ^ text.charCodeAt(i);
  }
  // >>> 0 → unsigned 32-bit; pad so the name is stable-length.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Cache filename for a given utterance's audio. */
export function ttsFileName(text: string): string {
  return `rh-tts-${hashText(text)}.mp3`;
}

/**
 * The `/tts` action rejects empty text and caps at 4096 chars. Labels are
 * short, but clamp defensively (and collapse whitespace so the file-cache key is
 * stable for visually-identical labels). Returns "" when there's nothing to say.
 */
export function prepareSpeech(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 4096 ? clean.slice(0, 4096) : clean;
}
