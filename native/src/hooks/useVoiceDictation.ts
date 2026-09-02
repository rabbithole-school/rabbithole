import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking } from "react-native";
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { readAsStringAsync, EncodingType } from "expo-file-system/legacy";
import { useAction } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { appStatusBus } from "@/lib/appStatusBus";
import { voiceMark } from "@/lib/voicePerf";

/**
 * Hard cap on a single recording. Exported so RecordingBar can render a
 * "max reached" state without needing it passed as a prop.
 */
export const MAX_RECORDING_MS = 120_000; // 2 minutes

/**
 * Native voice dictation. Records via expo-audio (metering ON for a live
 * waveform) and transcribes with the Convex Whisper action.
 *
 * States: idle → recording (isRecording) → transcribing (isTranscribing) → done.
 * Auto-stops at MAX_RECORDING_MS: the recorder stops capturing but isRecording
 * stays true so the bar remains visible; the saved URI is used when the user
 * taps ✓. Failed transcriptions surface via Alert with the recording preserved
 * in savedUriRef so a manual retry from the session layer is possible.
 *
 * durationMs is "frozen" at the last value when auto-stop fires so the RecordingBar
 * timer doesn't snap back to 0:00 if expo-audio resets its counter on stop().
 */
export function useVoiceDictation(sessionId?: Id<"sessions">) {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const state = useAudioRecorderState(recorder, 80);
  const transcribe = useAction(api.audioActions.transcribe);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  // true once the auto-stop timer has physically stopped the recorder
  const [isMaxed, setIsMaxed] = useState(false);
  // frozen durationMs after auto-stop so the UI doesn't snap to 0
  const [frozenDurationMs, setFrozenDurationMs] = useState<number | null>(null);

  const startingRef = useRef(false);
  // true once recorder.stop() has been called (auto or manual), prevents double-stop
  const physicallyStoppedRef = useRef(false);
  // the file URI saved by the auto-stop timer for deferred transcription
  const savedUriRef = useRef<string | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micOwnerRef = useRef(
    appStatusBus.createMicOwner("legacy-dictation"),
  );
  // mirror recorder + state in refs so the setTimeout closure always has the latest
  const recorderRef = useRef(recorder);
  // eslint-disable-next-line react-hooks/refs -- The auto-stop timer must use the latest Expo recorder without being recreated.
  recorderRef.current = recorder;
  const stateRef = useRef(state);
  // eslint-disable-next-line react-hooks/refs -- The auto-stop timer must read the latest recorder state without being recreated.
  stateRef.current = state;

  // metering dBFS (~ -60 quiet … 0 loud) → 0..1 for the waveform bars
  const db = state.metering ?? -60;
  const level = Math.max(0, Math.min(1, (db + 60) / 60));
  // Use frozen value so the timer display doesn't jump back to 0 after auto-stop
  const durationMs = frozenDurationMs ?? (state.durationMillis ?? 0);

  const clearAutoStopTimer = useCallback(() => {
    if (autoStopTimerRef.current !== null) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }, []);

  // Clean up on unmount
  useEffect(
    () => () => {
      clearAutoStopTimer();
      appStatusBus.setMicOwned(micOwnerRef.current, false);
    },
    [clearAutoStopTimer],
  );

  const start = useCallback(async () => {
    if (isRecording || startingRef.current) return;
    startingRef.current = true;
    physicallyStoppedRef.current = false;
    savedUriRef.current = null;
    setIsMaxed(false);
    setFrozenDurationMs(null);
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        Alert.alert(
          "Microphone access needed",
          "Open Settings and turn on Microphone for Rabbithole to use your voice.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      appStatusBus.setMicOwned(micOwnerRef.current, true);
      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecording(true);

      // Auto-stop: physically stop the recorder but keep isRecording=true so the bar
      // stays visible. The RecordingBar detects isMaxed and shows "Tap ✓ to send".
      // The frozen durationMs prevents the timer snapping back to 0:00.
      autoStopTimerRef.current = setTimeout(async () => {
        if (physicallyStoppedRef.current) return;
        physicallyStoppedRef.current = true;
        const capturedMs = stateRef.current.durationMillis ?? MAX_RECORDING_MS;
        try {
          await recorderRef.current.stop();
          appStatusBus.setMicOwned(micOwnerRef.current, false);
          savedUriRef.current = recorderRef.current.uri ?? null;
          voiceMark("micClosed");
        } catch (e) {
          appStatusBus.setMicOwned(micOwnerRef.current, false);
          console.warn("[voice] auto-stop failed", e);
        }
        setFrozenDurationMs(capturedMs);
        setIsMaxed(true);
      }, MAX_RECORDING_MS);
    } catch (e) {
      appStatusBus.setMicOwned(micOwnerRef.current, false);
      console.warn("[voice] start failed", e);
      Alert.alert("Couldn't start recording", "Please try again.");
    } finally {
      startingRef.current = false;
    }
  }, [isRecording, recorder]);

  /**
   * Stops recording, transcribes, returns the text (or null on any failure).
   * If the auto-stop timer already ran, uses the saved URI without re-stopping.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    if (!isRecording) return null;
    clearAutoStopTimer();
    setIsRecording(false);
    setIsMaxed(false);
    setFrozenDurationMs(null);
    setIsTranscribing(true);

    let uri: string | null;
    if (physicallyStoppedRef.current) {
      // Auto-stop already called recorder.stop(); grab the saved URI.
      uri = savedUriRef.current;
      savedUriRef.current = null;
    } else {
      physicallyStoppedRef.current = true;
      try {
        await recorder.stop();
        uri = recorder.uri ?? null;
        voiceMark("micClosed");
      } catch (e) {
        console.warn("[voice] stop recorder failed", e);
        uri = null;
      } finally {
        appStatusBus.setMicOwned(micOwnerRef.current, false);
      }
    }

    if (!uri) {
      Alert.alert("Couldn't hear that", "The recording was empty — tap the mic and try again.");
      setIsTranscribing(false);
      return null;
    }

    try {
      const audioBase64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
      const { text } = await transcribe({
        audioBase64,
        mimeType: "audio/mp4",
        sessionId,
      });
      const trimmed = text?.trim() ?? "";
      if (!trimmed) {
        Alert.alert(
          "Didn't catch that",
          "Try speaking a little closer to the iPad, then tap the mic again.",
        );
        return null;
      }
      voiceMark("transcript");
      return trimmed;
    } catch (e) {
      console.warn("[voice] transcribe failed", e);
      // Preserve the URI — a session-layer retry can call stop() again if wired up.
      savedUriRef.current = uri;
      Alert.alert(
        "Transcription failed",
        "Check your connection and try speaking again. Your recording was not lost.",
        [{ text: "OK" }],
      );
      return null;
    } finally {
      setIsTranscribing(false);
    }
  }, [isRecording, recorder, transcribe, sessionId, clearAutoStopTimer]);

  /** Discard the recording without transcribing. */
  const cancel = useCallback(async () => {
    if (!isRecording) return;
    clearAutoStopTimer();
    setIsRecording(false);
    setIsMaxed(false);
    setFrozenDurationMs(null);
    savedUriRef.current = null;
    if (!physicallyStoppedRef.current) {
      physicallyStoppedRef.current = true;
      try {
        await recorder.stop();
      } catch {
        // ignore — we're discarding anyway
      } finally {
        appStatusBus.setMicOwned(micOwnerRef.current, false);
      }
    }
  }, [isRecording, recorder, clearAutoStopTimer]);

  return { isRecording, isTranscribing, isMaxed, level, durationMs, start, stop, cancel };
}
