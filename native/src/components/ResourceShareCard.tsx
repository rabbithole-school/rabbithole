import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

import {
  activityResourceEmbedUrl,
  youtubeVideoId,
} from "../../vendor/shared/activityResourceEmbed";
import {
  buildYouTubeResourceDocument,
  YOUTUBE_RESOURCE_ALLOWED_HOSTS,
  YOUTUBE_RESOURCE_BASE_URL,
} from "@/lib/activityResourcePlayer";
import { openInteractiveWebContent } from "@/lib/externalAppHost";
import {
  allowedHostsForUrl,
  webEmbedUrlError,
} from "@/lib/webEmbedConfig";
import { fonts, useColors, type Colors } from "@/theme";

export type ResourceShare = {
  title: string;
  kind: "file" | "link" | "video";
  fileName: string | null;
  mimeType: string | null;
  url: string | null;
};

export function ResourceShareCard({
  resource,
  compact = false,
}: {
  resource: ResourceShare;
  compact?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const embedUrl = activityResourceEmbedUrl(resource);
  const youtubeId =
    resource.kind === "video" && resource.url
      ? youtubeVideoId(resource.url)
      : null;
  const available = !!embedUrl && !webEmbedUrlError(embedUrl);

  const open = () => {
    if (!embedUrl || !available) return;
    openInteractiveWebContent({
      id: `activity-resource:${resource.url}`,
      title: resource.title,
      subtitle: resourceDetail(resource) ?? undefined,
      url: embedUrl,
      ...(youtubeId
        ? {
            documentHtml: buildYouTubeResourceDocument(embedUrl),
            documentBaseUrl: YOUTUBE_RESOURCE_BASE_URL,
            allowedHosts: [...YOUTUBE_RESOURCE_ALLOWED_HOSTS],
            navigationPolicy: "youtube" as const,
          }
        : {
            allowedHosts: allowedHostsForUrl(embedUrl),
          }),
      gestureMode: "page",
    });
  };

  return (
    <Pressable
      onPress={open}
      disabled={!available}
      accessibilityRole="button"
      accessibilityLabel={
        available
          ? `Open ${resource.title}`
          : `${resource.title} is unavailable`
      }
      style={({ pressed }) => [
        styles.card,
        compact && styles.compactCard,
        !available && styles.unavailable,
        pressed && available && styles.pressed,
      ]}
    >
      <View style={styles.iconWrap}>
        <SymbolView
          name={resourceSymbol(resource)}
          size={compact ? 18 : 22}
          tintColor={colors.violet}
        />
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={2}>
          {resource.title}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {resourceDetail(resource)}
        </Text>
      </View>
      {available ? (
        <SymbolView
          name="chevron.right"
          size={17}
          tintColor={colors.violet}
        />
      ) : null}
    </Pressable>
  );
}

function resourceDetail(resource: ResourceShare): string | null {
  if (resource.kind === "file") return resource.fileName;
  return resource.kind === "video" ? "Video" : "Website";
}

function resourceSymbol(resource: ResourceShare): SymbolViewProps["name"] {
  if (resource.kind === "link") return "link";
  if (resource.kind === "video") return "play.rectangle.fill";
  if (resource.mimeType === "application/pdf") return "doc.richtext.fill";
  if (resource.mimeType?.startsWith("image/")) return "photo.fill";
  return "doc.text.fill";
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    card: {
      alignSelf: "center",
      width: "100%",
      maxWidth: 440,
      minHeight: 68,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 15,
      paddingVertical: 13,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
    },
    compactCard: {
      minHeight: 52,
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 12,
    },
    pressed: {
      backgroundColor: colors.violetSubtle,
      borderColor: colors.violetMuted,
    },
    unavailable: { opacity: 0.65 },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.violetSubtle,
    },
    text: { flex: 1 },
    title: {
      color: colors.navy,
      fontFamily: fonts.bold,
      fontSize: 15,
      lineHeight: 20,
    },
    detail: {
      marginTop: 2,
      color: colors.charcoalMuted,
      fontFamily: fonts.regular,
      fontSize: 13,
      lineHeight: 17,
    },
  });
}
