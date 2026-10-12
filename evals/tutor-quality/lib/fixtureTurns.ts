import type { TutorCase } from "./types";

export function regenerationScholarMessages(c: TutorCase): string[] {
  // Drop the "<start>" sentinel and blank scholar turns (image-only / voice
  // placeholder messages in real transcripts) — the API rejects empty content.
  const messages = c.turns
    .filter(
      (turn) =>
        turn.role === "user" &&
        turn.content !== "<start>" &&
        turn.content.trim().length > 0,
    )
    .map((turn) => turn.content);

  if (c.secondBeat) messages.push(c.secondBeat.scholarReply);
  return messages;
}
