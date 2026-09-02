/**
 * EmptyState — the one canonical empty-state primitive for the NATIVE app.
 *
 * The exact twin of the web `components/ui/EmptyState.tsx`, which had no native
 * counterpart: every one of native's ~29 empty states was hand-rolled, and they
 * drifted into nine different title sizes (13, 14, 14.5, 15, 16, 17, 18, 19,
 * 24px), two hard-coded hexes, and CTA-less dead ends that the same web surface
 * gave the scholar a way out of. Scholar-facing web/native parity is a standing
 * rule, so the treatments below are ports of the web recipe, not new taste.
 *
 * The rule (Andy, 2026-07): an empty state may freely INCLUDE or OMIT any of
 * its five elements — icon, dashed outline, title, hint, CTA — but there must be
 * ONE AND ONLY ONE visual treatment for each. This component owns them.
 *
 * The single treatment per element (web token → native equivalent):
 *   - icon   — colors.gray300, sized by `size`; caller passes a render function
 *              so it can build the platform icon with the size/color we choose.
 *   - title  — fonts.semibold, colors.charcoalSubtle, 15px (md) / 17px (lg).
 *              ALWAYS this, including inside the dashed outline — the outline is
 *              a CONTAINER treatment only.
 *   - hint   — fonts.regular, colors.fgMuted, 13px (md) / 15px (lg), max 420px,
 *              centered, 1.45 line height.
 *   - cta    — a single pill button; `primary` is the violet solid, default is
 *              the bordered outline.
 *   - outline — 1px dashed colors.border, radius 12. A bare title collapses to
 *              one left-aligned row (the web chip behavior).
 *
 * Sizes: `md` = in-card / inline (py 24, icon 28); `lg` = full-surface (py 40,
 * icon 52).
 *
 *   <EmptyState
 *     size="lg"
 *     icon={(size, color) => <SunIcon size={size} color={color} />}
 *     title="Your day is clear"
 *     hint="Nothing is scheduled and nothing is open."
 *     cta={{ label: "Start a Quest", onPress: openCreateQuest, primary: true }}
 *   />
 */
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { type Colors, fonts, useColors } from "@/theme";

export interface EmptyStateCta {
  label: string;
  onPress: () => void;
  /** true → the violet solid; default → the bordered outline. */
  primary?: boolean;
  disabled?: boolean;
}

export interface EmptyStateProps {
  /** The one required element. */
  title: string;
  /**
   * Renders the icon at the size and color this component chooses. A render
   * function rather than a node because native icon components take `size` and
   * `color` as props — there is no `fontSize`/`currentColor` to inherit.
   */
  icon?: (size: number, color: string) => React.ReactNode;
  /** One supporting sentence. */
  hint?: string;
  /** A single call-to-action. */
  cta?: EmptyStateCta;
  /** Wrap in the canonical dashed chip (container treatment only). */
  outline?: boolean;
  /** md = inline/in-card (default); lg = full-surface. */
  size?: "md" | "lg";
}

export function EmptyState({
  title,
  icon,
  hint,
  cta,
  outline = false,
  size = "md",
}: EmptyStateProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const lg = size === "lg";

  const iconNode = icon ? (
    <View style={styles.icon}>{icon(lg ? 52 : 28, colors.gray300)}</View>
  ) : null;

  const titleNode = (
    <Text style={[styles.title, lg ? styles.titleLg : styles.titleMd]}>
      {title}
    </Text>
  );

  const hintNode = hint ? (
    <Text style={[styles.hint, lg ? styles.hintLg : styles.hintMd]}>
      {hint}
    </Text>
  ) : null;

  const ctaNode = cta ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cta.label}
      disabled={cta.disabled}
      onPress={cta.onPress}
      style={({ pressed }) => [
        styles.cta,
        cta.primary ? styles.ctaPrimary : styles.ctaOutline,
        pressed && !cta.disabled && styles.ctaPressed,
        cta.disabled && styles.ctaDisabled,
      ]}
    >
      <Text style={[styles.ctaText, cta.primary && styles.ctaTextPrimary]}>
        {cta.label}
      </Text>
    </Pressable>
  ) : null;

  // Dashed outline: a container treatment only. A bare title collapses to a
  // single left-aligned row; anything richer stacks inside.
  const bare = !iconNode && !hintNode && !ctaNode;
  if (outline && bare) {
    return (
      <View style={styles.outline}>
        <Text style={[styles.title, lg ? styles.titleLg : styles.titleMd]}>
          {title}
        </Text>
      </View>
    );
  }

  const stack = (
    <View
      style={[
        styles.stack,
        { gap: lg ? 12 : 4 },
        !outline && { paddingVertical: lg ? 40 : 24 },
      ]}
    >
      {iconNode}
      {titleNode}
      {hintNode}
      {ctaNode}
    </View>
  );

  return outline ? <View style={styles.outline}>{stack}</View> : stack;
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    stack: { alignItems: "center" },
    icon: { opacity: 0.9 },
    title: {
      fontFamily: fonts.semibold,
      color: c.charcoalSubtle,
      textAlign: "center",
    },
    titleMd: { fontSize: 15 },
    titleLg: { fontSize: 17 },
    hint: {
      fontFamily: fonts.regular,
      color: c.fgMuted,
      textAlign: "center",
      maxWidth: 420,
      lineHeight: 21,
    },
    hintMd: { fontSize: 13 },
    hintLg: { fontSize: 15 },
    cta: {
      marginTop: 4,
      paddingHorizontal: 16,
      paddingVertical: 9,
      borderRadius: 999,
      borderWidth: 1,
    },
    ctaOutline: { borderColor: c.border, backgroundColor: "transparent" },
    ctaPrimary: { borderColor: c.violet, backgroundColor: c.violet },
    ctaPressed: { opacity: 0.75 },
    ctaDisabled: { opacity: 0.45 },
    ctaText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.charcoalSubtle,
    },
    ctaTextPrimary: { color: c.white },
    outline: {
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: c.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
  });
}
