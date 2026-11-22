/**
 * DismissButton — the quiet × on a Scholar's Prep row that dismisses it for
 * good, the RN twin of web components/ui/DismissButton.tsx: a Keep going row
 * (components/QuestionQueue, its top-right corner) and a wonder row
 * (components/ui/ListRow, after the verb). One look and one accessible name
 * ("Dismiss <title>") for both. Copy: shared/questionQueue.ts (vendored).
 *
 * Home's session rows use the same × to archive (`action` = "Archive"), so
 * every scholar list clears a row the same way.
 */

import { useMemo } from "react";
import { Pressable, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { XIcon } from "phosphor-react-native";

import { useColors, type Colors } from "@/theme";
import { QUESTION_QUEUE_COPY } from "../../../vendor/shared/questionQueue";

/** Touch target (pt): small to look at, full size to hit. */
const TOUCH = 40;

export function DismissButton({
  label,
  onPress,
  disabled = false,
  action = QUESTION_QUEUE_COPY.dismiss,
}: {
  /** The row's title, for the accessible name. */
  label: string;
  /** The verb in the accessible name ("Dismiss", or Home's "Archive"). */
  action?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${action} ${label}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <XIcon size={18} color={colors.charcoalSubtle} weight="bold" />
    </Pressable>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    button: {
      width: TOUCH,
      height: TOUCH,
      borderRadius: TOUCH / 2,
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: { backgroundColor: c.gray100 },
    disabled: { opacity: 0.5 },
  });
}
