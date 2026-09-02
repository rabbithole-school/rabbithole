export const VIEWPORT_SHELL_HEIGHT =
  "var(--rh-viewport-shell-height, 100dvh)";

export function remainingViewportHeight(bannerHeight: number): string {
  if (!Number.isFinite(bannerHeight)) return "100dvh";
  return `calc(100dvh - ${Math.max(0, Math.ceil(bannerHeight))}px)`;
}
