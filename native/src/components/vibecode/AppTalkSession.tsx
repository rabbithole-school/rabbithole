import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Modal } from "@/components/FreezableModal";
import { TakeReviewNative } from "@/components/talk/TakeReviewNative";
import { TALK_COPY } from "@/components/talk/talkCopy";
import { useTalkSession } from "@/components/talk/useTalkSession";
import type { LiveTalkMode } from "@/hooks/useLiveTalk";
import { fonts, useColors } from "@/theme";
import { AppPresentControls } from "./AppPresentControls";

/**
 * Presenting or rehearsing a scholar's app with recorded takes, the way
 * slides do (SlidesTalkNative): the corner controls gain Start/Record and
 * Finish/Stop, a BunnyPad at the back of the room can link to the talk and
 * film it (audience mode), and each take opens its review over the app. The
 * app's one WebView stays mounted underneath the whole time, so the game
 * keeps its state between takes.
 */
export function AppTalkSession({
  appKey,
  title,
  mode,
  onDone,
}: {
  /** The app's artifact id: its takes are kept under it. */
  appKey: string;
  title: string;
  mode: LiveTalkMode;
  onDone: () => void;
}) {
  const colors = useColors();
  const session = useTalkSession({
    workKey: appKey,
    kind: "app",
    mode,
    title: title || "Your app",
    slideCount: 0,
    slide: null,
  });
  const { phase, live, take } = session;

  return (
    <>
      {phase.kind === "presenting" ? (
        <AppPresentControls
          onDone={onDone}
          talk={{
            mode,
            take,
            onStop: session.stop,
            listener: live.listener,
            onDropListener: live.dropListener,
          }}
        />
      ) : null}
      <Modal
        animationType="fade"
        presentationStyle="fullScreen"
        supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
        visible={phase.kind !== "presenting"}
        onRequestClose={onDone}
      >
        {phase.kind === "review" ? (
          <TakeReviewNative
            title={title || "Your app"}
            deck={null}
            takes={phase.takes}
            selected={phase.selected}
            onSelect={session.selectTake}
            againLabel={mode === "rehearse" ? TALK_COPY.rehearseAgain : TALK_COPY.presentAgain}
            onAgain={session.presentAgain}
            onDone={onDone}
          />
        ) : (
          <View style={[styles.saving, { backgroundColor: colors.bg }]}>
            <ActivityIndicator color={colors.fgMuted} />
            <Text style={[styles.savingText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
              {TALK_COPY.saving}
            </Text>
          </View>
        )}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  saving: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  savingText: { fontSize: 18 },
});
