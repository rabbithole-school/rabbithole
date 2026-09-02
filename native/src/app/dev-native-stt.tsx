import { Stack } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { getNativeTTS } from "@/lib/nativeTTS";
import { fonts, useColors } from "@/theme";

type LogEntry = {
  id: number;
  elapsedMs: number;
  text: string;
};

export default function DevNativeStt() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [transcripts, setTranscripts] = useState<LogEntry[]>([]);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const turnStartedAtRef = useRef<number | null>(null);
  const nextIdRef = useRef(0);

  const append = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<LogEntry[]>>,
      text: string,
    ) => {
      const startedAt = turnStartedAtRef.current;
      setter((current) => [
        ...current,
        {
          id: nextIdRef.current++,
          elapsedMs: startedAt === null ? 0 : Date.now() - startedAt,
          text,
        },
      ]);
    },
    [],
  );

  const handleTranscript = useCallback(
    (text: string) => append(setTranscripts, text),
    [append],
  );
  const handleDiagnostic = useCallback(
    (event: string) => append(setEvents, event),
    [append],
  );
  const voice = useStreamingDictation(
    handleTranscript,
    undefined,
    handleDiagnostic,
  );

  const start = useCallback(() => {
    getNativeTTS().stop();
    turnStartedAtRef.current = Date.now();
    void voice.startRecording();
  }, [voice]);

  return (
    <>
      <Stack.Screen options={{ title: "Native streaming STT" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.surface}>
          <Text style={styles.heading}>Native streaming transcription</Text>
          <Text style={styles.readout}>
            state={voice.state} level={voice.level.toFixed(2)} duration=
            {Math.round(voice.durationMs)}ms speech={String(voice.hasSpeech)}
          </Text>
          {voice.error ? <Text style={styles.error}>{voice.error}</Text> : null}
          <View style={styles.controls}>
            <Control
              label="Start"
              onPress={start}
              disabled={voice.state !== "idle"}
              styles={styles}
            />
            <Control
              label="Stop"
              onPress={voice.stopRecording}
              disabled={voice.state !== "recording"}
              styles={styles}
            />
            <Control
              label="Cancel"
              onPress={voice.cancelRecording}
              disabled={voice.state === "idle"}
              styles={styles}
            />
          </View>
        </View>

        <Log title="Transcripts" entries={transcripts} styles={styles} />
        <Log title="Diagnostics" entries={events} styles={styles} />
      </ScrollView>
    </>
  );
}

function Control({
  label,
  onPress,
  disabled,
  styles,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

function Log({
  title,
  entries,
  styles,
}: {
  title: string;
  entries: LogEntry[];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.surface}>
      <Text style={styles.subheading}>{title}</Text>
      {entries.length === 0 ? (
        <Text style={styles.empty}>No entries yet.</Text>
      ) : (
        entries.map((entry) => (
          <Text key={entry.id} style={styles.logLine}>
            +{entry.elapsedMs}ms {entry.text}
          </Text>
        ))
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    content: { padding: 24, gap: 16, paddingBottom: 64 },
    surface: {
      backgroundColor: c.white,
      borderColor: c.border,
      borderRadius: 18,
      borderWidth: 1,
      gap: 10,
      padding: 18,
    },
    heading: { color: c.charcoal, fontFamily: fonts.bold, fontSize: 22 },
    subheading: { color: c.charcoal, fontFamily: fonts.semibold, fontSize: 17 },
    readout: { color: c.charcoalSubtle, fontFamily: fonts.mono, fontSize: 13 },
    error: { color: c.statusRed, fontFamily: fonts.semibold, fontSize: 14 },
    controls: { flexDirection: "row", gap: 10 },
    button: {
      backgroundColor: c.violet,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 10,
    },
    buttonDisabled: { opacity: 0.35 },
    buttonLabel: { color: c.white, fontFamily: fonts.semibold, fontSize: 14 },
    empty: { color: c.fgMuted, fontFamily: fonts.regular, fontSize: 14 },
    logLine: { color: c.charcoal, fontFamily: fonts.mono, fontSize: 13 },
  });
}
