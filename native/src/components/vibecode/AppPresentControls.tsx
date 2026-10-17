// Present mode's only chrome: a small corner cluster laid over the live app
// while a scholar shows it to the class. VibecodeScreen hides everything else
// (header, app row, code view, tutor line, deliverable footer, chat) and keeps
// the ONE app WebView mounted where it was, so the game keeps its state and is
// still played by touch.
//
// The TV shows the iPad through Screen Mirroring rather than a second rendering
// on an external screen (the slides path): a second WebView would be a second,
// diverging copy of the game that nobody is touching. "Connect TV" reuses the
// slides path's lock release so Control Center can be reached.

import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useExternalDisplay } from "react-native-external-display";
import { useKeepAwake } from "expo-keep-awake";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { usePresentationSystemUI } from "@/hooks/usePresentationSystemUI";
import {
  CONNECT_TV_GUIDANCE,
  CONNECT_TV_LABEL,
  getAppPresentDisplayState,
  type ExternalScreen,
} from "@/lib/presentationExternalDisplay";
import { fonts, useColors } from "@/theme";
import { APP_SURFACE_COPY } from "../../../vendor/shared/appSurface";

const TV_NOT_MIRRORING =
  "The TV is connected but isn't showing this iPad.";

export function AppPresentControls({ onDone }: { onDone: () => void }) {
  useKeepAwake();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const screens: Readonly<Record<string, ExternalScreen>> = useExternalDisplay();
  const { offerConnect, tvNotMirroring } = getAppPresentDisplayState(screens);
  const { requestSystemUI, restoreSystemUI } = usePresentationSystemUI();
  const [showGuidance, setShowGuidance] = useState(false);

  // A TV arrived: the lock goes back on and the hint has done its job.
  useEffect(() => {
    if (offerConnect) return;
    restoreSystemUI();
  }, [offerConnect, restoreSystemUI]);

  const connectTV = useCallback(() => {
    requestSystemUI();
    setShowGuidance(true);
  }, [requestSystemUI]);

  const done = useCallback(() => {
    restoreSystemUI();
    onDone();
  }, [onDone, restoreSystemUI]);

  const note = offerConnect
    ? showGuidance
      ? CONNECT_TV_GUIDANCE
      : null
    : tvNotMirroring
      ? TV_NOT_MIRRORING
      : null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <StatusBar hidden />
      <View
        pointerEvents="box-none"
        style={[
          styles.corner,
          { top: insets.top + 10, right: insets.right + 10 },
        ]}
      >
        <View style={styles.row}>
          {offerConnect ? (
            <CornerButton
              label={CONNECT_TV_LABEL}
              onPress={connectTV}
              color={colors.white}
            />
          ) : null}
          <CornerButton
            label={APP_SURFACE_COPY.stopPresenting}
            onPress={done}
            color={colors.white}
          />
        </View>
        {note ? (
          <Text style={[styles.note, { color: colors.white }]}>{note}</Text>
        ) : null}
      </View>
    </View>
  );
}

function CornerButton({
  label,
  onPress,
  color,
}: {
  label: string;
  onPress: () => void;
  color: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  corner: { position: "absolute", alignItems: "flex-end", gap: 8, maxWidth: 360 },
  row: { flexDirection: "row", gap: 8 },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  pressed: { opacity: 0.6 },
  buttonText: { fontFamily: fonts.semibold, fontSize: 13 },
  note: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "right",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
});
