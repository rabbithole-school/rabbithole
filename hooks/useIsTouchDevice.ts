"use client";

import { useEffect, useState } from "react";

/**
 * True on touch-primary devices (iPad/Chromebook), false on desktop. One-time
 * read of window/navigator APIs that are unavailable during SSR, so it starts
 * `false` and settles after mount — mirrors the detection SessionInterface uses
 * to pick the composer's touch vs desktop type scale.
 */
export function useIsTouchDevice() {
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsTouchDevice("ontouchstart" in window || navigator.maxTouchPoints > 0);
  }, []);
  return isTouchDevice;
}
