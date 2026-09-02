"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

interface TimeLimitState {
  /** Is a time limit currently active? */
  isActive: boolean;
  /** Seconds remaining (0 when expired). */
  secondsRemaining: number;
  /** Total seconds in the limit (for progress bar). */
  totalSeconds: number;
  /** Has the session expired? */
  isExpired: boolean;
  /** Human-readable time string (e.g. "4:23"). */
  display: string;
  /** Start a time limit. Throws if password is wrong. */
  setLimit: (minutes: number, password: string) => Promise<void>;
  /** Clear the time limit. Throws if password is wrong. */
  clearLimit: (password: string) => Promise<void>;
}

export function useTimeLimit(
  sessionId: string,
  sessionTimeLimit?: number | null,
  sessionStartTime?: number | null,
): TimeLimitState {
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [isExpired, setIsExpired] = useState(false);
  const whisperSentRef = useRef(false);

  const setTimeLimitMut = useMutation(api.sessions.setTimeLimit);
  const clearTimeLimitMut = useMutation(api.sessions.clearTimeLimit);
  const injectWhisper = useMutation(api.sessions.injectTimeLimitWhisper);

  const isActive = !!(sessionTimeLimit && sessionStartTime);

  // Calculate remaining time
  useEffect(() => {
    if (!isActive || !sessionTimeLimit || !sessionStartTime) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset of timer state when limit deactivated
      setSecondsRemaining(0);
      setIsExpired(false);
      whisperSentRef.current = false;
      return;
    }

    const calc = () => {
      const elapsedMs = Date.now() - sessionStartTime;
      const totalMs = sessionTimeLimit * 60 * 1000;
      const remainMs = Math.max(0, totalMs - elapsedMs);
      const remainSec = Math.ceil(remainMs / 1000);

      setSecondsRemaining(remainSec);
      setIsExpired(remainMs <= 0);

      // Inject whisper when 60 seconds remain
      if (remainSec <= 60 && remainSec > 0 && !whisperSentRef.current) {
        whisperSentRef.current = true;
        injectWhisper({ sessionId: sessionId as Id<"sessions"> }).catch(console.error);
      }
    };

    calc();
    const interval = setInterval(calc, 1000);
    return () => clearInterval(interval);
  }, [isActive, sessionTimeLimit, sessionStartTime, sessionId, injectWhisper]);

  const display = (() => {
    if (!isActive) return "";
    const mins = Math.floor(secondsRemaining / 60);
    const secs = secondsRemaining % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  })();

  const setLimit = useCallback(async (minutes: number, password: string) => {
    await setTimeLimitMut({
      sessionId: sessionId as Id<"sessions">,
      minutes,
      password,
    });
    whisperSentRef.current = false;
  }, [sessionId, setTimeLimitMut]);

  const clearLimit = useCallback(async (password: string) => {
    await clearTimeLimitMut({
      sessionId: sessionId as Id<"sessions">,
      password,
    });
    whisperSentRef.current = false;
  }, [sessionId, clearTimeLimitMut]);

  const totalSeconds = (sessionTimeLimit ?? 0) * 60;

  return {
    isActive,
    secondsRemaining,
    totalSeconds,
    isExpired,
    display,
    setLimit,
    clearLimit,
  };
}
