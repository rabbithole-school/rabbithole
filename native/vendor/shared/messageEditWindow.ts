// One edit/withdraw window for EVERY author and every conversation kind
// (family, mentor, workshop). The server enforces it on every edit/retract.
// Thread reads return WHEN it closes (`editableUntil`), never WHETHER it is
// open: a reactive query does not re-run as time passes, so a clock-derived
// flag goes stale on screen (T11 in .claude/rules/rabbithole-product-taste.md).
// Each UI runs one clock per open thread against that timestamp.

export const MESSAGE_EDIT_WINDOW_MS = 10 * 60 * 1000;

/** When a message sent at `sentAt` stops being editable/withdrawable. */
export function messageEditableUntil(sentAt: number): number {
  return sentAt + MESSAGE_EDIT_WINDOW_MS;
}

/** Is the window closing at `editableUntil` still open at `now`? Null means
 *  the message was never the caller's to change (someone else's, withdrawn,
 *  or an idea's opening message). */
export function editWindowOpen(editableUntil: number | null, now: number): boolean {
  return editableUntil !== null && now <= editableUntil;
}
