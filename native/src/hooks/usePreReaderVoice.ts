/**
 * Pre-reader voice mode for the native tutor chat — the iPad twin of web's
 * voice-first mode (components/SessionInterface.tsx, TRA-492).
 *
 * When the session's EFFECTIVE read level is `listener` (TRA-503; the server
 * resolves it — session override first, then the scholar's saved level — and
 * ships it as `session.readLevel`), voice mode starts ON:
 *
 *   1. Each tutor reply is spoken sentence by sentence AS IT STREAMS
 *      (SentenceAccumulator → the native TTS engine's queue), so the first
 *      words are heard about one short `/tts` call after the first sentence.
 *   2. When the spoken reply drains — and the stream is done — an audible
 *      "your turn" blip plays and, once it has finished, the mic reopens
 *      hands-free in LATCHED mode: the realtime transcriber's server VAD ends
 *      the take when the child stops talking, and the transcript sends itself.
 *   3. If the mic hears nothing for 10 s it closes on its own and the composer
 *      returns to the ordinary tap-to-talk state (useStreamingDictation's
 *      no-speech timeout). Nothing re-arms until the next reply, so it can
 *      never loop on silence.
 *
 * Turning voice mode ON (the toggle) does something you can hear right away:
 * it reads the tutor's latest reply aloud, then listens — or, when the tutor
 * hasn't said anything yet, it just opens the mic.
 *
 * The mic only ever reopens after the voice loop's OWN audio: the engine tags
 * every queued item with its source and reports which one drained, so a
 * tap-to-hear label, a stopped or failed reply, or a mic tap can't trigger it.
 *
 * Volume: the local OutputVolume module (modules/output-volume) reads the
 * iPad's system volume while voice mode is on. At or below
 * LOW_VOLUME_THRESHOLD a card asks for it to be turned up — shown, never
 * spoken (a muted iPad can't say it) — and clears itself when the volume
 * comes back up.
 *
 * Interrupting: the voice toggle stops speech and listening at once (web
 * parity); tapping the mic stops the tutor's voice and records; Stop on a
 * streaming reply silences it; a new reply (typed send, steer, retry) cuts off
 * the old one's voice; the recording bar's ✕ cancels a take. Leaving the app,
 * leaving the session, or switching sessions stops both.
 *
 * The stream callbacks (`onReplyStart` / `onReplyText` / `onReplyDone` /
 * `onReplyEnd`) are called from the screen's SSE handler; everything else is
 * owned here so the 3k-line session screen only threads four calls through.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

import { useOutputVolume } from "../../modules/output-volume";
import { appStatusBus } from "@/lib/appStatusBus";
import { getNativeTTS, type SpeechSource, type TTSState } from "@/lib/nativeTTS";
import {
  isVolumeTooLow,
  LISTEN_CUE_MS,
  shouldAutoListen,
} from "@/lib/voiceLoop";
import {
  SentenceAccumulator,
  stripMarkdownForSpeech,
} from "../../vendor/shared/sentenceStream";

const KEEP_AWAKE_TAG = "rh-pre-reader-voice";

export function usePreReaderVoice(opts: {
  /** This is the viewer's own session, its effective level is pre-reader, and
   *  read-aloud isn't teacher-disabled. */
  enabled: boolean;
  /** Speech-to-text isn't teacher-disabled (web: `sttEnabled`). */
  sttEnabled: boolean;
  /** Open the mic in latched (VAD auto-stop) mode. */
  startListening: () => void;
  /** Drop any open take without sending it. */
  cancelListening: () => void;
  /** The session id — the ON default applies once per session. */
  sessionKey: string;
  /** The tutor's latest reply, read aloud when voice mode is turned on. */
  lastTutorText: string | null;
}) {
  const { enabled, sttEnabled, sessionKey } = opts;
  // The child's/teacher's choice; voice mode is ON only while it AND
  // eligibility hold, so a flicker in `enabled` can't overwrite the choice.
  const [userOn, setUserOn] = useState(false);
  const voiceMode = userOn && enabled;

  // ── Volume ──────────────────────────────────────────────────────────────
  const volume = useOutputVolume(voiceMode);
  const tooLow = isVolumeTooLow(volume);
  const [volumeCardHidden, setVolumeCardHidden] = useState(false);
  // "Hide" lasts until the volume comes back up; a later drop shows it again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-arms the card from an external reading (the native volume)
    if (!tooLow) setVolumeCardHidden(false);
  }, [tooLow]);

  const voiceModeRef = useRef(false);
  const accRef = useRef(new SentenceAccumulator());
  const replyOpenRef = useRef(false);
  /** This session screen has focus — a backgrounded/covered screen's stream
   *  may still be delivering text, and it must not speak. */
  const focusedRef = useRef(false);
  const cueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultAppliedForRef = useRef<string | null>(null);
  const sttEnabledRef = useRef(sttEnabled);
  const startRef = useRef(opts.startListening);
  const cancelRef = useRef(opts.cancelListening);
  const lastTutorTextRef = useRef(opts.lastTutorText);
  // Latest values for the engine/AppState/timer callbacks, synced after commit.
  useEffect(() => {
    sttEnabledRef.current = sttEnabled;
    startRef.current = opts.startListening;
    cancelRef.current = opts.cancelListening;
    lastTutorTextRef.current = opts.lastTutorText;
  });

  const engine = getNativeTTS();
  const ttsState = useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.state,
    () => "idle" as TTSState,
  );

  const clearCueTimer = useCallback(() => {
    if (cueTimerRef.current) clearTimeout(cueTimerRef.current);
    cueTimerRef.current = null;
  }, []);

  /** Stop everything voice mode itself queued (never a label's audio). */
  const silenceVoice = useCallback(() => {
    clearCueTimer();
    getNativeTTS().cancelSource("voice");
  }, [clearCueTimer]);

  const canListenNow = useCallback(
    (drainedSource: SpeechSource | null) =>
      shouldAutoListen({
        voiceMode: voiceModeRef.current,
        sttEnabled: sttEnabledRef.current,
        replyOpen: replyOpenRef.current,
        appActive: AppState.currentState === "active",
        micBusy: appStatusBus.isMicOwned(),
        drainedSource,
      }),
    [],
  );

  /** Play the "your turn" cue, then open the mic once it has finished (so
   *  the VAD doesn't hear the blip). `drainedSource` is whose audio just
   *  ended — the gate only opens for the voice loop's own. */
  const listenAfterCue = useCallback(
    (drainedSource: SpeechSource | null) => {
      if (!canListenNow(drainedSource)) return;
      getNativeTTS().playListeningCue();
      clearCueTimer();
      cueTimerRef.current = setTimeout(() => {
        cueTimerRef.current = null;
        // Re-check: anything may have changed during the cue (toggle off, a
        // new reply, a label tap, backgrounding, another recorder).
        if (getNativeTTS().state !== "idle") return;
        if (!canListenNow(drainedSource)) return;
        startRef.current();
      }, LISTEN_CUE_MS);
    },
    [canListenNow, clearCueTimer],
  );

  /** The voice loop's audio just drained. */
  const maybeAutoListen = useCallback(
    (drainedSource: SpeechSource | null) => {
      // Drained between sentences while the reply is still streaming — the
      // `done` handler re-asks via engine.lastDrainedSource.
      if (replyOpenRef.current) return;
      listenAfterCue(drainedSource);
    },
    [listenAfterCue],
  );

  // Track the effective mode for callbacks; an on→off flip (toggle, or
  // eligibility lost) silences voice mode's audio and any open listen.
  const prevOnRef = useRef(false);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
    if (prevOnRef.current && !voiceMode) {
      silenceVoice();
      cancelRef.current();
    }
    prevOnRef.current = voiceMode;
  }, [voiceMode, silenceVoice]);

  // Default ON for a pre-reader session (a 4–6-year-old can't work a toggle) —
  // applied ONCE per session, the first time it turns eligible, so a later
  // flicker of `enabled` can't snap a manual toggle-off back on.
  useEffect(() => {
    if (!enabled || defaultAppliedForRef.current === sessionKey) return;
    defaultAppliedForRef.current = sessionKey;
    voiceModeRef.current = true;
    setUserOn(true);
  }, [enabled, sessionKey]);

  // Switching sessions inside one screen instance (or unmounting) stops the
  // old session's voice and listening; nothing carries over.
  useEffect(() => {
    return () => {
      replyOpenRef.current = false;
      silenceVoice();
      cancelRef.current();
    };
  }, [sessionKey, silenceVoice]);

  // The engine's natural drain is the "your turn" moment — owned by the
  // FOCUSED session screen. A session pushed on top (or any other screen)
  // takes focus: this one goes quiet and stops listening, and on returning it
  // re-claims the engine's onIdle (the singleton has one listener).
  useFocusEffect(
    useCallback(() => {
      const tts = getNativeTTS();
      const handler = (drained: SpeechSource | null) => maybeAutoListen(drained);
      focusedRef.current = true;
      tts.onIdle = handler;
      return () => {
        focusedRef.current = false;
        if (tts.onIdle === handler) tts.onIdle = null;
        replyOpenRef.current = false;
        silenceVoice();
        cancelRef.current();
      };
    }, [maybeAutoListen, silenceVoice]),
  );

  // A child listening to a long reply isn't touching the screen.
  useEffect(() => {
    if (!voiceMode) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [voiceMode]);

  // Leaving the app stops the mic and the voice — no recording or playback
  // running while backgrounded, no odd resume state (web parity).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "background" || !voiceModeRef.current) return;
      silenceVoice();
      cancelRef.current();
    });
    return () => sub.remove();
  }, [silenceVoice]);

  /** Queue whole text through the sentence splitter as the voice loop's own
   *  audio (so it hands the turn to the child when it finishes). */
  const speakAsVoice = useCallback((text: string) => {
    const tts = getNativeTTS();
    const acc = new SentenceAccumulator();
    const parts = acc.push(stripMarkdownForSpeech(text) + " ");
    const rest = acc.flush();
    if (rest) parts.push(rest);
    for (const s of parts) tts.enqueue(s, "voice");
  }, []);

  /** A stream attempt began (new turn, steer, or retry): fresh sentence
   *  buffer, reply is open, and any earlier reply still being spoken is cut
   *  off — its sentences never play after the new one starts. */
  const onReplyStart = useCallback(() => {
    accRef.current = new SentenceAccumulator();
    replyOpenRef.current = true;
    clearCueTimer();
    if (voiceModeRef.current) getNativeTTS().cancelSource("voice");
  }, [clearCueTimer]);

  /** A streamed text delta: speak each sentence it completes. */
  const onReplyText = useCallback((delta: string) => {
    if (!voiceModeRef.current || !focusedRef.current) return;
    const tts = getNativeTTS();
    for (const s of accRef.current.push(delta)) {
      tts.enqueue(stripMarkdownForSpeech(s), "voice");
    }
  }, []);

  /** The stream's `done`: speak the tail; if everything was already spoken,
   *  the engine won't fire another onIdle, so ask whose audio drained. */
  const onReplyDone = useCallback(() => {
    replyOpenRef.current = false;
    if (!voiceModeRef.current || !focusedRef.current) return;
    const tts = getNativeTTS();
    const rest = accRef.current.flush();
    if (rest) {
      tts.enqueue(stripMarkdownForSpeech(rest), "voice");
    } else if (tts.state === "idle") {
      maybeAutoListen(tts.lastDrainedSource);
    }
  }, [maybeAutoListen]);

  /** The turn settled. A reply that did NOT complete (Stop, failure, abort)
   *  is silenced, so its queued sentences can't drain into an auto-listen. */
  const onReplyEnd = useCallback(
    (completed: boolean) => {
      replyOpenRef.current = false;
      if (!completed && voiceModeRef.current) {
        clearCueTimer();
        getNativeTTS().cancelSource("voice");
      }
    },
    [clearCueTimer],
  );

  const toggleVoiceMode = useCallback(() => {
    const next = !voiceModeRef.current;
    voiceModeRef.current = next;
    setUserOn(next);
    if (!next || replyOpenRef.current) return; // a streaming reply will speak itself
    // Turning it on must be perceptible at once: read the tutor's latest
    // reply aloud (then the mic opens, as after any reply) — or, if the tutor
    // hasn't said anything yet, open the mic now.
    const text = lastTutorTextRef.current;
    if (text) speakAsVoice(text);
    else listenAfterCue("voice");
  }, [listenAfterCue, speakAsVoice]);

  const hideVolumeCard = useCallback(() => setVolumeCardHidden(true), []);

  return {
    voiceMode,
    /** Show "turn up this iPad's volume" (voice mode on, volume too low, not
     *  hidden since it last dropped). */
    volumeCard: voiceMode && tooLow && !volumeCardHidden,
    hideVolumeCard,
    /** Tutor voice is playing (drives the toggle's "speaking" look). */
    speaking: voiceMode && (ttsState === "speaking" || ttsState === "loading"),
    toggleVoiceMode,
    onReplyStart,
    onReplyText,
    onReplyDone,
    onReplyEnd,
  };
}
