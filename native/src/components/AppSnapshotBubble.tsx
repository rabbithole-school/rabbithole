import { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Modal } from "@/components/FreezableModal";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";

import { fonts, useColors } from "@/theme";

export function AppSnapshotBubble({ url }: { url: string | null }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);

  if (!url) return null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Open app snapshot"
        style={({ pressed }) => [
          styles.thumbnail,
          pressed && styles.thumbnailPressed,
        ]}
      >
        <Image
          source={{ uri: url }}
          style={styles.thumbnailImage}
          contentFit="cover"
          alt="App snapshot of the running app"
        />
        <View style={styles.caption}>
          <SymbolView name="camera.fill" size={11} tintColor={colors.white} />
          <Text style={styles.captionText}>App snapshot</Text>
        </View>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        supportedOrientations={[
          "portrait",
          "landscape",
          "landscape-left",
          "landscape-right",
        ]}
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={styles.lightbox}
          onPress={() => setOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Close app snapshot"
        >
          <Image
            source={{ uri: url }}
            style={styles.lightboxImage}
            contentFit="contain"
            alt="App snapshot of the running app"
          />
          <View style={styles.close}>
            <Text style={styles.closeText}>Close</Text>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    thumbnail: {
      width: 112,
      marginBottom: 6,
      overflow: "hidden",
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "rgba(255,255,255,0.45)",
      backgroundColor: "rgba(0,0,0,0.2)",
    },
    thumbnailPressed: { opacity: 0.82 },
    thumbnailImage: { width: 112, height: 64 },
    caption: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 7,
      paddingVertical: 4,
    },
    captionText: {
      color: colors.white,
      fontFamily: fonts.medium,
      fontSize: 10,
      lineHeight: 13,
    },
    lightbox: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      backgroundColor: "rgba(0,0,0,0.9)",
    },
    lightboxImage: { width: "100%", height: "88%" },
    close: {
      marginTop: 12,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.16)",
    },
    closeText: {
      color: colors.white,
      fontFamily: fonts.semibold,
      fontSize: 14,
    },
  });
}
