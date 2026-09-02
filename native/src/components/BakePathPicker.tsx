import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";

export interface SuggestedPath {
  emoji: string;
  title: string;
  blurb: string;
}

export const ENDLESS_CHAT = "endless-chat" as const;
export type PathChoice = SuggestedPath | typeof ENDLESS_CHAT;

export type BakePathSource =
  | { kind: "seed"; seedId: Id<"seeds"> }
  | { kind: "topic"; topic: string; rationale?: string };

const ACCENTS = ["#0ea5e9", "#f59e0b", "#10b981", "#8b5cf6"];
const FALLBACK_PATHS: SuggestedPath[] = [
  {
    emoji: "🔍",
    title: "Get to the bottom of it",
    blurb: "Chase the one big 'why' behind it until it really clicks.",
  },
  {
    emoji: "🔗",
    title: "Find the surprising links",
    blurb: "See what this secretly connects to in your own world.",
  },
  {
    emoji: "🛠️",
    title: "Make something that shows it",
    blurb: "Build a little explainer or diagram that proves you get it.",
  },
];

const LOADING_MESSAGES = [
  "✨ Finding a few ways into this…",
  "🧭 Weighing what's actually worth exploring…",
  "📚 Shaping real options just for you…",
  "🪄 Almost ready…",
];

const SUGGESTION_CACHE = new Map<string, SuggestedPath[]>();

type Selection = number | typeof ENDLESS_CHAT | null;

function cacheKey(source: BakePathSource): string {
  return source.kind === "seed"
    ? `seed:${source.seedId}`
    : `topic:${source.topic}::${source.rationale ?? ""}`;
}

function accentForIndex(i: number): string {
  return ACCENTS[i % ACCENTS.length];
}

function withAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function SuggestedBadge() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>Suggested</Text>
    </View>
  );
}

function OptionCard({
  emoji,
  title,
  blurb,
  tileBg,
  selected,
  badge,
  onPress,
}: {
  emoji: string;
  title: string;
  blurb: string;
  tileBg: string;
  selected: boolean;
  badge?: React.ReactNode;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        pressed && !selected && styles.optionPressed,
      ]}
    >
      <View style={[styles.emojiTile, { backgroundColor: tileBg }]}>
        <Text style={styles.emoji}>{emoji}</Text>
      </View>
      <View style={styles.optionText}>
        <View style={styles.optionTitleRow}>
          <Text style={styles.optionTitle}>{title}</Text>
          {badge}
        </View>
        <Text style={styles.optionBlurb}>{blurb}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <Text style={styles.check}>✓</Text>}
      </View>
    </Pressable>
  );
}

function LoadingCard() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.loadingCard}>
      <View style={styles.loadingLineWide} />
      <View style={styles.loadingLine} />
    </View>
  );
}

export function BakePathPicker({
  source,
  onSelect,
}: {
  source: BakePathSource;
  onSelect: (choice: PathChoice | null) => void;
}) {
  const suggest = useAction(api.bakePaths.suggestBakePaths);
  const sourceKind = source.kind;
  const sourceSeedId = source.kind === "seed" ? source.seedId : null;
  const sourceTopic = source.kind === "topic" ? source.topic : null;
  const sourceRationale = source.kind === "topic" ? source.rationale : undefined;
  const key = cacheKey(source);
  const cached = SUGGESTION_CACHE.get(key) ?? null;
  const [paths, setPaths] = useState<SuggestedPath[] | null>(cached);
  const [selected, setSelected] = useState<Selection>(cached ? 0 : null);
  const [msgIdx, setMsgIdx] = useState(0);
  const notifySelection = useEffectEvent(onSelect);
  const touchedRef = useRef(false);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    let cancelled = false;
    touchedRef.current = false;
    const hit = SUGGESTION_CACHE.get(key);
    if (hit) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- A cache hit must synchronously restore its paths before resetting and reporting the selected path.
      setPaths(hit);
      setSelected(0);
      notifySelection(hit[0] ?? null);
      return;
    }

    setPaths(null);
    setSelected(null);
    notifySelection(null);

    const params =
      sourceKind === "seed" && sourceSeedId
        ? { seedId: sourceSeedId }
        : {
            topic: sourceTopic!,
            ...(sourceRationale ? { rationale: sourceRationale } : {}),
          };

    suggest(params)
      .then((result) => {
        if (cancelled) return;
        const nextPaths = result.paths?.length ? result.paths : FALLBACK_PATHS;
        SUGGESTION_CACHE.set(key, nextPaths);
        setPaths(nextPaths);
        if (!touchedRef.current) {
          setSelected(0);
          notifySelection(nextPaths[0] ?? null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPaths(FALLBACK_PATHS);
        if (!touchedRef.current) {
          setSelected(0);
          notifySelection(FALLBACK_PATHS[0]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, sourceKind, sourceRationale, sourceSeedId, sourceTopic, suggest]);

  const loading = paths === null;
  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(
      () => setMsgIdx((i) => (i + 1) % LOADING_MESSAGES.length),
      2200,
    );
    return () => clearInterval(timer);
  }, [loading]);

  const pick = (choice: Selection, value: PathChoice) => {
    touchedRef.current = true;
    setSelected(choice);
    onSelect(value);
  };

  return (
    <View style={styles.wrap} accessibilityRole="radiogroup">
      <View style={styles.promptRow}>
        {loading && <ActivityIndicator size="small" color={colors.violet} />}
        <Text style={styles.prompt}>
          {loading ? LOADING_MESSAGES[msgIdx] : "How do you want to explore it?"}
        </Text>
      </View>

      <OptionCard
        emoji="💬"
        title="Endless chat"
        blurb="No plan — just start talking and follow your curiosity wherever it goes."
        tileBg={colors.gray100}
        selected={selected === ENDLESS_CHAT}
        onPress={() => pick(ENDLESS_CHAT, ENDLESS_CHAT)}
      />

      {loading ? (
        <>
          <LoadingCard />
          <LoadingCard />
          <LoadingCard />
        </>
      ) : (
        paths.map((path, i) => (
          <OptionCard
            key={`${path.title}-${i}`}
            emoji={path.emoji}
            title={path.title}
            blurb={path.blurb}
            tileBg={withAlpha(accentForIndex(i), 0.12)}
            selected={selected === i}
            badge={i === 0 ? <SuggestedBadge /> : undefined}
            onPress={() => pick(i, path)}
          />
        ))
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    wrap: {
      gap: 10,
    },
    promptRow: {
      minHeight: 22,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    prompt: {
      flex: 1,
      color: c.charcoalMuted,
      fontSize: 13.5,
      fontFamily: fonts.semibold,
    },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      backgroundColor: c.bg,
      paddingHorizontal: 12,
      paddingVertical: 11,
    },
    optionPressed: {
      backgroundColor: c.gray50,
    },
    optionSelected: {
      borderColor: c.violet,
      shadowColor: c.violet,
      shadowOpacity: 0.16,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 0 },
    },
    emojiTile: {
      width: 42,
      height: 42,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    emoji: {
      fontSize: 21,
      lineHeight: 25,
    },
    optionText: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    optionTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 7,
    },
    optionTitle: {
      color: c.navy,
      fontSize: 15.5,
      fontFamily: fonts.bold,
    },
    optionBlurb: {
      color: c.charcoalMuted,
      fontSize: 13.5,
      lineHeight: 19,
      fontFamily: fonts.regular,
    },
    radio: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: c.gray300,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    radioSelected: {
      borderColor: c.violet,
      backgroundColor: c.violet,
    },
    check: {
      color: c.white,
      fontSize: 14,
      lineHeight: 17,
      fontFamily: fonts.bold,
    },
    badge: {
      borderRadius: 999,
      backgroundColor: c.violetSubtle,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeText: {
      color: c.violetSolid,
      fontSize: 10,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      fontFamily: fonts.bold,
    },
    loadingCard: {
      height: 68,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.gray50,
      justifyContent: "center",
      paddingHorizontal: 16,
      gap: 10,
    },
    loadingLineWide: {
      width: "50%",
      height: 10,
      borderRadius: 999,
      backgroundColor: c.gray200,
    },
    loadingLine: {
      width: "78%",
      height: 8,
      borderRadius: 999,
      backgroundColor: c.gray100,
    },
  });
}
