/**
 * The "I wonder…" box (TRA-677), the RN twin of web components/WonderBox.tsx.
 * It lives in one place, at the head of Today's wonders on Scholar's Prep.
 * Whatever the scholar types or says opens a chat, and Rabbithole answers
 * first (review/quests-rebuilt-proposal.html, "The model").
 *
 * Asking is `wonders.ask({ question, askedOn })`, then the chat it opened, with
 * the same words handed over as the chat's first turn (lib/wonderChat.ts): the
 * session screen sends them through its ordinary send path, so the turn is
 * persisted, streamed and retried exactly like any other.
 *
 * Talking uses the session composer's own dictation (useStreamingDictation +
 * RecordingBar), and a spoken take is asked as soon as it is transcribed,
 * after anything already typed (web parity). Its recorder is mounted only
 * while the scholar is talking, so Home holds no microphone and mints no
 * transcription secret until the mic is tapped. Copy: shared/wonderRows.ts
 * (vendored), byte-identical to web.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextInput,
} from "react-native";

import { AppTextInput } from "@/components/AppTextInput";
import { RecordingBar } from "@/components/RecordingBar";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { api } from "@/lib/convex";
import { appStatusBus } from "@/lib/appStatusBus";
import { wonderChatRoute, type WonderInputModality } from "@/lib/wonderChat";
import { fonts, useColors, type Colors } from "@/theme";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";
import { WONDER_COPY } from "../../vendor/shared/wonderRows";

/** The seed keeps at most this many characters (convex/lib/seeds.ts
 *  WONDER_QUESTION_MAX_CHARS); the box stops there so what the chat opens on
 *  and what the row lists are the same words. */
const WONDER_MAX_CHARS = 500;
const TOUCH = 44;

export type WonderBoxHandle = {
  /** Put the cursor in the box (the quiet-day "Start a Quest" button's job). */
  focus: () => void;
};

export const WonderBox = forwardRef<WonderBoxHandle>(
  function WonderBox(_props, ref) {
    const router = useRouter();
    const colors = useColors();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const ask = useMutation(api.wonders.ask);
    const inputRef = useRef<TextInput>(null);
    const [text, setText] = useState("");
    const [asking, setAsking] = useState(false);
    const [talking, setTalking] = useState(false);

    useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

    // A promise chain, not try/catch: the React Compiler bails out on a try
    // statement in a component (native's compiler baseline is checked).
    const submit = (words: string, inputModality: WonderInputModality) => {
      const question = words.trim();
      if (!question || asking) return;
      setAsking(true);
      Haptics.selectionAsync().catch(() => {});
      // The box lives on Prep only, so that is always where it was asked.
      ask({ question, askedOn: { surface: "prep" } })
        .then(
          ({ sessionId }) => {
            // Home stays mounted under the chat, so the words leave the box
            // once they are on their way (a spoken take carried the draft).
            setText("");
            router.push(wonderChatRoute(sessionId, question, inputModality));
          },
          (error: unknown) => {
            console.warn("[wonder-box] ask failed", error);
            Alert.alert(
              serverErrorMessage(error, "Couldn't ask that"),
              "Please try again.",
            );
          },
        )
        .finally(() => setAsking(false));
    };

    const startTalking = () => {
      // One recorder at a time: the session composer or a writing box may
      // still hold the mic.
      if (asking || appStatusBus.isMicOwned()) return;
      Haptics.selectionAsync().catch(() => {});
      inputRef.current?.blur();
      setTalking(true);
    };

    const hasText = text.trim().length > 0;

    return (
      <View style={styles.box}>
        {talking ? (
          <WonderDictation
            onTranscript={(spoken) =>
              submit(text.trim() ? `${text.trim()} ${spoken}` : spoken, "spoken")
            }
            onEnd={() => setTalking(false)}
          />
        ) : (
          <View style={styles.field}>
            <AppTextInput
              ref={inputRef}
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={WONDER_COPY.boxPlaceholder}
              placeholderTextColor={colors.charcoalSubtle}
              // No accessibilityLabel: iOS already reads an empty field's
              // placeholder, and a label equal to it was read twice.
              maxLength={WONDER_MAX_CHARS}
              editable={!asking}
              multiline
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={() => submit(text, "typed")}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start recording — tap to talk, tap the check to ask"
              accessibilityState={{ disabled: asking }}
              disabled={asking}
              onPress={startTalking}
              hitSlop={6}
              style={({ pressed }) => [
                styles.circle,
                styles.mic,
                pressed && styles.pressed,
                asking && styles.inert,
              ]}
            >
              <SymbolView name="mic.fill" size={18} tintColor={colors.violet} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={WONDER_COPY.boxSend}
              accessibilityState={{ busy: asking, disabled: !hasText || asking }}
              disabled={!hasText || asking}
              onPress={() => submit(text, "typed")}
              hitSlop={6}
              style={({ pressed }) => [
                styles.circle,
                styles.send,
                pressed && styles.pressed,
                !hasText && !asking && styles.inert,
              ]}
            >
              {asking ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <SymbolView name="arrow.up" size={18} tintColor={colors.white} />
              )}
            </Pressable>
          </View>
        )}
        <Text style={styles.hint}>{WONDER_COPY.boxHint}</Text>
      </View>
    );
  },
);

/**
 * The box while the scholar is talking: the session composer's dictation and
 * recording bar, started as it mounts. `onEnd` fires once the take is over
 * (sent, cancelled, or it never started, e.g. no microphone permission), so
 * the box returns to its text field.
 */
function WonderDictation({
  onTranscript,
  onEnd,
}: {
  onTranscript: (text: string) => void;
  onEnd: () => void;
}) {
  const voice = useStreamingDictation(onTranscript);
  const { start, stop, cancel } = voice;
  const active = voice.isConnecting || voice.isRecording || voice.isTranscribing;
  const [started, setStarted] = useState(false);
  const startRequestedRef = useRef(false);

  useEffect(() => {
    // Once per mount (StrictMode runs a mount effect twice in dev).
    if (startRequestedRef.current) return;
    startRequestedRef.current = true;
    start().finally(() => setStarted(true));
  }, [start]);

  useEffect(() => {
    if (started && !active) onEnd();
  }, [started, active, onEnd]);

  if (!active) return null;
  return (
    <RecordingBar
      level={voice.level}
      durationMs={voice.durationMs}
      isTranscribing={voice.isTranscribing}
      isConnecting={voice.isConnecting}
      isMaxed={voice.isMaxed}
      onCancel={() => {
        Haptics.selectionAsync().catch(() => {});
        cancel();
      }}
      onStop={() => {
        Haptics.selectionAsync().catch(() => {});
        stop();
      }}
    />
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    box: { width: "100%", gap: 6 },
    field: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 6,
      paddingLeft: 14,
      paddingRight: 6,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      backgroundColor: c.bg,
    },
    // The placeholder stays at 16pt (the design's phone-width check).
    input: {
      flex: 1,
      minHeight: TOUCH,
      maxHeight: 160,
      fontFamily: fonts.regular,
      fontSize: 16,
      lineHeight: 22,
      color: c.charcoal,
      paddingTop: 11,
      paddingBottom: 11,
    },
    circle: {
      width: TOUCH,
      height: TOUCH,
      borderRadius: TOUCH / 2,
      alignItems: "center",
      justifyContent: "center",
    },
    mic: { backgroundColor: c.violetSubtle },
    send: { backgroundColor: c.violetSolid },
    pressed: { opacity: 0.8 },
    inert: { opacity: 0.4 },
    hint: {
      paddingHorizontal: 4,
      fontFamily: fonts.medium,
      fontSize: 12,
      lineHeight: 16,
      color: c.charcoalMuted,
    },
  });
}
