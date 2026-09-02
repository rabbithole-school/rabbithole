"use client";

/**
 * The drawn face of one piece of US currency (web). A pure, non-interactive
 * `<svg>`: geometry and denomination facts come from the shared
 * `lib/manipulative/currency` table, so this file is only pixels and its native
 * twin (`native/src/components/manipulatives/CurrencyArt.native.tsx`) draws the
 * exact same shapes from the exact same numbers.
 *
 * The look deliberately continues the coin-flip tray's coin
 * (`DiceManipulative`'s `drawCoin`): a metal disc with a radial highlight, a
 * soft rim, and an inner ring. What it does NOT carry over is the flip — money
 * pieces are placed and counted, never spun, so there is no rotation here.
 */
import {
  BILL_ASPECT,
  COIN_INNER_RING_RADIUS,
  COIN_PROFILE_OPACITY,
  COIN_PROFILE_PATH,
  COIN_RADIUS,
  FACE_BOX,
  MONEY_PIECES,
  coinReedTicks,
  moneyPieceSize,
  type MoneyDenomination,
} from "@/lib/manipulative/currency";

const REED_TICKS = coinReedTicks();
/** Bill note width in the shared 100-unit face box. Derived from the ONE
 *  aspect constant rather than a hard-coded 2.354, so web and native can't
 *  drift if the note proportions ever change (native does the same). */
const BILL_W = FACE_BOX * BILL_ASPECT;

export function CurrencyArt({
  denomination,
  /** Size of a QUARTER in px; every other piece scales off its real diameter. */
  base,
  title,
}: {
  denomination: MoneyDenomination;
  base: number;
  /** Accessible name; omit inside an element that already labels itself. */
  title?: string;
}) {
  const facts = MONEY_PIECES[denomination];
  const { width, height } = moneyPieceSize(denomination, base);
  if (!facts) return null;

  const gradientId = `manip-currency-${denomination}`;
  const isBill = facts.shape === "bill";

  return (
    <svg
      width={width}
      height={height}
      viewBox={isBill ? `0 0 ${BILL_W} ${FACE_BOX}` : `0 0 ${FACE_BOX} ${FACE_BOX}`}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <radialGradient id={gradientId} cx="34%" cy="30%" r="78%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={isBill ? 0.55 : 0.85} />
          <stop offset="55%" stopColor={facts.metal} />
          <stop offset="100%" stopColor={facts.rim} stopOpacity={isBill ? 0.35 : 0.7} />
        </radialGradient>
      </defs>
      {isBill ? <BillFace denomination={denomination} gradientId={gradientId} /> : <CoinFace denomination={denomination} gradientId={gradientId} />}
    </svg>
  );
}

function CoinFace({ denomination, gradientId }: { denomination: MoneyDenomination; gradientId: string }) {
  const facts = MONEY_PIECES[denomination];
  const c = FACE_BOX / 2;
  return (
    <>
      <circle cx={c} cy={c} r={COIN_RADIUS} fill={`url(#${gradientId})`} stroke={facts.rim} strokeWidth={2.4} />
      {/* Milled edge — the dime, quarter and half dollar have grooves; the
          penny, nickel and dollar coin are smooth. A detail a kid who has
          handled the coins will recognise. */}
      {facts.reeded &&
        REED_TICKS.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={facts.rim} strokeWidth={1.1} opacity={0.55} />
        ))}
      <circle cx={c} cy={c} r={COIN_INNER_RING_RADIUS} fill="none" stroke={facts.rim} strokeWidth={1.2} opacity={0.5} />
      <path d={COIN_PROFILE_PATH} fill={facts.rim} opacity={COIN_PROFILE_OPACITY} />
      <text
        x={c}
        y={c}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={facts.faceValue.length > 2 ? 27 : 32}
        fontWeight={800}
        fill={facts.rim}
        fontFamily="system-ui, sans-serif"
      >
        {facts.faceValue}
      </text>
    </>
  );
}

function BillFace({ denomination, gradientId }: { denomination: MoneyDenomination; gradientId: string }) {
  const facts = MONEY_PIECES[denomination];
  const w = BILL_W;
  const h = FACE_BOX;
  return (
    <>
      <rect x={1.5} y={1.5} width={w - 3} height={h - 3} rx={6} fill={`url(#${gradientId})`} stroke={facts.rim} strokeWidth={2.2} />
      <rect x={8} y={8} width={w - 16} height={h - 16} rx={4} fill="none" stroke={facts.rim} strokeWidth={1} opacity={0.55} />
      {/* the portrait oval, watermarked like the coin's profile */}
      <ellipse cx={w / 2} cy={h / 2} rx={26} ry={33} fill="none" stroke={facts.rim} strokeWidth={1.2} opacity={0.6} />
      <g transform={`translate(${w / 2 - 50}, ${h / 2 - 50}) scale(0.66) translate(25, 25)`}>
        <path d={COIN_PROFILE_PATH} fill={facts.rim} opacity={COIN_PROFILE_OPACITY} />
      </g>
      <text
        x={w / 2}
        y={17}
        textAnchor="middle"
        fontSize={10}
        fontWeight={700}
        fill={facts.rim}
        letterSpacing="0.6"
        fontFamily="system-ui, sans-serif"
      >
        THE UNITED STATES OF AMERICA
      </text>
      {/* corner numerals — both across the top, leaving the bottom band for the
          denomination word (a bottom-right numeral collides with it). */}
      {[
        { x: 32, y: 42 },
        { x: w - 32, y: 42 },
      ].map((p, i) => (
        <text
          key={i}
          x={p.x}
          y={p.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={30}
          fontWeight={800}
          fill={facts.rim}
          fontFamily="system-ui, sans-serif"
        >
          {facts.faceValue}
        </text>
      ))}
      <text
        x={w / 2}
        y={h - 16}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill={facts.rim}
        letterSpacing="0.5"
        fontFamily="system-ui, sans-serif"
      >
        {facts.faceValue.replace("$", "")} DOLLAR{facts.cents === 100 ? "" : "S"}
      </text>
    </>
  );
}
