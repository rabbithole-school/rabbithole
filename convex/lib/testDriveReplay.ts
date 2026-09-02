/**
 * Test Drive — Replay helpers (pure).
 *
 * "Reset & replay" carries a test drive's scholar turns forward onto a
 * fresh drive and auto-re-sends them against the edited prompt, so the
 * teacher doesn't re-type the conversation by hand to reach the moment
 * under test. These two pure functions derive the replayable script and
 * the pause boundary from a transcript; they're split out of the mutation
 * so they're unit-testable with no convexTest boilerplate (see
 * rabbithole-test-strategy.md — transcript-shaped logic is the
 * highest-leverage pure-helper win).
 *
 * The synthetic `<start>` message (the auto-greeting kick — see
 * SessionInterface) is NOT a teacher-typed turn, so it's excluded from the
 * script: the fresh drive sends its own `<start>` greeting before replay
 * begins.
 */

/** Minimal message shape these helpers need. */
export interface ReplayMessage {
  _id: string;
  role: string;
  content: string;
}

/** The synthetic kick that triggers the tutor's opening greeting. */
const START_SENTINEL = "<start>";

/**
 * A teacher-typed scholar turn worth replaying: a `user` message that isn't
 * the synthetic `<start>` kick and isn't empty/whitespace. Empty turns can't
 * be re-sent (handleSend no-ops on them), so excluding them here keeps the
 * script and the `computeReplayStopAfter` boundary counting the same turns.
 */
function isReplayableScholarTurn(
  m: Pick<ReplayMessage, "role" | "content">,
): boolean {
  return m.role === "user" && m.content.trim() !== "" && m.content !== START_SENTINEL;
}

/**
 * The scholar turns to replay, in transcript order, excluding the
 * synthetic `<start>` greeting kick (and any empty turns). These are exactly
 * the messages the teacher typed while role-playing the kid.
 */
export function buildReplayScript(
  messages: ReadonlyArray<Pick<ReplayMessage, "role" | "content">>,
): string[] {
  return messages.filter(isReplayableScholarTurn).map((m) => m.content);
}

/**
 * How many scholar turns to replay before pausing — the boundary that
 * lands on the last flagged tutor response (the moment under test). We
 * count scholar (non-`<start>` user) turns up to and including the one
 * whose tutor reply was flagged, so replaying that many turns regenerates
 * the flagged response against the new prompt.
 *
 * Returns the full script length when nothing is flagged (or only the
 * opening greeting was flagged, which has no preceding scholar turn to
 * stop at) — i.e. replay the whole thing.
 */
export function computeReplayStopAfter(
  messages: ReadonlyArray<ReplayMessage>,
  flaggedIds: ReadonlySet<string>,
): number {
  let scholarCount = 0;
  let lastFlaggedBoundary = 0;
  for (const m of messages) {
    if (isReplayableScholarTurn(m)) {
      scholarCount++;
    } else if (m.role === "assistant" && flaggedIds.has(m._id)) {
      // The flagged tutor reply answered the scholar turns seen so far;
      // replaying `scholarCount` turns reproduces this moment.
      lastFlaggedBoundary = scholarCount;
    }
  }
  return lastFlaggedBoundary > 0 ? lastFlaggedBoundary : scholarCount;
}
