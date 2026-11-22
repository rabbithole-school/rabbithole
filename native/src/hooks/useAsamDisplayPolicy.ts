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

  // A touch belongs to the Single App Mode session it happened in. Clearing it
  // during the render that sees the change (not in an effect) means the first
  // render after re-entry is already asleep — no one-frame keep-awake flash.
  const [sessionInSam, setSessionInSam] = useState(inSingleAppMode);
  if (sessionInSam !== inSingleAppMode) {
    setSessionInSam(inSingleAppMode);
    setLastActivityAt(null);
  }

  const recordActivity = useCallback(() => {
    if (!inSingleAppMode || AppState.currentState !== "active") return;
    const activityAt = Date.now();
    setLastActivityAt(activityAt);
    setNow(activityAt);
  }, [inSingleAppMode]);

  // Only a touch arms the window. Becoming `active` is not a person: an
  // unattended iPad goes active at its daily early-morning wake, and an iPad
  // in Single App Mode bounces back to active as it locks, so counting those
  // held the screen on for an hour at a time with nobody there.
  //
  // Leaving `active` ends the window. Inside the lock that mostly means the
  // folio closed or the top button was pressed. iOS often undoes such a lock
  // a split second later (Nov 2026 lifecycle data), and a window that survived
  // it kept the screen lit inside the closed folio until it ran out. Ended,
  // the iPad's own Auto-Lock turns that screen off; the next touch re-arms it.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppState(nextState);
      if (nextState === "active") setNow(Date.now());
      else setLastActivityAt(null);
    });
    return () => subscription.remove();
  }, []);

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
