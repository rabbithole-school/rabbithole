/**
 * BeginnerReplyText — a settled tutor reply for a young reader who is read to
 * (read level `listener` or `beginner`, TRA-504; shared/beginnerReading
 * `readsAlong`). A beginner sounds words out but can't read the reply on their
 * own yet; a listener doesn't read yet. Both get the read-along words; only a
 * beginner gets the your-turn line (a listener's caller passes no alphabet, so
 * a marked line never shows for them).
 *
 *   • Every word lights up while the voice says it. The `/tts` voice has no
 *     word timings, so the word is estimated from the player's clock inside
 *     each spoken sentence (shared/beginnerReading `spokenWordInMessage`).
 *   • Tap any word to hear just that word.
 *   • The letter teams they're learning keep their reading-ramp colors (the
 *     same segments GraphemeText paints, shared/graphemeSegments).
 *   • A `<your-turn>` line is set apart as THEIR line: bigger, in a card, and
 *     never read aloud by the voice. Its words can still be tapped for help.
 *     It's only shown when every word is decodable with what they know
 *     (`checkDecodable`); a line that fails is dropped, so a line they can't
 *     sound out is never presented as one they can.
 *
 * Rendered as plain text, like GraphemeText, after `beginnerDisplay` removes
 * markdown markers and lone emoji (a row of the same emoji, a counting
 * picture, stays); grapheme spans are moved onto the cleaned text.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { SymbolView } from "expo-symbols";

import { chatTextAt } from "@/lib/chatType";
import { getNativeTTS, speakUnowned } from "@/lib/nativeTTS";
import { fonts, useColors } from "@/theme";
import {
  beginnerDisplay,
  checkDecodable,
  mapSpans,
  partSpans,
  spokenWordInMessage,
  splitYourTurn,
  wordRuns,
  wordTokens,
  type DecodableAlphabet,
  type ReplyPart,
} from "../../vendor/shared/beginnerReading";
import {
  stageColor,
  toSegments,
  type GraphemeSpan,
  type GraphemeStages,
} from "../../vendor/shared/graphemeSegments";

const STAGE_FONT = { training: fonts.semibold, fading: fonts.medium } as const;
/** The your-turn line's size before young-reader steps. */
const YOUR_TURN_TEXT = { fontSize: 30, lineHeight: 42 } as const;

type Props = {
  /** The raw reply, markers included. */
  content: string;
  /** Reading-ramp spans (offsets into `content`), when the annotator ran. */
  spans?: readonly GraphemeSpan[];
  stages: GraphemeStages;
  /** What this scholar can decode — gates the your-turn styling. */
  /** Null while the inventory loads: your-turn lines wait, undecided. */
  alphabet: DecodableAlphabet | null;
  /** The bubble's text style (size, family, line height, ink). */
  style?: StyleProp<TextStyle>;
  /** Start the tap-to-talk mic to read the your-turn line aloud. Only the
   *  newest reply passes it; older cards show no mic. */
  onReadAloud?: () => void;
  /** The mic is busy (a take is open, or a reply is streaming). */
  readAloudDisabled?: boolean;
  /** Young-reader size steps (`conversationTextSteps`): the your-turn line
   *  moves up with the rest of the conversation. */
  textSteps?: number;
};

/** A reply part as shown: `text` is cleaned for a beginner (no markdown, no
 *  lone emoji — `beginnerDisplay`) and `spans` are moved onto it. */
type Part = ReplyPart & {
  styled: boolean;
  spans: { start: number; end: number; team: string }[];
};

/** A tapped word: which part, which word in it, and its text. */
type Tapped = { part: number; word: number; text: string };

export const BeginnerReplyText = memo(function BeginnerReplyText({
  content,
  spans,
  stages,
  alphabet,
  style,
  onReadAloud,
  readAloudDisabled,
  textSteps = 0,
}: Props) {
  const colors = useColors();
  const engine = getNativeTTS();

  const parts: Part[] = useMemo(() => {
    const raw = splitYourTurn(content);
    return raw
      .map((p, i) => {
        let { text, start } = p;
        // The blank lines around a your-turn line are the card's margin now.
        if (p.kind === "text" && raw[i + 1]?.kind === "yourTurn") text = text.trimEnd();
        if (p.kind === "text" && raw[i - 1]?.kind === "yourTurn") {
          const trimmed = text.trimStart();
          start += text.length - trimmed.length;
          text = trimmed;
        }
        const local = partSpans({ ...p, text, start }, spans ?? []);
        const shown = beginnerDisplay(text);
        return {
          ...p,
          text: shown.text,
          start,
          spans: mapSpans(local, shown.map),
          styled:
            p.kind === "yourTurn" && !!alphabet && checkDecodable(p.text, alphabet).ok,
        };
      })
      // A marked line the child can't decode is dropped, not shown as a
      // stray sentence: it was meant for them to read, the voice skips it,
      // and its words would only confuse. (Teachers still see it in the
      // transcript.)
      .filter((p) => p.text.length > 0 && (p.kind === "text" || p.styled));
  }, [content, alphabet, spans]);
  // What the voice reads: the ordinary text. Every marked line is skipped by
  // the voice (even one shown as plain text because it failed the check), so
  // none is part of the spoken word sequence.
  const spokenText = useMemo(
    () => parts.filter((p) => p.kind === "text").map((p) => p.text).join(" "),
    [parts],
  );
  // Word index offset of each spoken part within `spokenText`.
  const spokenOffsets = useMemo(() => {
    const out = new Map<number, number>();
    let n = 0;
    parts.forEach((p, i) => {
      if (p.kind !== "text") return;
      out.set(i, n);
      n += wordTokens(p.text).length;
    });
    return out;
  }, [parts]);

  const [tapped, setTapped] = useState<Tapped | null>(null);

  // Where the voice has got to in this reply: the voice moves forward through
  // it, so each new utterance is found AFTER the previous one (a repeated
  // sentence lights its own place, not its first).
  const cursorRef = useRef<{ utterance: string; from: number; end: number }>({
    utterance: "",
    from: 0,
    end: 0,
  });
  useEffect(() => {
    cursorRef.current = { utterance: "", from: 0, end: 0 };
  }, [spokenText]);

  // The lit word, as "part:word" (a string so the store only re-renders this
  // bubble when the word actually changes, not on every 50 ms clock tick).
  const getLit = useCallback((): string => {
    const pb = engine.playback;
    if (!pb) return "";
    if (tapped && pb.text === tapped.text) return `${tapped.part}:${tapped.word}`;
    const cursor = cursorRef.current;
    const from = pb.text === cursor.utterance ? cursor.from : cursor.end;
    const hit = spokenWordInMessage(spokenText, pb.text, pb.currentTime, pb.duration, from);
    if (hit === null) return "";
    if (pb.text !== cursor.utterance) {
      cursorRef.current = { utterance: pb.text, from: hit.end - wordTokens(pb.text).length, end: hit.end };
    }
    const idx = hit.index;
    for (const [part, offset] of spokenOffsets) {
      const count = wordTokens(parts[part].text).length;
      if (idx >= offset && idx < offset + count) return `${part}:${idx - offset}`;
    }
    return "";
  }, [engine, tapped, spokenText, spokenOffsets, parts]);
  const lit = useSyncExternalStore(
    (fn) => engine.subscribePlayback(fn),
    getLit,
    () => "",
  );

  const speakWord = useCallback(
    (part: number, word: number, text: string) => {
      setTapped({ part, word, text });
      // Mid-reply, the word plays in a gap and the reply carries on.
      void speakUnowned(text);
    },
    [],
  );

  const renderPart = (part: Part, pi: number, extra?: StyleProp<TextStyle>) => {
    const runs = wordRuns(toSegments(part.text, part.spans, stages));
    const words = wordTokens(part.text);
    // Group consecutive runs of one word into one tappable span.
    const nodes: React.ReactNode[] = [];
    let i = 0;
    while (i < runs.length) {
      const run = runs[i];
      if (run.word === null) {
        nodes.push(run.text);
        i++;
        continue;
      }
      const w = run.word;
      const group = [];
      while (i < runs.length && runs[i].word === w) group.push(runs[i++]);
      const wordText = part.text.slice(words[w].start, words[w].end);
      const isLit = lit === `${pi}:${w}`;
      nodes.push(
        <Text
          key={`${pi}-${w}`}
          onPress={() => speakWord(pi, w, wordText)}
          suppressHighlighting
          style={isLit ? { backgroundColor: colors.violetMuted, borderRadius: 4 } : undefined}
          accessibilityRole="button"
          accessibilityHint="Says this word"
        >
          {group.map((r, k) =>
            r.team && r.stage ? (
              <Text
                key={k}
                style={{
                  color: stageColor(r.team, r.stage),
                  fontFamily: STAGE_FONT[r.stage],
                }}
              >
                {r.text}
              </Text>
            ) : (
              r.text
            ),
          )}
        </Text>,
      );
    }
    return (
      <Text key={pi} style={[style, extra]}>
        {nodes}
      </Text>
    );
  };

  return (
    <View>
      {parts.map((part, pi) =>
        part.styled ? (
          <View
            key={pi}
            style={[styles.yourTurn, { borderColor: colors.violet, backgroundColor: colors.violetSubtle }]}
            testID="your-turn-line"
          >
            <View style={styles.yourTurnBody}>
              {/* "Your turn" plus a tap-a-word hint the child can read as a
                  picture: a tapping hand and a speaker. */}
              <View style={styles.yourTurnLabelRow}>
                <Text style={[styles.yourTurnLabel, { color: colors.violet }]}>Your turn</Text>
                <View
                  style={styles.tapHint}
                  accessible
                  accessibilityLabel="Tap a word to hear it"
                >
                  <SymbolView name="hand.tap.fill" size={14} tintColor={colors.violet} />
                  <SymbolView name="speaker.wave.2.fill" size={12} tintColor={colors.violet} />
                  <Text style={[styles.tapHintText, { color: colors.violet }]}>tap a word</Text>
                </View>
              </View>
              {renderPart(part, pi, [styles.yourTurnText, chatTextAt(YOUR_TURN_TEXT, textSteps)])}
            </View>
            {onReadAloud && (
              <Pressable
                onPress={onReadAloud}
                disabled={readAloudDisabled}
                hitSlop={10}
                style={({ pressed }) => [
                  styles.readMic,
                  { backgroundColor: readAloudDisabled ? colors.gray300 : colors.violet },
                  pressed && styles.readMicPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Read it out loud"
                testID="your-turn-mic"
              >
                <SymbolView name="mic.fill" size={26} tintColor={colors.white} />
              </Pressable>
            )}
          </View>
        ) : (
          renderPart(part, pi)
        ),
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  yourTurn: {
    marginTop: 12,
    borderWidth: 2,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  yourTurnBody: { flexShrink: 1 },
  yourTurnLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  yourTurnLabel: {
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  tapHint: { flexDirection: "row", alignItems: "center", gap: 3, opacity: 0.75 },
  tapHintText: { fontFamily: fonts.medium, fontSize: 12 },
  // Big and round, like the composer mic: the obvious next move.
  readMic: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  readMicPressed: { opacity: 0.7 },
  // A beginner's own line: big and roomy, like the first page of a reader.
  yourTurnText: {
    ...YOUR_TURN_TEXT,
    fontFamily: fonts.medium,
    letterSpacing: 0.5,
  },
});
