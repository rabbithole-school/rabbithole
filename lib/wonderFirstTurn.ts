/**
 * Hands a wonder's words from the "I wonder…" box to the chat it opens
 * (TRA-676). `wonders.ask` makes the chat; the session screen then sends the
 * kid's words as its first turn through its own send path (handleSend:
 * sendMessage, then /session-stream), in place of the "<start>" opener it sends
 * to an empty chat. Same tab, in memory: after a reload the screen sends
 * "<start>" and the tutor answers the seed's topic, which is the same question
 * (convex/wonders.ts header).
 */

import type { MessageInputModality } from "@/components/SessionTranscript";

export type WonderFirstTurn = {
  text: string;
  inputModality: MessageInputModality;
};

const pending = new Map<string, WonderFirstTurn>();

/** The box: remember the words for the chat `ask` just opened. */
export function setWonderFirstTurn(sessionId: string, turn: WonderFirstTurn): void {
  pending.set(sessionId, turn);
}

/** The session screen: the words to send first, once, or null. */
export function takeWonderFirstTurn(sessionId: string): WonderFirstTurn | null {
  const turn = pending.get(sessionId) ?? null;
  pending.delete(sessionId);
  return turn;
}
