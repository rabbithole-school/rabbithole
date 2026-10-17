/**
 * A scholar's photo attachment, drawn the same way in every native chat that
 * takes one (the tutor session, the App designer): the thumbnail staged in the
 * composer before send, and the photo in the scholar's own turn after. State
 * and upload live in `useImageAttachment`; this file is only the two views.
 */

import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";

import { useColors } from "@/theme";

/** An attached photo in a chat turn. The URL is served beside the message row
 *  by getWithMessages; a spinner holds its place until it resolves. */
export function ImageBubble({ url }: { url: string | null }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (!url) {
    return (
      <View style={[styles.imageBubble, styles.imageLoading]}>
        <ActivityIndicator color={colors.gray300} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: url }}
      style={styles.imageBubble}
      contentFit="cover"
      alt="Attached photo"
    />
  );
}

/** The photo staged in the composer, with its upload spinner and remove. */
export function PendingPhotoChip({
  uri,
  uploading,
  onRemove,
}: {
  uri: string;
  uploading: boolean;
  onRemove: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.previewChip}>
      <Image source={{ uri }} style={styles.previewImg} alt="Attached photo" />
      {uploading && (
        <View style={styles.previewOverlay}>
          <ActivityIndicator color={colors.white} />
        </View>
      )}
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        style={styles.previewRemove}
        accessibilityRole="button"
        accessibilityLabel="Remove photo"
      >
        <SymbolView
          name="xmark.circle.fill"
          size={22}
          tintColor={colors.charcoal}
        />
      </Pressable>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    imageBubble: {
      width: 220,
      height: 220,
      borderRadius: 20,
      backgroundColor: c.gray100,
    },
    imageLoading: { alignItems: "center", justifyContent: "center" },
    previewChip: {
      width: 88,
      height: 88,
      borderRadius: 14,
      overflow: "hidden",
      backgroundColor: c.gray100,
    },
    previewImg: { width: "100%", height: "100%" },
    previewOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.3)",
    },
    previewRemove: {
      position: "absolute",
      top: 2,
      right: 2,
      backgroundColor: c.white,
      borderRadius: 11,
    },
  });
}
