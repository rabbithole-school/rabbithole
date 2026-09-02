/**
 * Room Layer — pure, framework-free copy/formatting for `roomCues` (see
 * convex/schema.ts + convex/roomCues.ts). Web (`components/RoomCueBanner.tsx`,
 * `components/RestOverlay.tsx`) and native
 * (`native/src/components/RoomCueBanner.tsx`, `RestOverlay.tsx`) BOTH call
 * these so the words on a scholar's screen can never drift between the two
 * surfaces (SCHOLAR-facing parity is a standing rule). Imports nothing, so
 * native vendors a read-only copy (see native/scripts/sync-vendor.js).
 *
 * The teacher's words are used verbatim — this file only builds the fixed
 * chrome around them (the emoji lead, the "Eyes up — back at …" line), never
 * generates or rewrites what the teacher said.
 */

export type RoomCueKind = "message" | "transition" | "rest";

/** The shape `roomCues.activeRoomCuesForSelf` returns — exactly what renders,
 * nothing a scholar shouldn't see (no author id, no scope). */
export interface RoomCueForDisplay {
  cueId: string;
  kind: RoomCueKind;
  body: string | null;
  returnAt: number | null;
  authorName: string;
}

/** Fixed headline for the full-screen rest overlay — not authored per-call. */
export const REST_HEADLINE = "🌙 Screens resting";

/**
 * "1:15" — hour (no leading zero), no AM/PM. A same-day, same-room return
 * time read aloud by a teacher doesn't need a period marker; keeping it off
 * matches how the cue is spoken ("back at one fifteen").
 */
export function formatReturnAtClock(returnAt: number): string {
  const d = new Date(returnAt);
  const hours = ((d.getHours() + 11) % 12) + 1; // 0/12/13 → 12, 13 → 1, …
  const minutes = d.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** The rest overlay's secondary line, or null when no return time was set. */
export function restSubline(returnAt: number | null): string | null {
  if (returnAt == null) return null;
  return `Eyes up — back at ${formatReturnAtClock(returnAt)}`;
}

/**
 * The single-line banner text for a "message"/"transition" cue — the
 * teacher's words, verbatim, attributed to a first-name/title-only author:
 * "📣 Ms. K: Clean up in two minutes — then we're on the rug."
 */
export function roomCueBannerText(cue: RoomCueForDisplay): string {
  const body = (cue.body ?? "").trim();
  return `📣 ${cue.authorName}: ${body}`;
}

/**
 * Pick the one live cue per kind a screen should render, given the raw
 * subscription result + this session's LOCALLY-dismissed cue ids. Shared by
 * web's `useActiveRoomCues` and native's twin so the "which cue wins, and is
 * it dismissible" logic can never drift between the two hooks.
 *
 * `message`/`transition` respect local dismissal (a courtesy hide — the cue
 * still expires server-side regardless). `rest` NEVER respects local
 * dismissal: only the teacher's explicit clear (or the cue's own removal from
 * the subscription) should ever drop the full-screen overlay — see
 * RestOverlay's "no lockout semantics beyond the calm overlay, never
 * locally dismissed" invariant.
 */
export function pickCuesByKind(
  cues: readonly RoomCueForDisplay[] | undefined,
  dismissedIds: ReadonlySet<string>,
): {
  message: RoomCueForDisplay | null;
  transition: RoomCueForDisplay | null;
  rest: RoomCueForDisplay | null;
} {
  const find = (kind: RoomCueKind, respectDismiss: boolean) =>
    cues?.find(
      (c) => c.kind === kind && (!respectDismiss || !dismissedIds.has(c.cueId)),
    ) ?? null;
  return {
    message: find("message", true),
    transition: find("transition", true),
    rest: find("rest", false),
  };
}

