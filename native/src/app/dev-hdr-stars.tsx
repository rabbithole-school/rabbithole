/**
 * SPIKE screen — investigates whether the "brightest stars" in the sky map can
 * render BRIGHTER THAN 100% SDR white using the display's Extended Dynamic
 * Range (EDR / "HDR"). Reach it at the `/dev-hdr-stars` route (deep-link, or
 * register a temporary dev pill — this file does NOT edit sky.tsx or index.tsx).
 *
 * What it settles ON-DEVICE (screenshot it):
 *   1. The runtime EDR capability of THIS iPad. "Brighter than 100%" needs a
 *      display with EDR *headroom* (UIScreen.currentEDRHeadroom > 1.0). The
 *      base 11th-gen iPad (A16 / iPad15,7) is an SDR Liquid Retina LCD (~500
 *      nits, no HDR/XDR), so its headroom is expected to be 1.0 = NO headroom.
 *      The definitive value is a UIKit property NOT exposed to RN JS without a
 *      native module — so we surface it as "requires native module" and use a
 *      reachable-from-JS proxy: a WKWebView `(dynamic-range: high)` probe.
 *   2. Side-by-side "brightest star" treatments for eyeball comparison:
 *        A. pure #FFFFFF core + layered SVG bloom  (the SDR-max perceptual trick)
 *        B. plain #FFFFFF dot, no bloom            (baseline — what a star is now)
 *        C. an expo-image <Image> of an HDR gain-map asset
 *           (assets/hdr-star-core.heic) — proves expo-image renders it but
 *           CLAMPS it to SDR (no EDR) without a native module.
 *
 * Deliberately Convex-FREE (no useQuery / no auth), so a screenshot always
 * proves the bundle even if sign-in fails. See review/native-hdr-stars-spike.html.
 */

import { useMemo, useState } from "react";
import { Stack } from "expo-router";
import {
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Defs, Line, RadialGradient, Stop } from "react-native-svg";
import { Image } from "expo-image";
import WebView from "react-native-webview";
import * as Device from "expo-device";

import { fonts, useColors } from "@/theme";

// react-native-webview v14's component type resolves oddly under this Expo/TS
// combo for some iOS-only props; the runtime supports what we use here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProbeWebView = WebView as any;

// The candidate HDR star asset a designer drops in. Present in the repo at
// assets/hdr-star-core.heic (verify it carries a gain map / ISO-HDR tagging —
// if it's a plain SDR HEIC, re-export a true gain-map version). expo-image will
// decode + display it, but will NOT render it above SDR white (see the doc).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const HDR_STAR_ASSET = require("@/assets/hdr-star-core.heic");

// A tiny page whose only job is to report the WebKit render path's HDR
// capability back to RN. `(dynamic-range: high)` is supported in WKWebView on
// iOS 17+. On an SDR panel it resolves to `standard`; on an XDR/HDR panel it
// resolves to `high`. This is the best EDR-capability signal reachable from JS
// WITHOUT a custom native module (the exact UIScreen headroom number still needs
// native code).
const EDR_PROBE_HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head><body style="margin:0;background:#000">
<script>
(function () {
  function mm(q) { try { return window.matchMedia(q).matches; } catch (e) { return null; } }
  var payload = {
    high: mm('(dynamic-range: high)'),
    standard: mm('(dynamic-range: standard)'),
    videoHigh: mm('(video-dynamic-range: high)'),
  };
  try {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  } catch (e) {}
})();
true;
</script>
</body></html>`;

type ProbeResult = {
  high: boolean | null;
  standard: boolean | null;
  videoHigh: boolean | null;
};

export default function DevHdrStars() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const starSize = Math.min(200, (width - 80) / 3);

  const hdrCapable = probe?.high === true;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: "HDR stars (spike)" }} />

      <Text style={styles.title}>Can the brightest stars go “brighter than 100%”?</Text>
      <Text style={styles.subtitle}>
        “Brighter than SDR white” = Extended Dynamic Range (EDR). It needs a
        display with EDR headroom AND content rendered in extended range. This
        screen reads what it can on-device and shows the SDR-max alternative.
      </Text>

      {/* ── Verdict banner ─────────────────────────────────────────────── */}
      <View style={[styles.verdict, hdrCapable ? styles.verdictGood : styles.verdictWarn]}>
        <Text style={styles.verdictLabel}>
          {hdrCapable ? "EDR HEADROOM DETECTED" : "EXPECTED: NO EDR HEADROOM (SDR PANEL)"}
        </Text>
        <Text style={styles.verdictBody}>
          {hdrCapable
            ? "The WebKit probe reports a high-dynamic-range display. Real EDR is possible here — but only through a native Metal/Image path (see below)."
            : "The base iPad (A16) is an SDR Liquid Retina LCD (~500 nits): its EDR headroom is 1.0 — nothing can exceed 100% white. The brightest achievable is pure #FFFFFF + bloom (a perceptual trick). Real EDR only pays off on XDR iPads."}
        </Text>
      </View>

      {/* ── Capability read-out ───────────────────────────────────────── */}
      <View style={styles.card}>
        <Text style={styles.cardHead}>Runtime capability</Text>

        <Row label="Device (modelName)" value={Device.modelName ?? "—"} styles={styles} />
        <Row label="Device (modelId)" value={String(Device.modelId ?? "—")} styles={styles} />
        <Row
          label="OS"
          value={`${Device.osName ?? "—"} ${Device.osVersion ?? ""}`.trim()}
          styles={styles}
        />

        <View style={styles.divider} />

        <Row
          label="UIScreen.potentialEDRHeadroom"
          value="requires native module"
          hint="UIKit property — not exposed to RN JS"
          styles={styles}
        />
        <Row
          label="UIScreen.currentEDRHeadroom"
          value="requires native module"
          hint="UIKit property — not exposed to RN JS"
          styles={styles}
        />

        <View style={styles.divider} />

        <Row
          label="WebKit (dynamic-range: high)"
          value={fmtBool(probe?.high)}
          hint="WKWebView proxy for HDR capability (iOS 17+)"
          styles={styles}
        />
        <Row
          label="WebKit (dynamic-range: standard)"
          value={fmtBool(probe?.standard)}
          styles={styles}
        />
        <Row
          label="WebKit (video-dynamic-range: high)"
          value={fmtBool(probe?.videoHigh)}
          styles={styles}
        />
        <Text style={styles.note}>
          The WebKit probe is a proxy: `high` ≈ the display supports HDR/EDR.
          The exact headroom number (e.g. 1.6×) needs a tiny native module
          exposing `UIScreen.main.currentEDRHeadroom`.
        </Text>
      </View>

      {/* ── Hidden probe WebView (1×1, invisible) ─────────────────────── */}
      <View style={styles.hiddenProbe} pointerEvents="none">
        <ProbeWebView
          source={{ html: EDR_PROBE_HTML }}
          originWhitelist={["*"]}
          onMessage={(e: { nativeEvent: { data: string } }) => {
            try {
              setProbe(JSON.parse(e.nativeEvent.data) as ProbeResult);
            } catch {
              setProbe({ high: null, standard: null, videoHigh: null });
            }
          }}
          javaScriptEnabled
          scrollEnabled={false}
        />
      </View>

      {/* ── Treatments (on black) ─────────────────────────────────────── */}
      <Text style={styles.sectionHead}>“Brightest star” treatments</Text>
      <Text style={styles.subtitle}>
        Compare on-device against a dark room. On an SDR panel, A and B top out
        at the same physical brightness — bloom just makes A *read* brighter.
      </Text>

      <View style={styles.sky}>
        <Treatment
          label="A · #FFF core + bloom"
          caption="SDR-max perceptual (recommended)"
          size={starSize}
          styles={styles}
        >
          <BloomStar size={starSize} />
        </Treatment>

        <Treatment
          label="B · plain #FFF dot"
          caption="baseline — a star today"
          size={starSize}
          styles={styles}
        >
          <Svg width={starSize} height={starSize}>
            <Circle cx={starSize / 2} cy={starSize / 2} r={starSize * 0.16} fill="#ffffff" />
          </Svg>
        </Treatment>

        <Treatment
          label="C · HDR <Image> (.heic)"
          caption="expo-image → clamps to SDR"
          size={starSize}
          styles={styles}
        >
          <Image
            source={HDR_STAR_ASSET}
            style={{ width: starSize, height: starSize }}
            contentFit="contain"
            transition={0}
            alt="HDR star test asset"
          />
        </Treatment>
      </View>

      <Text style={styles.note}>
        Treatment C renders the gain-map asset via expo-image (SDWebImage under
        the hood). Even on an EDR-capable display it stays ≤ SDR white: expo-image
        exposes no `preferredImageDynamicRange`, so it can’t opt into the iOS-17
        EDR image path. A true EDR star needs a native module (see the doc).
      </Text>

      <Text style={styles.marker}>SPIKE:native-hdr-stars</Text>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function Row({
  label,
  value,
  hint,
  styles,
}: {
  label: string;
  value: string;
  hint?: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLabelWrap}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Treatment({
  label,
  caption,
  size,
  styles,
  children,
}: {
  label: string;
  caption: string;
  size: number;
  styles: ReturnType<typeof makeStyles>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.treatment}>
      <View style={[styles.stage, { width: size, height: size }]}>{children}</View>
      <Text style={styles.treatmentLabel}>{label}</Text>
      <Text style={styles.treatmentCaption}>{caption}</Text>
    </View>
  );
}

// The SDR-max "brightest star": a solid #FFFFFF core, a layered radial-gradient
// halo (bloom), and faint diffraction spikes. Pure white is the ceiling on an
// SDR panel; the bloom is what sells "very bright" to the eye.
function BloomStar({ size }: { size: number }) {
  const c = size / 2;
  const coreR = size * 0.12;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id="hdrBloom" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#ffffff" stopOpacity="1" />
          <Stop offset="0.10" stopColor="#ffffff" stopOpacity="0.92" />
          <Stop offset="0.26" stopColor="#ffffff" stopOpacity="0.42" />
          <Stop offset="0.55" stopColor="#ffffff" stopOpacity="0.12" />
          <Stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      {/* diffraction spikes (very faint) */}
      <Line x1={c} y1={size * 0.06} x2={c} y2={size * 0.94} stroke="#ffffff" strokeOpacity={0.28} strokeWidth={1.2} />
      <Line x1={size * 0.06} y1={c} x2={size * 0.94} y2={c} stroke="#ffffff" strokeOpacity={0.28} strokeWidth={1.2} />
      {/* bloom halo + hot core */}
      <Circle cx={c} cy={c} r={c} fill="url(#hdrBloom)" />
      <Circle cx={c} cy={c} r={coreR} fill="#ffffff" />
    </Svg>
  );
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === true) return "true";
  if (v === false) return "false";
  return "…";
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: c.bgSubtle },
    container: {
      width: "100%",
      maxWidth: 900,
      alignSelf: "center",
      paddingHorizontal: 20,
      paddingVertical: 16,
    },
    title: { fontFamily: fonts.bold, fontSize: 24, color: c.navy },
    subtitle: {
      fontFamily: fonts.regular,
      fontSize: 14.5,
      color: c.fgMuted,
      marginTop: 6,
      marginBottom: 16,
    },
    sectionHead: {
      fontFamily: fonts.bold,
      fontSize: 18,
      color: c.navy,
      marginTop: 26,
      marginBottom: 2,
    },
    verdict: {
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      marginBottom: 18,
    },
    verdictWarn: { backgroundColor: c.orangeSubtle, borderColor: c.orangeMuted },
    verdictGood: { backgroundColor: c.cyanSubtle, borderColor: c.cyanMuted },
    verdictLabel: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 1,
      color: c.orange,
      marginBottom: 6,
    },
    verdictBody: { fontFamily: fonts.medium, fontSize: 14.5, color: c.fg, lineHeight: 21 },
    card: {
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 4,
    },
    cardHead: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 1,
      color: c.charcoalSubtle,
      textTransform: "uppercase",
      marginBottom: 6,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      paddingVertical: 6,
      gap: 12,
    },
    rowLabelWrap: { flex: 1, minWidth: 0 },
    rowLabel: { fontFamily: fonts.semibold, fontSize: 14, color: c.navy },
    rowHint: { fontFamily: fonts.regular, fontSize: 11.5, color: c.fgMuted, marginTop: 1 },
    rowValue: {
      fontFamily: fonts.mono,
      fontSize: 13,
      color: c.fg,
      textAlign: "right",
      maxWidth: "48%",
    },
    divider: { height: 1, backgroundColor: c.border, marginVertical: 6 },
    note: {
      fontFamily: fonts.regular,
      fontSize: 12.5,
      color: c.fgMuted,
      marginTop: 10,
      lineHeight: 18,
    },
    hiddenProbe: { width: 1, height: 1, opacity: 0, overflow: "hidden" },
    sky: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-around",
      backgroundColor: "#05060c",
      borderRadius: 18,
      paddingVertical: 22,
      paddingHorizontal: 10,
      marginTop: 12,
      gap: 10,
    },
    treatment: { alignItems: "center", maxWidth: 220 },
    stage: { alignItems: "center", justifyContent: "center" },
    treatmentLabel: {
      fontFamily: fonts.semibold,
      fontSize: 13,
      color: "#ffffff",
      marginTop: 8,
      textAlign: "center",
    },
    treatmentCaption: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: "#9aa0b4",
      marginTop: 2,
      textAlign: "center",
    },
    marker: {
      fontFamily: fonts.mono,
      fontSize: 11,
      color: c.charcoalSubtle,
      opacity: 0.4,
      marginTop: 24,
      textAlign: "center",
    },
  });
}
