/**
 * US currency — the ONE table of denomination facts the `money` manipulative
 * renders, grades, and describes from. Framework-free data (no React, no
 * colors-module import), so the web SVG face, the native `react-native-svg`
 * face, the pure `logic.ts` predicates, and the Convex-side grader all read the
 * same numbers instead of four drifting copies.
 *
 * WHY DRAWN, NOT PHOTOGRAPHED. A coin here is vector art built from the facts
 * below, not a bitmap of a real coin. Three reasons, in order:
 *   1. A tray coin is ~48px and a bank coin ~64px on an iPad; a photo of a
 *      Lincoln cent at that size is brown mush, while `1¢` on a copper disc of
 *      the right relative diameter is unmistakable.
 *   2. RELATIVE SIZE IS THE MATH. A dime being physically SMALLER than a nickel
 *      while being worth twice as much is a real grade-2 stumbling block
 *      (2.MD.C.8), so `diameterMm` is load-bearing data the renderers scale
 *      from — not decoration. A photo set would have to be cropped to the same
 *      discipline anyway.
 *   3. Vector scales cleanly to both frontends with no binary assets, no fetch,
 *      and no chroma-key step (unlike the generative `theme.fill` icons, which
 *      are a charm layer where accuracy does not matter).
 *
 * The coin FACE styling deliberately reuses the visual language of the existing
 * coin-flip tray (`DiceManipulative`'s `drawCoin`): a metal disc with a radial
 * highlight, a soft rim stroke, and an inner ring. What it does NOT reuse is
 * the flip — a money piece is a thing you place and count, never a thing you
 * spin, so there is no rotation/animation path here at all.
 */

/** Every piece of US currency the `money` manipulative can put in the bank. */
export type MoneyDenomination =
  | "penny"
  | "nickel"
  | "dime"
  | "quarter"
  | "halfDollar"
  | "dollarCoin"
  | "oneDollarBill"
  | "fiveDollarBill"
  | "tenDollarBill";

/** Coins are discs sized by `diameterMm`; bills are notes of one common size. */
export type MoneyPieceShape = "coin" | "bill";

export interface MoneyPieceFacts {
  /** Face value in CENTS — the grading unit, so no float money ever exists. */
  cents: number;
  /** Singular kid-facing name, sentence case ("half dollar", "one-dollar bill"). */
  label: string;
  /** Plural of `label`, for prose ("three quarters"). */
  plural: string;
  /** The glyph drawn on the face ("1¢", "25¢", "$1"). */
  faceValue: string;
  shape: MoneyPieceShape;
  /**
   * Real diameter in millimetres (coins) — the renderers scale every coin off
   * this ONE number, so a dime always draws smaller than a nickel. Bills carry
   * their own fixed note size and set this to the note's height.
   */
  diameterMm: number;
  /** Base metal / ink color of the piece. */
  metal: string;
  /** The rim + linework color (a darker shade of `metal`). */
  rim: string;
  /**
   * True for the milled (grooved) edges: dime, quarter, half dollar. The penny
   * and nickel are smooth, and the Sacagawea dollar is smooth-edged too. A
   * small authenticity detail a kid who has held the coins will recognise.
   */
  reeded: boolean;
}

/**
 * The denomination table. Diameters are the real US Mint specifications, so
 * relative size on screen matches relative size in a hand.
 */
export const MONEY_PIECES: Record<MoneyDenomination, MoneyPieceFacts> = {
  penny: {
    cents: 1,
    label: "penny",
    plural: "pennies",
    faceValue: "1¢",
    shape: "coin",
    diameterMm: 19.05,
    metal: "#c47b45",
    rim: "#8d4f26",
    reeded: false,
  },
  nickel: {
    cents: 5,
    label: "nickel",
    plural: "nickels",
    faceValue: "5¢",
    shape: "coin",
    diameterMm: 21.21,
    metal: "#b9bcc2",
    rim: "#7d8189",
    reeded: false,
  },
  dime: {
    cents: 10,
    label: "dime",
    plural: "dimes",
    faceValue: "10¢",
    shape: "coin",
    diameterMm: 17.91,
    metal: "#c3c6cc",
    rim: "#83878f",
    reeded: true,
  },
  quarter: {
    cents: 25,
    label: "quarter",
    plural: "quarters",
    faceValue: "25¢",
    shape: "coin",
    diameterMm: 24.26,
    metal: "#bcbfc5",
    rim: "#7f838b",
    reeded: true,
  },
  halfDollar: {
    cents: 50,
    label: "half dollar",
    plural: "half dollars",
    faceValue: "50¢",
    shape: "coin",
    diameterMm: 30.61,
    metal: "#b6b9bf",
    rim: "#797d85",
    reeded: true,
  },
  dollarCoin: {
    cents: 100,
    label: "dollar coin",
    plural: "dollar coins",
    faceValue: "$1",
    shape: "coin",
    diameterMm: 26.49,
    metal: "#c9a44a",
    rim: "#8f6d1f",
    reeded: false,
  },
  oneDollarBill: {
    cents: 100,
    label: "one-dollar bill",
    plural: "one-dollar bills",
    faceValue: "$1",
    shape: "bill",
    diameterMm: 66.3,
    metal: "#d7e4d2",
    rim: "#2f6b45",
    reeded: false,
  },
  fiveDollarBill: {
    cents: 500,
    label: "five-dollar bill",
    plural: "five-dollar bills",
    faceValue: "$5",
    shape: "bill",
    diameterMm: 66.3,
    metal: "#d7e4d2",
    rim: "#2f6b45",
    reeded: false,
  },
  tenDollarBill: {
    cents: 1000,
    label: "ten-dollar bill",
    plural: "ten-dollar bills",
    faceValue: "$10",
    shape: "bill",
    diameterMm: 66.3,
    metal: "#d7e4d2",
    rim: "#2f6b45",
    reeded: false,
  },
};

/** Every denomination, ascending by value — the canonical bank display order. */
export const MONEY_DENOMINATIONS_ASCENDING: MoneyDenomination[] = (
  Object.keys(MONEY_PIECES) as MoneyDenomination[]
).sort((a, b) => MONEY_PIECES[a].cents - MONEY_PIECES[b].cents);

/** True when `value` names a denomination in the table (a total, safe guard). */
export function isMoneyDenomination(value: string): value is MoneyDenomination {
  return Object.prototype.hasOwnProperty.call(MONEY_PIECES, value);
}

/** Face value in cents, or 0 for an unknown/forged denomination string. */
export function moneyPieceCents(denomination: string): number {
  return isMoneyDenomination(denomination) ? MONEY_PIECES[denomination].cents : 0;
}

/**
 * A cent amount as kid-facing money text: under a dollar reads as `45¢`, a
 * dollar or more as `$1.35` (and `$2.00` keeps its cents so the decimal point
 * is always where a scholar expects it). Shared so the prompt, the running
 * total, and the tutor describers all format one way.
 */
export function formatMoney(cents: number): string {
  const n = Math.round(cents);
  if (n < 100) return `${n}¢`;
  return `$${(n / 100).toFixed(2)}`;
}

/**
 * The bill note's aspect ratio (US notes are 156.1mm × 66.3mm). A bill is drawn
 * as a rectangle of this shape, height-matched to the coin scale so a
 * ten-dollar bill visibly dwarfs a quarter — the same "size is data" discipline
 * the coin diameters carry.
 */
export const BILL_ASPECT = 156.1 / 66.3;

// ── face geometry, shared by the web SVG and the native react-native-svg ─────
// Both renderers draw into the SAME 0..100 square viewBox using the primitives
// below, so a coin can't quietly look like two different coins across the two
// frontends (`rabbithole-product-taste.md` T12).

/** Every face is drawn in a 100 × 100 box; a coin fills it edge to edge. */
export const FACE_BOX = 100;

/**
 * A right-facing profile bust, drawn as a low-opacity WATERMARK behind the
 * value glyph — the relief texture that makes a disc read as a struck coin
 * rather than a plain token. Deliberately generic and faint: it is not an
 * attempt at any particular portrait, and at tray size (~48px) the value glyph
 * is what a scholar actually identifies the coin by.
 */
export const COIN_PROFILE_PATH =
  "M38 82 C33 68 29 61 31 50 C32 41 38 29 50 26 C61 23 69 30 70 40 " +
  "C71 46 67 49 68 52 C69 56 66 57 65 59 C64 63 66 65 62 67 " +
  "C59 68 56 67 55 69 C54 73 57 77 55 82 Z";

/** Opacity of that watermark — present as texture, never competing with text. */
export const COIN_PROFILE_OPACITY = 0.18;

/** Radius of the coin disc inside the 100-box, leaving room for the rim stroke. */
export const COIN_RADIUS = 47;
/** Radius of the inner ring line struck inside the rim. */
export const COIN_INNER_RING_RADIUS = 39;

/** One milled-edge groove: a short radial tick just inside the coin's rim. */
export interface CoinReedTick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Round a drawn coordinate to three decimals — finer than a pixel at any size
 * this art renders, and REQUIRED for correctness on the web: `Math.cos`/`sin`
 * are not specified to be bit-identical across JS engines, so Node's server
 * render and the browser's hydration pass disagreed in the ~15th decimal place
 * and React reported a hydration mismatch it then refuses to patch (one console
 * error per coin, every page load). Rounding makes both passes emit the same
 * string. Lives here, beside the geometry, so the native renderer can't quietly
 * diverge from the web one.
 */
function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * The milled-edge grooves for a reeded coin (dime, quarter, half dollar), as
 * line segments in the 100-box. 48 ticks reads as milling without turning into
 * a moiré at tray size. Pure geometry, computed once per coin by each renderer.
 */
export function coinReedTicks(count = 48): CoinReedTick[] {
  const ticks: CoinReedTick[] = [];
  const c = FACE_BOX / 2;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ticks.push({
      x1: roundCoord(c + cos * (COIN_RADIUS - 3.5)),
      y1: roundCoord(c + sin * (COIN_RADIUS - 3.5)),
      x2: roundCoord(c + cos * COIN_RADIUS),
      y2: roundCoord(c + sin * COIN_RADIUS),
    });
  }
  return ticks;
}

/**
 * On-screen size of one piece, in px, for a given base coin size. Coins scale
 * off their real `diameterMm` relative to a quarter, so the size ORDER on
 * screen is the size order in a hand (a dime smaller than a nickel while being
 * worth more — the 2.MD.C.8 stumbling block). Bills are height-matched to a
 * touch under the base and take their width from `BILL_ASPECT`.
 */
export function moneyPieceSize(
  denomination: MoneyDenomination,
  base: number,
): { width: number; height: number } {
  const facts = MONEY_PIECES[denomination];
  if (!facts) return { width: base, height: base };
  if (facts.shape === "bill") {
    const height = roundCoord(base * 0.78);
    return { width: roundCoord(height * BILL_ASPECT), height };
  }
  const size = roundCoord(base * (facts.diameterMm / MONEY_PIECES.quarter.diameterMm));
  return { width: size, height: size };
}
