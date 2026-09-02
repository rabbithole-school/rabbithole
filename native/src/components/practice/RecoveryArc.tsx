import { useEffect, useState } from "react";
import { Animated, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";
import * as Haptics from "expo-haptics";

import {
  RECOVERY_ARC_DRAW_MS,
  RECOVERY_ARC_LENGTH,
  RECOVERY_ARC_MOTES,
  RECOVERY_ARC_MOTE_MS,
  RECOVERY_ARC_PATH,
  RECOVERY_ARC_VIEWBOX,
} from "../../../vendor/shared/recoveryCharm";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function RecoveryArc({ reduceMotion }: { reduceMotion: boolean }) {
  const [draw] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  const [motes] = useState(() =>
    RECOVERY_ARC_MOTES.map(() => new Animated.Value(reduceMotion ? 1 : 0)),
  );

  useEffect(() => {
    if (reduceMotion) {
      draw.setValue(1);
      for (const mote of motes) mote.setValue(1);
      return;
    }

    draw.setValue(0);
    for (const mote of motes) mote.setValue(0);
    const animation = Animated.parallel([
      Animated.timing(draw, {
        toValue: 1,
        duration: RECOVERY_ARC_DRAW_MS,
        useNativeDriver: false,
      }),
      ...motes.map((mote, index) =>
        Animated.timing(mote, {
          toValue: 1,
          duration: RECOVERY_ARC_MOTE_MS,
          delay: RECOVERY_ARC_MOTES[index].delayMs,
          useNativeDriver: false,
        }),
      ),
    ]);
    animation.start();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    return () => animation.stop();
  }, [draw, motes, reduceMotion]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: "100%", maxWidth: 420, height: 140, marginBottom: -12 }}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${RECOVERY_ARC_VIEWBOX.width} ${RECOVERY_ARC_VIEWBOX.height}`}
      >
        <Defs>
          <LinearGradient id="recovery-arc-gradient" x1="22" y1="120" x2="398" y2="74">
            <Stop offset="0" stopColor="#16707e" />
            <Stop offset="1" stopColor="#6d5bd0" />
          </LinearGradient>
        </Defs>
        <AnimatedPath
          d={RECOVERY_ARC_PATH}
          fill="none"
          stroke="url(#recovery-arc-gradient)"
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${RECOVERY_ARC_LENGTH} ${RECOVERY_ARC_LENGTH}`}
          strokeDashoffset={draw.interpolate({
            inputRange: [0, 1],
            outputRange: [RECOVERY_ARC_LENGTH, 0],
          })}
        />
        {RECOVERY_ARC_MOTES.map((mote, index) => (
          <AnimatedCircle
            key={`${mote.x}:${mote.y}`}
            cx={mote.x}
            cy={mote.y}
            r={mote.r}
            fill={mote.x < RECOVERY_ARC_VIEWBOX.width / 2 ? "#16707e" : "#6d5bd0"}
            opacity={motes[index]}
          />
        ))}
      </Svg>
    </View>
  );
}
