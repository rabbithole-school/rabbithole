import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "convex/react";

import { AppTextInput } from "@/components/AppTextInput";
import { Modal } from "@/components/FreezableModal";
import { PresentationButton } from "@/components/slides/SlidesPresentationNative";
import { api, type Id } from "@/lib/convex";
import { retry, setSpeaker, type MeterTakeView, type Speaker } from "@/lib/meterTakeSaver";
import { fonts, useColors, type Colors } from "@/theme";
import { TALK_COPY } from "./talkCopy";

/** What the server says about a saved take (decibelMeter.takesForRecorder). */
type SavedRow = {
  speakerId: Id<"users"> | null;
  speakerName: string | null;
  filedByTeacher: boolean;
};

/**
 * A take filmed on the Decibel meter, saved for the school: whether it has
 * saved, whose talk it is (named here, or left for a teacher to file from the
 * inbox), and Discard. Sits at the top of the review's side column.
 */
export function TakeSaveBox({
  takeId,
  save,
  row,
  onDiscard,
}: {
  takeId: string;
  save: MeterTakeView | null;
  row: SavedRow | null;
  onDiscard: () => void;
}) {
  const colors = useColors();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!save || save.state === "discarded") return null;

  // The server's word once saved; before that, a name picked here.
  const speakerName =
    save.state === "saved" ? (row?.speakerName ?? null) : (save.pendingSpeaker?.name ?? null);
  // Past the recorder's window the server refuses a change and says so.
  const filed = row?.filedByTeacher === true;

  const status =
    save.state === "saving"
      ? TALK_COPY.savingTake(save.pct)
      : save.state === "failed"
        ? (save.message ?? TALK_COPY.saveFailed)
        : speakerName
          ? TALK_COPY.savedTo(speakerName)
          : TALK_COPY.savedForTeacher;

  const choose = (speaker: Speaker | null) => {
    setPicking(false);
    setError(null);
    void setSpeaker(takeId, speaker).catch((e: unknown) => {
      console.warn("[audience] naming the speaker failed", e);
      setError(TALK_COPY.saveFailed);
    });
  };

  return (
    <View style={[styles.box, { borderColor: colors.border }]}>
      <View style={styles.statusRow}>
        {save.state === "saving" ? <ActivityIndicator color={colors.fgMuted} /> : null}
        <Text style={[styles.status, { color: colors.fg, fontFamily: fonts.medium }]}>{status}</Text>
      </View>
      {save.state === "failed" && !save.final ? (
        <PresentationButton label={TALK_COPY.tryAgain} onPress={() => retry(takeId)} colors={colors} />
      ) : null}
      {filed ? (
        <Text style={[styles.note, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
          {TALK_COPY.filedByTeacher}
        </Text>
      ) : (
        <View style={styles.actions}>
          {save.state === "failed" ? null : (
            <PresentationButton
              label={speakerName ? TALK_COPY.changeSpeaker : TALK_COPY.whoseTalk}
              onPress={() => setPicking(true)}
              colors={colors}
            />
          )}
          <PresentationButton label={TALK_COPY.discard} onPress={onDiscard} colors={colors} />
        </View>
      )}
      {error ? (
        <Text style={[styles.note, { color: colors.danger, fontFamily: fonts.regular }]}>{error}</Text>
      ) : null}
      <SpeakerSheet
        visible={picking}
        current={save.state === "saved" ? (row?.speakerId ?? null) : (save.pendingSpeaker?.id ?? null)}
        onPick={choose}
        onClose={() => setPicking(false)}
      />
    </View>
  );
}

/** "Whose talk is this?": the scholars at this school, searchable. */
function SpeakerSheet({
  visible,
  current,
  onPick,
  onClose,
}: {
  visible: boolean;
  current: Id<"users"> | null;
  onPick: (speaker: Speaker | null) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {/* Mounted only while open, so each open starts with an empty search. */}
      {visible ? <SpeakerList current={current} onPick={onPick} onClose={onClose} /> : null}
    </Modal>
  );
}

function SpeakerList({
  current,
  onPick,
  onClose,
}: {
  current: Id<"users"> | null;
  onPick: (speaker: Speaker | null) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  const styles2 = useMemo(() => sheetStyles(colors), [colors]);
  const speakers = useQuery(api.decibelMeter.speakers, {});
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (speakers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
  }, [search, speakers]);

  return (
    <View style={styles2.sheet}>
      <View style={styles2.header}>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10} style={styles2.headerSide}>
          <Text style={styles2.cancel}>{TALK_COPY.cancel}</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles2.title}>
          {TALK_COPY.whoseTalk}
        </Text>
        <View style={styles2.headerSide} />
      </View>
      <View style={styles2.searchRow}>
        <AppTextInput
          value={search}
          onChangeText={setSearch}
          placeholder={TALK_COPY.speakerSearch}
          placeholderTextColor={colors.charcoalSubtle}
          autoCorrect={false}
          style={styles2.search}
        />
      </View>
      {speakers === undefined ? (
        <ActivityIndicator color={colors.fgMuted} style={styles2.loading} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(s) => s.id}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <Pressable accessibilityRole="button" onPress={() => onPick(null)} style={styles2.row}>
              <Text style={[styles2.rowText, { color: colors.fgMuted }]}>{TALK_COPY.leaveForTeacher}</Text>
            </Pressable>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: item.id === current }}
              onPress={() => onPick({ id: item.id, name: item.name })}
              style={[styles2.row, item.id === current && { backgroundColor: colors.bgSubtle }]}
            >
              <Text style={styles2.rowText}>{item.name}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 10, marginBottom: 6 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  status: { flex: 1, fontSize: 17, lineHeight: 23 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  note: { fontSize: 16, lineHeight: 22 },
});

function sheetStyles(c: Colors) {
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
    title: { flex: 1, textAlign: "center", fontSize: 17, fontFamily: fonts.bold, color: c.fg },
    cancel: { fontSize: 16, fontFamily: fonts.regular, color: c.charcoalMuted },
    searchRow: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
    search: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 17,
      fontFamily: fonts.regular,
      color: c.fg,
    },
    loading: { marginTop: 24 },
    row: {
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowText: { fontSize: 17, fontFamily: fonts.regular, color: c.fg },
  });
}
