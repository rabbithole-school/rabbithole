/**
 * Shared type scale for the native chat surfaces — the scholar tutor chat
 * (`app/session/[id].tsx`) and the Workshop reflection chat (`app/meta.tsx`).
 * Kept here (not forked per-screen) so the two chats can never drift in size:
 * a scholar's reflection chat reads at the same scale as their tutor chat.
 * Mirrors the tutor `Markdown` body size (18/26) so bubble text and rendered
 * markdown line up.
 */

/** Message bubble text (the scholar's own turns; matches tutor markdown body). */
export const CHAT_MESSAGE_TEXT = { fontSize: 18, lineHeight: 26 } as const;

/** The composer text input. */
export const CHAT_COMPOSER_INPUT = { fontSize: 18, lineHeight: 24 } as const;
