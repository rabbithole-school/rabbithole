import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAuthToken } from "@convex-dev/auth/react";
import { fetch as expoFetch } from "expo/fetch";
import { SymbolView } from "expo-symbols";

import { convexSiteUrl } from "@/lib/convex";
import { fonts, type Colors, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";

export type GameCoachMessage = {
  role: "user" | "assistant";
  content: string;
};

type GameCoachSheetProps = {
  visible: boolean;
  onClose: () => void;
  gameSessionId: string;
  /** Conversation state lives in GameHost so re-opening resumes the SAME chat. */
  messages: GameCoachMessage[];
  setMessages: (messages: GameCoachMessage[]) => void;
  ended: boolean;
  setEnded: (ended: boolean) => void;
};

export const GAME_COACH_OPENER =
  "Good call, pausing to think — what's the tricky part?";

const FALLBACK_ERROR = "Something hiccuped — try again";

export function GameCoachSheet({
  visible,
  onClose,
  gameSessionId,
  messages,
  setMessages,
  ended,
  setEnded,
}: GameCoachSheetProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const authToken = useAuthToken();
  const authTokenRef = useRef(authToken);
  const scrollRef = useRef<ScrollView>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    if (!visible) return;
    const timeout = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 0);
    return () => clearTimeout(timeout);
  }, [messages.length, loading, error, visible]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || loading || ended) return;

    const nextMessages: GameCoachMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setLoading(true);

    const token = authTokenRef.current;
    try {
      const response = await expoFetch(`${convexSiteUrl}/practice-handoff`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ gameSessionId, messages: nextMessages }),
      });
      const data = (await response.json()) as {
        reply?: unknown;
        ended?: unknown;
        error?: unknown;
      };
      if (typeof data.reply !== "string") {
        setError(typeof data.error === "string" ? data.error : FALLBACK_ERROR);
        return;
      }
      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);
      if (data.ended === true) setEnded(true);
    } catch {
      setError(FALLBACK_ERROR);
    } finally {
      setLoading(false);
    }
  }, [ended, gameSessionId, input, loading, messages, setEnded, setMessages]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close coach"
        />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Talk it through</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close coach"
              hitSlop={10}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <SymbolView
                name="xmark.circle.fill"
                size={28}
                tintColor={colors.charcoalSubtle}
              />
            </Pressable>
          </View>

          <ScrollView
            ref={scrollRef}
            style={styles.thread}
            contentContainerStyle={styles.threadContent}
            keyboardShouldPersistTaps="handled"
            accessibilityLabel="Coach conversation"
          >
            <CoachBubble
              message={{ role: "assistant", content: GAME_COACH_OPENER }}
              styles={styles}
            />
            {messages.map((message, index) => (
              <CoachBubble key={`${index}:${message.role}`} message={message} styles={styles} />
            ))}
            {loading ? (
              <View style={[styles.bubbleRow, styles.assistantRow]}>
                <View style={[styles.bubble, styles.assistantBubble]}>
                  <ActivityIndicator size="small" color={colors.teal} />
                </View>
              </View>
            ) : null}
            {error ? (
              <Text style={styles.error} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
          </ScrollView>

          {ended ? (
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Back to the game"
              style={({ pressed }) => [styles.returnButton, pressed && styles.pressed]}
            >
              <Text style={styles.returnButtonText}>Back to the game →</Text>
            </Pressable>
          ) : (
            <View style={styles.composer}>
              <AppTextInput
                value={input}
                onChangeText={setInput}
                onSubmitEditing={() => void send()}
                editable={!loading}
                placeholder="Type what you're thinking…"
                placeholderTextColor={colors.fgMuted}
                accessibilityLabel="What are you thinking about?"
                returnKeyType="send"
                submitBehavior="submit"
                multiline
                style={styles.input}
              />
              <Pressable
                onPress={() => void send()}
                disabled={!input.trim() || loading}
                accessibilityRole="button"
                accessibilityLabel="Send to coach"
                style={({ pressed }) => [
                  styles.sendButton,
                  (!input.trim() || loading) && styles.sendButtonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <SymbolView name="arrow.up.circle.fill" size={36} tintColor={colors.teal} />
              </Pressable>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CoachBubble({
  message,
  styles,
}: {
  message: GameCoachMessage;
  styles: ReturnType<typeof makeStyles>;
}) {
  const mine = message.role === "user";
  return (
    <View style={[styles.bubbleRow, mine ? styles.userRow : styles.assistantRow]}>
      <View style={[styles.bubble, mine ? styles.userBubble : styles.assistantBubble]}>
        <Text style={[styles.bubbleText, mine && styles.userBubbleText]}>
          {message.content}
        </Text>
      </View>
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    overlay: { flex: 1, justifyContent: "flex-end" },
    backdrop: {
      backgroundColor: "rgba(15, 20, 35, 0.42)",
    },
    sheet: {
      alignSelf: "center",
      width: "100%",
      maxWidth: 760,
      maxHeight: "82%",
      minHeight: 360,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      backgroundColor: colors.bg,
      paddingHorizontal: 20,
      paddingTop: 14,
      paddingBottom: 18,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    title: { fontFamily: fonts.bold, fontSize: 20, color: colors.navy },
    closeButton: { padding: 2 },
    thread: { flexGrow: 0, flexShrink: 1 },
    threadContent: { paddingVertical: 16, gap: 10 },
    bubbleRow: { width: "100%", flexDirection: "row" },
    userRow: { justifyContent: "flex-end" },
    assistantRow: { justifyContent: "flex-start" },
    bubble: {
      maxWidth: "78%",
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    userBubble: { backgroundColor: colors.navy },
    assistantBubble: {
      backgroundColor: colors.gray100,
      borderWidth: 1,
      borderColor: colors.border,
    },
    bubbleText: {
      fontFamily: fonts.regular,
      fontSize: 16,
      lineHeight: 22,
      color: colors.charcoal,
    },
    userBubbleText: { color: colors.white },
    error: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: colors.statusRed,
      paddingHorizontal: 4,
    },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 10,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    input: {
      flex: 1,
      minHeight: 50,
      maxHeight: 110,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      backgroundColor: colors.bg,
      paddingHorizontal: 14,
      paddingTop: 13,
      paddingBottom: 13,
      fontFamily: fonts.regular,
      fontSize: 16,
      color: colors.fg,
    },
    sendButton: { paddingBottom: 7 },
    sendButtonDisabled: { opacity: 0.35 },
    returnButton: {
      minHeight: 50,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 14,
      backgroundColor: colors.teal,
      marginTop: 12,
      paddingHorizontal: 20,
    },
    returnButtonText: {
      fontFamily: fonts.bold,
      fontSize: 16,
      color: colors.white,
    },
    pressed: { opacity: 0.7 },
  });
}
