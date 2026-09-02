/**
 * RoomCueBanner — native twin of components/RoomCueBanner.tsx (web). The
 * calm, dismissible strip a scholar sees when a teacher calls a "message" or
 * "transition" room cue (see convex/roomCues.ts). Styled after the existing
 * focus-mismatch banner in session/[id].tsx (same idiom: an icon + text row
 * on a tinted background), but a distinct tint — this is a passed-through,
 * teacher-spoken note, not a restriction, so it shouldn't read as orange
 * "locked" chrome.
 *
 * Dismiss is LOCAL only (see hooks/useActiveRoomCues.ts) — never writes to
 * the server. The words are the teacher's, verbatim; this component only
 * supplies the fixed chrome around them.
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { fonts, palette } from "@/theme";
import {
  roomCueBannerText,
  type RoomCueForDisplay,
} from "../../vendor/shared/roomCueCopy";

export function RoomCueBanner({
  cue,
  onDismiss,
}: {
  cue: RoomCueForDisplay;
  onDismiss: (cueId: string) => void;
}) {
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>{roomCueBannerText(cue)}</Text>
      <Pressable
        onPress={() => onDismiss(cue.cueId)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      >
        <SymbolView name="xmark" size={15} tintColor={palette.navy[500]} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: palette.navy[200],
    backgroundColor: palette.navy[50],
  },
  text: {
    flex: 1,
    color: palette.navy[700],
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    lineHeight: 19,
  },
});
