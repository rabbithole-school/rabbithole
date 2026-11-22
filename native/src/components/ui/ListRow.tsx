/**
 * ListRow — the one row for wonders, starters and proposed Quests
 * (review/quests-rebuilt-proposal.html, "One row for everything", figure 12),
 * the RN twin of web components/ui/ListRow.tsx. Its words come from
 * shared/wonderRows.ts and shared/questRows.ts (`ListRowModel`, vendored), the
 * same model web draws.
 *
 * Anatomy, fixed: the thing's emoji in a round tile · a bold title · one
 * optional content line · the muted meta line, always last · exactly one verb
 * button on the right, centred on the row. No chevron, nothing under the
 * text. The button's weight says what kind of tap it is: solid keeps making
 * ("Continue"), outline begins or reopens ("Ask", "Open"), quiet looks
 * ("View").
 *
 * `onDismiss` adds a quiet × after the verb (Scholar's Prep's wonder rows,
 * and every row of a kid's Quests list), which takes the row off the list;
 * the verb stays the row's one action.
 *
 * A Quest's row carries `row.rocket` (shared/questRows.ts): a small rocket
 * badge on the mark, Phosphor's RocketLaunch drawn as an icon, never the
 * emoji. On the ground (dashed outline) while a proposal waits for a teacher,
 * solid violet once the Quest has launched. Wonders and starters carry none.
 *
 * The row draws no surface of its own: a list puts its rows on one white
 * QueueSurface (visual-design.md) and passes `divided` to every row but the
 * first.
 */

import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { RocketLaunchIcon, StarIcon } from "phosphor-react-native";

import { DismissButton } from "@/components/ui/DismissButton";
import { fonts, useColors, type Colors } from "@/theme";
import type { ListRowModel } from "../../../vendor/shared/wonderRows";

/** Touch target for the verb (pt). */
const TOUCH = 44;
const MARK = 40;
/** The rocket badge on a Quest's mark (pt). */
const BADGE = 18;

export function ListRow({
  row,
  onPress,
  busy = false,
  disabled = false,
  divided = false,
  onReplyPress,
  onDismiss,
}: {
  row: ListRowModel;
  onPress: () => void;
  /** A trailing × that takes the row off its list (wonders, Quests). */
  onDismiss?: () => void;
  /** Opens the conversation behind `row.replyLink` (the end of the meta line). */
  onReplyPress?: (threadId: string) => void;
  /** The verb's work is in flight (a spinner on the button). */
  busy?: boolean;
  disabled?: boolean;
  /** Hairline above the row: every row but a list's first. */
  divided?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const weight = row.verb.weight;
  const inert = busy || disabled;

  return (
    <View style={[styles.row, divided && styles.divided]}>
      <View style={styles.mark} accessible={false} importantForAccessibility="no-hide-descendants">
        <Text style={styles.markText}>{row.mark}</Text>
        {row.rocket ? (
          <View
            style={[
              styles.badge,
              row.rocket === "star"
                ? styles.badgeStar
                : row.rocket === "launched"
                  ? styles.badgeLaunched
                  : styles.badgeGround,
            ]}
            accessibilityLabel={row.rocket === "star" ? "Shown" : undefined}
          >
            {row.rocket === "star" ? (
              <StarIcon size={11} weight="fill" color={colors.white} />
            ) : (
              <RocketLaunchIcon
                size={11}
                weight="bold"
                color={row.rocket === "launched" ? colors.white : colors.charcoalMuted}
              />
            )}
          </View>
        ) : null}
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={3}>
          {row.title}
        </Text>
        {row.content ? (
          <Text style={styles.content} numberOfLines={2}>
            {row.content}
          </Text>
        ) : null}
        {row.meta || row.replyLink ? (
          <View style={styles.metaRow}>
            {row.meta ? <Text style={styles.meta}>{row.meta}</Text> : null}
            {row.meta && row.replyLink ? <Text style={styles.meta}> · </Text> : null}
            {row.replyLink ? (
              // The text stays 12pt; hitSlop gives the tap a 44pt-tall target.
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={row.replyLink.label}
                hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
                onPress={() => onReplyPress?.(row.replyLink!.threadId)}
              >
                <Text style={styles.replyLink}>{row.replyLink.label}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.verb.label}: ${row.title}`}
        accessibilityState={{ busy, disabled: inert }}
        disabled={inert}
        onPress={onPress}
        style={({ pressed }) => [
          styles.verb,
          weight === "solid" && styles.verbSolid,
          weight === "outline" && styles.verbOutline,
          (pressed || busy) && styles.pressed,
          disabled && !busy && styles.disabled,
        ]}
      >
        {busy ? (
          <ActivityIndicator
            size="small"
            color={weight === "solid" ? colors.white : colors.violet}
          />
        ) : (
          <Text
            style={[
              styles.verbText,
              weight === "solid" && styles.verbTextSolid,
              weight === "quiet" && styles.verbTextQuiet,
            ]}
            numberOfLines={1}
          >
            {row.verb.label}
          </Text>
        )}
      </Pressable>
      {onDismiss ? (
        <View style={styles.dismiss}>
          <DismissButton label={row.title} disabled={busy} onPress={onDismiss} />
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    divided: { borderTopWidth: 1, borderTopColor: c.gray100 },
    // The mark keeps its size and its place at the start of every row.
    mark: {
      width: MARK,
      height: MARK,
      borderRadius: MARK / 2,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.gray100,
    },
    markText: { fontSize: 20, lineHeight: 24 },
    badge: {
      position: "absolute",
      right: -4,
      bottom: -4,
      width: BADGE,
      height: BADGE,
      borderRadius: BADGE / 2,
      alignItems: "center",
      justifyContent: "center",
    },
    // Waiting on a yes: on the ground, a dashed outline.
    badgeGround: {
      backgroundColor: c.bg,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: c.charcoalMuted,
    },
    // Launched: solid violet, ringed so it reads against the mark's tile.
    badgeLaunched: {
      backgroundColor: c.violetSolid,
      borderWidth: 1.5,
      borderColor: c.bg,
    },
    // Shown to an advisor: the rocket becomes a gold star (TRA-684).
    badgeStar: {
      backgroundColor: "#E3A600",
      borderWidth: 1.5,
      borderColor: c.bg,
    },
    text: { flex: 1, minWidth: 0, gap: 2 },
    title: {
      fontFamily: fonts.bold,
      fontSize: 15,
      lineHeight: 20,
      color: c.navy,
    },
    content: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoal,
    },
    meta: {
      fontFamily: fonts.medium,
      fontSize: 12,
      lineHeight: 16,
      color: c.charcoalMuted,
    },
    metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
    replyLink: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      lineHeight: 16,
      color: c.violet,
      textDecorationLine: "underline",
    },
    verb: {
      flexShrink: 0,
      minHeight: TOUCH,
      minWidth: 72,
      borderRadius: 10,
      paddingHorizontal: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    verbSolid: { backgroundColor: c.violetSolid },
    verbOutline: {
      borderWidth: 1,
      borderColor: c.violet,
      backgroundColor: c.bg,
    },
    verbText: {
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: c.violet,
      textAlign: "center",
    },
    verbTextSolid: { color: c.white },
    verbTextQuiet: { color: c.charcoal },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.5 },
    dismiss: { flexShrink: 0, marginLeft: -6 },
  });
}
