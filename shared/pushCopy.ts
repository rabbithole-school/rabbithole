/**
 * Pushes — pure, framework-free copy/formatting for the "class focus" card
 * (see convex/schema.ts `pushes` + convex/pushes.ts). Web
 * (`components/FocusStrip.tsx`) and native
 * (`native/src/components/FocusStrip.tsx`) BOTH call these, so the words on
 * a scholar's screen can never drift between the two surfaces (SCHOLAR-facing
 * parity is a standing rule). Imports nothing, so native vendors a read-only
 * copy (see native/scripts/sync-vendor.js).
 *
 * The teacher's note is used verbatim — this file only builds the fixed
 * chrome around it.
 */

export type PushTargetKind = "activity" | "app" | "resource" | "link";

/** Exactly what renders — nothing a scholar shouldn't see (no pusher id,
 * no audience, no institution). Mirrors `HydratedPush` in convex/pushes.ts. */
export interface PushForDisplay {
  pushId: string;
  kind: PushTargetKind;
  title: string;
  subtitle?: string | null;
  url?: string | null;
  iconUrl?: string | null;
  /**
   * The tile's emoji rung, carried beside `iconUrl` because an app card
   * renders its identity through the SAME chain the launcher tile uses
   * (shared/appTileMark.ts): logo → emoji → initial. Without it a focus card
   * would drop to the app's initial while the tile beside it showed the
   * emoji, for the same app on the same screen.
   */
  iconEmoji?: string | null;
  color?: string | null;
  media?: "video" | "page" | null;
  note?: string | null;
  blocking: boolean;
  endsAt: number | null;
}

/** Fixed section heading. Not authored per-push. */
export const FOCUS_STRIP_HEADING = "Right now";

/**
 * The lead glyph for a card. Chosen from the TARGET, never from the note —
 * a teacher shouldn't be able to make a video look like an activity.
 */
export function pushGlyph(push: Pick<PushForDisplay, "kind" | "media">): string {
  if (push.kind === "app") return "▶";
  if (push.kind === "activity") return "✎";
  if (push.kind === "resource") return "◈";
  return push.media === "video" ? "▶" : "↗";
}

/** What tapping the card does, in the scholar's words. */
export function pushActionLabel(
  push: Pick<PushForDisplay, "kind" | "media">,
): string {
  switch (push.kind) {
    case "app":
      return "Open";
    case "activity":
      return "Start";
    case "resource":
      return "Open";
    case "link":
      return push.media === "video" ? "Watch" : "Open";
  }
}

/**
 * "18 min left" / "Less than a minute left" / "" when open-ended.
 *
 * Rounds UP, deliberately: a scholar told "1 min left" with 20 seconds
 * remaining experiences the card vanishing early as a bug. Rounding up
 * means the card always outlives its own countdown by under a minute.
 */
export function pushTimeLeftLabel(
  endsAt: number | null,
  now: number,
): string | null {
  if (endsAt == null) return null;
  const remaining = endsAt - now;
  if (remaining <= 0) return null;
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes <= 1) return "Less than a minute left";
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} hr left`;
  return `${hours} hr ${rest} min left`;
}

/**
 * The one-line summary a teacher-facing surface (and the Slack agent) shows
 * back after a push, so a confirmation reads like a sentence rather than a
 * row of fields.
 */
export function pushSummaryLine(opts: {
  title: string;
  audienceLabel: string;
  minutes: number;
}): string {
  return `${opts.title} → ${opts.audienceLabel}, for ${opts.minutes} min`;
}
