import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";

import type { Id } from "@/lib/convex";
import { formatCaptureDuration } from "../../vendor/shared/captureMedia";
import { fonts, palette } from "@/theme";

export type GalleryCapture = {
  captureId: Id<"captureStationCaptures">;
  mediaType: "image" | "video";
  thumbUrl: string | null;
  durationMs: number | null;
  videoUrl: string | null;
  createdAt: number;
  scholarIds: Id<"users">[];
  scholarNames: string[];
  label: string | null;
  editable: boolean;
};

export type PendingCaptureTile = { uri: string; mediaType: "image" | "video" };

/**
 * The "Captured" wall — a wrapping thumbnail grid for the right pane. An
 * in-flight upload shows first as a spinner tile; finished captures are
 * tappable (open the editor). Videos show a poster still + a duration badge.
 */
export function CaptureStationGallery({
  captures,
  pending,
  onSelect,
}: {
  captures: GalleryCapture[];
  pending?: PendingCaptureTile | null;
  onSelect: (captureId: Id<"captureStationCaptures">) => void;
}) {
  return (
    <View style={styles.grid}>
      {pending ? (
        <View style={styles.tile}>
          <View style={styles.imgWrap}>
            {pending.uri ? (
              <Image
                source={{ uri: pending.uri }}
                style={[styles.img, styles.pendingImg]}
                contentFit="cover"
                alt="Uploading capture"
              />
            ) : (
              <View style={[styles.img, styles.videoImg]} />
            )}
            <View style={styles.pendingOverlay}>
              <ActivityIndicator color={palette.white} />
            </View>
          </View>
          <Text style={styles.cap} numberOfLines={1}>
            Uploading…
          </Text>
        </View>
      ) : null}
      {captures.map((item) => (
        <Pressable
          key={item.captureId}
          accessibilityRole="button"
          accessibilityLabel={`Edit capture tagged ${
            item.scholarNames.join(", ") || "no one"
          }`}
          onPress={() => onSelect(item.captureId)}
          style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
        >
          <View style={styles.imgWrap}>
            {item.thumbUrl ? (
              <Image
                source={{ uri: item.thumbUrl }}
                style={styles.img}
                contentFit="cover"
                alt="Capture thumbnail"
              />
            ) : (
              <View style={[styles.img, styles.videoImg]}>
                <SymbolView name="video.fill" size={26} tintColor={palette.violet[300]} />
              </View>
            )}
            {item.mediaType === "video" ? (
              <View style={styles.videoBadge}>
                <SymbolView name="play.fill" size={9} tintColor={palette.white} />
                {item.durationMs != null ? (
                  <Text style={styles.videoBadgeText}>
                    {formatCaptureDuration(item.durationMs)}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <View style={styles.editBadge}>
              <SymbolView name="pencil" size={12} tintColor="rgba(255,255,255,0.95)" />
            </View>
          </View>
          <Text style={styles.cap} numberOfLines={1}>
            {item.scholarNames.length ? item.scholarNames.join(", ") : "Unassigned"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  tile: { width: 150 },
  tilePressed: { opacity: 0.7 },
  imgWrap: { position: "relative" },
  img: {
    width: 150,
    height: 116,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  pendingImg: { opacity: 0.5 },
  videoImg: {
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  pendingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "rgba(8,10,28,0.35)",
  },
  videoBadge: {
    position: "absolute",
    left: 6,
    bottom: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  videoBadgeText: {
    color: palette.white,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  editBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  cap: {
    marginTop: 6,
    color: "rgba(255,255,255,0.66)",
    fontFamily: fonts.medium,
    fontSize: 12,
    maxWidth: 150,
  },
});
