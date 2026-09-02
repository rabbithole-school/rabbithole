"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const ACTIVITY_PATH = "/api/dev-activity";
const THROTTLE_MS = 15_000;

export function DevActivityBeacon() {
  const pathname = usePathname();

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    let lastSent = 0;
    const signal = () => {
      const now = Date.now();
      if (now - lastSent < THROTTLE_MS) return;
      lastSent = now;
      if (!navigator.sendBeacon(ACTIVITY_PATH)) {
        void fetch(ACTIVITY_PATH, { method: "POST", keepalive: true }).catch(
          (error) => console.debug("Development activity beacon failed", error),
        );
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") signal();
    };

    signal();
    window.addEventListener("focus", signal);
    window.addEventListener("pointerdown", signal, { capture: true, passive: true });
    window.addEventListener("keydown", signal, { capture: true });
    window.addEventListener("touchstart", signal, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", signal);
      window.removeEventListener("pointerdown", signal, { capture: true });
      window.removeEventListener("keydown", signal, { capture: true });
      window.removeEventListener("touchstart", signal, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pathname]);

  return null;
}
