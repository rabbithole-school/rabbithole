/**
 * CurrencyArt (native) — the RN twin of the web `components/manipulative/
 * CurrencyArt.tsx`. Same shapes, same numbers: every dimension, colour and path
 * comes from the vendored `vendor/manipulative/currency` table, so a quarter
 * cannot look like two different quarters across the two frontends.
 *
 * Non-interactive by design — the tap targets live in `Money.native`, and this
 * file is only the face. No flip, no spin: a money piece is placed and counted.
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
} from "../../../vendor/manipulative/currency";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { fonts } from "@/theme";

const REED_TICKS = coinReedTicks();
const BILL_W = FACE_BOX * BILL_ASPECT;

export function CurrencyArt({
  denomination,
  /** Size of a QUARTER in px; every other piece scales off its real diameter. */
  base,
}: {
  denomination: MoneyDenomination;
  base: number;
}) {
  const facts = MONEY_PIECES[denomination];
  if (!facts) return null;
  const { width, height } = moneyPieceSize(denomination, base);
  const isBill = facts.shape === "bill";
  const gradientId = `manip-currency-${denomination}`;

  return (
    <Svg
      width={width}
      height={height}
      viewBox={isBill ? `0 0 ${BILL_W} ${FACE_BOX}` : `0 0 ${FACE_BOX} ${FACE_BOX}`}
    >
      <Defs>
        <RadialGradient id={gradientId} cx="34%" cy="30%" r="78%">
          <Stop offset="0%" stopColor="#ffffff" stopOpacity={isBill ? 0.55 : 0.85} />
          <Stop offset="55%" stopColor={facts.metal} stopOpacity={1} />
          <Stop offset="100%" stopColor={facts.rim} stopOpacity={isBill ? 0.35 : 0.7} />
        </RadialGradient>
      </Defs>
      {isBill ? (
        <BillFace denomination={denomination} gradientId={gradientId} />
      ) : (
        <CoinFace denomination={denomination} gradientId={gradientId} />
      )}
    </Svg>
  );
}

function CoinFace({ denomination, gradientId }: { denomination: MoneyDenomination; gradientId: string }) {
  const facts = MONEY_PIECES[denomination];
  const c = FACE_BOX / 2;
  return (
    <>
      <Circle cx={c} cy={c} r={COIN_RADIUS} fill={`url(#${gradientId})`} stroke={facts.rim} strokeWidth={2.4} />
      {facts.reeded &&
        REED_TICKS.map((t, i) => (
          <Line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={facts.rim} strokeWidth={1.1} opacity={0.55} />
        ))}
      <Circle cx={c} cy={c} r={COIN_INNER_RING_RADIUS} fill="none" stroke={facts.rim} strokeWidth={1.2} opacity={0.5} />
      <Path d={COIN_PROFILE_PATH} fill={facts.rim} opacity={COIN_PROFILE_OPACITY} />
      <SvgText
        x={c}
        y={c}
        textAnchor="middle"
        // react-native-svg has no `dominantBaseline`, so the baseline is nudged
        // by roughly a third of the cap height to sit optically centred.
        dy={facts.faceValue.length > 2 ? 9 : 11}
        fontSize={facts.faceValue.length > 2 ? 27 : 32}
        fontFamily={fonts.bold}
        fill={facts.rim}
      >
        {facts.faceValue}
      </SvgText>
    </>
  );
}

function BillFace({ denomination, gradientId }: { denomination: MoneyDenomination; gradientId: string }) {
  const facts = MONEY_PIECES[denomination];
  const w = BILL_W;
  const h = FACE_BOX;
  return (
    <>
      <Rect x={1.5} y={1.5} width={w - 3} height={h - 3} rx={6} fill={`url(#${gradientId})`} stroke={facts.rim} strokeWidth={2.2} />
      <Rect x={8} y={8} width={w - 16} height={h - 16} rx={4} fill="none" stroke={facts.rim} strokeWidth={1} opacity={0.55} />
      <Ellipse cx={w / 2} cy={h / 2} rx={26} ry={33} fill="none" stroke={facts.rim} strokeWidth={1.2} opacity={0.6} />
      <G transform={`translate(${w / 2 - 50}, ${h / 2 - 50}) scale(0.66) translate(25, 25)`}>
        <Path d={COIN_PROFILE_PATH} fill={facts.rim} opacity={COIN_PROFILE_OPACITY} />
      </G>
      <SvgText x={w / 2} y={20} textAnchor="middle" fontSize={10} fontFamily={fonts.bold} fill={facts.rim}>
        THE UNITED STATES OF AMERICA
      </SvgText>
      {/* corner numerals — both across the top, leaving the bottom band for the
          denomination word (a bottom-right numeral collides with it). */}
      {[
        { x: 32, y: 52 },
        { x: w - 32, y: 52 },
      ].map((p, i) => (
        <SvgText key={i} x={p.x} y={p.y} textAnchor="middle" fontSize={30} fontFamily={fonts.bold} fill={facts.rim}>
          {facts.faceValue}
        </SvgText>
      ))}
      <SvgText x={w / 2} y={h - 14} textAnchor="middle" fontSize={11} fontFamily={fonts.bold} fill={facts.rim}>
        {`${facts.faceValue.replace("$", "")} DOLLAR${facts.cents === 100 ? "" : "S"}`}
      </SvgText>
    </>
  );
}
