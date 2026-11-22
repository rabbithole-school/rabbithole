import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";

import { RADICAL_KEYPAD_PATH, RADICAL_KEYPAD_VIEWBOX, radicalMetrics } from "../model/radicalGeometry";

// The 2-D builder's structure-key faces. Each one draws the shape it inserts.
// Kept in their own file (no theme, no pad styles) so an app with its own key
// styling can use the faces alone.

/** A key face that LOOKS like a stacked fraction (two boxes and a bar): a
 *  structural key depicts what it inserts, never ASCII like `[]/[]`. */
export function GlyphFraction({ color }: { color: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View style={[glyphStyles.miniBox, { borderColor: color }]} />
      <View style={[glyphStyles.miniBar, { backgroundColor: color }]} />
      <View style={[glyphStyles.miniBox, { borderColor: color }]} />
    </View>
  );
}

/** A key face that LOOKS like a base box with a raised exponent box. */
export function GlyphPower({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      <View style={[glyphStyles.miniBox, { borderColor: color }]} />
      <View style={[glyphStyles.miniBox, { borderColor: color, marginTop: -6, marginLeft: 1 }]} />
    </View>
  );
}

export function GlyphSquareRoot({ color }: { color: string }) {
  const metrics = radicalMetrics(26);
  return (
    <Svg accessible={false} height={28} viewBox={RADICAL_KEYPAD_VIEWBOX} width={40}>
      <Path
        d={RADICAL_KEYPAD_PATH}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={metrics.strokeWidth}
      />
      <Rect fill="none" height={18} rx={3} stroke={color} strokeWidth={1.6} width={16} x={21} y={4} />
    </Svg>
  );
}

export function GlyphIndexedRoot({ color }: { color: string }) {
  const metrics = radicalMetrics(26, true);
  return (
    <Svg accessible={false} height={28} viewBox={RADICAL_KEYPAD_VIEWBOX} width={40}>
      <Path
        d={RADICAL_KEYPAD_PATH}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={metrics.strokeWidth}
      />
      <SvgText fill={color} fontSize={9} fontWeight="600" x={1} y={9}>
        n
      </SvgText>
      <Rect fill="none" height={18} rx={3} stroke={color} strokeWidth={1.6} width={16} x={19} y={7} />
    </Svg>
  );
}

const glyphStyles = StyleSheet.create({
  miniBox: { width: 13, height: 11, borderWidth: 1.5, borderRadius: 3 },
  miniBar: { width: 15, height: 2, marginVertical: 2, borderRadius: 1 },
});
