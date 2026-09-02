import { useCallback, useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import {
  remainingAsamAwakeMs,
  shouldKeepAsamAwake,
} from "@/lib/asam/displayPolicy";

type AsamDisplayPolicy = {
  keepAwake: boolean;
  recordActivity: () => void;
};

export function useAsamDisplayPolicy(
  inSingleAppMode: boolean,
): AsamDisplayPolicy {
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState,
  );
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const recordActivity = useCallback(() => {
    if (!inSingleAppMode || AppState.currentState !== "active") return;
    const activityAt = Date.now();
    setLastActivityAt(activityAt);
    setNow(activityAt);
  }, [inSingleAppMode]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppState(nextState);
      if (nextState === "active") {
        const activityAt = Date.now();
        setLastActivityAt(activityAt);
        setNow(activityAt);
      }
    });
    return () => subscription.remove();
  }, [inSingleAppMode]);

  useEffect(() => {
    if (!inSingleAppMode) return;
    const timer = setTimeout(recordActivity, 0);
    return () => clearTimeout(timer);
  }, [inSingleAppMode, recordActivity]);

  const state = {
    inSingleAppMode,
    appIsActive: appState === "active",
    lastActivityAt,
    now,
  };
  const remainingMs = remainingAsamAwakeMs(state);

  useEffect(() => {
    if (remainingMs === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remainingMs + 1);
    return () => clearTimeout(timer);
  }, [remainingMs]);

  return {
    keepAwake: shouldKeepAsamAwake(state),
    recordActivity,
  };
}
