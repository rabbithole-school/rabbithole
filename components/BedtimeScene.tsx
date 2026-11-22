"use client";

/**
 * The bedtime takeover's picture: night sky, twinkling stars, a crescent
 * moon, and a bunny asleep on a cloud with z's drifting up. A declared charm
 * layer (visual-design.md) — it's here to be lovely to an 8-year-old at
 * 8 pm, not to encode anything. Geometry: shared/bedtimeArt.ts (shared with
 * native/src/components/BedtimeScene.tsx).
 */
import {
  BEDTIME_ART as A,
  BEDTIME_COLORS as C,
  BEDTIME_SKY,
  BEDTIME_STARS,
  BEDTIME_VIEWBOX,
} from "@/shared/bedtimeArt";

const SCENE_CSS = `
.rh-bedtime-star { animation: rh-bedtime-twinkle 4s ease-in-out infinite; }
@keyframes rh-bedtime-twinkle {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
.rh-bedtime-z { animation: rh-bedtime-drift 4.5s ease-in-out infinite; opacity: 0; }
@keyframes rh-bedtime-drift {
  0% { opacity: 0; transform: translate(0, 6px); }
  25% { opacity: 0.9; }
  100% { opacity: 0; transform: translate(-10px, -18px); }
}
.rh-bedtime-breathe {
  animation: rh-bedtime-breathe 4.5s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: 50% 100%;
}
@keyframes rh-bedtime-breathe {
  0%, 100% { transform: scale(1, 1); }
  50% { transform: scale(1.015, 1.035); }
}
@media (prefers-reduced-motion: reduce) {
  .rh-bedtime-star, .rh-bedtime-breathe { animation: none; }
  .rh-bedtime-z { animation: none; opacity: 0.8; }
}
`;

export function BedtimeScene() {
  return (
    <>
      <style>{SCENE_CSS}</style>
      {/* The sky fills the screen behind everything. */}
      <svg
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="rh-bedtime-sky" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor={BEDTIME_SKY[0]} />
            <stop offset="45%" stopColor={BEDTIME_SKY[1]} />
            <stop offset="100%" stopColor={BEDTIME_SKY[2]} />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#rh-bedtime-sky)" />
        {BEDTIME_STARS.map((s, i) => (
          <circle
            key={i}
            className="rh-bedtime-star"
            cx={`${s.x}%`}
            cy={`${s.y}%`}
            r={s.r}
            fill="#fff"
            style={{ animationDelay: `${s.delay}s` }}
          />
        ))}
      </svg>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${BEDTIME_VIEWBOX.width} ${BEDTIME_VIEWBOX.height}`}
        style={{ position: "relative", width: "min(88vw, 520px)", height: "auto" }}
      >
        <path d={A.moon} fill={C.moon} />
        <path d={A.cloud} fill={C.cloud} opacity={0.9} />
        <g className="rh-bedtime-breathe">
          <ellipse {...A.body} fill={C.fur} />
          <circle {...A.tail} fill="#fff" />
          {A.ears.map((ear, i) => (
            <g key={i} transform={`rotate(${ear.rotate} ${ear.cx} ${ear.cy})`}>
              <ellipse cx={ear.cx} cy={ear.cy} rx={ear.rx} ry={ear.ry} fill={C.furShade} />
              <ellipse
                cx={ear.cx + 4}
                cy={ear.cy}
                rx={ear.inner.rx}
                ry={ear.inner.ry}
                fill={C.innerEar}
              />
            </g>
          ))}
          <ellipse {...A.head} fill={C.fur} />
          <ellipse {...A.paw} fill={C.furShade} />
          <path d={A.eye} stroke={C.ink} strokeWidth={3} strokeLinecap="round" fill="none" />
          <ellipse {...A.nose} fill={C.nose} />
          <ellipse {...A.blush} fill={C.innerEar} opacity={0.6} />
        </g>
        {A.zs.map((z, i) => (
          <text
            key={i}
            className="rh-bedtime-z"
            x={z.x}
            y={z.y}
            fontSize={z.size}
            fontWeight={700}
            fill="#fff"
            fontFamily="'Hanken Grotesk', system-ui, sans-serif"
            style={{ animationDelay: `${i * 1.5}s` }}
          >
            z
          </text>
        ))}
      </svg>
    </>
  );
}
