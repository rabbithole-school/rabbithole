import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";

import {
  allowedHostsForUrl,
  devManipulativeDemoContent,
  rabbitholeWebUrl,
  webEmbedUrlError,
} from "@/lib/webEmbedConfig";
import { openInteractiveWebContent } from "@/lib/externalAppHost";
import { fonts, useColors } from "@/theme";

export type EmbeddedWebLaunchButtonProps = {
  title: string;
  subtitle?: string;
  /** Absolute URL or Rabbithole-web path (resolved against EXPO_PUBLIC_RABBITHOLE_WEB_URL). */
  url: string;
  allowedHosts?: string[] | null;
  label?: string;
};

export function EmbeddedWebLaunchButton({
  title,
  subtitle,
  url,
  allowedHosts,
  label = "Open",
}: EmbeddedWebLaunchButtonProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const resolvedUrl = useMemo(() => rabbitholeWebUrl(url), [url]);
  const urlError = webEmbedUrlError(resolvedUrl);
  const disabled = !!urlError;

  const open = () => {
    if (disabled) return;
    Haptics.selectionAsync();
    openInteractiveWebContent({
      title,
      subtitle,
      url: resolvedUrl,
      allowedHosts: allowedHosts ?? allowedHostsForUrl(resolvedUrl),
      gestureMode: "interactive",
    });
  };

  return (
    <Pressable
      onPress={open}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${title}`}
      accessibilityHint={urlError ?? "Opens the activity in Rabbithole without leaving the app."}
      style={({ pressed }) => [
        styles.card,
        pressed && !disabled && styles.cardPressed,
        disabled && styles.cardDisabled,
      ]}
    >
      <View style={styles.iconWrap}>
        <SymbolView name="hand.draw.fill" size={26} tintColor={colors.violet} />
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.eyebrow}>WEB ACTIVITY</Text>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle || urlError ? (
          <Text style={[styles.subtitle, urlError && styles.error]} numberOfLines={2}>
            {urlError ?? subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={styles.cta}>{label} ›</Text>
    </Pressable>
  );
}

export function DevManipulativeLauncher() {
  const demo = devManipulativeDemoContent();
  if (!demo) return null;
  return (
    <EmbeddedWebLaunchButton
      title={demo.title}
      subtitle={demo.subtitle}
      url={demo.url}
      allowedHosts={demo.allowedHosts}
      label="Try"
    />
  );
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(colors: ColorSet) {
  return StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      paddingVertical: 14,
      paddingHorizontal: 16,
      shadowColor: colors.navy,
      shadowOpacity: 0.06,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
    },
    cardPressed: { opacity: 0.78 },
    cardDisabled: { opacity: 0.58 },
    iconWrap: {
      width: 48,
      height: 48,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.violetSubtle,
    },
    textWrap: { flex: 1, minWidth: 0 },
    eyebrow: {
      fontSize: 11.5,
      letterSpacing: 1.1,
      fontFamily: fonts.bold,
      color: colors.violet,
      marginBottom: 2,
    },
    title: {
      fontSize: 17,
      lineHeight: 21,
      fontFamily: fonts.bold,
      color: colors.navy,
    },
    subtitle: {
      marginTop: 3,
      fontSize: 13.5,
      lineHeight: 18,
      fontFamily: fonts.regular,
      color: colors.fgMuted,
    },
    error: { color: colors.statusRed },
    cta: {
      fontSize: 15,
      fontFamily: fonts.semibold,
      color: colors.violet,
    },
  });
}
