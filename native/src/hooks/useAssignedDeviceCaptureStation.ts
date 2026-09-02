import { useEffect, useState } from "react";
import { useConvex, useQuery } from "convex/react";

import { api } from "@/lib/convex";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import {
  captureStationGateMode,
} from "@/lib/captureStationAssignment";

export function useAssignedDeviceCaptureStation() {
  const convex = useConvex();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(
    () => convex.connectionState().isWebSocketConnected,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void getStableDeviceId()
      .then((id) => {
        if (!cancelled) setDeviceId(id);
      })
      .catch(() => {
        // A device identity is required for this temporary, teacher-granted mode.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return convex.subscribeToConnectionState((state) => {
      setIsConnected(state.isWebSocketConnected);
      setNow(Date.now());
    });
  }, [convex]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // This is deliberately a live subscription, not a persisted/cached assignment:
  // losing its connection immediately returns the device to the scholar app.
  const assignment = useQuery(
    api.captureStations.assignedDeviceCaptureState,
    deviceId && isConnected ? { deviceId } : "skip",
  );
  useEffect(() => {
    if (!assignment) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, assignment.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [assignment]);
  const mode = captureStationGateMode({
    hasStaticToken: false,
    assignment,
    isConnected,
    now,
  });

  return {
    assignment: mode === "assigned" ? assignment : null,
    deviceId,
    mode,
  };
}
