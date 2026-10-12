import { Component, type ReactNode } from "react";

/**
 * A resettable render-error wall. On a managed 1:1 iPad an uncaught render
 * throw is not a redbox — it is RCTFatal -> abort(), which takes the whole app
 * (and the scholar's session) down. Anything that can throw in render — a
 * renderer we don't fully trust, or a Convex `useQuery`, which RETHROWS a
 * server error in render — gets one of these between it and the root.
 *
 * Renders `fallback` (default nothing) while crashed.
 *
 * Recovery — why this is NOT a plain latch: a boundary that stays crashed
 * forever silently disables its subtree for the rest of the session. The
 * caller passes a `resetKey` that changes on the user's natural retry motion
 * (a new game launch, a pull-to-refresh); when it changes the children
 * remount. For a thrown query that remount is a real retry: the crash
 * unmounted the subscription, so remounting subscribes afresh and the server
 * runs the query again.
 *
 * Callers: `GameHostBoundary` (keyed on the game request) and the scholar
 * Home's Math tab (keyed on the refresh generation — the 2026-09-22 incident,
 * where `practiceSkills:choiceCardsForSelf` hit Convex's read limit and the
 * rethrow inside `PracticePlaylistCard` aborted the app).
 */
export class ContainmentBoundary extends Component<
  {
    children: ReactNode;
    resetKey: unknown;
    fallback?: ReactNode;
    onCatch: (error: unknown) => void;
  },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onCatch(error);
  }

  componentDidUpdate(prevProps: { resetKey: unknown }) {
    if (this.state.crashed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ crashed: false });
    }
  }

  render() {
    return this.state.crashed ? (this.props.fallback ?? null) : this.props.children;
  }
}
