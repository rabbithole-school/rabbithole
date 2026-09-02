import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  AsamControllerContext,
  usePresentationAsam,
} from "@/contexts/AsamControllerContext";

/**
 * Covers the mount-condition seam behind the "Teacher unlock" account-menu
 * entry (native/src/components/AccountMenu.tsx): it must render ONLY when
 * AsamHybridHost is actually mounted (ASAM_HYBRID_ENABLED in app/_layout.tsx)
 * and, when it renders, must open the SAME modal the 4-finger-hold gesture
 * opens rather than a second one. AccountMenuButton itself pulls in Convex
 * queries, router, and reanimated, so it isn't a cheap render target here —
 * this exercises the context contract those callers rely on directly.
 */
function Probe({ onRender }: { onRender: (value: ReturnType<typeof usePresentationAsam>) => void }) {
  onRender(usePresentationAsam());
  return null;
}

describe("AsamControllerContext", () => {
  it("defaults to isTeacherUnlockAvailable: false with a no-op openTeacherUnlock (no Provider mounted)", () => {
    let captured: ReturnType<typeof usePresentationAsam> | undefined;
    act(() => {
      create(createElement(Probe, { onRender: (v) => (captured = v) }));
    });

    expect(captured?.isTeacherUnlockAvailable).toBe(false);
    // Calling it must be safe (it's reachable from AccountMenu's onPress even
    // though the row itself is gated on isTeacherUnlockAvailable) and must NOT
    // throw or do anything observable.
    expect(() => captured?.openTeacherUnlock()).not.toThrow();
  });

  it("reflects the real Provider value once AsamHybridHost mounts it", () => {
    const openTeacherUnlock = vi.fn();
    let captured: ReturnType<typeof usePresentationAsam> | undefined;

    act(() => {
      create(
        createElement(
          AsamControllerContext.Provider,
          {
            value: {
              releaseForSystemUI: vi.fn(),
              restoreAfterSystemUI: vi.fn(),
              openTeacherUnlock,
              isTeacherUnlockAvailable: true,
            },
          },
          createElement(Probe, { onRender: (v) => (captured = v) }),
        ),
      );
    });

    expect(captured?.isTeacherUnlockAvailable).toBe(true);
    captured?.openTeacherUnlock();
    expect(openTeacherUnlock).toHaveBeenCalledTimes(1);
  });
});
