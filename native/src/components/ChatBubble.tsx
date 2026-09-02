/**
 * ChatBubble — the ONE shared chat-turn rendering for native chat surfaces that
 * present in a sheet/drawer (the sideline tutor, the vibecode builder). It reuses
 * the canonical `chatBubbleStyles` (lib/chatBubbles.ts) — the same navy own-turn
 * bubble and bare, book-like tutor voice, at the shared `CHAT_MESSAGE_TEXT` scale
 * — so these chats never drift from the scholar tutor chat (`app/session/[id].tsx`)
 * or read at staff-sized type. Assistant turns keep the tap-to-read affordance
 * (SpeakableBubble, voice parity).
 *
 * Settled turns only. The in-flight streaming bubble stays per-screen (each owns
 * its stream state) but should use `chatBubbleStyles().bubbleText` for the same
 * metrics.
 */

import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";

import { Markdown } from "@/components/Markdown";
import { SpeakableBubble } from "@/components/SpeakableBubble";
import { chatBubbleStyles } from "@/lib/chatBubbles";
import { useColors } from "@/theme";

export function ChatBubble({
  role,
  content,
  ttsEnabled,
}: {
  role: string;
  content: string;
  ttsEnabled: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const mine = role === "user";

  if (mine) {
    return (
      <View style={[styles.row, styles.rowMine]}>
        <View style={styles.colMine}>
          <View style={[styles.bubble, styles.mine]}>
            <Text style={[styles.bubbleText, styles.textMine]}>{content}</Text>
          </View>
        </View>
      </View>
    );
  }

  // Assistant: bare (no bubble) markdown, with the same tap-to-read affordance
  // the scholar session chat gives tutor turns.
  return (
    <View style={[styles.row, styles.rowTutor]}>
      <View style={styles.colTutor}>
        <SpeakableBubble
          content={content}
          speakable
          ttsEnabled={ttsEnabled}
          align="left"
          onCopy={() => {
            void Clipboard.setStringAsync(content);
          }}
        >
          <View style={styles.tutorBare}>
            <Markdown content={content} color={colors.charcoal} />
          </View>
        </SpeakableBubble>
      </View>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    // Canonical bubble treatment (navy own-turn bubble, bare tutor voice,
    // shared text scale) — never forked per screen.
    ...chatBubbleStyles(c),
    // Row/column framing matches app/session/[id].tsx.
    row: { flexDirection: "row" },
    rowMine: { justifyContent: "flex-end" },
    rowTutor: { justifyContent: "flex-start" },
    colMine: { maxWidth: "80%", alignItems: "flex-end" },
    colTutor: { maxWidth: "80%", alignItems: "flex-start" },
  });
}
