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
import { AppSnapshotBubble } from "@/components/AppSnapshotBubble";
import { ImageBubble } from "@/components/PhotoAttachment";
import { chatBubbleStyles } from "@/lib/chatBubbles";
import { fonts, useColors } from "@/theme";

export function ChatBubble({
  role,
  content,
  ttsEnabled,
  stopRequestedAt,
  appSnapshotUrl,
  hasImage = false,
  imageUrl,
}: {
  role: string;
  content: string;
  ttsEnabled: boolean;
  // Set on the assistant row the user cut short — renders the muted "Stopped"
  // caption beneath the finished bubble.
  stopRequestedAt?: number | null;
  appSnapshotUrl?: string | null;
  /** The scholar attached a photo to this turn; `imageUrl` may still be
   *  resolving, so presence and URL are separate. */
  hasImage?: boolean;
  imageUrl?: string | null;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const mine = role === "user";

  if (mine) {
    // A photo-only turn draws the photo alone, never an empty text bubble.
    const showBubble = !!content.trim() || !!appSnapshotUrl || !hasImage;
    return (
      <View style={[styles.row, styles.rowMine]}>
        <View style={styles.colMine}>
          {hasImage ? <ImageBubble url={imageUrl ?? null} /> : null}
          {showBubble ? (
            <View style={[styles.bubble, styles.mine]}>
              {appSnapshotUrl ? (
                <AppSnapshotBubble url={appSnapshotUrl} />
              ) : null}
              {content ? (
                <Text style={[styles.bubbleText, styles.textMine]}>
                  {content}
                </Text>
              ) : null}
            </View>
          ) : null}
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
        {stopRequestedAt != null ? (
          <Text style={styles.stopped}>Stopped</Text>
        ) : null}
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
    // The user cut this reply short — a quiet, sentence-case caption under the
    // bubble (matches the web transcript's "Stopped").
    stopped: {
      marginTop: 3,
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.charcoalSubtle,
    },
  });
}
