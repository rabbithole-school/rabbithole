import { useCallback, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/lib/convex";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import { captureStationEnrollmentToken } from "@/lib/captureStationToken";
import {
  CAPTURE_STATION_PENDING_UPLOAD_KEY,
  captureSessionIsReusable,
} from "@/lib/captureStationState";
import {
  assignedSessionIsCurrent,
  type AssignedDeviceCaptureState,
} from "@/lib/captureStationAssignment";

const SESSION_KEY = "rabbithole.captureStation.session";
const ASSIGNED_SESSION_KEY = "rabbithole.captureStation.assignedSession";
type Bootstrap = FunctionReturnType<typeof api.captureStations.bootstrap>;
type StoredSession = { sessionToken: string; expiresAt: number };
type StoredAssignedSession = StoredSession & { revision: number };

export type CaptureStationSource =
  | { kind: "static" }
  | { kind: "assigned"; assignment: AssignedDeviceCaptureState };

function parseStoredSession(value: string): StoredSession | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredSession>;
    return typeof parsed.sessionToken === "string" &&
      typeof parsed.expiresAt === "number"
      ? { sessionToken: parsed.sessionToken, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

function parseStoredAssignedSession(value: string): StoredAssignedSession | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredAssignedSession>;
    return typeof parsed.sessionToken === "string" &&
      typeof parsed.expiresAt === "number" &&
      typeof parsed.revision === "number"
      ? {
          sessionToken: parsed.sessionToken,
          expiresAt: parsed.expiresAt,
          revision: parsed.revision,
        }
      : null;
  } catch {
    return null;
  }
}

export function useCaptureStation(source: CaptureStationSource) {
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | undefined>();
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [sessionRevision, setSessionRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assignmentRevisionRef = useRef<number | null>(
    source.kind === "assigned" ? source.assignment.updatedAt : null,
  );
  const exchange = useMutation(api.captureStations.exchangeEnrollmentToken);
  const startAssigned = useMutation(
    api.captureStations.startAssignedDeviceCapture,
  );
  const loadBootstrap = useMutation(api.captureStations.bootstrap);

  useEffect(() => {
    assignmentRevisionRef.current =
      source.kind === "assigned" ? source.assignment.updatedAt : null;
  }, [source]);

  const clearSession = useCallback(() => {
    setSessionToken(null);
    setDeviceId(null);
    setBootstrap(undefined);
    setExpiresAt(null);
    setSessionRevision(null);
  }, []);

  const runStart = useCallback(async (force = false) => {
    setError(null);
    const nextDeviceId = await getStableDeviceId();

    if (source.kind === "assigned") {
      const { assignment } = source;
      const now = Date.now();
      if (
        !force &&
        assignedSessionIsCurrent({
          assignment,
          sessionRevision,
          sessionExpiresAt: expiresAt,
          now,
        }) &&
        sessionToken
      ) {
        return;
      }
      // The server re-validates the binding revision and expiry on every call,
      // so a still-current session survives background/foreground cycles and
      // remounts — restore it instead of minting a churned replacement.
      if (!force) {
        const storedValue = await SecureStore.getItemAsync(ASSIGNED_SESSION_KEY);
        if (storedValue) {
          const stored = parseStoredAssignedSession(storedValue);
          const storedIsCurrent =
            stored !== null &&
            assignedSessionIsCurrent({
              assignment,
              sessionRevision: stored.revision,
              sessionExpiresAt: stored.expiresAt,
              now,
            });
          if (!storedIsCurrent) {
            await SecureStore.deleteItemAsync(ASSIGNED_SESSION_KEY);
          } else {
            const restoredBootstrap = await loadBootstrap({
              sessionToken: stored.sessionToken,
              deviceId: nextDeviceId,
            }).catch(() => null);
            if (assignmentRevisionRef.current !== assignment.updatedAt) return;
            if (restoredBootstrap) {
              setBootstrap(restoredBootstrap);
              setDeviceId(nextDeviceId);
              setSessionToken(stored.sessionToken);
              setExpiresAt(stored.expiresAt);
              setSessionRevision(stored.revision);
              return;
            }
            // A failed bootstrap here may be a transport blip, not a stale
            // capability — keep the persisted entry and fall through to mint
            // (a successful mint overwrites it; an offline mint leaves it for
            // the next attempt).
          }
        }
      }
      const session = await startAssigned({
        deviceId: nextDeviceId,
        expectedUpdatedAt: assignment.updatedAt,
      });
      // A teacher can stop or revise the assignment while the mutation is in
      // flight. Do not admit the resulting capability under the old revision.
      if (assignmentRevisionRef.current !== assignment.updatedAt) return;
      const nextBootstrap = await loadBootstrap({
        sessionToken: session.sessionToken,
        deviceId: nextDeviceId,
      });
      if (!nextBootstrap) {
        throw new Error("Capture station is unavailable");
      }
      if (assignmentRevisionRef.current !== assignment.updatedAt) return;
      await SecureStore.setItemAsync(
        ASSIGNED_SESSION_KEY,
        JSON.stringify({
          sessionToken: session.sessionToken,
          expiresAt: session.expiresAt,
          revision: assignment.updatedAt,
        } satisfies StoredAssignedSession),
        { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
      );
      setBootstrap(nextBootstrap);
      setDeviceId(nextDeviceId);
      setSessionToken(session.sessionToken);
      setExpiresAt(session.expiresAt);
      setSessionRevision(assignment.updatedAt);
      return;
    }

    const enrollmentToken = captureStationEnrollmentToken();
    if (!enrollmentToken) {
      setError("This iPad is not configured as a capture station.");
      return;
    }
    const storedValue = await SecureStore.getItemAsync(SESSION_KEY);
    const hasPendingUpload =
      (await SecureStore.getItemAsync(CAPTURE_STATION_PENDING_UPLOAD_KEY)) !==
      null;
    if (storedValue) {
      const stored = parseStoredSession(storedValue);
      if (
        stored &&
        captureSessionIsReusable(stored.expiresAt, Date.now(), hasPendingUpload)
      ) {
        const nextBootstrap = await loadBootstrap({
          sessionToken: stored.sessionToken,
          deviceId: nextDeviceId,
        }).catch(() => null);
        if (nextBootstrap) {
          setBootstrap(nextBootstrap);
          setDeviceId(nextDeviceId);
          setSessionToken(stored.sessionToken);
          setExpiresAt(stored.expiresAt);
          return;
        }
      }
      await SecureStore.deleteItemAsync(SESSION_KEY);
    }
    const session = await exchange({ token: enrollmentToken, deviceId: nextDeviceId });
    const nextBootstrap = await loadBootstrap({
      sessionToken: session.sessionToken,
      deviceId: nextDeviceId,
    });
    await SecureStore.setItemAsync(
      SESSION_KEY,
      JSON.stringify(session satisfies StoredSession),
    );
    setBootstrap(nextBootstrap);
    setDeviceId(nextDeviceId);
    setSessionToken(session.sessionToken);
    setExpiresAt(session.expiresAt);
  }, [
    exchange,
    expiresAt,
    loadBootstrap,
    sessionRevision,
    sessionToken,
    source,
    startAssigned,
  ]);

  // Concurrent invocations (mount effect racing the AppState "active" handler)
  // join the in-flight run instead of minting competing sessions — the second
  // mint's supersede pass would delete the first mint's row while its token is
  // being adopted.
  const startInFlightRef = useRef<Promise<void> | null>(null);
  const start = useCallback(
    async (force = false) => {
      const inFlight = startInFlightRef.current;
      if (inFlight) {
        if (!force) return inFlight;
        await inFlight.catch(() => {});
      }
      const run = runStart(force).finally(() => {
        if (startInFlightRef.current === run) startInFlightRef.current = null;
      });
      startInFlightRef.current = run;
      return run;
    },
    [runStart],
  );

  useEffect(() => {
    void start().catch(() => {
      clearSession();
      setError("Couldn’t start capture mode. Ask a teacher.");
    });
  }, [clearSession, start]);

  useEffect(() => {
    if (source.kind !== "assigned") return;
    if (
      !assignedSessionIsCurrent({
        assignment: source.assignment,
        sessionRevision,
        sessionExpiresAt: expiresAt,
        now: Date.now(),
      })
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- invalidate local capability state immediately when the live assignment changes.
      clearSession();
    }
  }, [clearSession, expiresAt, sessionRevision, source]);

  useEffect(() => {
    if (!expiresAt) return;
    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(clearSession, delay);
    return () => clearTimeout(timer);
  }, [clearSession, expiresAt]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        // The static kiosk drops its in-memory capability while backgrounded
        // (SecureStore retains it). The assigned session keeps its state so a
        // screen lock or app switch does not mint a replacement session —
        // start() below no-ops while the session is still current.
        if (source.kind === "static") clearSession();
      } else if (state === "active") {
        void start().catch(() => {
          clearSession();
          setError("Couldn’t restart capture mode. Ask a teacher.");
        });
      }
    });
    return () => subscription.remove();
  }, [clearSession, source.kind, start]);

  const refreshSession = useCallback(async () => {
    if (
      (await SecureStore.getItemAsync(CAPTURE_STATION_PENDING_UPLOAD_KEY)) !==
      null
    ) {
      throw new Error("Finish recovering the pending capture first");
    }
    if (source.kind === "static") {
      await SecureStore.deleteItemAsync(SESSION_KEY);
    } else {
      await SecureStore.deleteItemAsync(ASSIGNED_SESSION_KEY);
    }
    clearSession();
    await start(true);
  }, [clearSession, source.kind, start]);

  return {
    sessionToken,
    deviceId,
    bootstrap,
    error,
    expiresAt,
    isTemporary: source.kind === "assigned",
    refreshSession,
  };
}
