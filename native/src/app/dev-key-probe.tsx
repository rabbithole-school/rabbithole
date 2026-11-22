// Dev-only: which physical keys reach the app, and through which channel?
// Logs every press from GameController (`gc`) and UIKit's sendEvent (`uikit`),
// with and without a text field focused. Used by the voice-key spike.
import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import {
  hardwareKeyEventsAvailable,
  probeHardwareKeys,
  useHardwareKeyboard,
  type KeyProbeEvent,
} from "@/lib/hardwareKeyboard";
import { MIC_KEY_PRESS_TYPE } from "@/lib/voiceKey";
import { fonts, useColors } from "@/theme";

type Row = KeyProbeEvent & { id: number; at: number };

const hex = (n?: number) => (n === undefined ? "—" : `0x${n.toString(16)}`);

export default function DevKeyProbe() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const connected = useHardwareKeyboard();
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState("");
  const nextRowId = useRef(0);

  // Only while this screen is on top, and never outside a development build:
  // the probe logs every key, including whatever a scholar types elsewhere.
  useFocusEffect(
    useCallback(() => {
      if (!__DEV__) return;
      return probeHardwareKeys((event) => {
        // Mirror to the Metro log so a probe run leaves a transcript.
        console.log(`[key-probe] ${JSON.stringify(event)}`);
        setRows((current) => [{ ...event, id: nextRowId.current++, at: Date.now() }, ...current].slice(0, 80));
      });
    }, []),
  );

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: "Key probe" }} />
      <Text style={styles.meta}>
        keyboard {connected ? "connected" : "not connected"} · key events{" "}
        {hardwareKeyEventsAvailable() ? "available" : "MISSING (rebuild the dev client)"} · mic key
        press type {MIC_KEY_PRESS_TYPE}
      </Text>
      <TextInput
        testID="key-probe-input"
        value={text}
        onChangeText={setText}
        placeholder="Tap here to test with a text field focused"
        placeholderTextColor={colors.fgMuted}
        style={styles.input}
      />
      <Pressable onPress={() => setRows([])} style={styles.clear}>
        <Text style={styles.meta}>Clear</Text>
      </Pressable>
      <ScrollView style={styles.log}>
        {rows.map((r) => (
          <Text key={r.id} style={styles.row}>
            {r.channel.padEnd(5)} {r.phase.padEnd(5)} hid {hex(r.hid).padEnd(6)}
            {r.chars !== undefined ? ` chars ${JSON.stringify(r.chars)}` : ""}
            {r.mods !== undefined ? ` mods ${hex(r.mods)}` : ""}
            {r.firstResponder ? ` fr ${r.firstResponder}` : ""}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { flex: 1, padding: 16, gap: 8, backgroundColor: colors.bg },
    meta: { fontFamily: fonts.regular, fontSize: 15, color: colors.fg },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 10,
      fontSize: 16,
      color: colors.fg,
    },
    clear: { alignSelf: "flex-start", paddingVertical: 4 },
    log: { flex: 1 },
    row: { fontFamily: fonts.mono, fontSize: 13, color: colors.fg },
  });
}
