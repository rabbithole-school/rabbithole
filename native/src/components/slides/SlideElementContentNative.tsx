import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import Svg, { Ellipse } from "react-native-svg";

import type { SlideElement } from "../../../vendor/shared/slidesScene";
import {
  lineStrokeLogical,
  textLineHeightPx,
  TEXT_PADDING,
} from "../../../vendor/shared/slidesRenderContract";
import { shouldRenderSlideImage } from "../../../vendor/shared/slideImageFallback";
import { fonts, useColors } from "@/theme";
import { mediaAccessibility } from "./mediaAccessibility";

export function SlideElementContentNative({
  element,
  scale,
  resolveAsset,
  hideText = false,
  accessible = true,
  renderVideo = true,
  videoPlaying = false,
  videoMuted = true,
  onVideoPress,
  testID,
}: {
  element: SlideElement;
  scale: number;
  resolveAsset?: (assetId: string) => string | null;
  hideText?: boolean;
  accessible?: boolean;
  renderVideo?: boolean;
  videoPlaying?: boolean;
  videoMuted?: boolean;
  onVideoPress?: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (element.type === "text") {
    if (hideText) return null;
    return (
      <Text
        accessible={accessible}
        style={{
          color: element.style.color,
          fontFamily: element.style.bold ? fonts.bold : fonts.regular,
          fontStyle: element.style.italic ? "italic" : "normal",
          fontSize: element.style.fontSize * scale,
          lineHeight: textLineHeightPx(element.style.fontSize, scale),
          padding: TEXT_PADDING * scale,
          textAlign: element.style.align,
          width: "100%",
        }}
      >
        {element.text}
      </Text>
    );
  }

  if (element.type === "image") {
    const uri = resolveAsset?.(element.assetId) ?? null;
    const renderImage = shouldRenderSlideImage(uri, failedSource);
    const media = mediaAccessibility(
      element.alt,
      accessible,
      "image",
      renderImage ? "resolved" : "fallback",
    );
    return renderImage ? (
      <Image
        source={{ uri }}
        testID={testID ? `${testID}-image` : undefined}
        style={styles.fill}
        contentFit="contain"
        alt={media.imageAlt}
        aria-hidden={media.ariaHidden}
        onError={() => setFailedSource(uri)}
      />
    ) : (
      <View
        accessible={accessible}
        accessibilityLabel={media.accessibilityLabel}
        testID={testID ? `${testID}-fallback` : undefined}
        style={[styles.fill, styles.imagePlaceholder, { borderColor: colors.border }]}
      >
        <Text style={{ color: colors.fgMuted, fontFamily: fonts.regular, fontSize: 11 }}>
          {media.fallbackLabel}
        </Text>
      </View>
    );
  }

  if (element.type === "video") {
    const uri = resolveAsset?.(element.assetId) ?? null;
    const media = mediaAccessibility(
      element.alt,
      accessible,
      "video",
      !renderVideo || !uri ? "fallback" : "resolved",
      videoPlaying,
    );
    if (!renderVideo || !uri) {
      return (
        <View
          accessible={accessible}
          accessibilityLabel={media.accessibilityLabel}
          style={[styles.fill, styles.imagePlaceholder, { borderColor: colors.border }]}
        >
          <Text style={{ color: colors.fgMuted, fontFamily: fonts.medium, fontSize: 11 }}>
            {media.fallbackLabel} ▶
          </Text>
        </View>
      );
    }
    return (
      <SlideVideo
        accessible={accessible}
        accessibilityLabel={media.accessibilityLabel}
        onPress={onVideoPress}
        muted={videoMuted}
        playing={videoPlaying}
        uri={uri}
      />
    );
  }

  if (element.type === "line") {
    return (
      <View accessible={false} style={styles.lineWrap}>
        <View
          style={{
            width: "100%",
            height: lineStrokeLogical(element.style.strokeWidth) * scale,
            backgroundColor: element.style.stroke ?? "#222656",
          }}
        />
      </View>
    );
  }

  if (element.type === "ellipse") {
    const width = element.frame.w * scale;
    const height = element.frame.h * scale;
    const strokeWidth = element.style.strokeWidth * scale;
    return (
      <Svg accessible={false} height="100%" style={styles.fill} width="100%">
        <Ellipse
          cx={width / 2}
          cy={height / 2}
          fill={element.style.fill ?? "transparent"}
          rx={Math.max(0, width / 2 - strokeWidth / 2)}
          ry={Math.max(0, height / 2 - strokeWidth / 2)}
          stroke={element.style.stroke ?? "transparent"}
          strokeWidth={strokeWidth}
        />
      </Svg>
    );
  }

  return (
    <View
      accessible={false}
      style={[
        styles.fill,
        {
          backgroundColor: element.style.fill ?? "transparent",
          borderColor: element.style.stroke ?? "transparent",
          borderWidth: element.style.strokeWidth * scale,
        },
      ]}
    />
  );
}

function SlideVideo({
  accessible,
  accessibilityLabel,
  onPress,
  muted,
  playing,
  uri,
}: {
  accessible: boolean;
  accessibilityLabel?: string;
  onPress?: () => void;
  muted: boolean;
  playing: boolean;
  uri: string;
}) {
  const player = useVideoPlayer(uri, (createdPlayer) => {
    createdPlayer.muted = muted;
  });

  useEffect(() => {
    if (playing) player.play();
    else player.pause();
  }, [player, playing]);

  return (
    <Pressable
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={styles.fill}
    >
      <VideoView
        contentFit="contain"
        nativeControls={false}
        player={player}
        style={styles.fill}
      />
      {!playing && (
        <View pointerEvents="none" style={styles.playOverlay}>
          <View style={styles.playButton}>
            <Text style={styles.playIcon}>▶</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { position: "absolute", inset: 0 },
  imagePlaceholder: {
    alignItems: "center",
    borderStyle: "dashed",
    borderWidth: 1,
    justifyContent: "center",
  },
  lineWrap: {
    position: "absolute",
    inset: 0,
    justifyContent: "center",
  },
  playOverlay: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  playButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.62)",
  },
  playIcon: {
    color: "#ffffff",
    fontSize: 21,
    marginLeft: 3,
  },
});
