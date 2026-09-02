/**
 * Colour words.
 *
 * A scholar writes `color(red)` — a bare word, not `"#e5484d"` and not
 * `"red"`. Two reasons, both about the iPad keyboard more than about taste:
 * a quote is a character you have to hunt for, and a quoted string that is
 * misspelled fails silently, whereas a bare word that is misspelled is an
 * undefined variable the runtime can name back at you.
 *
 * `STUDIO_COLORS` in the contract is the list we TEACH — ten words a nine-year
 * old already owns. The extra names below are not taught; they exist so that a
 * kid who reaches for `gold` or `teal` because it is the colour they meant gets
 * the colour they meant instead of an error. Guessing right should be rewarded.
 */
import { STUDIO_COLORS, type StudioColor } from "../../shared/studioContract";

export const HEX: Record<string, string> = {
  // the taught ten
  red: "#e5484d",
  orange: "#f0883e",
  yellow: "#e8d44d",
  green: "#3fa34d",
  blue: "#3b6fd4",
  purple: "#8c5bd8",
  pink: "#e06a9c",
  brown: "#8a6242",
  black: "#22252e",
  white: "#ffffff",

  // rewarded guesses
  coral: "#f2795f",
  gold: "#e5b23c",
  lemon: "#e8d44d",
  lime: "#8fc93a",
  teal: "#2ba39a",
  sky: "#4aa8e0",
  indigo: "#5b4bcc",
  violet: "#8c5bd8",
  plum: "#a4489c",
  rose: "#dd4f74",
  sand: "#d9c39a",
  cream: "#f4efe4",
  ink: "#22252e",
  grey: "#6b7488",
  gray: "#6b7488",
};

export const TAUGHT: readonly StudioColor[] = STUDIO_COLORS;

/** Ink is the fallback: an unknown colour still draws, so the run continues. */
export const colorOf = (v: unknown): string =>
  typeof v === "string" ? (HEX[v] ?? (v.startsWith("#") ? v : HEX.ink)) : HEX.ink;

/** Which taught word a painted cell holds, for `onColor()` comparison. */
export const normalize = (v: unknown): string => colorOf(v);
