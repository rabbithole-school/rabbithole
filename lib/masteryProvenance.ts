type ObservationEvidence = {
  attemptContext?: string | null;
};

/** Teacher-facing phrase for where a mastery observation's evidence came from. */
export function evidenceSourcePhrase(observation: ObservationEvidence): string {
  switch (observation.attemptContext) {
    case "game_session":
      return "read off the game round";
    case "portfolio_scan":
      return "read off scanned work";
    case "reflection":
      return "read off the scholar's reflection";
    default:
      return "read off the session transcript";
  }
}

/** Heading for the excerpt that contains the observation's evidence. */
export function evidenceExcerptLabel(observation: ObservationEvidence): string {
  switch (observation.attemptContext) {
    case "game_session":
      return "Game round";
    case "portfolio_scan":
      return "Scanned work";
    case "reflection":
      return "Reflection";
    default:
      return "Transcript";
  }
}
