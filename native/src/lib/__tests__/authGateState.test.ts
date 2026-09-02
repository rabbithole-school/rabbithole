import { describe, expect, it } from "vitest";

import { authGateScreen } from "../../app/authGateState";

describe("authGateScreen", () => {
  it("shows the managed-claim fallback notice to an unauthenticated user", () => {
    expect(
      authGateScreen({
        isAuthenticated: false,
        isLoading: false,
        isReconciling: false,
        showFallbackNotice: true,
      }),
    ).toBe("fallback-notice");
  });

  it("allows an authenticated user past a stale managed-claim fallback", () => {
    expect(
      authGateScreen({
        isAuthenticated: true,
        isLoading: false,
        isReconciling: false,
        showFallbackNotice: true,
      }),
    ).toBe("app");
  });

  it("shows the hand-over screen ahead of the plain loader", () => {
    // The previous scholar's surface must disappear the instant we know the
    // iPad is being re-paired — and the swap must be visible, not silent.
    expect(
      authGateScreen({
        isAuthenticated: true,
        isLoading: false,
        isReconciling: true,
        isSwitchingScholar: true,
        showFallbackNotice: false,
      }),
    ).toBe("switching");
  });

  it("keeps an ordinary same-scholar reconcile on the plain loader", () => {
    expect(
      authGateScreen({
        isAuthenticated: true,
        isLoading: false,
        isReconciling: true,
        isSwitchingScholar: false,
        showFallbackNotice: false,
      }),
    ).toBe("loading");
  });
});
