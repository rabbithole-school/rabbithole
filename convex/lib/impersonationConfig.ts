// Impersonation ("view as user") feature flag. OFF by default — the redesign
// ships dormant on prod and is enabled per-deployment (dev/preview) via the
// IMPERSONATION_ENABLED env var while we verify it. When unset/anything-but-on,
// startImpersonation refuses, the identity overlay is never consulted (zero
// hot-path cost), and the read-only gate is a no-op. See
// review/admin-impersonation-redesign-plan.html.
export function isImpersonationEnabled(): boolean {
  return process.env.IMPERSONATION_ENABLED === "on";
}

// A "view-as" overlay is read-only admin debugging — it should never linger.
// Each overlay carries a hard TTL: past it, the overlay is INERT everywhere
// (getActiveOverlay ignores it, so getCurrentUser/the read-only gate/the banner
// all revert to the real owner) even before the hourly sweep flips `active`.
// This is the defense against sticky/orphaned overlays: a closed tab that never
// hit Exit can't keep a session in view-as for the ~30-day life of its login.
// Overridable per-deployment via IMPERSONATION_TTL_MINUTES (positive number).
export const DEFAULT_IMPERSONATION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

export function impersonationTtlMs(): number {
  const raw = process.env.IMPERSONATION_TTL_MINUTES;
  const mins = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(mins) && mins > 0
    ? mins * 60_000
    : DEFAULT_IMPERSONATION_TTL_MS;
}

/**
 * The wall-clock time an overlay stops being effective. Prefers the stored
 * `expiresAt` (stamped at start); falls back to `startedAt + TTL` so legacy
 * rows written before the field existed still expire.
 */
export function overlayExpiresAt(o: {
  startedAt: number;
  expiresAt?: number;
}): number {
  return o.expiresAt ?? o.startedAt + impersonationTtlMs();
}

export function isOverlayExpired(
  o: { startedAt: number; expiresAt?: number },
  now: number = Date.now(),
): boolean {
  return overlayExpiresAt(o) <= now;
}
