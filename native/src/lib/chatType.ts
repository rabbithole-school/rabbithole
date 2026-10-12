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

/**
 * The steps young readers' conversation text moves up (TRA-504: listener +2,
 * beginner +1 — shared/beginnerReading `conversationTextSteps`). 3 pt a step,
 * so a listener's 18 pt body reads at 24 pt (the same as the web's 2xl), and
 * the line height keeps its proportion. RN applies the device's Dynamic Type
 * setting on top, so a child's own text-size choice still counts.
 */
export const CHAT_TEXT_STEP = 3;

export function chatTextAt(
  base: { fontSize: number; lineHeight: number },
  steps: number,
): { fontSize: number; lineHeight: number } {
  if (steps <= 0) return base;
  const fontSize = base.fontSize + CHAT_TEXT_STEP * steps;
  return { fontSize, lineHeight: Math.round((base.lineHeight * fontSize) / base.fontSize) };
}
