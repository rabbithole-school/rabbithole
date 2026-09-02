/**
 * Streaming paragraph-gap harness on iPad — reach it at the `/dev-streaming`
 * route (deep-link). Replays a canned multi-paragraph tutor reply through the
 * PRODUCTION streaming path — the exact `StreamingText` (while live) →
 * `Markdown` (once settled) handoff the scholar chat uses — so the
 * inter-paragraph gap can be eyeballed frame-by-frame.
 *
 * The bug it guards: the live reply used to render as one <Text> with literal
 * `\n\n` blank lines, so the gap between paragraphs POPPED — snapping in as the
 * next paragraph's first glyph arrived and reflowing again when the settled
 * <Markdown/> (block margins) took over. The fix lays the live reply out as
 * paragraph BLOCKS with the SAME stable margin as the settled render, so the
 * top (live) bubble and the bottom (settled reference) must line up exactly —
 * no shift as it streams, and no jump at the handoff.
 *
 * Deliberately Convex-FREE (no useQuery / no tutor call): the stream is
 * simulated on a timer, so the animation is deterministic + replayable and
 * proves the render even if the backend is down.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stack } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Markdown } from "@/components/Markdown";
import { StreamingText } from "@/components/StreamingText";
import { chatBubbleStyles } from "@/lib/chatBubbles";
import { fonts, useColors } from "@/theme";

// A realistic multi-paragraph tutor reply. Three plain paragraphs (blank-line
// separated) so the inter-paragraph gap is the thing under test.
const REPLY =
  "Great question! A rainbow happens because sunlight bends as it passes " +
  "through a raindrop, and each colour bends by a slightly different amount.\n\n" +
  "That splitting is called dispersion. Red light bends the least and violet " +
  "the most, so they fan out into the band of colours you can see.\n\n" +
  "Here's something to chew on: if every drop makes a full circle of colour, " +
  "why do you usually only see an arc? What do you think is cutting the " +
  "circle off at the bottom?";

// Chunk the reply out over time the way the SSE handler grows `streamingText`
// (setStreamingText(full) on each token burst). StreamingText's own leaky
// bucket then smooths whatever cadence we feed it.
const CHUNK_MS = 55;
const CHUNK_MIN = 2;
const CHUNK_MAX = 7;

export default function DevStreaming() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [streamed, setStreamed] = useState("");
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current != null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const replay = useCallback(() => {
    stop();
    setDone(false);
    setStreamed("");
    let i = 0;
    timer.current = setInterval(() => {
      const step = CHUNK_MIN + Math.floor(Math.random() * (CHUNK_MAX - CHUNK_MIN + 1));
      i = Math.min(REPLY.length, i + step);
      setStreamed(REPLY.slice(0, i));
      if (i >= REPLY.length) {
        stop();
        // Mirror the chat: swap to the settled <Markdown/> a beat after the last
        // token, so the wet ink dries before the handoff.
        setTimeout(() => setDone(true), 500);
      }
    }, CHUNK_MS);
  }, [stop]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starts the deterministic replay harness when this dev-only screen mounts.
    replay();
    return stop;
  }, [replay, stop]);

  return (
    <>
      <Stack.Screen options={{ title: "Streaming gap harness" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.sub}>
          The top bubble streams (StreamingText → Markdown, exactly like the chat). The bottom is the
          settled Markdown reference. The paragraph gaps must match and never pop as it streams.
        </Text>

        <Pressable style={styles.replayBtn} onPress={replay}>
          <Text style={styles.replayLabel}>{done ? "Replay ↻" : "Streaming…  (tap to restart)"}</Text>
        </Pressable>

        <Text style={styles.caption}>Live (streaming → settles)</Text>
        <View style={styles.bubbleRow}>
          <View style={styles.colTutor}>
            <View style={styles.tutorBare}>
              {done ? (
                <Markdown content={REPLY} color={colors.charcoal} />
              ) : (
                <StreamingText
                  content={streamed}
                  done={false}
                  color={colors.charcoal}
                  fadeMs={420}
                  style={styles.bubbleText}
                />
              )}
            </View>
          </View>
        </View>

        <Text style={styles.caption}>Settled reference (Markdown)</Text>
        <View style={styles.bubbleRow}>
          <View style={styles.colTutor}>
            <View style={styles.tutorBare}>
              <Markdown content={REPLY} color={colors.charcoal} />
            </View>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    ...chatBubbleStyles(c),
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    content: { padding: 20, gap: 12, paddingBottom: 64 },
    sub: { fontFamily: fonts.regular, fontSize: 14, color: c.fgMuted },
    caption: { fontFamily: fonts.semibold, fontSize: 13, color: c.charcoalSubtle, marginTop: 10 },
    bubbleRow: { flexDirection: "row", justifyContent: "flex-start" },
    colTutor: { maxWidth: "80%", alignItems: "flex-start" },
    replayBtn: {
      alignSelf: "flex-start",
      backgroundColor: c.violet,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    replayLabel: { fontFamily: fonts.semibold, fontSize: 14, color: c.white },
  });
}
