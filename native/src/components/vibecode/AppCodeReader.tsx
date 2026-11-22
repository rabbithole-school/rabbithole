/**
 * The Code view's reading mode (iPad twin of components/AppCodeReader.tsx):
 * the app's own source, opened on the world's rules and the code that decides
 * with them, with everything else folded into one line per run.
 *
 * It needs nothing from the builder. The model (shared/appCodeMap.ts →
 * buildReader) reads the code itself and the rules the app already publishes
 * in APP STATE. Labels stay honest to the code: a part shows its name as
 * written and the lines that run it, verbatim; a fold lists the names inside
 * it. A rule's starting value is tinted where it sits; tapping it says which
 * rule it is, who set it, and that its card in the app is where it changes.
 * The card stays the one place a rule's value is edited.
 *
 * Editing stays in the existing editor (ArtifactEditor), one tap away.
 */
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { fonts, useColors } from "@/theme";
import {
  buildReader,
  type AppRuleEntry,
  type Token,
} from "../../../vendor/shared/appCodeMap";

export type AppRule = AppRuleEntry;

/** Long open parts render this many lines until the reader asks for more. */
const OPEN_LINE_CAP = 120;

export function AppCodeReader({
  source,
  rules,
  startingRules,
  onEdit,
}: {
  source: string;
  /** APP STATE `rules` now: name, current value, who set it. */
  rules: readonly AppRule[] | undefined;
  /** The same rules as the app's code first wrote them (`__rhDefaults`). */
  startingRules: readonly AppRule[] | undefined;
  onEdit: () => void;
}) {
  const colors = useColors();
  const reader = useMemo(() => buildReader(source, rules, startingRules), [source, rules, startingRules]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [note, setNote] = useState<{ line: number; name: string } | null>(null);
  const toggle = (start: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });

  const tokenColor: Record<Token["kind"], string> = {
    keyword: colors.violet,
    string: colors.indigo,
    // Numbers are what a reader scans for first, so they get the strongest
    // readable hue in both themes.
    number: colors.teal,
    comment: colors.charcoalSubtle,
    text: colors.fg,
  };

  const renderLine = (k: number) => {
    const tokens = reader.tokens.get(k);
    const noteHere = note?.line === k ? note.name : null;
    return (
      <View key={k}>
        <Text style={styles.codeLine}>
          {tokens
            ? tokens.map((t, i) => {
                const rule = reader.ruleFor(k, t);
                if (!rule) {
                  return (
                    <Text key={i} style={{ color: tokenColor[t.kind] }}>
                      {t.text}
                    </Text>
                  );
                }
                return (
                  <Text
                    key={i}
                    onPress={() => setNote(noteHere === rule ? null : { line: k, name: rule })}
                    style={[styles.ruleValue, { color: tokenColor[t.kind], backgroundColor: colors.orangeSubtle }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Rule: ${rule}`}
                  >
                    {t.text}
                  </Text>
                );
              })
            : <Text style={{ color: colors.fgMuted }}>{reader.map.lines[k]}</Text>}
        </Text>
        {noteHere ? (
          <View style={[styles.note, { borderColor: colors.border, backgroundColor: colors.bg }]}>
            <Text style={[styles.noteText, { color: colors.fg }]}>{reader.noteFor(noteHere)}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.topRow}>
        <Text style={[styles.intro, { color: colors.fgMuted }]}>
          {"Rabbithole’s AI writes this code based on your conversation with it. It’s JavaScript code that runs inside the Rabbithole app on your BunnyPad."}
        </Text>
        <Pressable
          onPress={onEdit}
          style={[styles.editBtn, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Edit code"
        >
          <SymbolView name="pencil" size={14} tintColor={colors.violet} />
          <Text style={[styles.editText, { color: colors.violet }]}>Edit code</Text>
        </Pressable>
      </View>
      {reader.blocks.map((b) => {
        const isRest = b.kind === "rest";
        const open = isRest ? expanded.has(b.start) : !expanded.has(b.start);
        return (
          <Section
            key={b.start}
            start={b.start}
            end={b.end}
            title={b.kind === "part" ? b.part.title : b.title}
            titleIsCode={b.kind === "part" ? b.part.titleIsCode : b.titleIsCode}
            calledFrom={b.kind === "part" ? b.part.calledFrom : undefined}
            open={open}
            muted={isRest}
            onToggle={() => toggle(b.start)}
            renderLine={renderLine}
          />
        );
      })}
    </View>
  );
}

function Section({
  start,
  end,
  title,
  titleIsCode,
  calledFrom,
  open,
  muted,
  onToggle,
  renderLine,
}: {
  start: number;
  end: number;
  title: string;
  titleIsCode: boolean;
  /** Lines elsewhere that run this part, verbatim. */
  calledFrom?: string[];
  open: boolean;
  muted: boolean;
  onToggle: () => void;
  renderLine: (k: number) => React.ReactNode;
}) {
  const colors = useColors();
  const [showAll, setShowAll] = useState(false);
  const count = end - start + 1;
  const last = showAll ? end : Math.min(end, start + OPEN_LINE_CAP - 1);
  const rows: number[] = [];
  if (open) for (let k = start; k <= last; k++) rows.push(k);
  return (
    <View
      style={[
        styles.part,
        { borderColor: colors.border, backgroundColor: muted && !open ? colors.bgSubtle : colors.bg },
      ]}
    >
      <Pressable
        onPress={onToggle}
        style={styles.partHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${count} lines`}
      >
        <SymbolView name={open ? "chevron.down" : "chevron.right"} size={12} tintColor={colors.fgMuted} />
        <Text
          style={[styles.partTitle, titleIsCode && styles.partTitleCode, { color: muted ? colors.fgMuted : colors.fg }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        <Text style={[styles.lineCount, { color: colors.fgMuted }]}>
          {count === 1 ? "1 line" : `${count} lines`}
        </Text>
      </Pressable>
      {open && calledFrom?.length ? (
        <View style={styles.calledFrom}>
          {calledFrom.map((site) => (
            <Text key={site} style={[styles.calledFromLine, { color: colors.fgMuted }]}>
              Runs from <Text style={[styles.calledFromCode, { color: colors.fg }]}>{site}</Text>
            </Text>
          ))}
        </View>
      ) : null}
      {rows.map(renderLine)}
      {open && last < end ? (
        <Pressable onPress={() => setShowAll(true)} style={styles.more} accessibilityRole="button">
          <Text style={[styles.moreText, { color: colors.violet }]}>Show {end - last} more lines</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  intro: { flex: 1, fontFamily: fonts.regular, fontSize: 14 },
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  editText: { fontFamily: fonts.semibold, fontSize: 14 },
  part: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  partHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  partTitle: { flex: 1, fontFamily: fonts.semibold, fontSize: 16 },
  partTitleCode: { fontFamily: fonts.mono, fontSize: 14 },
  lineCount: { fontFamily: fonts.regular, fontSize: 13 },
  calledFrom: { marginTop: 4, marginLeft: 22, gap: 2 },
  calledFromLine: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  calledFromCode: { fontFamily: fonts.mono, fontSize: 12 },
  codeLine: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 22, marginTop: 2 },
  ruleValue: { fontFamily: fonts.mono, fontWeight: "700" },
  note: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 4,
    alignSelf: "flex-start",
    maxWidth: 460,
  },
  noteText: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  more: { paddingTop: 8 },
  moreText: { fontFamily: fonts.semibold, fontSize: 14 },
});
