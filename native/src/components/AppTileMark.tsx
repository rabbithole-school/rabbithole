// The NATIVE App Launcher tile mark — the squircle and what goes inside it.
//
// Both native surfaces that draw an app render it through here: the home
// launcher grid and the unlock modal. That is the same reason the web has one
// `components/ui/AppTileIcon.tsx` — the fallback chain and the tint are decided
// once (`shared/appTileMark.ts`, via lib/externalAppIcon), so the scholar sees
// the same mark on the tile they tapped and on the modal that opens it, and a
// fix to one is a fix to both.
//
// It also owns the RUNTIME rung of that chain. A remote logo can resolve as a
// perfectly good URL and still never produce pixels — the iPad is offline, the
// asset was deleted, ATS blocked the host — which would leave a blank white
// squircle with no mark at all. `<Image onError>` reports the failure back into
// the shared resolver, so the tile continues to the emoji/initial exactly as it
// would have for an absent icon. The failure is keyed on the icon location, so
// a tile pointed at a different image (or reused for another app) drops it.
//
// Layout is the caller's: pass the squircle's own style (size, radius, shadow,
// dimming). Only the BACKGROUND is decided here, because it depends on which
// rung the chain actually landed on — white for a real logo, the app's tint for
// an emoji or initial.
//
// So is the ANNOUNCEMENT, in one prop. On its own the squircle is a single
// image element labeled "<app> icon" on every rung, so a mark standing alone is
// never a silent letter or an unlabeled graphic. A caller whose own element
// already names the app — the launcher's Pressable, the unlock modal's status
// group — passes `decorative` instead of letting a nested label compete with it.

import { useState, type ReactNode } from "react";
import {
  Image,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { appTileTint, resolveNativeAppTileMark } from "@/lib/externalAppIcon";
import { fonts, palette } from "@/theme";

export function AppTileMark({
  name,
  iconUrl,
  iconEmoji,
  color,
  markFontSize,
  decorative = false,
  style,
  children,
}: {
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
  /** Font size of the initial; an emoji is drawn 1.35x this, as on web. */
  markFontSize: number;
  /**
   * Set when the element AROUND the mark already announces this app — the
   * launcher's Pressable and the unlock modal's status group. The mark is then hidden from assistive
   * tech, because a labeled child inside a labeled element is either ignored
   * or announced twice, and neither adds anything a scholar needs.
   */
  decorative?: boolean;
  /** The squircle itself — size, radius, shadow, border, dimming. */
  style?: StyleProp<ViewStyle>;
  /** Overlay drawn on top of the mark (e.g. a launching spinner). */
  children?: ReactNode;
}) {
  const [unusableImageSrc, setUnusableImageSrc] = useState<string | null>(null);
  const mark = resolveNativeAppTileMark({
    iconUrl,
    emoji: iconEmoji,
    name,
    unusableImageSrc,
  });
  const background =
    mark.kind === "image" ? palette.white : appTileTint({ color, name });
  const emojiFontSize = Math.round(markFontSize * 1.35);

  // The whole squircle is ONE image element, whichever rung the chain landed
  // on: a logo, the emoji, and the initial all mean "this is <app>", so they
  // are announced identically rather than the emoji claiming an unlabeled
  // image role and the initial being read as a stray letter.
  const accessibility = decorative
    ? ({
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      } as const)
    : ({
        accessible: true,
        accessibilityRole: "image",
        accessibilityLabel: `${name} icon`,
      } as const);

  return (
    <View
      style={[{ backgroundColor: background }, styles.tile, style]}
      {...accessibility}
    >
      {mark.kind === "image" ? (
        <Image
          key={iconUrl ?? ""}
          source={mark.source}
          style={styles.image}
          resizeMode="contain"
          // The squircle above is the one element assistive tech sees, so the
          // logo inside it is decorative: empty alt, and hidden outright so RN
          // doesn't promote it to an element with no label of its own.
          alt=""
          aria-hidden
          onError={() => setUnusableImageSrc(iconUrl)}
        />
      ) : mark.kind === "emoji" ? (
        <Text
          style={{
            fontSize: emojiFontSize,
            lineHeight: Math.round(emojiFontSize * 1.16),
          }}
        >
          {mark.glyph}
        </Text>
      ) : (
        <Text style={[styles.initial, { fontSize: markFontSize }]}>
          {mark.text}
        </Text>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "72%",
    height: "72%",
  },
  initial: {
    color: palette.white,
    fontFamily: fonts.bold,
  },
});
