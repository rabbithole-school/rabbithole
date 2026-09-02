import { useEffect } from "react";
import {
  Animated,
  StyleSheet,
  useAnimatedValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { useColors } from "@/theme";

export type SkeletonProps = {
  width?: number | string;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

export function Skeleton({
  width,
  height,
  radius = 8,
  style,
}: SkeletonProps) {
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const pulse = useAnimatedValue(0.5);

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.5,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, reduceMotion]);

  const dimensions: ViewStyle = {
    height,
    ...(width === undefined
      ? {}
      : { width: width as ViewStyle["width"] }),
  };

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        styles.block,
        dimensions,
        {
          borderRadius: radius,
          backgroundColor: colors.gray200,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  block: {
    alignSelf: "stretch",
  },
});
