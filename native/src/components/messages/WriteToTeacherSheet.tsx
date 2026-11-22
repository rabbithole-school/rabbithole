import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";

import { AppTextInput } from "@/components/AppTextInput";
import { Modal } from "@/components/FreezableModal";
import { ScholarAvatar } from "@/components/ScholarAvatar";
import { api, type Id } from "@/lib/convex";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { fonts, useColors, type Colors } from "@/theme";
import { serverErrorMessage } from "../../../vendor/shared/serverErrorMessage";
import { WRITE_TO_TEACHER_COPY as COPY } from "../../../vendor/shared/writeToTeacher";

/**
 * A scholar writes to ONE teacher at their school
 * (`scholarMessages.startConversationWithTeacher`). The message lands in the
 * conversation they already have with that teacher, else opens one; `onSent`
 * gets that thread. Web twin: components/messaging/WriteToTeacherDialog.tsx.
 */
export function WriteToTeacherSheet({
  visible,
  onClose,
  onSent,
}: {
  visible: boolean;
  onClose: () => void;
  onSent: (threadId: Id<"parentThreads">) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {/* Mounted only while open, so every open starts from a clean draft. */}
      {visible ? (
        <SheetBody onClose={onClose} onSent={onSent} colors={colors} styles={styles} />
      ) : null}
    </Modal>
  );
}

function SheetBody({
  onClose,
  onSent,
  colors,
  styles,
}: {
  onClose: () => void;
  onSent: (threadId: Id<"parentThreads">) => void;
  colors: Colors;
  styles: Styles;
}) {
  const teachers = useQuery(api.scholarMessages.listTeachersForScholar, {});
  const start = useMutation(api.scholarMessages.startConversationWithTeacher);
  const [teacherId, setTeacherId] = useState<Id<"users"> | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // A school with one teacher has nobody to choose between.
  const chosen = teacherId ?? (teachers?.length === 1 ? teachers[0]._id : null);
  const body = text.trim();
  const canSend = chosen !== null && body.length > 0 && !sending;

  const send = async () => {
    if (!chosen) return setError(COPY.chooseFirst);
    if (!body) return setError(COPY.writeFirst);
    if (sending) return;
    setSending(true);
    setError("");
    await start({ teacherId: chosen, body }).then(
      ({ threadId }) => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        onSent(threadId);
      },
      (e: unknown) => {
        setError(serverErrorMessage(e, COPY.failed));
        setSending(false);
      },
    );
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.sheet}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          disabled={sending}
          hitSlop={10}
          style={styles.headerSide}
        >
          <Text style={styles.cancel}>{COPY.cancel}</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          {COPY.title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend }}
          onPress={() => void send()}
          disabled={!canSend}
          hitSlop={10}
          style={[styles.headerSide, styles.headerRight]}
          testID="write-to-teacher-send"
        >
          {sending ? (
            <ActivityIndicator color={colors.violet} />
          ) : (
            <Text style={[styles.send, !canSend && styles.sendDisabled]}>{COPY.send}</Text>
          )}
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>{COPY.toLabel}</Text>
        {teachers === undefined ? (
          <ActivityIndicator color={colors.violet} style={styles.loading} />
        ) : teachers.length === 0 ? (
          <Text style={styles.muted}>{COPY.noTeachers}</Text>
        ) : (
          <View style={styles.chips} accessibilityRole="radiogroup">
            {teachers.map((teacher) => {
              const selected = chosen === teacher._id;
              return (
                <Pressable
                  key={teacher._id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setTeacherId(teacher._id);
                  }}
                  disabled={sending}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <ScholarAvatar
                    name={teacher.name}
                    image={resolveUserImageUri(teacher.image)}
                    size={26}
                  />
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {teacher.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        <Text style={[styles.label, styles.messageLabel]}>{COPY.messageLabel}</Text>
        <AppTextInput
          value={text}
          onChangeText={setText}
          placeholder={COPY.placeholder}
          placeholderTextColor={colors.charcoalSubtle}
          multiline
          editable={!sending}
          style={styles.input}
          testID="write-to-teacher-input"
        />
        <Text style={styles.note}>{COPY.note}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: Colors) {
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: c.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerSide: { width: 90 },
    headerRight: { alignItems: "flex-end" },
    title: {
      flex: 1,
      textAlign: "center",
      fontSize: 17,
      fontFamily: fonts.bold,
      color: c.fg,
    },
    cancel: { fontSize: 16, fontFamily: fonts.regular, color: c.charcoalMuted },
    send: { fontSize: 16, fontFamily: fonts.bold, color: c.violet },
    sendDisabled: { color: c.charcoalSubtle },
    content: { padding: 20, gap: 10 },
    label: { fontSize: 14, fontFamily: fonts.semibold, color: c.charcoalMuted },
    messageLabel: { marginTop: 10 },
    loading: { alignSelf: "flex-start", marginVertical: 8 },
    muted: { fontSize: 15, fontFamily: fonts.regular, color: c.charcoalSubtle },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingLeft: 4,
      paddingRight: 14,
      paddingVertical: 4,
      backgroundColor: c.bg,
    },
    chipSelected: { borderColor: c.violet, backgroundColor: c.violet },
    chipText: { fontSize: 15, fontFamily: fonts.medium, color: c.charcoal },
    chipTextSelected: { color: "#fff", fontFamily: fonts.semibold },
    input: {
      minHeight: 160,
      maxHeight: 320,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingTop: 12,
      paddingBottom: 12,
      fontSize: 16,
      lineHeight: 22,
      fontFamily: fonts.regular,
      color: c.fg,
      textAlignVertical: "top",
      backgroundColor: c.bgSubtle,
    },
    note: { fontSize: 13, lineHeight: 18, fontFamily: fonts.regular, color: c.charcoalSubtle },
    error: { fontSize: 14, fontFamily: fonts.semibold, color: c.statusRed },
  });
}
