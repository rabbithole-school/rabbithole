"use client";

/**
 * Ruler — drag the free end of a bar along a printed scale until the BAR is the
 * length the prompt asks for. The same Mafs "knob on a scale" idiom as the
 * number line, but what is graded is a LENGTH, not a position: with a non-zero
 * `startAt` the bar begins partway along the ruler, so the number its end lands
 * on is not its length (see the `RulerSpec` doc comment — the broken-ruler case
 * is the reason this kind exists and is not a number line with a skin).
 *
 * The bar is drawn as a solid band ABOVE the scale with its own end caps, so
 * "the thing being measured" and "the thing measuring it" are visibly two
 * objects laid alongside each other, exactly as on a desk.
 */
import { useEffect } from "react";
import { Mafs, Line, Text, useMovablePoint } from "mafs";
import type { KindProps } from "../Manipulative";
import type { RulerSpec } from "@/lib/manipulative/types";
import { C, wash } from "../colors";
import {
  clamp,
  initialRuler,
  liveReadoutPolicy,
  rulerLength,
  rulerPrecision,
  rulerSnapEnd,
  rulerSolved,
  rulerStart,
} from "@/lib/manipulative/logic";

/** Fixed internal x-span, like NumberLine's — every ruler renders identically
 *  regardless of how many units it prints. */
const SCALE = 10;
/** Math-space y of the ruler's baseline and of the bar's band. */
const RULE_Y = 0;
const BAR_Y = 1.35;

export function RulerManipulative({ spec, onSolvedChange, onStateChange }: KindProps<RulerSpec>) {
  const precision = rulerPrecision(spec);
  const start = rulerStart(spec);
  const toInternal = (v: number) => (v / spec.length) * SCALE;

  const knob = useMovablePoint([toInternal(initialRuler(spec).end), BAR_Y], {
    constrain: ([x]) => {
      const raw = (clamp(x, 0, SCALE) / SCALE) * spec.length;
      return [toInternal(rulerSnapEnd(spec, raw)), BAR_Y];
    },
    color: C.violet,
  });
  const end = rulerSnapEnd(spec, (knob.point[0] / SCALE) * spec.length);
  const length = rulerLength(spec, { end });
  const showLength = liveReadoutPolicy(spec).showValue;

  useEffect(() => {
    onSolvedChange(rulerSolved(spec, { end }));
    onStateChange?.({ end });
  }, [spec, end, onSolvedChange, onStateChange]);

  // Whole units get a labelled long tick; sub-unit gradations get short ones,
  // with the half mark drawn taller than the quarters — the visual hierarchy a
  // real ruler uses so a scholar can find "three and a half" without counting.
  const wholeTicks: number[] = [];
  for (let v = 0; v <= spec.length + 1e-9; v += 1) wholeTicks.push(Math.round(v));
  const subTicks: Array<{ v: number; major: boolean }> = [];
  if (precision < 1) {
    for (let v = precision; v < spec.length - 1e-9; v += precision) {
      const rounded = Math.round(v / precision) * precision;
      if (Math.abs(rounded - Math.round(rounded)) < 1e-9) continue; // a whole unit
      subTicks.push({ v: rounded, major: Math.abs((rounded * 2) % 2 - 1) < 1e-9 });
    }
  }

  const pad = 0.55;
  const barX1 = toInternal(start);
  const barX2 = toInternal(end);

  return (
    <div className="manip-mafs">
      <Mafs viewBox={{ x: [-pad, SCALE + pad], y: [-1.5, 2.4] }} pan={false} zoom={false} height={210}>
        {/* the ruler's body — a plain band so the scale reads as an object */}
        <Line.Segment point1={[0, RULE_Y]} point2={[SCALE, RULE_Y]} color={C.navy} weight={2.5} />
        <Line.Segment point1={[0, RULE_Y - 0.75]} point2={[SCALE, RULE_Y - 0.75]} color={C.line} weight={2} />
        <Line.Segment point1={[0, RULE_Y]} point2={[0, RULE_Y - 0.75]} color={C.line} weight={2} />
        <Line.Segment point1={[SCALE, RULE_Y]} point2={[SCALE, RULE_Y - 0.75]} color={C.line} weight={2} />

        {subTicks.map(({ v, major }) => (
          <Line.Segment
            key={`sub-${v}`}
            point1={[toInternal(v), RULE_Y]}
            point2={[toInternal(v), RULE_Y - (major ? 0.3 : 0.19)]}
            color={C.charcoal}
            weight={1.4}
          />
        ))}
        {wholeTicks.map((v) => (
          <Line.Segment
            key={`whole-${v}`}
            point1={[toInternal(v), RULE_Y]}
            point2={[toInternal(v), RULE_Y - 0.46]}
            color={C.navy}
            weight={2}
          />
        ))}
        {wholeTicks.map((v) => (
          <Text key={`label-${v}`} x={toInternal(v)} y={RULE_Y - 0.98} size={15} color={C.charcoal}>
            {String(v)}
          </Text>
        ))}
        <Text x={SCALE - 0.3} y={RULE_Y - 0.38} size={13} color={C.charcoal}>
          {spec.unit}
        </Text>

        {/* the bar being measured — a band with hard end caps, laid ALONGSIDE
            the ruler rather than drawn on it */}
        <Line.Segment point1={[barX1, BAR_Y]} point2={[barX2, BAR_Y]} color={C.violet} weight={16} opacity={0.28} />
        <Line.Segment point1={[barX1, BAR_Y]} point2={[barX2, BAR_Y]} color={C.violet} weight={3} />
        <Line.Segment point1={[barX1, BAR_Y - 0.34]} point2={[barX1, BAR_Y + 0.34]} color={C.violet} weight={3} />
        {/* the pinned left edge, dropped to the scale so the broken-ruler start
            is unmissable: this is where the measurement begins */}
        <Line.Segment point1={[barX1, RULE_Y]} point2={[barX1, BAR_Y]} color={C.violet} weight={1.2} opacity={0.5} />
        <Line.Segment point1={[barX2, RULE_Y]} point2={[barX2, BAR_Y]} color={C.violet} weight={1.2} opacity={0.5} />
        {knob.element}
      </Mafs>
      <div
        style={{
          textAlign: "center",
          fontSize: 15,
          fontWeight: 700,
          color: C.charcoal,
          background: wash(C.violet, 0.1),
          borderRadius: 10,
          padding: "6px 10px",
          marginTop: 4,
        }}
      >
        {/* The readout shows the SUBTRACTION FRAME — "8 − 3 = ?" — and withholds
            its result whenever the goal names the length. Printing the answer
            here is what the scholar was asked to work out: they would drag until
            the bold number matched the prompt and never read the scale, let
            alone perform `end − start`. Frame without result keeps the sentence
            the broken ruler teaches while leaving the arithmetic to the kid; a
            free explorer (no goal) has nothing to give away, so it shows the
            length outright. Same discipline as `NumberLine`, which prints no
            number at all. */}
        {formatUnit(end)} − {formatUnit(start)} ={" "}
        {showLength ? (
          <strong>
            {formatUnit(length)} {spec.unit}
          </strong>
        ) : (
          <strong>? {spec.unit}</strong>
        )}{" "}
        long
      </div>
    </div>
  );
}

/** Trim float dust off a gradation value ("3.5", "7", not "3.5000000001"). */
function formatUnit(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
