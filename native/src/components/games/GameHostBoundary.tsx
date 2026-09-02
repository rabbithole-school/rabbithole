import { Component, type ReactNode } from "react";

import { useGameRequest, type GameRequest } from "@/lib/gameHost";

/**
 * Host-level containment for `<GameHost />`, mounted at the app root.
 *
 * `GameHost` already has a `GameErrorBoundary` around the game's Screen, but
 * that boundary lives INSIDE GameHost's own returned JSX, so it cannot catch a
 * throw from the host's OWN render (component-body init, hooks, module wiring) —
 * exactly the failure PR #1862 fixed: a temporal-dead-zone `ReferenceError`
 * that threw on every game launch. On a managed 1:1 iPad an uncaught render
 * throw is not a redbox — it is RCTFatal -> abort(), which takes the whole app
 * (and the scholar's session) down. That wording mirrors the comment above
 * `ManipulativeRendererBoundary` in NativeManipulativeItem.tsx. It stops here.
 *
 * Renders nothing while crashed: GameHost is an invisible overlay host (a Modal
 * that only draws once a game is playing), so a half-drawn fallback would be
 * worse than none — the scholar is simply left on whatever screen they were on,
 * with the rest of the app fully alive.
 *
 * Recovery — why this is NOT a plain latch: a boundary that sets `crashed:true`
 * forever would silently disable games for the ENTIRE session, a worse
 * long-term outcome than the crash itself. Every game launch flows through the
 * `openGameActivity` store as a NEW `GameRequest` reference (and `closeGame`
 * sets it to `null`); we key the latch on that reference and clear `crashed`
 * the moment it changes. So the crashed request stays contained, but the next
 * launch remounts a fresh GameHost and works again.
 *
 * Reporting: GameHost's own `onCrash` reports to Convex via
 * `api.games.reportCrash`, but that needs a live `sessionId`. A host-level
 * crash can happen before a session is ever started (PR #1862's throw fired
 * during render, pre-session), so there is no reliable id to report against
 * here — inventing one would be a reporting path that cannot work. We
 * `console.error` with a clear tag instead, matching the sibling boundaries.
 *
 * NOTE: `ExternalAppHost` and `NativeManipulativeHost` (its two siblings at the
 * app root) have the same exposure and are deliberately left out of scope for
 * this narrow fix.
 */
export function GameHostBoundary({ children }: { children: ReactNode }) {
  const request = useGameRequest();
  return <GameHostBoundaryInner resetKey={request}>{children}</GameHostBoundaryInner>;
}

class GameHostBoundaryInner extends Component<
  { children: ReactNode; resetKey: GameRequest | null },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[game-host] GameHost host-level render threw — games disabled until the next launch", error);
  }

  componentDidUpdate(prevProps: { resetKey: GameRequest | null }) {
    if (this.state.crashed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ crashed: false });
    }
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}
