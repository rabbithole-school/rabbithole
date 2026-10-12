/**
 * The pure gate for pre-reader voice mode's hands-free step: after the tutor's
 * spoken reply drains, may the mic reopen on its own? Kept free of React and
 * Expo so the rule is unit-testable (see __tests__/voiceLoop.test.ts); the
 * wiring lives in hooks/usePreReaderVoice.ts.
 *
 * Mirrors web's `maybeAutoListen` (components/SessionInterface.tsx), plus one
 * native-only guard: the drained audio must be the voice loop's OWN. The native
 * TTS engine is an app-wide singleton shared with tap-to-hear labels, so the
 * engine tags every queued item with its source and reports which one drained
 * (`SpeechSource` in lib/nativeTTS.ts). A label read-aloud, a stopped reply, or
 * a mic tap therefore can never reopen the mic — there is no caller-side flag
 * to go stale.
 */
import type { SpeechSource } from "./nativeTTS";

export type AutoListenInput = {
  /** Voice mode is on for this session. */
  voiceMode: boolean;
  /** The teacher hasn't disabled speech-to-text for this scholar. */
  sttEnabled: boolean;
  /** A tutor reply is still streaming — more sentences may arrive. */
  replyOpen: boolean;
  /** The app is in the foreground. */
  appActive: boolean;
  /** Some recorder already holds the mic (e.g. the writing box). */
  micBusy: boolean;
  /** Whose audio just drained (null: nothing, or it was stopped). */
  drainedSource: SpeechSource | null;
};

export function shouldAutoListen(s: AutoListenInput): boolean {
  const ownDrain = s.drainedSource === "voice";
  return (
    s.voiceMode &&
    s.sttEnabled &&
    !s.replyOpen &&
    s.appActive &&
    !s.micBusy &&
    ownDrain
  );
}

/**
 * How long the "your turn" blip (assets/sfx/listen.wav, ~230 ms) needs before
 * the mic opens, so the transcriber's VAD doesn't hear the cue itself.
 */
export const LISTEN_CUE_MS = 300;

/**
 * Volume (TRA-492): voice mode is useless on a muted iPad, and a pre-reader
 * can't read why nothing is happening. The native OutputVolume module
 * (modules/output-volume) reads the system output volume; at or below this
 * level voice mode shows a card asking an adult to turn it up.
 *
 * Why 0.1: iPad volume moves in 16 button steps of 0.0625. 0.1 catches muted
 * (0) and the bottom step (0.0625), which is inaudible in a classroom; the
 * second step (0.125) is quiet but hearable up close, so it passes. Same rule
 * on every output route — the reading is the route's own volume.
 */
export const LOW_VOLUME_THRESHOLD = 0.1;

/** True only for a real reading at/below the threshold; unknown (null) is
 *  never "too low" — a missing module must not nag. */
export function isVolumeTooLow(volume: number | null): boolean {
  return volume !== null && volume <= LOW_VOLUME_THRESHOLD;
}

/** Shown, not spoken: a muted iPad can't say it. Written for the adult (or
 *  the child) looking at the screen. */
export const LOW_VOLUME_CARD = {
  title: "Turn up this iPad's volume so I can talk to you",
  dismiss: "Hide",
} as const;

/** The text voice mode reads when it's turned on: the tutor's latest reply
 *  (the thing the child most likely missed), or null when there is none. */
export function lastTutorSpeech(
  messages: ReadonlyArray<{ role: string; content?: string | null }> | undefined,
): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = (m.content ?? "").trim();
    if (text) return text;
  }
  return null;
}
