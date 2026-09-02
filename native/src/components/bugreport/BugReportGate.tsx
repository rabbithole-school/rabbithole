import { useCallback, useEffect, useRef, useState } from "react";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { usePathname } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Pressable, StyleSheet, View } from "react-native";
import { captureScreen } from "react-native-view-shot";

import {
  subscribeBugReportGesture,
  type BugReportGestureEvent,
} from "../../../modules/bug-report-gesture";
import { useOfflineRecovery } from "@/hooks/useOfflineRecovery";
import { appStatusBus } from "@/lib/appStatusBus";
import { api } from "@/lib/convex";
import { getNativeTTS } from "@/lib/nativeTTS";
import { uploadImageUri } from "@/lib/uploadImage";
import {
  BugReportOverlay,
  type BugReportPhase,
} from "@/components/bugreport/BugReportOverlay";
import {
  attachPendingAudio,
  BUG_REPORT_SCREENSHOT,
  clearPendingBugReport,
  deleteBugReportFiles,
  retryPendingBugReport,
  savePendingBugReport,
  stageBugReportFile,
  type PendingBugReport,
} from "@/components/bugreport/bugReportOutbox";
import { useBugReportRecorder } from "@/components/bugreport/useBugReportRecorder";

export const BUG_REPORT_CANCEL_WINDOW_MS = 5_000;

type DevMenuPreferencesModule = {
  setPreferencesAsync(settings: {
    touchGestureEnabled: boolean;
  }): Promise<void>;
};

const devMenuPreferences = __DEV__
  ? requireOptionalNativeModule<DevMenuPreferencesModule>("DevMenuPreferences")
  : null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Please try again.";
}

export function BugReportGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const currentUser = useQuery(api.users.currentUser, {});
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const submitBugReport = useMutation(api.bugReports.submit);
  const {
    permission: micPermission,
    level: recordingLevel,
    durationMs: recordingDurationMs,
    isCapped: isRecordingCapped,
    start: startRecorder,
    stop: stopRecorder,
    cancel: cancelRecorder,
  } = useBugReportRecorder();
  const { isOffline } = useOfflineRecovery();

  const [phase, setPhaseState] = useState<BugReportPhase>("idle");
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reportSaved, setReportSaved] = useState(true);

  const phaseRef = useRef<BugReportPhase>("idle");
  const generationRef = useRef(0);
  const releasedRef = useRef(false);
  const cancelledRef = useRef(false);
  const gestureActiveRef = useRef(false);
  const activeNativeSequenceRef = useRef<number | null>(null);
  const finishingRef = useRef(false);
  const recorderReadyRef = useRef(false);
  const pendingRef = useRef<PendingBugReport | null>(null);
  const pendingReadyRef = useRef<Promise<PendingBugReport | null> | null>(null);
  const armRetryRef = useRef<Promise<PendingBugReport | null> | null>(null);
  const retryRef = useRef<Promise<PendingBugReport | null> | null>(null);
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhase = useCallback((next: BugReportPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const clearTimers = useCallback(() => {
    if (cancelTimerRef.current !== null) {
      clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = null;
    }
    if (savedTimerRef.current !== null) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
  }, []);

  const resetOverlay = useCallback(() => {
    clearTimers();
    generationRef.current += 1;
    releasedRef.current = false;
    cancelledRef.current = false;
    gestureActiveRef.current = false;
    activeNativeSequenceRef.current = null;
    finishingRef.current = false;
    recorderReadyRef.current = false;
    pendingRef.current = null;
    pendingReadyRef.current = null;
    setAudioUnavailable(false);
    setFailure(null);
    setReportSaved(true);
    setPhase("idle");
  }, [clearTimers, setPhase]);

  useEffect(() => {
    appStatusBus.setRoute(pathname || "/");
  }, [pathname]);

  useEffect(() => {
    // Expo's dev client owns a window-level three-finger hold at 0.5s. Disable
    // that debug-only shortcut so it cannot preempt this product gesture at 1.5s.
    void devMenuPreferences
      ?.setPreferencesAsync({ touchGestureEnabled: false })
      .catch((error: unknown) => {
        console.warn("[bug-report] couldn't disable dev-menu touch gesture", error);
      });
  }, []);

  useEffect(
    () => () => {
      clearTimers();
      void cancelRecorder().catch((error: unknown) => {
        console.warn("[bug-report] recorder teardown failed", error);
      });
    },
    [cancelRecorder, clearTimers],
  );

  const submitPending = useCallback(
    async (pending: PendingBugReport): Promise<void> => {
      const screenshotStorageId = pending.screenshotUri
        ? await uploadImageUri(
            await generateUploadUrl(),
            pending.screenshotUri,
            BUG_REPORT_SCREENSHOT.mime,
          )
        : undefined;
      const audioStorageId = pending.audioUri
        ? await uploadImageUri(
            await generateUploadUrl(),
            pending.audioUri,
            "audio/mp4",
          )
        : undefined;
      const result = await submitBugReport({
        ...pending.context,
        clientReportId: pending.id,
        screenshotStorageId,
        audioStorageId,
      });
      if (!result.ok) {
        await clearPendingBugReport(pending);
        if (pendingRef.current?.id === pending.id) pendingRef.current = null;
        throw new Error(result.error);
      }
    },
    [generateUploadUrl, submitBugReport],
  );

  const retryOutbox = useCallback(() => {
    if (retryRef.current) return retryRef.current;
    const promise = retryPendingBugReport(submitPending).finally(() => {
      if (retryRef.current === promise) retryRef.current = null;
    });
    retryRef.current = promise;
    return promise;
  }, [submitPending]);

  useEffect(() => {
    if (isOffline || !currentUser) return;
    void retryOutbox().catch((error: unknown) => {
      console.warn("[bug-report] outbox retry failed", error);
    });
  }, [currentUser, isOffline, retryOutbox]);

  const showSaved = useCallback(() => {
    setFailure(null);
    setPhase("saved");
    savedTimerRef.current = setTimeout(resetOverlay, 4_000);
  }, [resetOverlay, setPhase]);

  const failWith = useCallback(
    (error: unknown) => {
      // pendingRef is assigned only after savePendingBugReport resolves, so it
      // is the source of truth for whether anything is actually on disk to retry.
      setReportSaved(pendingRef.current !== null);
      setFailure(errorMessage(error));
      setPhase("failed");
    },
    [setPhase],
  );

  const sendCurrentReport = useCallback(
    async (generation: number) => {
      if (
        generation !== generationRef.current ||
        cancelledRef.current
      ) {
        return;
      }
      clearTimers();
      setPhase("sending");
      const pending =
        pendingRef.current ?? (await pendingReadyRef.current);
      if (!pending) {
        failWith(new Error("No bug-report capture was available."));
        return;
      }
      try {
        await submitPending(pending);
        await clearPendingBugReport(pending);
        if (
          generation === generationRef.current &&
          !cancelledRef.current
        ) {
          showSaved();
        }
      } catch (error) {
        console.warn("[bug-report] send failed", error);
        if (
          generation === generationRef.current &&
          !cancelledRef.current
        ) {
          failWith(error);
        }
      }
    },
    [clearTimers, failWith, setPhase, showSaved, submitPending],
  );

  const enterCancelWindow = useCallback(
    (generation: number) => {
      if (
        generation !== generationRef.current ||
        cancelledRef.current
      ) {
        return;
      }
      setPhase("cancel-window");
      cancelTimerRef.current = setTimeout(() => {
        cancelTimerRef.current = null;
        void sendCurrentReport(generation);
      }, BUG_REPORT_CANCEL_WINDOW_MS);
    },
    [sendCurrentReport, setPhase],
  );

  const finishRelease = useCallback(
    async (generation: number) => {
      if (
        finishingRef.current ||
        generation !== generationRef.current ||
        cancelledRef.current
      ) {
        return;
      }
      finishingRef.current = true;
      let audioUri: string | null = null;
      try {
        if (recorderReadyRef.current) {
          audioUri = await stopRecorder();
        } else {
          await cancelRecorder();
        }
        let pending =
          pendingRef.current ?? (await pendingReadyRef.current);
        if (
          generation !== generationRef.current ||
          cancelledRef.current ||
          !pending
        ) {
          return;
        }
        if (audioUri) {
          pending = await attachPendingAudio(pending, audioUri);
          pendingRef.current = pending;
        }
        enterCancelWindow(generation);
      } catch (error) {
        console.warn("[bug-report] release failed", error);
        if (
          generation === generationRef.current &&
          !cancelledRef.current
        ) {
          failWith(error);
        }
      } finally {
        finishingRef.current = false;
        recorderReadyRef.current = false;
      }
    },
    [cancelRecorder, enterCancelWindow, failWith, stopRecorder],
  );

  const beginArm = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    armRetryRef.current = retryOutbox().catch((error: unknown) => {
      console.warn("[bug-report] existing outbox retry failed", error);
      return null;
    });
  }, [retryOutbox]);

  const activate = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    releasedRef.current = false;
    cancelledRef.current = false;
    gestureActiveRef.current = true;
    finishingRef.current = false;
    recorderReadyRef.current = false;
    setFailure(null);
    setPhase("held");

    const micUnavailable =
      micPermission !== "granted" || appStatusBus.isMicOwned();
    setAudioUnavailable(micUnavailable);
    if (!micUnavailable) getNativeTTS().stop();

    void (async () => {
      let screenshotSourceUri: string | null = null;
      try {
        screenshotSourceUri = await captureScreen({
          format: BUG_REPORT_SCREENSHOT.format,
          quality: BUG_REPORT_SCREENSHOT.quality,
          result: "tmpfile",
        });
      } catch (error) {
        console.warn("[bug-report] screenshot capture failed", error);
      }

      if (
        generation !== generationRef.current ||
        cancelledRef.current
      ) {
        return;
      }

      const reportId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const route = appStatusBus.getRoute();
      const stagedScreenshotPromise = screenshotSourceUri
        ? stageBugReportFile(reportId, "screenshot", screenshotSourceUri).catch(
            (error: unknown) => {
              console.warn("[bug-report] screenshot staging failed", error);
              return undefined;
            },
          )
        : Promise.resolve(undefined);

      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch((error: unknown) => {
        console.warn("[bug-report] haptic failed", error);
      });

      if (!releasedRef.current) {
        setPhase("recording");
        if (!micUnavailable) {
          void startRecorder()
            .then((started) => {
              if (
                generation !== generationRef.current ||
                cancelledRef.current ||
                releasedRef.current
              ) {
                if (started) {
                  void cancelRecorder().catch((error: unknown) => {
                    console.warn(
                      "[bug-report] late recorder cleanup failed",
                      error,
                    );
                  });
                }
                return;
              }
              recorderReadyRef.current = started;
            })
            .catch((error: unknown) => {
              console.warn("[bug-report] audio unavailable", error);
              setAudioUnavailable(true);
            });
        }
      }

      const pendingPromise = (async () => {
        const screenshotUri = await stagedScreenshotPromise;
        await armRetryRef.current;
        if (
          generation !== generationRef.current ||
          cancelledRef.current
        ) {
          await deleteBugReportFiles({ screenshotUri });
          return null;
        }
        const pending: PendingBugReport = {
          id: reportId,
          createdAt: Date.now(),
          context: {
            surface: "native",
            url: route.route,
            sessionId: route.sessionId,
            deviceModel: Device.modelName ?? undefined,
            osVersion: Device.osVersion ?? undefined,
            appVersion: Constants.expoConfig?.version,
            appBuild: Constants.expoConfig?.ios?.buildNumber,
          },
          screenshotUri,
        };
        try {
          await savePendingBugReport(pending);
        } catch (error) {
          await deleteBugReportFiles(pending);
          throw error;
        }
        pendingRef.current = pending;
        return pending;
      })();
      pendingReadyRef.current = pendingPromise;
      void pendingPromise.catch((error: unknown) => {
        console.warn("[bug-report] outbox persistence failed", error);
      });

      if (releasedRef.current) {
        await finishRelease(generation);
      }
    })().catch((error: unknown) => {
      console.warn("[bug-report] activation failed", error);
      if (
        generation === generationRef.current &&
        !cancelledRef.current
      ) {
        failWith(error);
      }
    });
  }, [
    cancelRecorder,
    failWith,
    finishRelease,
    micPermission,
    setPhase,
    startRecorder,
  ]);

  const release = useCallback(
    (success: boolean) => {
      if (!success || !gestureActiveRef.current) return;
      releasedRef.current = true;
      gestureActiveRef.current = false;
      void finishRelease(generationRef.current);
    },
    [finishRelease],
  );

  const finalize = useCallback(
    (success: boolean) => {
      if (success || !gestureActiveRef.current) return;
      const generation = generationRef.current;
      cancelledRef.current = true;
      generationRef.current += 1;
      gestureActiveRef.current = false;
      clearTimers();
      void (async () => {
        await cancelRecorder();
        const pending =
          pendingRef.current ?? (await pendingReadyRef.current);
        if (pending) await clearPendingBugReport(pending);
        if (generation + 1 === generationRef.current) resetOverlay();
      })().catch((error: unknown) => {
        console.warn("[bug-report] cancelled gesture cleanup failed", error);
        if (generation + 1 === generationRef.current) resetOverlay();
      });
    },
    [cancelRecorder, clearTimers, resetOverlay],
  );

  const cancelSend = useCallback(() => {
    const pending = pendingRef.current;
    cancelledRef.current = true;
    clearTimers();
    void (async () => {
      if (pending) await clearPendingBugReport(pending);
      resetOverlay();
    })().catch((error: unknown) => {
      console.warn("[bug-report] cancelled send cleanup failed", error);
      resetOverlay();
    });
  }, [clearTimers, resetOverlay]);

  const retryFailed = useCallback(() => {
    const generation = generationRef.current;
    setPhase("sending");
    void retryOutbox()
      .then((retried) => {
        if (generation !== generationRef.current) return;
        if (retried) showSaved();
        else resetOverlay();
      })
      .catch((error: unknown) => {
        console.warn("[bug-report] manual retry failed", error);
        if (generation === generationRef.current) {
          failWith(error);
        }
      });
  }, [failWith, resetOverlay, retryOutbox, setPhase, showSaved]);

  useEffect(
    () =>
      subscribeBugReportGesture((event: BugReportGestureEvent) => {
        if (event.phase === "began") {
          if (phaseRef.current !== "idle") return;
          activeNativeSequenceRef.current = event.sequence;
          beginArm();
          activate();
          return;
        }
        if (activeNativeSequenceRef.current !== event.sequence) return;
        activeNativeSequenceRef.current = null;
        if (event.phase === "ended") release(true);
        else finalize(false);
      }),
    [activate, beginArm, finalize, release],
  );

  const reporterName =
    currentUser?.name ?? currentUser?.username ?? "the current user";

  return (
    <>
      <View style={styles.fill}>
        {children}
        {__DEV__ && (
          <Pressable
            accessible
            accessibilityLabel="Start bug report test capture"
            accessibilityRole="button"
            onPress={() => {
              activeNativeSequenceRef.current = null;
              beginArm();
              activate();
            }}
            style={styles.axStart}
          />
        )}
      </View>
      <BugReportOverlay
        phase={phase}
        reporterName={reporterName}
        audioUnavailable={audioUnavailable}
        level={recordingLevel}
        durationMs={recordingDurationMs}
        isCapped={isRecordingCapped}
        isOffline={isOffline}
        error={failure}
        reportSaved={reportSaved}
        onCancelSend={cancelSend}
        onRetry={retryFailed}
        onDismiss={resetOverlay}
        onTestRelease={() => release(true)}
        onTestRetryPending={() => {
          void retryOutbox().catch((error: unknown) => {
            console.warn("[bug-report] test retry failed", error);
          });
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  axStart: {
    position: "absolute",
    left: 1,
    bottom: 1,
    width: 2,
    height: 2,
  },
});
