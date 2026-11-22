"use client";

import { useSyncExternalStore } from "react";
import { PublicAnalytics } from "./PublicAnalytics";
import { browserHoldsSignIn } from "./publicAnalyticsConfig";

/**
 * PublicAnalytics for a public page that renders without the app's providers
 * (the worksheet maker, listed in lib/lightPublicRoutes.ts), so it can't ask
 * Convex who is signed in. It loads only after reading this browser's storage
 * and finding no Rabbithole sign-in, so a scholar who opens a worksheet on a
 * signed-in device is never counted. If storage can't be read, it loads
 * nothing.
 */
/** No subscription: a sign-in on this page reloads into the app anyway. */
const subscribe = () => () => {};

function browserIsSignedOut(): boolean {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return !browserHoldsSignIn(storage);
}

export function NoAccountAnalytics() {
  // The server snapshot is false, so nothing loads before the browser checks.
  const signedOut = useSyncExternalStore(subscribe, browserIsSignedOut, () => false);
  return signedOut ? <PublicAnalytics /> : null;
}
