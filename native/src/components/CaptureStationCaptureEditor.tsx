import { useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppTextInput } from "@/components/AppTextInput";
import type { Id } from "@/lib/convex";
import type { GalleryCapture } from "@/components/CaptureStationGallery";
import { toggleRosterSelection } from "@/lib/captureStationState";
import { clampLabelToCap } from "../../vendor/shared/portfolioLabel";
import { fonts, type Colors, useColors } from "@/theme";

type RosterScholar = { id: Id<"users">; name: string; image: string | null };

function sameSet(a: Id<"users">[], b: Id<"users">[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].map(String).sort();
  const sortedB = [...b].map(String).sort();
  return sortedA.every((id, index) => id === sortedB[index]);
}

/**
 * Tapping a captured thumbnail opens this editor to change who a photo/video is
 * tagged to, or delete it. Rendered with a `key` of the capture id so opening a
 * different capture resets local selection. Editing is blocked once a capture
 * has been curated into a lesson (`editable === false`).
 */
export function CaptureStationCaptureEditor({
  capture,
  roster,
  onClose,
  onSave,
  onSaveLabel,
  onDelete,
}: {
  capture: GalleryCapture | null;
  roster: RosterScholar[];
  onClose: () => void;
  onSave: (scholarIds: Id<"users">[]) => Promise<void>;
  onSaveLabel: (label: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [selected, setSelected] = useState<Id<"users">[]>(
    () => capture?.scholarIds ?? [],
  );
  // `busy` is the PRIMARY-flow latch: it gates re-tagging and delete only while
  // THEIR mutation is in flight. Naming deliberately never touches it (below).
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(() => capture?.label ?? "");
  // Last value we know is persisted, so a Done with no name edit is a no-op.
  const [savedName, setSavedName] = useState(() => capture?.label ?? "");
  // Naming is OPTIONAL and secondary, so it gets its OWN local pending/error
  // state and NEVER the global `busy` flag. That is the fix for the trap: a
  // slow/failed name save (offline, Convex retrying) can no longer disable
  // Cancel, Done, delete, or tagging, so a child is never stranded in the editor.
  const [nameSaving, setNameSaving] = useState(false);
  const [nameFailed, setNameFailed] = useState(false);

  const editable = capture?.editable ?? false;

  // Optional and after-the-fact: naming lives here in the review editor, never
  // in the capture path, so a scholar in a hurry taps capture and walks away.
  //
  // Persisting the name never throws and never blocks the primary flow: on
  // failure it flips a local flag and the editor keeps working. The underlying
  // Convex mutation is durable, so an offline write is retried in the background
  // rather than being reported as saved when it was not.
  const commitName = async () => {
    if (!capture || !editable || nameSaving) return;
    const next = name.trim();
    if (next === savedName) return;
    setNameSaving(true);
    setNameFailed(false);
    try {
      await onSaveLabel(next);
      setSavedName(next);
      setNameSaving(false);
    } catch {
      setNameFailed(true);
      setNameSaving(false);
    }
  };

  // Done: commit any pending name, then save the tagging change and close.
  // Committing the name is fire-and-durable — we never block closing on it, so
  // Done always closes (even offline) and Convex retries the name write in the
  // background. Cancel, by contrast, does NOT save the name.
  const done = async () => {
    if (!capture || busy) return;
    if (!editable) {
      onClose();
      return;
    }
    void commitName();
    if (!selected.length) {
      setErr("Choose at least one scholar.");
      return;
    }
    if (sameSet(selected, capture.scholarIds)) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSave(selected);
      onClose();
    } catch {
      setErr("Couldn’t save those changes. Ask a teacher.");
      setBusy(false);
    }
  };

  // Cancel is the always-available escape hatch: it never saves (not the name,
  // not the tags) and is never disabled, so a child can always leave the editor.
  const cancel = () => {
    onClose();
  };

  const confirmDelete = () => {
    Alert.alert(
      "Delete this capture?",
      "It will be removed for staff review too.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            setErr(null);
            void onDelete().catch(() => {
              setErr("Couldn’t delete that capture. Ask a teacher.");
              setBusy(false);
            });
          },
        },
      ],
    );
  };

  return (
    <Modal
      visible={capture != null}
      transparent
      animationType="fade"
      supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <View
          style={[
            styles.card,
            { marginTop: insets.top + 24, marginBottom: insets.bottom + 24 },
          ]}
        >
          {capture ? (
            <>
              <View style={styles.mediaColumn}>
                {capture.mediaType === "video" ? (
                  capture.videoUrl ? (
                    <EditorVideo uri={capture.videoUrl} style={styles.media} />
                  ) : (
                    <View style={[styles.media, styles.videoMedia]}>
                      <SymbolView
                        name="video.fill"
                        size={44}
                        tintColor={colors.violet}
                      />
                    </View>
                  )
                ) : capture.thumbUrl ? (
                  <Image
                    source={{ uri: capture.thumbUrl }}
                    style={styles.media}
                    contentFit="cover"
                    alt="Capture preview"
                  />
                ) : (
                  <View style={[styles.media, styles.videoMedia]}>
                    <SymbolView
                      name="photo"
                      size={44}
                      tintColor={colors.violet}
                    />
                  </View>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Delete capture"
                  disabled={busy || !editable}
                  onPress={confirmDelete}
                  style={({ pressed }) => [
                    styles.deleteButton,
                    (busy || !editable) && styles.buttonDisabled,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <SymbolView name="trash" size={16} tintColor={colors.statusRed} />
                  <Text style={styles.deleteText}>Delete</Text>
                </Pressable>
              </View>

              <View style={styles.editColumn}>
                <Text style={styles.fieldLabel}>Name this work</Text>
                <AppTextInput
                  style={[styles.nameInput, !editable && styles.nameInputDisabled]}
                  value={name}
                  onChangeText={(text) => setName(clampLabelToCap(text))}
                  onSubmitEditing={() => void commitName()}
                  editable={editable}
                  placeholder="Optional"
                  placeholderTextColor={colors.fgMuted}
                  returnKeyType="done"
                  autoCapitalize="sentences"
                  autoCorrect={false}
                  accessibilityLabel="Name this work"
                />
                <View style={styles.nameStatusRow}>
                  {nameSaving ? (
                    <Text style={styles.nameSavingText}>Saving…</Text>
                  ) : nameFailed ? (
                    <Text style={styles.nameErrorText}>
                      Couldn&rsquo;t save that name. Ask a teacher.
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.title}>Who&rsquo;s tagged?</Text>
                <ScrollView
                  style={styles.list}
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                >
                  {roster.map((scholar) => {
                    const isOn = selected.includes(scholar.id);
                    return (
                      <Pressable
                        key={scholar.id}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: isOn, disabled: !editable }}
                        accessibilityLabel={scholar.name}
                        disabled={!editable || busy}
                        onPress={() =>
                          setSelected((current) =>
                            toggleRosterSelection(current, scholar.id),
                          )
                        }
                        style={[
                          styles.row,
                          {
                            borderColor: isOn ? colors.violet : colors.border,
                            backgroundColor: isOn ? colors.violetSubtle : colors.bg,
                          },
                        ]}
                      >
                        <Text style={[styles.check, { color: colors.violet }]}>
                          {isOn ? "✓" : "○"}
                        </Text>
                        <Text style={[styles.rowName, { color: colors.fg }]}>
                          {scholar.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                {!editable ? (
                  <Text style={styles.note}>
                    This capture has been added to a lesson and can&rsquo;t be
                    changed here.
                  </Text>
                ) : null}
                {err ? <Text style={styles.error}>{err}</Text> : null}
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                    onPress={cancel}
                    style={({ pressed }) => [
                      styles.cancelButton,
                      pressed && styles.buttonPressed,
                    ]}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Done"
                    disabled={busy}
                    onPress={() => void done()}
                    style={({ pressed }) => [
                      styles.doneButton,
                      busy && styles.buttonDisabled,
                      pressed && styles.buttonPressed,
                    ]}
                  >
                    <Text style={styles.doneText}>Done</Text>
                  </Pressable>
                </View>
              </View>
            </>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function EditorVideo({
  uri,
  style,
}: {
  uri: string;
  style: StyleProp<ViewStyle>;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={style}
      accessibilityLabel="Capture video"
    />
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(15, 23, 42, 0.62)",
      padding: 32,
    },
    card: {
      width: "92%",
      maxWidth: 760,
      maxHeight: "88%",
      flexDirection: "row",
      gap: 32,
      borderRadius: 24,
      backgroundColor: colors.bg,
      padding: 28,
      shadowColor: "#000000",
      shadowOpacity: 0.2,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 12 },
      elevation: 12,
    },
    mediaColumn: { width: 260, gap: 16 },
    media: {
      width: 260,
      height: 200,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
    },
    videoMedia: {
      backgroundColor: colors.bgSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    deleteButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 12,
    },
    deleteText: { color: colors.statusRed, fontFamily: fonts.semibold, fontSize: 16 },
    editColumn: { flex: 1 },
    fieldLabel: {
      color: colors.fgMuted,
      fontFamily: fonts.semibold,
      fontSize: 15,
      marginBottom: 8,
    },
    nameInput: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.bg,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.fg,
      fontFamily: fonts.medium,
      fontSize: 17,
      marginBottom: 8,
    },
    nameInputDisabled: { opacity: 0.6 },
    nameStatusRow: { minHeight: 18, marginBottom: 12, justifyContent: "center" },
    nameSavingText: { color: colors.fgMuted, fontFamily: fonts.medium, fontSize: 13 },
    nameErrorText: { color: colors.statusRed, fontFamily: fonts.medium, fontSize: 13 },
    title: {
      color: colors.fg,
      fontFamily: fonts.bold,
      fontSize: 22,
      letterSpacing: -0.3,
      marginBottom: 12,
    },
    list: { flexGrow: 0 },
    row: {
      minHeight: 48,
      borderWidth: 1,
      borderRadius: 12,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      gap: 12,
      marginBottom: 8,
    },
    check: { fontSize: 21, fontFamily: fonts.bold },
    rowName: { fontFamily: fonts.medium, fontSize: 16 },
    note: {
      marginTop: 4,
      color: colors.fgMuted,
      fontFamily: fonts.regular,
      fontSize: 13,
    },
    error: {
      marginTop: 8,
      color: colors.statusRed,
      fontFamily: fonts.medium,
      fontSize: 13,
    },
    actions: {
      marginTop: "auto",
      paddingTop: 16,
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 12,
    },
    cancelButton: { borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
    cancelText: { color: colors.fgMuted, fontFamily: fonts.semibold, fontSize: 16 },
    doneButton: {
      borderRadius: 12,
      backgroundColor: colors.violetSolid,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    doneText: { color: colors.white, fontFamily: fonts.semibold, fontSize: 16 },
    buttonPressed: { opacity: 0.82 },
    buttonDisabled: { opacity: 0.5 },
  });
}
