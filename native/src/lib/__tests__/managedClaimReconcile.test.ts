import { describe, expect, it, vi } from "vitest";

import {
  assertManagedClaimSignInStarted,
  decideManagedClaimAction,
  isManagedClaimHandover,
  managedClaimNeedsAttention,
  MANAGED_CLAIM_RETRY_COOLDOWN_MS,
  isManagedClaimAttemptLatched,
  managedClaimAttemptReducer,
  reconcileManagedClaim,
  resolveManagedClaimAction,
  type ManagedClaimAttemptState,
} from "../managedClaimReconcile";

describe("managed claim reconciliation", () => {
  it("rejects a credentials response that did not start a session", () => {
    expect(() =>
      assertManagedClaimSignInStarted({ signingIn: false }),
    ).toThrow("Managed claim was rejected");
    expect(() =>
      assertManagedClaimSignInStarted({ signingIn: true }),
    ).not.toThrow();
  });

  it("does nothing when no claim is delivered", () => {
    expect(
      decideManagedClaimAction({
        claimToken: null,
        isAuthenticated: false,
        lastExchangedClaimToken: null,
      }),
    ).toBe("none");
  });

  it("exchanges a claim when there is no live session", () => {
    expect(
      decideManagedClaimAction({
        claimToken: "rhc_new",
        isAuthenticated: false,
        lastExchangedClaimToken: null,
      }),
    ).toBe("exchange");
  });

  it("does nothing when the live session already exchanged this claim", () => {
    expect(
      decideManagedClaimAction({
        claimToken: "rhc_current",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_current",
      }),
    ).toBe("none");
  });

  it("replaces a rotated same-scholar claim without clearing the session", async () => {
    const calls: string[] = [];
    const result = await reconcileManagedClaim(
      {
        claimToken: "rhc_reassigned",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_previous",
        subject: "self",
      },
      {
        clearSession: async () => {
          calls.push("clear");
        },
        exchange: async () => {
          calls.push("exchange");
        },
        rememberExchange: async () => {
          calls.push("remember");
        },
      },
    );

    expect(calls).toEqual(["exchange", "remember"]);
    expect(result).toEqual({
      action: "exchange",
      didExchange: true,
      showFallback: false,
    });
  });

  it("lazily loads the stored claim and flags a changed one for attribution", async () => {
    const loadLastExchangedClaimToken = vi.fn(async () => "rhc_previous");

    const result = await resolveManagedClaimAction({
      claimToken: "rhc_reassigned",
      isAuthenticated: true,
      lastExchangedClaimToken: null,
      lastExchangedLoaded: false,
      loadLastExchangedClaimToken,
    });

    expect(loadLastExchangedClaimToken).toHaveBeenCalledOnce();
    expect(result).toEqual({
      needsAttention: true,
      lastExchangedClaimToken: "rhc_previous",
    });
  });

  it("gates on attention, NOT on the final action", async () => {
    // The seam that matters: the final action needs `subject`, which is not
    // known until the server is asked. If this gate returned an action, an
    // unattributed claim would decide "none" and every hand-over would be
    // short-circuited before it was ever attributed.
    const result = await resolveManagedClaimAction({
      claimToken: "rhc_reassigned",
      isAuthenticated: true,
      lastExchangedClaimToken: "rhc_previous",
      lastExchangedLoaded: true,
      loadLastExchangedClaimToken: vi.fn(async () => null),
    });
    expect(result.needsAttention).toBe(true);
    expect(
      decideManagedClaimAction({
        claimToken: "rhc_reassigned",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_previous",
      }),
    ).toBe("none");
  });

  it("needs no attention once the live session already exchanged this claim", () => {
    expect(
      managedClaimNeedsAttention({
        claimToken: "rhc_current",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_current",
      }),
    ).toBe(false);
  });

  it("does not sign out after a transient bootstrap failure", async () => {
    const clearSession = vi.fn(async () => undefined);
    const result = await reconcileManagedClaim(
      {
        claimToken: "rhc_revoked",
        isAuthenticated: false,
        lastExchangedClaimToken: null,
      },
      {
        clearSession,
        exchange: async () => {
          throw new Error("Claim rejected");
        },
        rememberExchange: vi.fn(async () => undefined),
      },
    );

    expect(clearSession).not.toHaveBeenCalled();
    expect(result.action).toBe("exchange");
    expect(result.didExchange).toBe(false);
    expect(result.showFallback).toBe(true);
  });

  it("clears a genuinely invalidated session before re-exchanging", async () => {
    const calls: string[] = [];
    const result = await reconcileManagedClaim(
      {
        claimToken: "rhc_current",
        isAuthenticated: false,
        lastExchangedClaimToken: "rhc_current",
        sessionInvalidated: true,
      },
      {
        clearSession: async () => {
          calls.push("clear");
        },
        exchange: async () => {
          calls.push("exchange");
        },
        rememberExchange: async () => {
          calls.push("remember");
        },
      },
    );

    expect(calls).toEqual(["clear", "exchange", "remember"]);
    expect(result.action).toBe("clear-and-exchange");
  });

  it("latches a revoked claim until foreground grants one retry", () => {
    let state: ManagedClaimAttemptState = { failedClaimToken: null };
    state = managedClaimAttemptReducer(state, {
      type: "exchange-failed",
      claimToken: "rhc_revoked",
    });

    expect(isManagedClaimAttemptLatched(state, "rhc_revoked")).toBe(true);
    expect(isManagedClaimAttemptLatched(state, "rhc_revoked")).toBe(true);

    state = managedClaimAttemptReducer(state, { type: "foreground" });
    expect(isManagedClaimAttemptLatched(state, "rhc_revoked")).toBe(false);

    state = managedClaimAttemptReducer(state, {
      type: "exchange-failed",
      claimToken: "rhc_revoked",
    });
    expect(isManagedClaimAttemptLatched(state, "rhc_revoked")).toBe(true);
  });

  it("remembers a successful sign-in when attaching the device session fails", async () => {
    const rememberExchange = vi.fn(async () => undefined);
    const onAttachError = vi.fn();
    const result = await reconcileManagedClaim(
      {
        claimToken: "rhc_current",
        isAuthenticated: false,
        lastExchangedClaimToken: null,
      },
      {
        clearSession: vi.fn(async () => undefined),
        exchange: vi.fn(async () => undefined),
        attachSession: async () => {
          throw new Error("Network unavailable");
        },
        onAttachError,
        rememberExchange,
      },
    );

    expect(onAttachError).toHaveBeenCalledOnce();
    expect(rememberExchange).toHaveBeenCalledOnce();
    expect(result.showFallback).toBe(false);
    expect(result.didExchange).toBe(true);
  });
});

describe("managed claim hand-over", () => {
  const base = {
    claimToken: "rhc_reassigned",
    isAuthenticated: true,
    lastExchangedClaimToken: "rhc_previous",
  };

  it("is a hand-over only once the server names a different scholar", () => {
    expect(isManagedClaimHandover({ ...base, subject: "other" })).toBe(true);
    expect(isManagedClaimHandover({ ...base, subject: "self" })).toBe(false);
    expect(isManagedClaimHandover({ ...base, subject: "unknown" })).toBe(false);
  });

  it("is never a hand-over without a live session or a changed claim", () => {
    expect(
      isManagedClaimHandover({ ...base, isAuthenticated: false, subject: "other" }),
    ).toBe(false);
    expect(
      isManagedClaimHandover({
        ...base,
        lastExchangedClaimToken: base.claimToken,
        subject: "other",
      }),
    ).toBe(false);
    expect(
      isManagedClaimHandover({ ...base, claimToken: null, subject: "other" }),
    ).toBe(false);
  });

  it("clears the live session BEFORE exchanging a hand-over claim", async () => {
    // Not cosmetic ordering: signing in over a live session leaves the Convex
    // connection authenticated as the previous scholar (see decideManagedClaim
    // Action). Clearing first is what makes the identity swap real.
    const calls: string[] = [];
    const result = await reconcileManagedClaim(
      {
        claimToken: "rhc_reassigned",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_previous",
        subject: "other",
      },
      {
        clearSession: async () => {
          calls.push("clear");
        },
        exchange: async () => {
          calls.push("exchange");
        },
        rememberExchange: async () => {
          calls.push("remember");
        },
      },
    );

    expect(calls).toEqual(["clear", "exchange", "remember"]);
    expect(result.action).toBe("clear-and-exchange");
  });

  it("leaves a SAME-scholar rotation as a plain exchange", async () => {
    // The staged-replacement guarantee: the server keeps the previous token
    // valid until the device presents the new one, so a failed rotation must
    // never strand a signed-in iPad.
    const clearSession = vi.fn(async () => undefined);
    const result = await reconcileManagedClaim(
      {
        claimToken: "rhc_rotated",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_previous",
        subject: "self",
      },
      {
        clearSession,
        exchange: async () => {
          throw new Error("Network unavailable");
        },
        rememberExchange: vi.fn(async () => undefined),
      },
    );

    expect(clearSession).not.toHaveBeenCalled();
    expect(result.action).toBe("exchange");
    expect(result.showFallback).toBe(true);
  });

  it("picks the action from who the server says the claim names", () => {
    const base = {
      claimToken: "rhc_new",
      isAuthenticated: true,
      lastExchangedClaimToken: "rhc_old",
    };
    expect(decideManagedClaimAction({ ...base, subject: "other" })).toBe(
      "clear-and-exchange",
    );
    expect(decideManagedClaimAction({ ...base, subject: "self" })).toBe(
      "exchange",
    );
  });

  it("DEFERS a changed claim we could not attribute, never exchanging blind", () => {
    // Regression guard for a self-inflicted trap: exchanging on an unknown
    // subject succeeds server-side and persists the new token as
    // lastExchanged, while the live connection keeps serving the previous
    // scholar — after which delivered === lastExchanged forever and the iPad
    // is pinned to the WRONG scholar with no unattended recovery.
    expect(
      decideManagedClaimAction({
        claimToken: "rhc_new",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_old",
        subject: "unknown",
      }),
    ).toBe("none");
    // Defaulting to unknown must be just as safe as stating it.
    expect(
      decideManagedClaimAction({
        claimToken: "rhc_new",
        isAuthenticated: true,
        lastExchangedClaimToken: "rhc_old",
      }),
    ).toBe("none");
  });

  it("still exchanges freely with no live session to protect", () => {
    // Signed out there is no identity to keep serving and no onChange trap, so
    // an unattributed claim must NOT be deferred — that is the zero-touch path.
    expect(
      decideManagedClaimAction({
        claimToken: "rhc_new",
        isAuthenticated: false,
        lastExchangedClaimToken: "rhc_old",
        subject: "unknown",
      }),
    ).toBe("exchange");
  });

  it("expires the retry latch so a transient failure recovers unattended", () => {
    const at = 1_000_000;
    const state = managedClaimAttemptReducer(
      { failedClaimToken: null },
      { type: "exchange-failed", claimToken: "rhc_reassigned", at },
    );

    expect(isManagedClaimAttemptLatched(state, "rhc_reassigned", at + 1)).toBe(
      true,
    );
    expect(
      isManagedClaimAttemptLatched(
        state,
        "rhc_reassigned",
        at + MANAGED_CLAIM_RETRY_COOLDOWN_MS,
      ),
    ).toBe(false);
  });
});
