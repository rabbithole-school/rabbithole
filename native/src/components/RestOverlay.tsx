/**
 * RestOverlay — native twin of components/RestOverlay.tsx (web). The
 * full-screen "screens down" calm state a teacher calls with a `rest` room
 * cue (see convex/roomCues.ts). A ROOM STATE, not a countdown or lockout: no
 * clock ticking down, nothing tappable, and nothing underneath is destroyed
 * — nav/session state is untouched, the overlay just sits on top until the
 * teacher clears it (or calls a new cue), purely reactively (Andy,
 * 2026-07-13). `Modal` (not an absolutely-positioned View) so it also covers
 * the native status bar/nav chrome, same idiom as BadgeAwardOverlay.
 *
 * Deliberately nothing tappable yet — a "hand-raise" affordance is a later
 * PR's scope. The Android hardware back button is a no-op here (there is no
 * scholar-side dismissal).
 */
import { Modal, StyleSheet, Text, View } from "react-native";
import { fonts, palette } from "@/theme";
import { REST_HEADLINE, restSubline } from "../../vendor/shared/roomCueCopy";

export function RestOverlay({ returnAt }: { returnAt: number | null }) {
  const subline = restSubline(returnAt);
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => {}}
    >
      <View style={styles.backdrop}>
        <Text style={styles.headline}>{REST_HEADLINE}</Text>
        {subline ? <Text style={styles.subline}>{subline}</Text> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: palette.navy[900],
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 32,
  },
  headline: {
    color: "#ffffff",
    fontFamily: fonts.bold,
    fontSize: 24,
    textAlign: "center",
  },
  subline: {
    color: "rgba(255,255,255,0.8)",
    fontFamily: fonts.regular,
    fontSize: 16,
    textAlign: "center",
  },
});
