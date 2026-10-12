"use client";

/**
 * The one canonical "night sky" wash used by the signed-out surfaces
 * (landing page + /sign-in, /sign-up).
 *
 * CONTRACT
 * --------
 * - `SHELL_BG` is the single definition of the purple→black gradient. Callers
 *   that only need the colour (a loading shell, a native inset strip) import
 *   the constant and set it as `bg` themselves.
 * - `<StarfieldBackground />` renders ONLY the star layer, `inset: 0` over its
 *   nearest positioned ancestor. It defaults to `position: absolute`, so a
 *   BAND (a header or footer section) can own its own sky: give the band
 *   `position="relative"` and `overflow="hidden"`. Pass `fixed` when the sky
 *   should span the whole viewport and stay put while content scrolls past. It does not
 *   paint the gradient, so the parent still owns `bg={SHELL_BG}` — that keeps
 *   overscroll/rubber-band areas the right colour on iPad.
 *   Usage: put it as the first child of a full-bleed container and give the
 *   real content `position: relative; zIndex: 1` so it sits above the stars.
 *   Because the layer is viewport-fixed it works both for a container that
 *   owns its own scroll (`position="fixed" inset={0} overflowY="auto"`, the
 *   landing page and AuthForm idiom) and for a plain `minH="100vh"` box — the
 *   sky stays put while content scrolls past it, which is what you want.
 * - It is `pointer-events: none` at `zIndex: 0`, so it can never eat a click.
 *
 * The stars read as weather, not decoration: 1–2px, and a twinkle you notice
 * without it competing with the copy or the sign-in form in front of it.
 *
 * Positions come from a seeded PRNG evaluated once at module load, never
 * `Math.random()` at render time — this app server-renders, and per-render
 * randomness would produce a React hydration mismatch.
 */

export const SHELL_BG =
  "linear-gradient(150deg, #3B2E7E 0%, #221A4D 42%, #0C0A18 100%)";

/** Deterministic 32-bit PRNG (mulberry32) — same sequence on server + client. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Star = {
  /** viewport percentages */
  left: number;
  top: number;
  /** px */
  size: number;
  /** peak opacity */
  opacity: number;
  /** seconds */
  duration: number;
  delay: number;
};

const STARS: Star[] = (() => {
  const rand = mulberry32(0x5ee_d17);
  const round = (n: number, places: number) => Number(n.toFixed(places));
  return Array.from({ length: 320 }, () => ({
    left: round(rand() * 100, 3),
    top: round(rand() * 100, 3),
    size: rand() < 0.78 ? 1 : 2,
    // Peak opacity 0.28–0.78. Brighter than a pure texture, still well under
    // the copy in front of it.
    opacity: round(0.28 + rand() * 0.5, 3),
    duration: round(3.5 + rand() * 4.5, 2),
    delay: round(rand() * 9, 2),
  }));
})();

const STARFIELD_CSS = `
.rh-starfield {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.rh-star {
  position: absolute;
  border-radius: 9999px;
  background: #fff;
  opacity: var(--rh-star-o);
  animation: rh-twinkle var(--rh-star-d) ease-in-out var(--rh-star-delay) infinite;
}
@keyframes rh-twinkle {
  0%, 100% { opacity: calc(var(--rh-star-o) * 0.12); }
  50% { opacity: var(--rh-star-o); }
}
.rh-starfield--fixed { position: fixed; }
@media (prefers-reduced-motion: reduce) {
  .rh-star { animation: none; opacity: var(--rh-star-o); }
}
`;

/**
 * Subtle twinkling starfield. See the CONTRACT comment at the top of this file
 * before using it somewhere new.
 */
export function StarfieldBackground({
  position = "absolute",
}: {
  /** `absolute` fills the nearest positioned ancestor (a band); `fixed` pins
   *  the sky to the viewport for a full-bleed screen. */
  position?: "absolute" | "fixed";
}) {
  return (
    <div
      className={
        position === "fixed" ? "rh-starfield rh-starfield--fixed" : "rh-starfield"
      }
      aria-hidden="true"
    >
      <style>{STARFIELD_CSS}</style>
      {STARS.map((star, i) => (
        <span
          key={i}
          className="rh-star"
          style={
            {
              left: `${star.left}%`,
              top: `${star.top}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              "--rh-star-o": String(star.opacity),
              "--rh-star-d": `${star.duration}s`,
              "--rh-star-delay": `${star.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
