import { useCallback, useEffect, useRef, useState } from "react";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";

import { appStatusBus } from "@/lib/appStatusBus";

export const BUG_REPORT_MAX_RECORDING_MS = 60_000;

export type BugReportMicPermission = "checking" | "granted" | "denied";

export function useBugReportRecorder() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 80);
  const [permission, setPermission] =
    useState<BugReportMicPermission>("checking");
  const [isRecording, setIsRecording] = useState(false);
  const [isCapped, setIsCapped] = useState(false);
  const [frozenDurationMs, setFrozenDurationMs] = useState<number | null>(null);

  const permissionRef = useRef<BugReportMicPermission>("checking");
  const startingRef = useRef(false);
  const recordingRef = useRef(false);
  const physicallyStoppedRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const savedUriRef = useRef<string | null>(null);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micOwnerRef = useRef(
    appStatusBus.createMicOwner("bug-report-recorder"),
  );
  const recorderRef = useRef(recorder);
  const stateRef = useRef(recorderState);
  // eslint-disable-next-line react-hooks/refs -- The cap timer and unmount cleanup must use the latest Expo recorder without recreating them.
  recorderRef.current = recorder;
  // eslint-disable-next-line react-hooks/refs -- The cap timer must read the latest recorder state without being recreated.
  stateRef.current = recorderState;

  const setPermissionValue = useCallback(
    (next: BugReportMicPermission) => {
      permissionRef.current = next;
      setPermission(next);
    },
    [],
  );

  const clearCapTimer = useCallback(() => {
    if (capTimerRef.current !== null) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const micOwner = micOwnerRef.current;
    let mounted = true;
    void requestRecordingPermissionsAsync()
      .then(({ granted }) => {
        if (mounted) setPermissionValue(granted ? "granted" : "denied");
      })
      .catch((error: unknown) => {
        console.warn("[bug-report] mic permission preflight failed", error);
        if (mounted) setPermissionValue("denied");
      });
    return () => {
      mounted = false;
      clearCapTimer();
      cancelRequestedRef.current = true;
      appStatusBus.setMicOwned(micOwner, false);
      if (recordingRef.current && !physicallyStoppedRef.current) {
        void recorderRef.current.stop().catch((error: unknown) => {
          console.warn("[bug-report] recorder cleanup failed", error);
        });
      }
    };
  }, [clearCapTimer, setPermissionValue]);

  const start = useCallback(async (): Promise<boolean> => {
    if (
      permissionRef.current !== "granted" ||
      startingRef.current ||
      recordingRef.current
    ) {
      return false;
    }
    startingRef.current = true;
    cancelRequestedRef.current = false;
    physicallyStoppedRef.current = false;
    savedUriRef.current = null;
    setIsCapped(false);
    setFrozenDurationMs(null);
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      if (cancelRequestedRef.current) {
        return false;
      }
      recorder.record();
      recordingRef.current = true;
      appStatusBus.setMicOwned(micOwnerRef.current, true);
      setIsRecording(true);
      capTimerRef.current = setTimeout(() => {
        if (!recordingRef.current || physicallyStoppedRef.current) return;
        physicallyStoppedRef.current = true;
        void recorderRef.current
          .stop()
          .then(() => {
            savedUriRef.current = recorderRef.current.uri ?? null;
            setFrozenDurationMs(
              stateRef.current.durationMillis ??
                BUG_REPORT_MAX_RECORDING_MS,
            );
            recordingRef.current = false;
            setIsRecording(false);
            setIsCapped(true);
          })
          .catch((error: unknown) => {
            console.warn("[bug-report] recorder cap failed", error);
          })
          .finally(() => {
            appStatusBus.setMicOwned(micOwnerRef.current, false);
          });
      }, BUG_REPORT_MAX_RECORDING_MS);
      return true;
    } catch (error) {
      appStatusBus.setMicOwned(micOwnerRef.current, false);
      console.warn("[bug-report] recorder start failed", error);
      recordingRef.current = false;
      setIsRecording(false);
      throw error;
    } finally {
      startingRef.current = false;
    }
  }, [recorder]);

  const stop = useCallback(async (): Promise<string | null> => {
    cancelRequestedRef.current = true;
    clearCapTimer();
    if (startingRef.current && !recordingRef.current) return null;

    let uri = savedUriRef.current;
    if (recordingRef.current && !physicallyStoppedRef.current) {
      physicallyStoppedRef.current = true;
      try {
        await recorder.stop();
        uri = recorder.uri ?? null;
      } finally {
        recordingRef.current = false;
        appStatusBus.setMicOwned(micOwnerRef.current, false);
        setIsRecording(false);
      }
    }
    savedUriRef.current = null;
    setIsCapped(false);
    setFrozenDurationMs(null);
    return uri;
  }, [clearCapTimer, recorder]);

  const cancel = useCallback(async (): Promise<void> => {
    cancelRequestedRef.current = true;
    clearCapTimer();
    savedUriRef.current = null;
    setIsCapped(false);
    setFrozenDurationMs(null);
    if (recordingRef.current && !physicallyStoppedRef.current) {
      physicallyStoppedRef.current = true;
      try {
        await recorder.stop();
      } finally {
        recordingRef.current = false;
        appStatusBus.setMicOwned(micOwnerRef.current, false);
        setIsRecording(false);
      }
      return;
    }
    recordingRef.current = false;
    appStatusBus.setMicOwned(micOwnerRef.current, false);
    setIsRecording(false);
  }, [clearCapTimer, recorder]);

  const db = recorderState.metering ?? -60;
  const level = Math.max(0, Math.min(1, (db + 60) / 60));
  const durationMs =
    frozenDurationMs ?? Math.min(
      recorderState.durationMillis ?? 0,
      BUG_REPORT_MAX_RECORDING_MS,
    );

  return {
    permission,
    isRecording,
    isCapped,
    level,
    durationMs,
    start,
    stop,
    cancel,
  };
}
