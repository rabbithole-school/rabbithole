/**
 * LaunchpadCard (native) — the instructional "Launchpad" doorway, the RN twin of
 * web `components/practice/LaunchpadCard.tsx`.
 *
 * A Launchpad is a short, opt-in instructional beat the scholar meets the first
 * time a run reaches a genuinely new strand with verified content. It sits ON
 * the playlist but NEVER grades and never moves mastery — structurally, not by
 * convention: the entry arrives as `practiceSession.launchpad`, a sibling of the
 * graded `items` array rather than a member of it.
 *
 * Two equally-valid paths (no path is the "right" one, neither is remediation,
 * both lead to the same first item with identical credit):
 *   - "Try it myself"    → record the choice, go straight to the problem.
 *   - "Show me the move" → reveal a genuine worked example, then "Now you try".
 *
 * Fire-once, exactly like the web card and StoryMomentCard: on mount we CLAIM
 * the impression via `claimInstructionShown` (a query can't write, so the client
 * claims). If the claim is refused we proceed straight to practice rather than
 * showing a card we shouldn't.
 *
 * Parity (2026-07-04 standing rule) is EXPERIENCE, not feature existence: the
 * same eyebrow, title, hook, fork copy and reassurance line as web, at the same
 * relative type scale, with the same terminal-engagement semantics.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors, type Colors } from "@/theme";
import { LaunchpadAtoms } from "@/components/practice/LaunchpadContent";
import type { InstructionEntry } from "../../../vendor/practice/instructionEntries";

type CardPhase = "offer" | "example";

export function LaunchpadCard({
  scholarId,
  entry,
  onProceed,
}: {
  scholarId: Id<"users">;
  entry: InstructionEntry;
  /** Leave the doorway and start the first item. Called on either fork choice
   *  (after recording it) and if the impression claim is refused. */
  onProceed: () => void;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);

  const claimShown = useMutation(api.instruction.claimInstructionShown);
  const recordChoice = useMutation(api.instruction.recordInstructionChoice);
  const recordViewed = useMutation(api.instruction.recordInstructionViewed);
  const recordCompleted = useMutation(api.instruction.recordInstructionCompleted);

  const [phase, setPhase] = useState<CardPhase>("offer");
  const proceededRef = useRef(false);
  const [initialOffer] = useState(() => ({
    claimShown,
    entryKey: entry.key,
    onProceed,
    scholarId,
  }));

  useEffect(() => {
    let cancelled = false;
    void initialOffer.claimShown({ scholarId: initialOffer.scholarId, key: initialOffer.entryKey })
      .then((res) => {
        if (cancelled) return;
        if (!res.claimed && !proceededRef.current) {
          proceededRef.current = true;
          initialOffer.onProceed();
        }
      })
      .catch(() => {
        // A claim hiccup must never trap the scholar on the doorway — the card
        // still reads fine; worst case is a duplicate impression, never a lost
        // turn and never a grade.
      });
    return () => {
      cancelled = true;
    };
  }, [initialOffer]);

  const proceed = useCallback(() => {
    if (proceededRef.current) return;
    proceededRef.current = true;
    onProceed();
  }, [onProceed]);

  const onTryFirst = useCallback(() => {
    void recordChoice({ scholarId, key: entry.key, choice: "try" }).catch(() => {});
    proceed();
  }, [recordChoice, scholarId, entry.key, proceed]);

  const onShowMe = useCallback(() => {
    void recordChoice({ scholarId, key: entry.key, choice: "show" }).catch(() => {});
    // Viewing the worked example is a terminal engagement — it won't be re-offered.
    void recordViewed({ scholarId, key: entry.key }).catch(() => {});
    setPhase("example");
  }, [recordChoice, recordViewed, scholarId, entry.key]);

  const onNowYouTry = useCallback(() => {
    void recordCompleted({ scholarId, key: entry.key }).catch(() => {});
    proceed();
  }, [recordCompleted, scholarId, entry.key, proceed]);

  // The story hook frames the "why" up front on the offer; the method (explain +
  // worked example) is held for the Show path so "Try it myself" is a real choice.
  const hookAtom = entry.atoms.find((a) => a.kind === "story_hook");
  const methodAtoms = entry.atoms.filter((a) => a.kind !== "story_hook");

  return (
    <View style={styles.card} testID="launchpad card" accessibilityLabel="launchpad">
      <Text style={styles.eyebrow}>NEW GROUND — A QUICK LAUNCHPAD</Text>

      <View style={styles.titleBlock}>
        <Text style={styles.title}>{entry.title}</Text>
        {entry.subtitle ? <Text style={styles.subtitle}>{entry.subtitle}</Text> : null}
      </View>

      {phase === "offer" ? (
        <>
          {hookAtom && hookAtom.kind === "story_hook" ? (
            <Text style={styles.hook}>{hookAtom.hook}</Text>
          ) : null}

          <View style={styles.forkBlock}>
            <View style={styles.forkRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.forkButton,
                  styles.tryButton,
                  pressed && styles.pressed,
                ]}
                onPress={onTryFirst}
                accessibilityRole="button"
                accessibilityLabel={entry.fork.tryFirstLabel}
                testID="launchpad try first"
              >
                <Text style={styles.forkButtonText}>{entry.fork.tryFirstLabel}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.forkButton,
                  styles.showButton,
                  pressed && styles.pressed,
                ]}
                onPress={onShowMe}
                accessibilityRole="button"
                accessibilityLabel={entry.fork.showMeLabel}
                testID="launchpad show me"
              >
                <Text style={styles.forkButtonText}>{entry.fork.showMeLabel}</Text>
              </Pressable>
            </View>
            <Text style={styles.reassurance}>
              Either way works. You can pull up the example any time.
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.exampleBlock}>
          <LaunchpadAtoms atoms={methodAtoms} />
          <Pressable
            style={({ pressed }) => [styles.forkButton, styles.showButton, pressed && styles.pressed]}
            onPress={onNowYouTry}
            accessibilityRole="button"
            accessibilityLabel="Now you try"
            testID="launchpad now you try"
          >
            <Text style={styles.forkButtonText}>Now you try</Text>
          </Pressable>
        </View>
      )}
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
    hook: {
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
    tryButton: { backgroundColor: c.green },
    showButton: { backgroundColor: c.teal },
    pressed: { opacity: 0.82 },
    forkButtonText: {
      fontFamily: fonts.bold,
      fontSize: 16,
      color: c.white,
      textAlign: "center",
    },
    reassurance: {
      fontFamily: fonts.regular,
      fontSize: 12.5,
      color: c.charcoalSubtle,
      textAlign: "center",
    },
    exampleBlock: { gap: 16 },
  });
}
