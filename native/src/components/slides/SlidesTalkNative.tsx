import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import type { Deck } from "../../../vendor/shared/slidesScene";
import { TakeReviewNative } from "@/components/talk/TakeReviewNative";
import { TALK_COPY } from "@/components/talk/talkCopy";
import { useTalkSession } from "@/components/talk/useTalkSession";
import type { LiveTalkMode } from "@/hooks/useLiveTalk";
import { fonts, useColors } from "@/theme";
import { SlidesPresentationNative } from "./SlidesPresentationNative";

/**
 * Presenting or rehearsing a deck with recorded takes: the speaker view with
 * Start/Record and Finish/Stop, then the review of that take beside the
 * deck's earlier ones, and round again. While it is open the school can see
 * this scholar presenting, so a BunnyPad at the back of the room can link to
 * it and film each take (audience mode).
 */
export function SlidesTalkNative({
  deck,
  deckKey,
  mode,
  slideIndex,
  onSlideIndexChange,
  onExit,
  resolveAsset,
}: {
  deck: Deck;
  deckKey: string;
  mode: LiveTalkMode;
  /** Controlled current slide; uncontrolled from the first slide when omitted. */
  slideIndex?: number;
  onSlideIndexChange?: (slideIndex: number) => void;
  onExit: () => void;
  resolveAsset?: (assetId: string) => string | null;
}) {
  const colors = useColors();
  const [uncontrolledIndex, setUncontrolledIndex] = useState(0);
  const count = deck.slides.length;
  const index = Math.max(0, Math.min(Math.max(0, count - 1), slideIndex ?? uncontrolledIndex));
  const setIndex = onSlideIndexChange ?? setUncontrolledIndex;
  const current = deck.slides[index];

  const session = useTalkSession({
    workKey: deckKey,
    kind: "slides",
    mode,
    title: deck.title || "Slides",
    slideCount: Math.max(1, count),
    slide: current ? { index, slideId: current.id } : null,
  });
  const { phase, live, take } = session;

  if (phase.kind === "presenting") {
    return (
      <SlidesPresentationNative
        deck={deck}
        slideIndex={index}
        onSlideIndexChange={setIndex}
        onExit={onExit}
        resolveAsset={resolveAsset}
        talk={{
          mode,
          take,
          onStop: session.stop,
          listener: live.listener,
          onDropListener: live.dropListener,
        }}
      />
    );
  }
  if (phase.kind === "saving") {
    return (
      <View style={[styles.saving, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.fgMuted} />
        <Text style={[styles.savingText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
          {TALK_COPY.saving}
        </Text>
      </View>
    );
  }
  return (
    <TakeReviewNative
      title={deck.title || "Your slides"}
      deck={deck}
      takes={phase.takes}
      selected={phase.selected}
      onSelect={session.selectTake}
      againLabel={mode === "rehearse" ? TALK_COPY.rehearseAgain : TALK_COPY.presentAgain}
      onAgain={() => {
        // Another rehearsal starts from the first slide; presenting again
        // picks up where the deck is.
        if (mode === "rehearse") setIndex(0);
        session.presentAgain();
      }}
      onDone={onExit}
      resolveAsset={resolveAsset}
    />
  );
}

const styles = StyleSheet.create({
  saving: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  savingText: { fontSize: 18 },
});
