/**
 * Constants shared by manual-rehearsal flag UI.
 *
 * The snippet of a flagged tutor message is truncated to this length
 * everywhere it's captured or rendered: the pending-flag chip above the
 * bot drawer's input, the persisted snapshot on the user's bot message,
 * and the "…" suffix that appears in chip text when the original was
 * longer. Keep them in sync via this constant.
 */
export const MAX_FLAG_SNIPPET_LEN = 100;
