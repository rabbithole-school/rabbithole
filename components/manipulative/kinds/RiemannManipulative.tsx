"use client";

/**
 * Riemann — speed over time becomes distance as area. The left-sum bars are
 * deliberately a little under the line; adding bars makes the gaps shrink.
 */
import { useEffect, useState } from "react";
import { Box, Flex, Text as ChakraText } from "@chakra-ui/react";
import { Coordinates, Line, Mafs, Polygon, Text as MafsText } from "mafs";
import type { KindProps } from "../Manipulative";
import type { RiemannSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import { leftSumArea, riemannSolved, speedAt } from "@/lib/manipulative/logic";

export function RiemannManipulative({ spec, onSolvedChange, onStateChange }: KindProps<RiemannSpec>) {
  const minBars = spec.minBars ?? 1;
  const maxBars = spec.maxBars ?? 20;
  const [bars, setBars] = useState(spec.startBars);
  const dt = spec.tMax / bars;
  const estimate = leftSumArea(spec, bars);
  const yMax = Math.max(speedAt(spec, 0), speedAt(spec, spec.tMax), spec.intercept, 1) + 1;

  useEffect(() => {
    onSolvedChange(riemannSolved(spec, { bars }));
    onStateChange?.({ bars });
  }, [spec, bars, onSolvedChange, onStateChange]);

  const rectangles = Array.from({ length: bars }, (_, i) => {
    const x0 = i * dt;
    const x1 = (i + 1) * dt;
    const h = Math.max(0, speedAt(spec, x0));
    return (
      <Polygon
        key={i}
        points={[[x0, 0], [x1, 0], [x1, h], [x0, h]]}
        color={C.cyan}
        fillOpacity={0.33}
        weight={1.4}
      />
    );
  });

  return (
    <Box>
      <div className="manip-mafs">
        <Mafs viewBox={{ x: [0, spec.tMax], y: [0, yMax] }} pan={false} zoom={false} height={360}>
          <Coordinates.Cartesian subdivisions={1} xAxis={{ labels: () => "" }} yAxis={{ labels: () => "" }} />
          {rectangles}
          <Line.Segment point1={[0, speedAt(spec, 0)]} point2={[spec.tMax, speedAt(spec, spec.tMax)]} color={C.violet} weight={4} />
          <MafsText x={spec.tMax * 0.78} y={Math.min(yMax - 0.45, speedAt(spec, spec.tMax) + 0.4)} size={17} color={C.navy}>
            speed
          </MafsText>
          <MafsText x={spec.tMax * 0.82} y={0.35} size={15} color={C.charcoal}>
            time
          </MafsText>
        </Mafs>
      </div>
      <Box mt={3}>
        <Flex justify="space-between" align="baseline" gap={3} mb={1}>
          <ChakraText fontSize="13px" fontWeight="700" color="brand.primary">
            {bars} left-sum bars
          </ChakraText>
          <ChakraText fontSize="13px" color="fg.muted">
            Distance estimate ≈ {estimate.toFixed(1)} squares
          </ChakraText>
        </Flex>
        <input
          type="range"
          min={minBars}
          max={maxBars}
          step={1}
          value={bars}
          onChange={(e) => setBars(e.currentTarget.valueAsNumber)}
          aria-label="Number of Riemann bars"
          style={{ accentColor: C.violet, height: 44, width: "100%" }}
        />
      </Box>
    </Box>
  );
}
