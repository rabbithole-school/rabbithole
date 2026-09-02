"use client";

import { useEffect, useMemo, useRef } from "react";
import type React from "react";

/**
 * Dependency-free touch-swipe recognizers for the iPad (and any touch
 * browser). Mouse/trackpad users never trigger these — they're touch-event
 * based, so desktop Chrome behavior is untouched.
 */

const SWIPE_THRESHOLD = 60; // px of travel along the swipe axis
const DRIFT_LIMIT = 50; // px of cross-axis drift before we stop treating it as a swipe
const EDGE_WIDTH = 28; // px from the screen edge that counts as an edge start

/**
 * Swipe right from the left screen edge → onOpen. Mirrors the iPadOS
 * "slide in the sidebar" convention. Window-level listeners; passive, so
 * scrolling never janks.
 */
export function useEdgeSwipeOpen(
  onOpen: () => void,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const onOpenRef = useRef(onOpen);
  // eslint-disable-next-line react-hooks/refs -- keep latest callback without re-binding window listeners (same idiom as SessionInterface's sendMessageRef)
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!enabled) return;
    let startX = -1;
    let startY = -1;
    let fired = false;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      fired = false;
      // Only arm when the touch begins at the screen's left edge.
      startX = t.clientX <= EDGE_WIDTH ? t.clientX : -1;
      startY = t.clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (startX < 0 || fired) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dy > DRIFT_LIMIT) {
        startX = -1; // mostly vertical — it's a scroll, stand down
        return;
      }
      if (dx >= SWIPE_THRESHOLD) {
        fired = true;
        onOpenRef.current();
      }
    };
    const onTouchEnd = () => {
      startX = -1;
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [enabled]);
}

/**
 * Swipe in `direction` on the element → onDismiss. Returns touch handlers
 * to spread onto the element (typically a drawer's content or its grab
 * region). Cross-axis drift cancels, so scrollable drawer bodies still
 * scroll normally.
 */
export function useSwipeDismiss(
  onDismiss: () => void,
  direction: "down" | "left" | "right",
): {
  onTouchStart: React.TouchEventHandler;
  onTouchMove: React.TouchEventHandler;
  onTouchEnd: React.TouchEventHandler;
} {
  const state = useRef({ x: -1, y: -1, fired: false });
  const onDismissRef = useRef(onDismiss);
  // eslint-disable-next-line react-hooks/refs -- keep latest callback without invalidating the memoized handlers
  onDismissRef.current = onDismiss;

  return useMemo(() => {
    const axis = direction === "down" ? "y" : "x";
    const sign = direction === "left" ? -1 : 1;
    return {
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        state.current = { x: t.clientX, y: t.clientY, fired: false };
      },
      onTouchMove: (e: React.TouchEvent) => {
        const s = state.current;
        if (s.x < 0 || s.fired) return;
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - s.x;
        const dy = t.clientY - s.y;
        const along = axis === "y" ? dy : dx * sign;
        const drift = Math.abs(axis === "y" ? dx : dy);
        if (drift > DRIFT_LIMIT) {
          s.x = -1;
          return;
        }
        if (along >= SWIPE_THRESHOLD) {
          s.fired = true;
          onDismissRef.current();
        }
      },
      onTouchEnd: () => {
        state.current.x = -1;
      },
    };
  }, [direction]);
}
