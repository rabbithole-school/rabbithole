/**
 * The bedtime banner and night-sky overlay, drawn from BedtimeContext (state
 * computed once by BedtimeGate). Kept apart from the gate so `FreezableModal`
 * and `AsamHybridHost` can mount these layers without pulling in the gate's
 * Convex and expo-web-browser imports.
 */
import { MoonStarsIcon } from "phosphor-react-native";
import { useContext, useEffect } from "react";
import { Keyboard, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BedtimeBunny, BedtimeSky } from "@/components/BedtimeScene";
import { BedtimeContext } from "@/contexts/BedtimeContext";
import { fonts } from "@/theme";
import { BEDTIME_HEADLINE } from "../../vendor/shared/bedtime";

/** The 5-minute banner and the night-sky overlay, whichever is due. */
export function BedtimeLayers() {
  const { warningText } = useContext(BedtimeContext);
  return (
    <>
      {warningText ? (
        <BedtimeWarningBanner text={warningText} />
      ) : null}
      <BedtimeOverlay />
    </>
  );
}

/** The night-sky takeover; renders nothing while awake. */
function BedtimeOverlay() {
  const { asleepSubline } = useContext(BedtimeContext);
  // A focused field underneath would keep its keyboard up over the overlay
  // (and keep typing into the app), including one that focuses later.
  useEffect(() => {
    if (!asleepSubline) return;
    Keyboard.dismiss();
    const sub = Keyboard.addListener("keyboardDidShow", () => Keyboard.dismiss());
    return () => sub.remove();
  }, [asleepSubline]);
  if (!asleepSubline) return null;

  return (
    <View
      style={styles.overlay}
      // Claim every touch so nothing underneath can be used overnight.
      onStartShouldSetResponder={() => true}
      accessibilityViewIsModal
      accessible
      accessibilityLabel={`${BEDTIME_HEADLINE}. ${asleepSubline}`}
    >
      <BedtimeSky />
      <BedtimeBunny />
      <Text style={styles.headline}>{BEDTIME_HEADLINE}</Text>
      <Text style={styles.subline}>{asleepSubline}</Text>
    </View>
  );
}

/** A notice, not a control: touches pass through it, and it ends at 8 pm. */
function BedtimeWarningBanner({ text }: { text: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="none"
      style={[styles.bannerWrap, { top: insets.top + 12 }]}
    >
      <View style={styles.banner} accessibilityRole="alert">
        <MoonStarsIcon size={24} weight="duotone" color="#FCE9A8" />
        <Text style={styles.bannerText}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 1100,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0C0A18",
    paddingHorizontal: 32,
  },
  headline: {
    color: "#ffffff",
    fontFamily: fonts.bold,
    fontSize: 34,
    letterSpacing: -0.5,
    textAlign: "center",
    marginTop: 8,
  },
  subline: {
    color: "rgba(255,255,255,0.8)",
    fontFamily: fonts.regular,
    fontSize: 20,
    lineHeight: 28,
    textAlign: "center",
    maxWidth: 520,
    marginTop: 10,
  },
  bannerWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 1050,
    alignItems: "center",
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    maxWidth: 560,
    width: "100%",
    backgroundColor: "#221A4D",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  bannerText: {
    flex: 1,
    color: "#ffffff",
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22,
  },
});
