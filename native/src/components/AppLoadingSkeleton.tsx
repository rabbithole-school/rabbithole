import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { Skeleton } from "@/components/ui/Skeleton";
import { useColors } from "@/theme";

/**
 * Holds an app's place while its document is prepared (bundled libraries read
 * and verified, assets resolved): a calm pulse in the app's own frame instead
 * of a blank white rectangle. It fills only the app area, so the controls
 * around it stay live.
 */
export function AppLoadingSkeleton({
  style,
}: {
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.frame, { backgroundColor: colors.bgSubtle }, style]}
      accessible
      accessibilityLabel="Loading the app"
    >
      <Skeleton radius={16} style={styles.block} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  block: { flex: 1, margin: 16 },
});
