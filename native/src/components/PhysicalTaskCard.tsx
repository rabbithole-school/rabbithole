import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";

import { useImageAttachment } from "@/hooks/useImageAttachment";
import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";

/**
 * PhysicalTaskCard — the scholar-facing "Go try this" card for a tutor-suggested
 * hands-on task (Phase 2 of the physical-environment feature). The native port
 * of components/PhysicalTaskCard.tsx, rendered inline in the session stream from
 * a `role:"tool"` message whose `toolAction === "physical_task"` and whose
 * `content` is the physicalTasks id.
 *
 * The scholar can return with either "I'm back" or "Show what I found." Photo
 * returns reuse the native image attachment upload path, then call the same
 * physicalTasks.attachPhoto mutation as web so the task completes with evidence
 * and a user image message. The native app is scholar-only, so there's no
 * read-only teacher path here (the web card takes a `readOnly` prop).
 */
export function PhysicalTaskCard({
  physicalTaskId,
}: {
  physicalTaskId: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const task = useQuery(api.physicalTasks.getForCard, {
    id: physicalTaskId as Id<"physicalTasks">,
  });
  const markDone = useMutation(api.physicalTasks.markDone);
  const attachPhoto = useMutation(api.physicalTasks.attachPhoto);
  const image = useImageAttachment();
  const [returningWithPhoto, setReturningWithPhoto] = useState(false);
  const photoUrl = useQuery(
    api.files.getUrl,
    task?.photoStorageId ? { storageId: task.photoStorageId } : "skip",
  );

  if (task === undefined || task === null) return null;
  const done = task.status === "completed";
  const busy = image.uploading || returningWithPhoto;

  const handleDone = () => {
    if (busy) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void markDone({ id: task.id });
  };

  const handlePhotoReturn = async (source: "camera" | "library") => {
    if (busy) return;
    setReturningWithPhoto(true);
    try {
      const storageId = await image.attach(source);
      if (!storageId) return;
      await attachPhoto({ id: task.id, photoStorageId: storageId });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      image.clear();
    } catch (error) {
      console.warn("[physical-task] photo return failed", error);
      Alert.alert("Couldn't return with that photo", "Please try again.");
      image.clear();
    } finally {
      setReturningWithPhoto(false);
    }
  };

  const handleShowFound = () => {
    if (busy) return;
    void Haptics.selectionAsync();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", "Take Photo", "Choose Photo"],
        cancelButtonIndex: 0,
      },
      (i) => {
        if (i === 1) void handlePhotoReturn("camera");
        else if (i === 2) void handlePhotoReturn("library");
      },
    );
  };

  return (
    <View style={styles.card}>
      <View style={styles.kicker}>
        <SymbolView
          name="location.circle"
          size={18}
          tintColor={colors.violet}
        />
        <Text style={styles.kickerText}>GO TRY THIS</Text>
      </View>

      <View style={styles.equipmentRow}>
        <Text style={styles.equipment}>{task.equipmentName}</Text>
        {task.spaceName ? (
          <View style={styles.spaceRow}>
            <SymbolView
              name="map.fill"
              size={12}
              tintColor={colors.charcoalMuted}
            />
            <Text style={styles.space}>{task.spaceName}</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.prompt}>{task.prompt}</Text>

      {done ? (
        // Subtle done state — a quiet checkmark, no celebration (we don't yet
        // know how it went; the report-back in chat is where the learning is).
        <View style={styles.doneRow}>
          {task.photoStorageId ? (
            photoUrl ? (
              <Image
                source={{ uri: photoUrl }}
                style={styles.photoThumb}
                resizeMode="cover"
                alt="What the scholar found"
              />
            ) : (
              <View style={[styles.photoThumb, styles.photoThumbLoading]}>
                <ActivityIndicator color={colors.violet} size="small" />
              </View>
            )
          ) : null}
          <SymbolView
            name="checkmark"
            size={13}
            tintColor={colors.charcoalMuted}
          />
          <Text style={styles.doneText}>Returned</Text>
        </View>
      ) : (
        <View style={styles.actionsRow}>
          <Pressable
            onPress={handleDone}
            accessibilityRole="button"
            accessibilityLabel="I'm back"
            disabled={busy}
            style={({ pressed }) => [
              styles.backButton,
              (pressed || busy) && styles.buttonPressed,
            ]}
          >
            <Text style={styles.backButtonText}>I’m back</Text>
          </Pressable>
          <Pressable
            onPress={handleShowFound}
            accessibilityRole="button"
            accessibilityLabel="Show what I found"
            disabled={busy}
            style={({ pressed }) => [
              styles.photoButton,
              (pressed || busy) && styles.buttonPressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={colors.white} size="small" />
            ) : (
              <SymbolView name="camera.fill" size={15} tintColor={colors.white} />
            )}
            <Text style={styles.photoButtonText}>
              {busy ? "Adding…" : "Show what I found"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(c: ColorSet) {
  return StyleSheet.create({
    card: {
      alignSelf: "center",
      width: "100%",
      maxWidth: 460,
      backgroundColor: c.violetSubtle,
      borderWidth: 1,
      borderColor: c.violetMuted,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    kicker: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 6,
    },
    kickerText: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.8,
      color: c.violet,
    },
    equipmentRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 6,
    },
    equipment: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: c.navy,
    },
    spaceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    space: {
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.charcoalMuted,
    },
    prompt: {
      marginTop: 4,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 21,
      color: c.charcoal,
    },
    doneRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 12,
    },
    photoThumb: {
      width: 40,
      height: 40,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.violetMuted,
      backgroundColor: c.white,
    },
    photoThumbLoading: {
      alignItems: "center",
      justifyContent: "center",
    },
    doneText: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      color: c.charcoalMuted,
    },
    actionsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
      marginTop: 12,
    },
    backButton: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: c.violetMuted,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    photoButton: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: c.violetSolid,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    buttonPressed: { opacity: 0.78 },
    backButtonText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.violet,
    },
    photoButtonText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.white,
    },
  });
}
