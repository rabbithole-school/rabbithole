/**
 * Shared "receipt row" geometry — the full-width, hairline-divided row idiom
 * used by PlaylistCard's `PlaylistRow` ("Today's Math Playlists") and
 * DailyRecapCard's row ("Your map changed today"), so the two scholar-home
 * cards read as visual siblings: same lead-column width, same row padding,
 * same divider weight/color, same quiet right-aligned tag treatment.
 *
 * A style-constant extraction, not a new row component — each card still
 * renders its own row markup (different content and semantics: a
 * session-progress dot + queue tag on PlaylistCard vs. a mastery dot +
 * proficiency-word tag on DailyRecapCard).
 */

/** Leading dot/glyph column width — keeps the strip icon, row dots, and CTA
 *  on one grid line. Mirrors the LEAD_W already duplicated locally in
 *  components/ui/UnitGroupCard.tsx for the same sibling-card alignment. */
export const RECEIPT_LEAD_W = "18px";
/** Gap between the lead column and the row's text (10px). */
export const RECEIPT_LEAD_GAP = 2.5;

/** Row/strip horizontal inset (14px) — flush with the card's own edges since
 *  the card Surface renders with no padding of its own (p=0). */
export const RECEIPT_ROW_PX = 3.5;
/** Row vertical padding (10px). */
export const RECEIPT_ROW_PY = 2.5;
/** Strip (header/footer) vertical padding (10px / 12px respectively — see
 *  PlaylistCard's `strip` vs. its CTA box). */
export const RECEIPT_STRIP_PY = 2.5;
export const RECEIPT_FOOTER_PY = 3;

/** Hairline divider between rows. */
export const RECEIPT_ROW_DIVIDER_COLOR = "gray.100";
/** Heavier divider between the strip/footer and the row list. */
export const RECEIPT_STRIP_DIVIDER_COLOR = "gray.200";

/** The quiet right-aligned tag — exactly the playlist's "Next up" / "In your
 *  set" treatment. */
export const RECEIPT_TAG_FONT_SIZE = "xs";
export const RECEIPT_TAG_COLOR = "charcoal.300";

/** The row's main text. */
export const RECEIPT_LABEL_FONT_SIZE = "sm";
