import { View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

import {
  countablesAccessibilityLabel,
  countablesGeometry,
  type CountablesPromptVisual as CountablesPromptVisualSpec,
} from "../../../vendor/shared/practicePromptVisual";

const DOT_FILL = "#16707e";
const DOT_STROKE = "#0f4f59";
const FRAME_STROKE = "#ded8cb";
const FRAME_FILL = "#fffdfa";

export function CountablesPromptVisual({ spec }: { spec: CountablesPromptVisualSpec }) {
  const geometry = countablesGeometry(spec);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={countablesAccessibilityLabel(spec)}
      style={{ width: "100%", alignItems: "center" }}
    >
      <Svg width={geometry.width} height={geometry.height} viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
        <Defs>
          <RadialGradient id="countableDot" cx="35%" cy="30%" r="70%">
            <Stop offset="0%" stopColor="#39a2b1" />
            <Stop offset="100%" stopColor={DOT_FILL} />
          </RadialGradient>
        </Defs>
        {geometry.tenFrameCells.map((cell, i) => (
          <Rect
            key={`cell-${i}`}
            x={cell.x}
            y={cell.y}
            width={cell.width}
            height={cell.height}
            rx={i % 10 === 0 || i % 10 === 4 || i % 10 === 5 || i % 10 === 9 ? 7 : 0}
            fill={FRAME_FILL}
            stroke={FRAME_STROKE}
            strokeWidth={1.4}
          />
        ))}
        {geometry.points.map((point) => (
          <G
            key={point.index}
            transform={`translate(${point.x}, ${point.y}) rotate(${point.rotation}) scale(${point.scale})`}
          >
            <CountableMotif motif={spec.motif} r={point.r} />
          </G>
        ))}
      </Svg>
    </View>
  );
}

function CountableMotif({ motif, r }: { motif: string; r: number }) {
  switch (motif) {
    case "dot":
    default:
      return (
        <Circle
          cx={0}
          cy={0}
          r={r}
          fill="url(#countableDot)"
          stroke={DOT_STROKE}
          strokeWidth={1.5}
        />
      );
  }
}
