import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { fonts } from "@/theme";
import {
  advanceReveal,
  buildRamp,
  computeInkView,
  PARA_GAP,
  sampleRamp,
  segmentParagraphs,
  DEFAULT_FADE_MS,
  type InkStop,
  type InkView,
} from "../../vendor/shared/streamingInk";

// Wet-ink streaming reveal (native renderer). The timing constants, colour-ramp
// maths, leaky-bucket advance, and per-frame view computation are the SHARED
// engine in shared/streamingInk.ts (vendored here) — the SAME code the web
// renderer (components/StreamingText.tsx) runs, so both surfaces reveal with
// identical cadence and feel. This file owns only the RN painting + the RAF loop.

export type StreamingTextVariant = "gradient-mask" | "per-word";

type StreamingTextProps = {
  content: string;
  done: boolean;
  /** Convenience: a single-colour ramp (color @ TAIL_MIN_ALPHA → color @ 1). */
  color?: string;
  /** Full control: colour+alpha stops interpolated by character dryness. */
  ramp?: InkStop[];
  /** How long a released character stays "wet" before drying to solid. */
  fadeMs?: number;
  variant?: StreamingTextVariant;
  style?: StyleProp<TextStyle>;
};

type TextToken = { key: string; text: string; isWord: boolean };

const WORD_OR_SPACE = /\S+\s*|\s+/g;

export function StreamingText({
  content,
  done,
  color,
  ramp,
  fadeMs = DEFAULT_FADE_MS,
  variant = "gradient-mask",
  style,
}: StreamingTextProps) {
  const stops = useMemo(() => buildRamp(ramp, color), [ramp, color]);
  const endColor = useMemo(() => sampleRamp(stops, 1), [stops]);
  const textStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.text, style, { color: endColor }],
    [style, endColor],
  );
  const dryMs = fadeMs < 1 ? 1 : fadeMs;

  // Leaky-bucket reveal + wet-ink drying — see shared/streamingInk.ts for the
  // model. All mutable per-frame state lives in refs touched ONLY inside the
  // animation effect; render reads the computed `view` state, never the refs.
  const released = useRef(0); // leaky-bucket level: chars released so far (float)
  const revealedAt = useRef<number[]>([]); // per-char release time → its dry clock
  const prevLen = useRef(0);
  const firstRun = useRef(true);
  const rafRef = useRef<number | null>(null);

  const [view, setView] = useState<InkView>(() =>
    done || content.length === 0
      ? { paras: segmentParagraphs(content).map((seg) => ({ body: seg.text, spans: [] })) }
      : { paras: [] },
  );

  useEffect(() => {
    if (variant !== "gradient-mask") return;

    const len = content.length;
    if (len < prevLen.current) {
      // Content replaced (new message / demo loop restart) — reset the bucket.
      released.current = 0;
      revealedAt.current = [];
    }
    prevLen.current = len;
    // Already-complete (or empty) on first mount → show solid: release everything,
    // pre-dried, so nothing animates a spurious reveal.
    if (firstRun.current && (done || len === 0)) {
      released.current = len;
      revealedAt.current = new Array(len).fill(0);
    }
    firstRun.current = false;

    const step = () => {
      const now = Date.now();
      const total = content.length;
      released.current = advanceReveal(released.current, total, done);
      const shown = Math.min(total, Math.floor(released.current));
      for (let i = revealedAt.current.length; i < shown; i++) revealedAt.current[i] = now;
      setView(computeInkView(content, now, released.current, revealedAt.current, stops, dryMs));
      const lastAt = shown > 0 ? revealedAt.current[shown - 1] : now - dryMs;
      const releasing = released.current < total;
      const drying = now - lastAt < dryMs;
      rafRef.current = releasing || drying ? requestAnimationFrame(step) : null;
    };

    step(); // paint one frame now so we don't wait a frame to start
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [content, done, variant, dryMs, stops]);

  if (variant === "per-word") {
    if (content.length === 0) return <Text style={textStyle}>{content}</Text>;
    return (
      <Text style={textStyle}>
        {tokenize(content).map((token) =>
          token.isWord ? (
            <Animated.Text
              key={token.key}
              entering={FadeIn.duration(210)}
              style={textStyle}
            >
              {token.text}
            </Animated.Text>
          ) : (
            token.text
          ),
        )}
      </Text>
    );
  }

  return (
    <View style={styles.root}>
      {view.paras.map((p, idx) => {
        const gap = idx > 0 ? styles.paraGap : null;
        if (p.spans.length === 0) {
          // Fully-dry paragraph — one solid run (incl. every settled paragraph).
          return (
            <Text key={idx} style={[textStyle, gap]}>
              {p.body}
            </Text>
          );
        }
        return (
          <Text
            key={idx}
            style={[textStyle, gap]}
            accessibilityLabel={p.body + p.spans.map((s) => s.ch).join("")}
            accessibilityRole="text"
          >
            {p.body}
            {p.spans.map((s) => (
              <Text key={s.key} style={{ color: s.color }}>
                {s.ch}
              </Text>
            ))}
          </Text>
        );
      })}
    </View>
  );
}

function tokenize(content: string): TextToken[] {
  return Array.from(content.matchAll(WORD_OR_SPACE), (match) => {
    const text = match[0];
    const index = match.index ?? 0;
    const isWord = /\S/.test(text);
    return { key: `${isWord ? "w" : "s"}:${index}`, text, isWord };
  });
}

const styles = StyleSheet.create({
  root: { width: "100%" },
  paraGap: { marginTop: PARA_GAP },
  text: {
    fontFamily: fonts.regular,
    fontSize: 18,
    lineHeight: 26,
    includeFontPadding: false,
  },
});
