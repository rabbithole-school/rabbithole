/**
 * GameBeatCard (native) — the game doorway on the practice playlist, the RN twin
 * of web `components/practice/GameBeatCard.tsx`.
 *
 * A game beat is a teacher-bound game offered inside a run. Like the Launchpad
 * it sits ON the playlist and NEVER grades — structurally, not by convention:
 * the entry arrives as `practiceSession.gameBeat`, a sibling of the graded
 * `items` array rather than a member of it, so nothing here can reach
 * `recordAttemptCore`. Whatever happens in the game is evidence for the teacher
 * (D-3); it buys no credit either way, which is exactly why passing on it costs
 * the scholar nothing.
 *
 * Two paths, both fine:
 *   - "Play it"  → record the acceptance, hand off to the full-screen GameHost.
 *   - "Not now"  → record the decline, fall through to the item underneath.
 *
 * Coming BACK from the game is deliberately not a special case. `GameHost` is
 * mounted at the app root and renders over the playlist, so this screen stays
 * mounted and `idx` is preserved for free; when the host closes, the beat is
 * done and the same index falls through to its item.
 *
 * Impression claiming mirrors the Launchpad: a query can't write, so the card
 * claims on mount and a refusal proceeds straight to practice rather than
 * showing a doorway the budget didn't allow.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation } from "convex/react";

import { openGameActivity } from "@/lib/gameHost";
import { api, type Id } from "@/lib/convex";
import { fonts, useColors, type Colors } from "@/theme";
import type { GameBeatEntry } from "../../../vendor/practice/gameBeats";

export function GameBeatCard({
  entry,
  onProceed,
}: {
  entry: GameBeatEntry;
  /** Leave the doorway and fall through to the item underneath. Called on
   *  either choice (after recording it) and if the impression claim is refused. */
  onProceed: () => void;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);

  const claimOffer = useMutation(api.practiceGames.claimGameBeatOffer);
  const accept = useMutation(api.practiceGames.acceptGameBeat);
  const decline = useMutation(api.practiceGames.declineGameBeat);

  const proceededRef = useRef(false);
  const activityId = entry.activityId as Id<"activities">;
  const [offer] = useState(() => ({ activityId, claimOffer, onProceed }));

  useEffect(() => {
    let cancelled = false;
    void offer.claimOffer({ activityId: offer.activityId })
      .then((res) => {
        if (cancelled) return;
        if (!res.claimed && !proceededRef.current) {
          proceededRef.current = true;
          offer.onProceed();
        }
      })
      .catch(() => {
        // A claim hiccup must never trap the scholar on the doorway — worst
        // case is a duplicate impression, never a lost turn and never a grade.
      });
    return () => {
      cancelled = true;
    };
  }, [offer]);

  const proceed = useCallback(() => {
    if (proceededRef.current) return;
    proceededRef.current = true;
    onProceed();
  }, [onProceed]);

  const onPlay = useCallback(() => {
    void accept({ activityId }).catch(() => {});
    // The host renders full-screen OVER this screen, so `proceed()` here is not
    // "skip the game" — it marks the beat handled so that closing the host
    // lands on the item underneath rather than back on the doorway.
    openGameActivity({ activityId, activityTitle: entry.title });
    proceed();
  }, [accept, activityId, entry.title, proceed]);

  const onNotNow = useCallback(() => {
    void decline({ activityId }).catch(() => {});
    proceed();
  }, [decline, activityId, proceed]);

  return (
    <View style={styles.card} testID="game beat card" accessibilityLabel="game beat">
      <Text style={styles.eyebrow}>A GAME FOR THIS</Text>

      <View style={styles.titleBlock}>
        <Text style={styles.title}>{entry.title}</Text>
        {entry.subtitle ? <Text style={styles.subtitle}>{entry.subtitle}</Text> : null}
      </View>

      {entry.blurb ? <Text style={styles.blurb}>{entry.blurb}</Text> : null}

      <View style={styles.forkBlock}>
        <View style={styles.forkRow}>
          <Pressable
            style={({ pressed }) => [styles.forkButton, styles.playButton, pressed && styles.pressed]}
            onPress={onPlay}
            accessibilityRole="button"
            accessibilityLabel="Play it"
            testID="game beat play"
          >
            <Text style={styles.forkButtonText}>Play it</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.forkButton, styles.skipButton, pressed && styles.pressed]}
            onPress={onNotNow}
            accessibilityRole="button"
            accessibilityLabel="Not now"
            testID="game beat not now"
          >
            <Text style={[styles.forkButtonText, styles.skipButtonText]}>Not now</Text>
          </Pressable>
        </View>
        {/* Said plainly, because it is true and because it is the whole reason a
            game can sit on a graded playlist at all. */}
        <Text style={styles.reassurance}>
          This one isn&apos;t scored. Either way, your practice picks up right after.
        </Text>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 18,
      padding: 22,
      gap: 16,
    },
    eyebrow: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.8,
      color: c.teal,
    },
    titleBlock: { gap: 4 },
    title: {
      fontFamily: fonts.bold,
      fontSize: 26,
      lineHeight: 32,
      color: c.fg,
    },
    subtitle: {
      fontFamily: fonts.regular,
      fontSize: 15,
      lineHeight: 23,
      color: c.fgMuted,
    },
    blurb: {
      fontFamily: fonts.regular,
      fontSize: 15.5,
      lineHeight: 26,
      color: c.fg,
    },
    forkBlock: { gap: 10, paddingTop: 4 },
    forkRow: { flexDirection: "row", gap: 10 },
    forkButton: {
      flex: 1,
      borderRadius: 12,
      paddingVertical: 16,
      paddingHorizontal: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    playButton: { backgroundColor: c.green },
    skipButton: { backgroundColor: c.bgSubtle, borderWidth: 1, borderColor: c.border },
    pressed: { opacity: 0.82 },
    forkButtonText: {
      fontFamily: fonts.bold,
      fontSize: 16,
      color: c.white,
      textAlign: "center",
    },
    skipButtonText: { color: c.fgMuted },
    reassurance: {
      fontFamily: fonts.regular,
      fontSize: 12.5,
      color: c.charcoalSubtle,
      textAlign: "center",
    },
  });
}
