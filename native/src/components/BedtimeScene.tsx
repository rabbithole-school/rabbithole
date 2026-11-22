/**
 * Native twin of components/BedtimeScene.tsx: night sky, stars, a crescent
 * moon, and a bunny asleep on a cloud with z's drifting up. A declared charm
 * layer. Geometry is shared (vendor/shared/bedtimeArt.ts) so both platforms
 * draw the same picture; the z's drift with RN Animated, and hold still when
 * the scholar has Reduce Motion on.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

import { fonts } from "@/theme";
import {
  BEDTIME_ART as A,
  BEDTIME_COLORS as C,
  BEDTIME_SKY,
  BEDTIME_STARS,
  BEDTIME_VIEWBOX,
} from "../../vendor/shared/bedtimeArt";

export function BedtimeSky() {
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="rh-bedtime-sky" x1="0" y1="0" x2="0.4" y2="1">
          <Stop offset="0" stopColor={BEDTIME_SKY[0]} />
          <Stop offset="0.45" stopColor={BEDTIME_SKY[1]} />
          <Stop offset="1" stopColor={BEDTIME_SKY[2]} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#rh-bedtime-sky)" />
      {BEDTIME_STARS.map((s, i) => (
        <Circle
          key={i}
          cx={`${s.x}%`}
          cy={`${s.y}%`}
          r={s.r * 1.3}
          fill="#fff"
          opacity={0.35 + (s.delay / 4) * 0.6}
        />
      ))}
    </Svg>
  );
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce, () => {});
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduce,
    );
    return () => sub.remove();
  }, []);
  return reduce;
}

function DriftingZ({
  left,
  top,
  size,
  delayMs,
  reduceMotion,
}: {
  left: number;
  top: number;
  size: number;
  delayMs: number;
  reduceMotion: boolean;
}) {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delayMs),
        Animated.timing(progress, {
          toValue: 1,
          duration: 4500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
        Animated.delay(Math.max(0, 3000 - delayMs)),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [delayMs, progress, reduceMotion]);

  const style = reduceMotion
    ? { opacity: 0.8 }
    : {
        opacity: progress.interpolate({
          inputRange: [0, 0.25, 1],
          outputRange: [0, 0.9, 0],
        }),
        transform: [
          {
            translateX: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [0, -10],
            }),
          },
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [6, -18],
            }),
          },
        ],
      };

  return (
    <Animated.Text
      style={[
        styles.z,
        // SVG text sits on its baseline; a View's top is the glyph box top.
        { left, top: top - size, fontSize: size },
        style,
      ]}
    >
      z
    </Animated.Text>
  );
}

export function BedtimeBunny() {
  const { width: windowWidth } = useWindowDimensions();
  const width = Math.min(windowWidth * 0.7, 520);
  const scale = width / BEDTIME_VIEWBOX.width;
  const height = BEDTIME_VIEWBOX.height * scale;
  const reduceMotion = useReduceMotion();
  const zs = useMemo(
    () =>
      A.zs.map((z, i) => ({
        left: z.x * scale,
        top: z.y * scale,
        size: z.size * scale,
        delayMs: i * 1500,
      })),
    [scale],
  );

  return (
    <View style={{ width, height }}>
      <Svg
        width={width}
        height={height}
        viewBox={`0 0 ${BEDTIME_VIEWBOX.width} ${BEDTIME_VIEWBOX.height}`}
      >
        <Path d={A.moon} fill={C.moon} />
        <Path d={A.cloud} fill={C.cloud} opacity={0.9} />
        <Ellipse {...A.body} fill={C.fur} />
        <Circle {...A.tail} fill="#fff" />
        {A.ears.map((ear, i) => (
          <G key={i} rotation={ear.rotate} origin={`${ear.cx}, ${ear.cy}`}>
            <Ellipse cx={ear.cx} cy={ear.cy} rx={ear.rx} ry={ear.ry} fill={C.furShade} />
            <Ellipse
              cx={ear.cx + 4}
              cy={ear.cy}
              rx={ear.inner.rx}
              ry={ear.inner.ry}
              fill={C.innerEar}
            />
          </G>
        ))}
        <Ellipse {...A.head} fill={C.fur} />
        <Ellipse {...A.paw} fill={C.furShade} />
        <Path d={A.eye} stroke={C.ink} strokeWidth={3} strokeLinecap="round" fill="none" />
        <Ellipse {...A.nose} fill={C.nose} />
        <Ellipse {...A.blush} fill={C.innerEar} opacity={0.6} />
      </Svg>
      {zs.map((z, i) => (
        <DriftingZ key={i} {...z} reduceMotion={reduceMotion} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  z: {
    position: "absolute",
    color: "#ffffff",
    fontFamily: fonts.bold,
  },
});
