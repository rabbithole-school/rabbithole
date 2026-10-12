/**
 * LicenseCardImage — a Calculator License badge, drawn as the ID card it is.
 *
 * The calculator_license badge's image is the license card itself: a
 * landscape PNG the server renders from the printed card's design (the web
 * twin is `LicenseCardArt` in components/BadgeArt.tsx). Every native surface
 * that shows that badge — the award overlay, the My Learning shelf, the Math
 * tab's license card — draws it through here, at the card's own ID-1 aspect
 * with rounded corners and a soft shadow, never cropped into the square or
 * circle a medallion badge gets.
 *
 * Before the first render lands it holds the card's shape (cream, with a
 * spinner when asked), so nothing jumps when the image arrives; a re-record's
 * re-render dims the previous card instead.
 */
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";

import {
  LICENSE_CARD_ASPECT,
  LICENSE_CARD_CORNER_RATIO,
} from "../../vendor/shared/calculatorLicense";

const CARD_CREAM = "#faf7ed";
const SPINNER_GOLD = "#c99a2e";

export function LicenseCardImage({
  imageUrl,
  width,
  generating,
  icon,
  showSpinner = true,
  alt,
}: {
  imageUrl: string | null;
  /** Card width in points; the height follows the ID-1 aspect. */
  width: number;
  generating: boolean;
  /** Shown only when there is no image and nothing is rendering. */
  icon?: string | null;
  /** Spinner while rendering (off for small thumbnails, where it's noise). */
  showSpinner?: boolean;
  alt?: string;
}) {
  const height = width / LICENSE_CARD_ASPECT;
  const radius = width * LICENSE_CARD_CORNER_RATIO;
  return (
    <View
      style={[
        styles.frame,
        {
          width,
          height,
          borderRadius: radius,
          // Shadow on a frame with a background follows its rounded bounds.
          backgroundColor: CARD_CREAM,
          shadowRadius: Math.max(4, width * 0.03),
        },
      ]}
    >
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={[
            { width, height, borderRadius: radius },
            generating && styles.dim,
          ]}
          contentFit="contain"
          transition={200}
          alt={alt ?? "Calculator license card"}
        />
      ) : !generating ? (
        <Text style={{ fontSize: Math.round(width * 0.2) }}>{icon ?? "🧮"}</Text>
      ) : null}
      {generating && showSpinner ? (
        <View style={styles.spinner} pointerEvents="none">
          <ActivityIndicator color={SPINNER_GOLD} size="large" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#101b44",
    shadowOpacity: 0.22,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  dim: { opacity: 0.6 },
  spinner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
