export type AuthGateScreen =
  | "loading"
  | "switching"
  | "fallback-notice"
  | "sign-in"
  | "app";

export function authGateScreen({
  isAuthenticated,
  isLoading,
  isReconciling,
  isSwitchingScholar,
  showFallbackNotice,
}: {
  isAuthenticated: boolean;
  isLoading: boolean;
  isReconciling: boolean;
  isSwitchingScholar?: boolean;
  showFallbackNotice: boolean;
}): AuthGateScreen {
  // A hand-over outranks the plain loader: the previous scholar's surface must
  // disappear the moment we know the iPad is being re-paired, and the swap has
  // to be visible rather than happening silently under a child's hands.
  if (isSwitchingScholar) return "switching";
  if (isLoading || isReconciling) return "loading";
  if (showFallbackNotice && !isAuthenticated) return "fallback-notice";
  return isAuthenticated ? "app" : "sign-in";
}
