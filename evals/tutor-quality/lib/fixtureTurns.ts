import type { TutorCase } from "./types";

export function regenerationScholarMessages(c: TutorCase): string[] {
  const messages = c.turns
    .filter((turn) => turn.role === "user" && turn.content !== "<start>")
    .map((turn) => turn.content);

  if (c.secondBeat) messages.push(c.secondBeat.scholarReply);
  return messages;
}
