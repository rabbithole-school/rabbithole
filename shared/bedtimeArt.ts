/**
 * The bedtime takeover's drawing — a bunny asleep on a cloud under a crescent
 * moon — as plain geometry, so web (inline SVG) and native (react-native-svg)
 * render the same picture from one source. Coordinates are in a 400×300
 * viewBox. The sky behind it is `BEDTIME_SKY`, the same purple→black as the
 * signed-out night sky (`components/StarfieldBackground.tsx` SHELL_BG).
 */

export const BEDTIME_VIEWBOX = { width: 400, height: 300 };

/** Top → bottom stops of the night-sky gradient. */
export const BEDTIME_SKY = ["#3B2E7E", "#221A4D", "#0C0A18"] as const;

export const BEDTIME_COLORS = {
  moon: "#FCE9A8",
  cloud: "#CFC7EE",
  fur: "#F6F3FC",
  furShade: "#E2DCF3",
  innerEar: "#F7B6CB",
  nose: "#F28FB0",
  ink: "#3B2E7E",
} as const;

export const BEDTIME_ART = {
  moon: "M326 34 a38 38 0 1 0 30 66 a32 32 0 1 1 -30 -66 z",
  cloud:
    "M66 252 q0 -26 30 -27 q10 -24 40 -19 q18 -22 50 -12 q24 -18 54 -2 q30 -12 50 12 q34 2 34 30 q0 18 -24 19 H96 q-30 0 -30 -1 z",
  body: { cx: 212, cy: 204, rx: 70, ry: 40 },
  tail: { cx: 280, cy: 198, r: 14 },
  head: { cx: 146, cy: 200, rx: 42, ry: 36 },
  // Ears lie back along the body from the top of the head; drawn over the
  // body and under the head. `rotate` is degrees about the ear's center.
  ears: [
    { cx: 204, cy: 167, rx: 44, ry: 12, rotate: 6, inner: { rx: 32, ry: 5.5 } },
    { cx: 196, cy: 180, rx: 40, ry: 11, rotate: 14, inner: { rx: 28, ry: 5 } },
  ],
  eye: "M120 196 q9 8 18 0",
  nose: { cx: 106, cy: 206, rx: 5, ry: 4 },
  blush: { cx: 134, cy: 216, rx: 8, ry: 4.5 },
  paw: { cx: 160, cy: 236, rx: 17, ry: 8 },
  // The drifting z's, smallest first (closest to the bunny).
  zs: [
    { x: 122, y: 150, size: 16 },
    { x: 100, y: 120, size: 22 },
    { x: 76, y: 84, size: 30 },
  ],
} as const;

/**
 * Seeded star positions (percent of the scene) — never Math.random at render,
 * which would mismatch the web server render.
 */
export const BEDTIME_STARS: ReadonlyArray<{
  x: number;
  y: number;
  r: number;
  delay: number;
}> = (() => {
  let a = 0x5eed;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 48 }, () => ({
    x: next() * 100,
    y: next() * 100,
    r: 0.6 + next() * 1.2,
    delay: next() * 4,
  }));
})();
