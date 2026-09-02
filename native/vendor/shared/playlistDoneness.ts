/**
 * PLAYLIST DONENESS — the ONE cross-surface verdict for whether a scholar's
 * daily practice set still has undone skills, plus the done-screen eyebrow that
 * announces it.
 *
 * Why this file exists: the exact `allDone` / `caughtUp` derivation was
 * hand-copied THREE times — the blend row and the active-tile row in BOTH home
 * cards (`components/practice/PlaylistCard.tsx`, `native/src/components/
 * practice/PracticePlaylistCard.tsx`) — and the practice done-screen never
 * subscribed to it at all, so it announced a flat "Session complete" + a Done
 * eject even while Home simultaneously showed "Continue your math playlist"
 * with more skills queued. Two surfaces, two contradictory stories. Following
 * the `shared/practiceSegments.ts` precedent (segment logic that drifted across
 * three copies), this is the single owner: web imports `@/shared/
 * playlistDoneness`, native imports the vendored copy (native/scripts/
 * sync-vendor.js), and the home cards + done screens all derive done-ness here.
 *
 * The verdict is a PURE function of the fields `practiceSkills.playlistForScholar`
 * already returns (`set[].doneToday`, `nextUp`, `firstPostPlacementBlock`) — no
 * new server concept, no second vocabulary for done-ness.
 *
 * Imports nothing, so it resolves standalone under Metro when vendored.
 */

/** The subset of a `playlistForScholar` result the verdict reads. Kept
 *  structural (not the full row) so any caller — a full query result or a
 *  recomposed tile preview — satisfies it. */
export interface PlaylistDonenessInput {
  /** Today's set; only `doneToday` is read. */
  set: readonly { doneToday: boolean }[];
  /** The next queued skill, or `null` when nothing is left to serve. */
  nextUp: unknown | null;
  /** The first post-placement block still calibrating — it must never read as
   *  "caught up" even with no visible rows yet (a fresh placement can have no
   *  calibration rows), or the card/done-screen would regress straight to the
   *  post-practice "all done" state. */
  firstPostPlacementBlock: boolean;
  /** The server's `blocked` flag: the scholar's Math plan leaves nothing
   *  servable right now. It arrives shaped exactly like a finished day (empty
   *  `set`, null `nextUp`), so without this the verdict below would congratulate
   *  a scholar for a boundary someone else drew — a false statement about them.
   *  Absent/false on every ordinary playlist, so callers that never pass it are
   *  unaffected. */
  blocked?: boolean;
}

export interface PlaylistDoneness {
  /** Every skill in today's set has been practiced today (non-empty set). */
  allDone: boolean;
  /** The scholar is done for today: nothing queued (or everything done), not
   *  mid-first-block calibration, and not scope-blocked. This is the signal both
   *  home cards render as "You're all caught up" and the done screen reads to
   *  say "Playlist complete" rather than "Round complete". */
  caughtUp: boolean;
  /** Nothing is servable because of the plan's boundary, not because the work
   *  is finished. Mutually exclusive with `caughtUp`, and the ONLY state that
   *  may render the Math-plan boundary copy. */
  blocked: boolean;
}

export function derivePlaylistDoneness({
  set,
  nextUp,
  firstPostPlacementBlock,
  blocked: rawBlocked,
}: PlaylistDonenessInput): PlaylistDoneness {
  const doneCount = set.filter((s) => s.doneToday).length;
  const allDone = set.length > 0 && doneCount === set.length;
  const blocked = rawBlocked === true;
  const caughtUp = !blocked && !firstPostPlacementBlock && (nextUp === null || allDone);
  return { allDone, caughtUp, blocked };
}

/** True only once a resolved playlist still has work for the scholar. A
 *  scope-blocked playlist has none — the boundary is not work. */
export function hasActionablePlaylist(
  playlist: PlaylistDonenessInput | null | undefined,
): boolean {
  if (playlist == null) return false;
  const { caughtUp, blocked } = derivePlaylistDoneness(playlist);
  return !caughtUp && !blocked;
}

/**
 * The plain-playlist done-screen eyebrow, in canonical Title case (each surface
 * applies its own casing — web via CSS `text-transform`, native via
 * `toUpperCase()`).
 *
 * "Playlist complete" is the honest stopping point — the daily set is finished.
 * "Round complete" says a single run wrapped but the playlist is still going,
 * so the done screen can offer Continue instead of ejecting the scholar home.
 * This replaces the old flat "Session complete", whose "session" collided with
 * the tutor-conversation `sessions` table / "My Sessions" nomenclature.
 */
export function playlistCompleteEyebrow(caughtUp: boolean): string {
  return caughtUp ? "Playlist complete" : "Round complete";
}

/** The checkpoint masthead's right-side dateline. Placement replaces the
 * playlist entirely, while a started playlist shows its progress before falling
 * back to its standing time frame. */
export function playlistMastheadDateline({
  effectiveNeedsPlacement,
  practicedToday,
  setLength,
  practicedCount,
  goalMin,
}: {
  effectiveNeedsPlacement: boolean;
  practicedToday: boolean;
  setLength: number;
  practicedCount: number;
  goalMin: number | null;
}): string | null {
  if (effectiveNeedsPlacement) return null;
  if (practicedToday && setLength > 0) {
    return `${practicedCount} of ${setLength} skills practiced today`;
  }
  return goalMin ? `~${goalMin} min` : null;
}
