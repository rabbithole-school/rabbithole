/**
 * WebView-WebRTC spike harness — reach it at the `/dev-webrtc` route
 * (deep-link). Loads an HTTPS page (default: the web app's /dev-voice-spike
 * diagnostic) inside a raw react-native-webview configured with the same
 * media props ExternalAppHost uses, PLUS `mediaCapturePermissionGrantType`,
 * to answer the question that decides the native streaming-STT transport:
 *
 *   Does getUserMedia + WebRTC work inside WKWebView in OUR app on a real
 *   iPad — permission prompt behavior, secure-context, echo — well enough
 *   to ship voice via a web seam and skip a react-native-webrtc fleet
 *   rebuild? (TODO #voice-provider-bakeoff, native follow-up.)
 *
 * Dev-only harness: not linked from any scholar surface; the URL bar exists
 * so an agent/human can retarget it (e.g. a fresh Vercel preview) without
 * rebundling.
 */

import { useMemo, useState } from "react";
import { Stack } from "expo-router";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

import { fonts, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";

const DEFAULT_URL =
  process.env.EXPO_PUBLIC_VOICE_SPIKE_URL ??
  "https://rabbithole.school/dev-voice-spike";

export default function DevWebrtc() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [draft, setDraft] = useState(DEFAULT_URL);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [webViewKey, setWebViewKey] = useState(0);
  const [lastMessage, setLastMessage] = useState<string | null>(null);

  return (
    <>
      <Stack.Screen options={{ title: "WebView WebRTC spike" }} />
      <View style={styles.screen}>
        <View style={styles.bar}>
          <AppTextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://…/dev-voice-spike"
          />
          <Pressable
            style={styles.go}
            onPress={() => {
              setUrl(draft.trim());
              setWebViewKey((k) => k + 1);
            }}
          >
            <Text style={styles.goLabel}>Go</Text>
          </Pressable>
        </View>
        {lastMessage ? (
          <Text style={styles.msg} numberOfLines={2}>
            postMessage: {lastMessage}
          </Text>
        ) : null}
        <WebView
          key={webViewKey}
          source={{ uri: url }}
          style={styles.web}
          // The props under test — mirror ExternalAppHost's media config and
          // add the capture-permission policy the spike evaluates.
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          onMessage={(e) => setLastMessage(e.nativeEvent.data)}
        />
      </View>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    bar: { flexDirection: "row", gap: 8, padding: 10 },
    input: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.charcoal,
      backgroundColor: c.white,
    },
    go: {
      backgroundColor: c.violet,
      borderRadius: 8,
      paddingHorizontal: 16,
      justifyContent: "center",
    },
    goLabel: { fontFamily: fonts.semibold, fontSize: 14, color: c.white },
    msg: {
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.fgMuted,
      paddingHorizontal: 10,
      paddingBottom: 6,
    },
    web: { flex: 1 },
  });
}
