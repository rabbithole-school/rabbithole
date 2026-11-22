// Present mode's only chrome: a small corner cluster laid over the live app
// while a scholar shows it to the class. VibecodeScreen hides everything else
// (header, app row, code view, tutor line, deliverable footer, chat) and keeps
// the ONE app WebView mounted where it was, so the game keeps its state and is
// still played by touch.
//
// The TV shows the iPad through Screen Mirroring rather than a second rendering
// on an external screen (the slides path): a second WebView would be a second,
// diverging copy of the game that nobody is touching. The TV button ("Connect
// TV", then "Disconnect TV") reuses the slides path's lock release so Control
// Center can be reached both to start mirroring and to stop it.

import { useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useExternalDisplay } from "react-native-external-display";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTvButton } from "@/hooks/usePresentationSystemUI";
import {
  getAppPresentDisplayState,
  type ExternalScreen,
} from "@/lib/presentationExternalDisplay";
import { fonts, useColors } from "@/theme";
import { APP_SURFACE_COPY } from "../../../vendor/shared/appSurface";
import { useKeepAwakeUnlessBedtime } from "@/hooks/useKeepAwakeUnlessBedtime";
import {
  RecordingClock,
  type PresentingTalk,
} from "@/components/slides/SlidesPresentationNative";
import { TALK_COPY } from "@/components/talk/talkCopy";

const TV_NOT_MIRRORING =
  "The TV is connected but isn't showing this iPad.";

export function AppPresentControls({
  onDone,
  talk,
}: {
  onDone: () => void;
  /**
   * Recording a take (AppTalkSession): Start/Record and Finish/Stop beside
   * the TV button, and who is watching from the back of the room.
   */
  talk?: PresentingTalk;
}) {
  useKeepAwakeUnlessBedtime();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const screens: Readonly<Record<string, ExternalScreen>> = useExternalDisplay();
  const { offerConnect, tvNotMirroring } = getAppPresentDisplayState(screens);
  const tvButton = useTvButton(!offerConnect);
  const { restoreSystemUI } = tvButton;

  const rehearsing = talk?.mode === "rehearse";
  const takeStatus = talk?.take.status ?? "idle";
  const recordingTake = takeStatus !== "idle";
  const done = useCallback(() => {
    restoreSystemUI();
    // A take still recording ends here too, and its review opens.
    if (recordingTake && talk) talk.onStop();
    else onDone();
  }, [onDone, recordingTake, restoreSystemUI, talk]);
  const stopTake = useCallback(() => {
    restoreSystemUI();
    talk?.onStop();
  }, [restoreSystemUI, talk]);

  const note =
    talk?.take.notice ??
    tvButton.guidance ??
    (tvNotMirroring ? TV_NOT_MIRRORING : null);

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
          {talk && recordingTake ? (
            <Text style={[styles.clock, { color: colors.white }]}>
              {takeStatus === "recording" ? (
                <RecordingClock subscribe={talk.take.subscribe} />
              ) : takeStatus === "starting" ? (
                TALK_COPY.starting
              ) : (
                TALK_COPY.saving
              )}
            </Text>
          ) : null}
          {talk ? (
            <CornerButton
              label={
                recordingTake
                  ? rehearsing
                    ? TALK_COPY.finish
                    : TALK_COPY.stop
                  : rehearsing
                    ? TALK_COPY.start
                    : TALK_COPY.record
              }
              onPress={recordingTake ? stopTake : talk.take.start}
              disabled={takeStatus === "starting" || takeStatus === "stopping"}
              color={colors.white}
            />
          ) : null}
          <CornerButton
            label={tvButton.label}
            onPress={tvButton.press}
            color={colors.white}
          />
          {rehearsing && recordingTake ? null : (
            <CornerButton
              label={APP_SURFACE_COPY.stopPresenting}
              onPress={done}
              color={colors.white}
            />
          )}
        </View>
        {talk?.listener ? (
          <View style={styles.row}>
            <Text style={[styles.note, { color: colors.white }]}>
              {TALK_COPY.watching(talk.listener.name)}
            </Text>
            <CornerButton
              label={TALK_COPY.disconnect}
              onPress={talk.onDropListener}
              color={colors.white}
            />
          </View>
        ) : null}
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
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  color: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, (pressed || disabled) && styles.pressed]}
    >
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  corner: { position: "absolute", alignItems: "flex-end", gap: 8, maxWidth: 360 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  clock: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
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
