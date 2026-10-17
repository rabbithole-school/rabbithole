import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportRenderCrash } from "@/lib/appHealthMonitor";

/**
 * Root error boundary for crash reporting only. React Native sends an uncaught
 * render error straight to its native fatal path, around the JS global
 * handler, so without this a render crash would read as an unexplained quit.
 * It files the crash with its component stack, then re-raises it as a fatal,
 * so the app still aborts exactly as before (lib/appHealthMonitor.ts).
 */
export class AppHealthBoundary extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRenderCrash(error, info.componentStack ?? undefined);
  }

  render() {
    // Blank for the moment between the crash and the abort.
    return this.state.crashed ? null : this.props.children;
  }
}
