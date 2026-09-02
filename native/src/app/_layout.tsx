import { useEffect, useRef, useState } from "react";
import { Stack } from "expo-router";
import Constants from "expo-constants";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  ConvexAuthProvider,
  useAuthActions,
  useConvexAuth,
} from "@convex-dev/auth/react";
import {
  useFonts,
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from "@expo-google-fonts/hanken-grotesk";

import { AccountMenuButton } from "@/components/AccountMenu";
import { ScholarIdentityReveal } from "@/components/ScholarIdentityReveal";
import { AsamHybridHost } from "@/components/AsamHybridHost";
import { NativeAppLaunchProvider } from "@/contexts/NativeAppLaunchContext";
import { BadgeAwardOverlay } from "@/components/BadgeAwardOverlay";
import { BugReportGate } from "@/components/bugreport/BugReportGate";
import { ExternalAppHost } from "@/components/ExternalAppHost";
import { NativeManipulativeHost } from "@/components/manipulatives/NativeManipulativeHost";
import { GameHost } from "@/components/games/GameHost";
import { GameHostBoundary } from "@/components/games/GameHostBoundary";
import {
  eagerLoadAllGames,
  eagerLoadFailureIsFatal,
  shouldEagerLoadGames,
} from "@/games/registry";
import { KioskWifiHelpOverlay } from "@/components/wifi/KioskWifiHelpOverlay";
import { OnboardingFlow } from "@/components/OnboardingFlow";
import { SignIn, DEV_LOGIN_AVAILABLE } from "@/components/SignIn";
import { convex } from "@/lib/convex";
import { secureTokenStorage } from "@/lib/secureTokenStorage";
import { fonts, useColors } from "@/theme";
import { hasSeenOnboarding } from "@/lib/onboardingStorage";
import { useManagedClaimBootstrap } from "@/hooks/useManagedClaimBootstrap";
import { useManagedMaximumBrightness } from "@/hooks/useManagedMaximumBrightness";
import { devServerUrlFromHostUri } from "@/lib/devClientSafety";
import { guardCurrentDevServer } from "../../modules/dev-client-safety";
import { useNativeClientHeartbeat } from "@/hooks/useNativeClientHeartbeat";
import { DevNavigationBridge } from "@/components/DevNavigationBridge";
import { getManagedConfig } from "../../modules/managed-config";
import { isManagedAsamEnabled } from "@/lib/asam/asamDecision";
import { authGateScreen } from "./authGateState";
import { captureStationEnrollmentToken } from "@/lib/captureStationToken";
import { CaptureStationScreen } from "@/components/CaptureStationScreen";
import { useApprovedDeviceSignOut } from "@/hooks/useDeviceSignOut";
import { useAssignedDeviceCaptureStation } from "@/hooks/useAssignedDeviceCaptureStation";

const showBuildStamp = process.env.EXPO_PUBLIC_SHOW_BUILD_STAMP === "1";
const buildStamp = process.env.EXPO_PUBLIC_BUILD_STAMP ?? "local-dev";
// Marketing version + build number, read from the built app's own config so the
// stamp says WHICH release is on the iPad (e.g. "v1.0.4 (5)"), not just when it
// was bundled. Ad Hoc fleet releases are identified by version + build number,
// so this is what makes "is this device up to date or stale?" answerable at a
// glance without a Mac.
const appVersion = Constants.expoConfig?.version ?? null;
const appBuildNumber = Constants.expoConfig?.ios?.buildNumber ?? null;
const versionLabel = appVersion
  ? `v${appVersion}${appBuildNumber ? ` (${appBuildNumber})` : ""}`
  : null;

// The offline wifi-recovery overlay. In every lockdown posture we ship now
// (the ASAM "best of both" hybrid, and the multi-app kiosk), the OS Settings
// app IS reachable while offline — the ASAM hybrid deliberately steps OUT of
// Single App Mode the moment it goes offline — so recovery is always "open
// Settings → Wi-Fi and pick any network" (KioskWifiHelpOverlay). The former
// hard Single App Mode path (Settings blocked → a MDM-preprovisioned
// Carrot-hotspot rescue) was discarded; see the removed HotspotRecoveryOverlay
// in git history if it ever needs resurrecting.
const WifiRecoveryOverlay = KioskWifiHelpOverlay;

// ASAM is only available to MDM-managed installs explicitly configured for it.
// The App Store-safe Stable binary carries the code but has no path into ASAM
// on a personal install.
const ASAM_HYBRID_ENABLED = isManagedAsamEnabled(getManagedConfig());

// Games load LAZILY in a fleet build so a broken game module can never take
// down app startup on a kiosk iPad (no app switcher, no USB recovery — "the
// game is broken" and "the iPad is a brick" must not be the same event). In dev
// and the rhtest variant we want the opposite: require every registered game
// right here at module scope so a failure is found at boot. CI is the real gate
// (native/src/games/__tests__/registry.test.ts).
if (shouldEagerLoadGames()) {
  void eagerLoadAllGames().catch((err) => {
    // ALWAYS loud; fatal only in dev. rhtest opts into the boot-time check but
    // is a RELEASE build, where an unhandled JS exception is process death
    // rather than a dismissible RedBox — see `eagerLoadFailureIsFatal`.
    console.error(err);
    if (eagerLoadFailureIsFatal()) {
      setTimeout(() => {
        throw err;
      }, 0);
    }
  });
}

// DEV-ONLY opt-in: auto-sign-in as the seeded dev scholar via the `devLogin`
// provider so the headless dev loop can skip the sign-in tap. Requires an
// explicit EXPO_PUBLIC_DEV_AUTOLOGIN=1 and a dev-login secret, and is compiled
// out of production builds (DEV_LOGIN_AVAILABLE is false when !__DEV__). The
// DEFAULT unauthenticated surface is always the real sign-in screen.
const DEV_AUTOLOGIN =
  DEV_LOGIN_AVAILABLE && process.env.EXPO_PUBLIC_DEV_AUTOLOGIN === "1";
const DEV_NAVIGATION_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_DEV_NAV_BRIDGE === "1";

function DevClientSafetyGate() {
  useEffect(() => {
    if (!__DEV__) return;
    const serverUrl = devServerUrlFromHostUri(Constants.expoConfig?.hostUri);
    if (!serverUrl) {
      console.warn("[dev-client-safety] Expo hostUri is unavailable");
      return;
    }

    let attempts = 0;
    const guard = async () => {
      attempts += 1;
      const result = await guardCurrentDevServer(serverUrl);
      if (result?.guarded) {
        console.log(
          `[dev-client-safety] picker guarded to ${result.serverUrl ?? serverUrl}`,
        );
        return;
      }
      if (attempts >= 20) {
        console.warn(
          `[dev-client-safety] could not guard picker to ${serverUrl}; ` +
            "rebuild the dev client before trusting a cold launch",
        );
        return;
      }
      setTimeout(() => void guard(), 250);
    };
    void guard();
  }, []);

  return null;
}

// Auth gate: renders the app only when signed in. While the (async,
// SecureStore-backed) token load is in flight we show a brand loader so the
// sign-in screen never flashes on a cold start for an already-signed-in
// scholar. When signed out, the real username/password SignIn screen is the
// default surface; signing out (AccountMenu / Account Details) flips
// useConvexAuth() back to unauthenticated and returns here automatically.
function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  useNativeClientHeartbeat();
  const { signIn, signOut } = useAuthActions();
  const colors = useColors();
  const devLoginAttempted = useRef(false);
  const [devAutoLoginReady, setDevAutoLoginReady] = useState(!DEV_AUTOLOGIN);
  const managedClaim = useManagedClaimBootstrap({
    isAuthenticated,
    isAuthLoading: isLoading,
  });
  useApprovedDeviceSignOut(isAuthenticated && !isLoading && devAutoLoginReady);

  useEffect(() => {
    if (
      !DEV_AUTOLOGIN ||
      isLoading ||
      managedClaim.hasManagedClaim ||
      devLoginAttempted.current
    ) {
      return;
    }
    // A remote smoke can outlive a reset of its private dev database. Its
    // SecureStore token then looks authenticated locally but is rejected by the
    // backend; refresh through devLogin before mounting any authenticated query.
    //
    // The sign-out first is load-bearing, not hygiene: calling signIn while the
    // stored tokens are still VALID makes the server delete the prior session
    // and all its refresh tokens, and the client's concurrent force-refresh
    // with the now-orphaned stored refresh token then gets null back and wipes
    // the fresh devLogin tokens from memory and keychain — bouncing the app to
    // SignIn on exactly the boots where the keychain carried a live session.
    //
    // Accepted residual: a force-refresh that read the OLD refresh token
    // before this signOut clears storage can still resolve after the fresh
    // sign-in and null the new tokens (@convex-dev/auth serializes refreshes
    // but has no stale-result guard, and signIn/signOut don't join its mutex).
    // A refresh starting after signOut finds no stored token and returns null
    // without clobbering. If the narrow window ever hits, the boot fails with
    // a clean keychain and the smoke harness's one-shot warm relaunch
    // (scripts/remote-ios-smoke.sh) recovers deterministically.
    devLoginAttempted.current = true;
    void (async () => {
      await signOut().catch(() => {});
      await signIn("devLogin", {
        username: process.env.EXPO_PUBLIC_DEV_SCHOLAR ?? "test-scholar-001",
        secret: process.env.EXPO_PUBLIC_DEV_LOGIN_SECRET ?? "",
      });
    })()
      .catch((e) => console.warn("[devLogin] auto failed", e))
      .finally(() => setDevAutoLoginReady(true));
  }, [
    isLoading,
    managedClaim.hasManagedClaim,
    signIn,
    signOut,
  ]);

  const screen = authGateScreen({
    isAuthenticated,
    isLoading: isLoading || !devAutoLoginReady,
    isReconciling: managedClaim.isReconciling,
    isSwitchingScholar: managedClaim.isSwitchingScholar,
    showFallbackNotice: managedClaim.showFallbackNotice,
  });

  if (screen === "loading") {
    return (
      <View style={[styles.authLoading, { backgroundColor: colors.bgSubtle }]}>
        <ActivityIndicator color={colors.violet} size="large" />
      </View>
    );
  }
  if (screen === "switching") {
    // A hand-over: this iPad was re-paired to somebody else. Say so instead of
    // swapping identity silently — the previous scholar's surface is already
    // gone by the time this renders.
    return (
      <View style={[styles.authLoading, { backgroundColor: colors.bgSubtle }]}>
        <ActivityIndicator color={colors.violet} size="large" />
        <Text style={[styles.switchingTitle, { color: colors.fg }]}>
          {managedClaim.switchingToName
            ? `Switching to ${managedClaim.switchingToName}…`
            : "Switching to a new scholar…"}
        </Text>
        <Text style={[styles.switchingBody, { color: colors.fgMuted }]}>
          This iPad was assigned to someone else. Your work is saved.
        </Text>
      </View>
    );
  }
  if (screen === "fallback-notice") {
    return (
      <SignIn notice="Couldn't sign in automatically — ask your teacher." />
    );
  }
  if (screen === "sign-in") return <SignIn />;
  return <AssignedDeviceCaptureGate>{children}</AssignedDeviceCaptureGate>;
}

// A teacher's temporary device assignment is live-only: no SecureStore fallback
// means an offline or revoked station returns to the ordinary scholar surface.
// This stays below AuthGate so managed-claim reconciliation and the native
// heartbeat keep running while a robotics station is open.
function AssignedDeviceCaptureGate({ children }: { children: React.ReactNode }) {
  const station = useAssignedDeviceCaptureStation();
  if (station.mode !== "assigned" || !station.assignment) return <>{children}</>;
  return (
    <CaptureStationScreen
      source={{ kind: "assigned", assignment: station.assignment }}
    />
  );
}

// First-run gate: shows OnboardingFlow once, stored via expo-secure-store.
// Renders children immediately underneath so Home is never blocked for
// returning users — the flow is an absolute overlay, not a modal push.
function OnboardingGate({ children }: { children: React.ReactNode }) {
  // Onboarding temporarily disabled (dev): always skip the first-run flow.
  const [showFlow, setShowFlow] = useState<boolean | null>(false);
  useEffect(() => {
    void hasSeenOnboarding(); // no-op; kept so the import stays wired for re-enable
  }, []);
  return (
    <>
      {children}
      {showFlow && <OnboardingFlow onDone={() => setShowFlow(false)} />}
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
  });
  const colors = useColors();
  useManagedMaximumBrightness(ASAM_HYBRID_ENABLED);
  const captureStation = captureStationEnrollmentToken() !== null;

  if (!fontsLoaded) return null;

  // Shared Stack navigator config — same settings used in both ASAM and
  // non-ASAM branches so the two paths stay in sync.
  const stackScreenOptions = {
    headerLargeTitle: false,
    // No headerStyle.backgroundColor — on the iOS 26 SDK the native
    // UINavigationBar renders Liquid Glass by default; forcing an
    // opaque background (as we used to) overrides/kills that glass.
    // headerTransparent is set per-screen (the chat screen) where we
    // want content to scroll under the glass.
    headerTitleStyle: {
      fontFamily: fonts.semibold,
      color: colors.navy,
    },
    // Chevron-only back button (iOS 26 convention). We deliberately do
    // NOT set headerBackTitleStyle: giving the back title a custom
    // (non-"System") font forces react-native-screens to install a
    // custom backBarButtonItem, and on the iOS 26 Liquid Glass nav bar
    // that custom item renders as an oversized glass pill (see
    // react-navigation#13164 / react-native-screens#3834). "minimal"
    // keeps the well-behaved native system back button (a plain
    // chevron, tinted below) and sidesteps the bug entirely.
    headerBackButtonDisplayMode: "minimal" as const,
    headerTintColor: colors.violet,
    contentStyle: { backgroundColor: colors.bgSubtle },
  };

  // The main app subtree shared by both the ASAM-wrapped and bare paths.
  const appContent = (
    <>
      <DevClientSafetyGate />
      {/* Deliberately above AuthGate: the dev bridge must keep polling on sign-in
          and report the route AuthGate actually permits, not surprise-navigate
          only after authentication completes (REVIEW-BRIDGE #8). */}
      {DEV_NAVIGATION_ENABLED && <DevNavigationBridge />}
      <AuthGate>
        <OnboardingGate>
          {/* expo-router <Stack> = native-stack = UINavigationController: real
              push/pop, swipe-back, large-title nav bar. Styled with the
              Rabbithole palette + Hanken Grotesk so the native chrome matches
              the brand. */}
          <Stack screenOptions={stackScreenOptions}>
            <Stack.Screen
              name="index"
              options={{
                title: "My Sessions",
                headerRight: () => <AccountMenuButton />,
              }}
            />
            <Stack.Screen name="me" options={{ title: "My Learning" }} />
            <Stack.Screen name="practice" options={{ title: "Practice" }} />
            <Stack.Screen name="reflection" options={{ title: "Today's reflection" }} />
            <Stack.Screen name="workshop" options={{ title: "The Workshop" }} />
            <Stack.Screen name="workshop-ask" options={{ title: "Ask Rabbithole" }} />
            <Stack.Screen name="meta" options={{ title: "The Workshop" }} />
            <Stack.Screen name="account" options={{ title: "Account details" }} />
            <Stack.Screen name="how-it-works" options={{ title: "How it works" }} />
            <Stack.Screen name="unit-progress" options={{ title: "Where you are" }} />
            <Stack.Screen name="dev-hdr-stars" options={{ title: "HDR stars (spike)" }} />
            <Stack.Screen name="dev-slides" options={{ title: "Slides (harness)" }} />
            <Stack.Screen
              name="sky"
              options={{
                title: "Your Map",
                headerShown: false,
                animation: "fade",
                // The Map owns its OWN pan/pinch (the Sky canvas + the Tree
                // webview), so a horizontal finger drag MUST pan the map, never
                // navigate. Disable the iOS interactive back-swipe for this route
                // only — both the left-edge pop (gestureEnabled) and the
                // whole-width variant (fullScreenGestureEnabled). The deliberate
                // close affordance is the in-screen Done button (router.back()).
                gestureEnabled: false,
                fullScreenGestureEnabled: false,
              }}
            />
            <Stack.Screen
              name="studio"
              options={{
                title: "Studio",
                headerShown: false,
                animation: "fade",
                // The Studio WebView owns canvas drags (robot/pen movement) and
                // the code editor's own scrolling, same reasoning as "sky"
                // above — a horizontal/vertical drag must reach the document,
                // never the native back-swipe. The close affordance is the
                // in-screen Done button (router.back()).
                gestureEnabled: false,
                fullScreenGestureEnabled: false,
              }}
            />
          </Stack>
          <ScholarIdentityReveal />
          {/* Badge award overlay — mounted here so it can appear over any screen */}
          <BadgeAwardOverlay />
          {/* Keep-alive embedded WebView host — mounted once; survives reopen */}
          <ExternalAppHost />
          {/* Inline native manipulative practice-item host — the sibling of
              ExternalAppHost for kinds with a native renderer (WebView-embed
              fallback for the rest). Driven by openNativeManipulativeItem. */}
          <NativeManipulativeHost />
          {/* Game host — the sibling of the two above for kind="game"
              activities. Games are native-only by policy; a browser shows a
              capability notice instead. Driven by openGameActivity.
              Wrapped in a host-level boundary: GameHost's own GameErrorBoundary
              lives inside its returned JSX and can't catch a throw from the
              host's own render (see PR #1862), which on a kiosk iPad is an
              app-killing RCTFatal. See GameHostBoundary for the recovery design. */}
          <GameHostBoundary>
            <GameHost />
          </GameHostBoundary>
        </OnboardingGate>
      </AuthGate>
      {/* Take-home wifi recovery overlay — a SIBLING of AuthGate (inside the
          provider, outside the sign-in wall) so it can appear even when the
          device has no internet and the scholar can't sign in yet. Native-only
          by design; the web app never runs in kiosk/Single App Mode. Guides the
          user to open Settings → Wi-Fi and pick any network (WifiRecoveryOverlay
          above). */}
      <WifiRecoveryOverlay />
    </>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ConvexAuthProvider client={convex} storage={secureTokenStorage}>
        <BugReportGate>
          {/* ASAM "best of both" hybrid host — wraps the entire app subtree so the
              4-finger hold GestureDetector (inside AsamParentGate) is full-screen.
              Must be inside ConvexAuthProvider (uses useAsamController) but wraps
              AuthGate so Device settings is reachable even from the sign-in screen.
              When the MDM runtime gate is absent, appContent renders plainly. */}
          {captureStation ? (
            <CaptureStationScreen source={{ kind: "static" }} />
          ) : ASAM_HYBRID_ENABLED ? (
            <AsamHybridHost>
              <NativeAppLaunchProvider>{appContent}</NativeAppLaunchProvider>
            </AsamHybridHost>
          ) : (
            // Managed-app visibility is an MDM policy independent of ASAM.
            // Keep the unlock gate mounted even when the ASAM opt-in is absent;
            // its presentation controller is safely a no-op in that posture.
            <NativeAppLaunchProvider>{appContent}</NativeAppLaunchProvider>
          )}
        </BugReportGate>
      </ConvexAuthProvider>
      {showBuildStamp && (
        <View
          pointerEvents="none"
          style={styles.buildStamp}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={[styles.buildStampText, { color: colors.navy }]}>
            {versionLabel ? `${versionLabel} · ` : ""}Build {buildStamp}
          </Text>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  authLoading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  switchingTitle: {
    marginTop: 20,
    fontFamily: fonts.semibold,
    fontSize: 22,
    textAlign: "center",
  },
  switchingBody: {
    marginTop: 8,
    fontFamily: fonts.regular,
    fontSize: 16,
    textAlign: "center",
  },
  buildStamp: {
    position: "absolute",
    left: 10,
    bottom: 8,
    zIndex: 9999,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.55)",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  buildStampText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    opacity: 0.55,
  },
});
