/**
 * The SHARED chat-bubble treatment for the two native chat surfaces — the
 * scholar tutor chat (`app/session/[id].tsx`) and the Workshop reflection chat
 * (`app/meta.tsx`). Kept here (not forked per-screen) so the two chats can
 * never drift: a scholar's own turns render in the SAME navy bubble in their
 * reflection chat as in their tutor chat, and the tutor/aide voice reads
 * book-like (no bubble) in both. Sibling to `chatType.ts` (the typography
 * de-fork, which owns the shared text scale) — one source of truth for how a
 * chat turn looks.
 *
 * Returned as plain style objects (NOT `StyleSheet.create`'d) so each screen
 * can spread them straight into its own `StyleSheet.create({ ... })` alongside
 * its screen-specific styles.
 */
import type { TextStyle, ViewStyle } from "react-native";

import { CHAT_MESSAGE_TEXT } from "@/lib/chatType";
import { fonts, type Colors } from "@/theme";

/**
 * The hidden opener the client auto-sends to elicit the tutor's first turn. It
 * is a protocol token, never shown as a scholar message — every chat surface
 * filters it (one source of truth so a new surface can't forget to). See
 * `app/session/[id].tsx` and the `ChatBubble` consumers.
 */
export const OPENER_SENTINEL = "<start>";

export interface ChatBubbleStyles {
  /** The scholar's own turn: a filled bubble (paired with `mine`). */
  bubble: ViewStyle;
  /** The scholar's own-turn fill + tucked bottom-right corner (navy, never violet). */
  mine: ViewStyle;
  /** The tutor/aide voice: no bubble, text flowing on the page. */
  tutorBare: ViewStyle;
  /** Body text metrics shared with the rendered markdown (see chatType.ts). */
  bubbleText: TextStyle;
  /** Overrides `bubbleText` colour inside a `mine` bubble. */
  textMine: TextStyle;
  /** The "…" placeholder while an assistant turn is empty. */
  thinking: TextStyle;
}

export function chatBubbleStyles(c: Colors): ChatBubbleStyles {
  return {
    bubble: {
      maxWidth: "100%",
      borderRadius: 22,
      paddingVertical: 12,
      paddingHorizontal: 17,
    },
    mine: { backgroundColor: c.navy, borderBottomRightRadius: 7 },
    tutorBare: {
      maxWidth: "100%",
      paddingVertical: 6,
      paddingHorizontal: 2,
    },
    bubbleText: {
      ...CHAT_MESSAGE_TEXT,
      fontFamily: fonts.regular,
      color: c.charcoal,
    },
    textMine: { color: c.white },
    thinking: { color: c.charcoalSubtle, fontSize: 22, letterSpacing: 2 },
  };
}
