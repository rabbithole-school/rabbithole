/**
 * The hand-off from the "I wonder…" box to the chat it opens (TRA-677).
 *
 * `wonders.ask` saves the kid's words and opens a plain chat; the session
 * screen then sends those same words as the chat's first turn, through its
 * ordinary send path (convex/wonders.ts header). The words travel as route
 * params, built here and read back here, so the box and the session screen
 * can't disagree about the names.
 */

import type { Id } from "@/lib/convex";

export type WonderInputModality = "typed" | "spoken";

/** The session route a just-asked wonder opens. `title` shows the question in
 *  the nav bar straight away, like every other card that opens a chat. */
export function wonderChatRoute(
  sessionId: Id<"sessions">,
  question: string,
  inputModality: WonderInputModality,
) {
  return {
    pathname: "/session/[id]" as const,
    params: {
      id: sessionId,
      title: question,
      wonder: question,
      wonderBy: inputModality,
    },
  };
}

/** The first turn a session screen should send for its `wonder` / `wonderBy`
 *  params, or null when it was not opened from the box (it then keeps its
 *  usual opener). Blank words are no turn. */
export function wonderFirstTurn(
  wonder: string | string[] | undefined,
  wonderBy: string | string[] | undefined,
): { text: string; inputModality: WonderInputModality } | null {
  const text = (Array.isArray(wonder) ? wonder[0] : wonder)?.trim();
  if (!text) return null;
  const by = Array.isArray(wonderBy) ? wonderBy[0] : wonderBy;
  return { text, inputModality: by === "spoken" ? "spoken" : "typed" };
}
