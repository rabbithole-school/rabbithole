import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type AudioRecorder,
} from "expo-audio";
import { deleteAsync } from "expo-file-system/legacy";

import { METERED_RECORDING } from "@/hooks/useMeteredRecorder";
import { appStatusBus } from "@/lib/appStatusBus";
import { levelFromDbfs, METER_FRAME_MS, SILENT_DBFS } from "@/lib/micLevel";

export type PresentingMicStatus =
  /** The mic is off. */
  | "off"
  /** Asking for permission or opening the mic. */
  | "starting"
  /** Recording; a frame arrives every `METER_FRAME_MS`. */
  | "on"
  /** The microphone permission is turned off for the app. */
  | "denied"
  /** The mic would not open. */
  | "failed";

export type MicFrame = {
  /** 0..1 on the app's metering scale. */
  level: number;
  /** The raw metering reading, for measuring the meter's zones. */
  dbfs: number;
  /** Where in the recording this frame falls. */
  atMs: number;
};

export type MicFrameListener = (frame: MicFrame) => void;

/**
 * The microphone while a scholar presents: the voice meter's level, and the
 * rehearsal's recording.
 *
 * The mic runs while `enabled` is true and the app isn't in the background. It
 * asks for permission each time it starts (iOS prompts only once), switches
 * the shared audio session to recording only while it records, and puts the
 * session back to playback when it stops, when the app goes to the background
 * and on unmount, so a slide video or read-aloud isn't left in a recording
 * session. While it records, a frame arrives every `METER_FRAME_MS`, at
 * `onFrame` and at anything `subscribe`d. Frames never re-render the caller:
 * a meter subscribes from its own small component, so the whole presenter
 * isn't redrawn a dozen times a second. If the mic can't start,
 * `onUnavailable` says why and it stays off until `enabled` turns off and on.
 *
 * The meter's recording is thrown away. With `keepRecording` the file is kept
 * for the caller: `stop()` returns it, and a background stop holds the mic off
 * (instead of starting a second file on return) until `stop()` collects it.
 */
export function usePresentingMic({
  enabled,
  keepRecording = false,
  onFrame,
  onUnavailable,
}: {
  enabled: boolean;
  keepRecording?: boolean;
  onFrame?: (frame: MicFrame) => void;
  /** The mic didn't start: permission is off, or it wouldn't open. */
  onUnavailable?: (reason: "denied" | "failed") => void;
}) {
  const recorder = useAudioRecorder(METERED_RECORDING);
  const [status, setStatus] = useState<PresentingMicStatus>("off");
  // Only a real background stops the mic. "inactive" is Control Center (which
  // "Connect TV" opens mid-presentation), the permission prompt or a
  // notification, and the recording carries on through those.
  const [foreground, setForeground] = useState(
    AppState.currentState !== "background",
  );

  // Latest values for the async start/stop chain and the frame timer, which
  // outlive the render that started them.
  const recorderRef = useRef(recorder);
  const keepRef = useRef(keepRecording);
  const onFrameRef = useRef(onFrame);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    recorderRef.current = recorder;
    keepRef.current = keepRecording;
    onFrameRef.current = onFrame;
    onUnavailableRef.current = onUnavailable;
  });
  const micOwnerRef = useRef(appStatusBus.createMicOwner("presenting-mic"));

  // What the caller wants, what the recorder is doing, and whether a start or
  // stop is in flight. Starts and stops reconfigure the one iOS audio
  // session, so they run one at a time and re-check what is wanted after each.
  const wantedRef = useRef(false);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  /** Set by `stop()` (and by a background stop of a kept file) until `enabled` turns off. */
  const heldOffRef = useRef(false);
  const keptUriRef = useRef<string | null>(null);
  /** The file the recorder is writing, known once it is prepared. */
  const recordingUriRef = useRef<string | null>(null);
  const settledRef = useRef<Array<() => void>>([]);
  const listenersRef = useRef(new Set<MicFrameListener>());

  const reconcile = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    while (wantedRef.current !== runningRef.current) {
      if (wantedRef.current) {
        setStatus("starting");
        const started = await startRecording(recorderRef.current, () =>
          wantedRef.current,
        );
        if (started.ok) {
          recordingUriRef.current = started.uri;
          runningRef.current = true;
          appStatusBus.setMicOwned(micOwnerRef.current, true);
          setStatus("on");
        } else {
          wantedRef.current = false;
          setStatus(started.reason);
          if (started.reason !== "off") onUnavailableRef.current?.(started.reason);
        }
      } else {
        const uri =
          (await stopRecording(recorderRef.current)) ?? recordingUriRef.current;
        runningRef.current = false;
        appStatusBus.setMicOwned(micOwnerRef.current, false);
        if (keepRef.current) {
          keptUriRef.current = uri;
        } else if (uri) {
          await discardRecording(uri);
        }
        setStatus((current) => (current === "on" ? "off" : current));
      }
    }
    busyRef.current = false;
    for (const resolve of settledRef.current.splice(0)) resolve();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const inForeground = next !== "background";
      // A kept recording ends with the app in the background; starting a
      // second file on return would lose the first.
      if (!inForeground && keepRef.current && runningRef.current) {
        heldOffRef.current = true;
      }
      setForeground(inForeground);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!enabled) heldOffRef.current = false;
    wantedRef.current = enabled && foreground && !heldOffRef.current;
    void reconcile();
  }, [enabled, foreground, reconcile]);

  useEffect(() => {
    if (status !== "on") return;
    const timer = setInterval(() => {
      const now = recorderRef.current.getStatus();
      const frame: MicFrame = {
        level: levelFromDbfs(now.metering),
        dbfs: now.metering ?? SILENT_DBFS,
        atMs: now.durationMillis ?? 0,
      };
      onFrameRef.current?.(frame);
      for (const listener of listenersRef.current) listener(frame);
    }, METER_FRAME_MS);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    const micOwner = micOwnerRef.current;
    return () => {
      // Presenting ended. expo-audio releases the recorder on unmount, which
      // stops a recording; stop defensively anyway, put playback back, and
      // delete whatever the caller never collected.
      wantedRef.current = false;
      appStatusBus.setMicOwned(micOwner, false);
      const wasRunning = runningRef.current;
      runningRef.current = false;
      const leftovers = new Set([
        wasRunning ? recordingUriRef.current : null,
        keptUriRef.current,
      ]);
      keptUriRef.current = null;
      const ended = recorderRef.current;
      void (async () => {
        if (wasRunning) await stopRecording(ended);
        for (const uri of leftovers) {
          if (uri) await discardRecording(uri);
        }
      })();
    };
  }, []);

  /**
   * Stops the mic and keeps it off until `enabled` turns off. Returns the
   * recording's file with `keepRecording` (the caller now owns it), else null.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    heldOffRef.current = true;
    wantedRef.current = false;
    if (busyRef.current) {
      await new Promise<void>((resolve) => settledRef.current.push(resolve));
    }
    await reconcile();
    const uri = keptUriRef.current;
    keptUriRef.current = null;
    return uri;
  }, [reconcile]);

  /** Listen to frames while the mic is on; returns the unsubscribe. */
  const subscribe = useCallback((listener: MicFrameListener) => {
    const listeners = listenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { status, stop, subscribe };
}

type StartResult =
  | { ok: true; uri: string | null }
  | { ok: false; reason: "off" | "denied" | "failed" };

async function startRecording(
  recorder: AudioRecorder,
  stillWanted: () => boolean,
): Promise<StartResult> {
  try {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) return { ok: false, reason: "denied" };
    if (!stillWanted()) return { ok: false, reason: "off" };
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    return { ok: true, uri: recorder.uri ?? null };
  } catch (error) {
    console.warn("[presenting-mic] start failed", error);
    await restorePlayback();
    return { ok: false, reason: "failed" };
  }
}

/** Stops the recorder and puts playback back; returns the file it wrote. */
async function stopRecording(recorder: AudioRecorder): Promise<string | null> {
  let uri: string | null = null;
  try {
    await recorder.stop();
    uri = recorder.uri ?? null;
  } catch (error) {
    // Already stopped, or released with the screen.
    console.warn("[presenting-mic] stop failed", error);
  }
  await restorePlayback();
  return uri;
}

// Recording leaves the shared session in play-and-record; put playback back
// so a slide video or read-aloud afterwards plays normally.
async function restorePlayback() {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
  }).catch((error: unknown) => {
    console.warn("[presenting-mic] audio mode restore failed", error);
  });
}

// The recorder writes into expo's cache directory, where deleting is allowed;
// a file that won't delete is left for iOS to reclaim rather than failing.
async function discardRecording(uri: string) {
  try {
    await deleteAsync(uri, { idempotent: true });
  } catch (error) {
    console.warn("[presenting-mic] could not delete a recording", error);
  }
}
