import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useMutation } from "convex/react";
import { useIsFocused } from "expo-router";
import { useOpenEmbeddedWebContent } from "@/lib/externalAppHost";
import { useGameRequest } from "@/lib/gameHost";
import { useNativeManipulativeRequest } from "@/lib/nativeManipulativeHost";

import { api, type Id } from "@/lib/convex";
import {
  createAppPlayTracker,
  type AppPlayInteractionSource,
  type AppPlayTracker,
} from "../../vendor/shared/appPlaySession";

/**
 * Record when this app is on screen (convex/appPlaySessions.ts): while
 * `onScreen` is true and Rabbithole is the foreground app. The server decides
 * whether this viewer is tracked at all — a teacher watching gets null back
 * from start() and nothing is written. Web twin: hooks/useAppPlaySession.ts.
 *
 * AppState "active" is not proof the screen is on: a BunnyPad locked into
 * Rabbithole (Single App Mode) goes active by itself as it locks and at its
 * early-morning wake, which is how a closed folio once logged a whole night
 * on screen. With `interactions`, the interval also carries active time and
 * ends itself once nobody has touched the app for a while
 * (shared/appPlaySession.ts), so that time is no longer counted.
 */
export function useAppPlaySession(
  artifactId: Id<"artifacts"> | null,
  onScreen: boolean,
  interactions?: AppPlayInteractionSource,
): void {
  const start = useMutation(api.appPlaySessions.start);
  const heartbeat = useMutation(api.appPlaySessions.heartbeat);
  const end = useMutation(api.appPlaySessions.end);
  // Built and disposed in an effect (StrictMode-safe); the active flag is
  // mirrored in a ref so a tracker rebuilt for a new artifact starts in the
  // current state.
  const trackerRef = useRef<AppPlayTracker | null>(null);
  const activeRef = useRef(false);
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState,
  );
  const tracksInteraction = interactions !== undefined;

  useEffect(() => {
    if (artifactId === null) return;
    const next = createAppPlayTracker<Id<"appPlaySessions">>({
      start: () =>
        start({
          artifactId,
          surface: "native",
          ...(tracksInteraction ? { tracksInteraction: true } : {}),
        }),
      heartbeat: (playSessionId, activity) =>
        heartbeat({ playSessionId, ...activity }),
      end: ({ playSessionId, resumes }, endedAt, activity) =>
        end({ playSessionId, resumes, endedAt, ...activity }),
      tracksInteraction,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
      onError: (error) =>
        console.warn("[rabbithole] app play tracking failed", error),
    });
    trackerRef.current = next;
    next.setActive(activeRef.current);
    return () => {
      next.dispose();
      if (trackerRef.current === next) trackerRef.current = null;
    };
  }, [artifactId, start, heartbeat, end, tracksInteraction]);

  useEffect(
    () => interactions?.subscribe(() => trackerRef.current?.noteInteraction()),
    [interactions],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);

  const active = onScreen && appState === "active";
  useEffect(() => {
    activeRef.current = active;
    trackerRef.current?.setActive(active);
  }, [active]);
}

/**
 * The tracker as a render-nothing component, for hosts that may live outside
 * a navigator screen: only a session app mounts it, and it is paused while
 * its screen is covered. Two things cover it without unmounting it:
 * expo-router's native stack keeps a pushed-over screen mounted, and the
 * root hosts (_layout.tsx: ExternalAppHost, NativeManipulativeHost, GameHost)
 * draw over the current screen without blurring it.
 */
export function AppPlaySessionTracker({
  artifactId,
  onScreen,
  interactions,
}: {
  artifactId: Id<"artifacts">;
  onScreen: boolean;
  interactions?: AppPlayInteractionSource;
}): null {
  const focused = useIsFocused();
  const embedded = useOpenEmbeddedWebContent();
  const manipulative = useNativeManipulativeRequest();
  const game = useGameRequest();
  const covered = embedded !== null || manipulative !== null || game !== null;
  useAppPlaySession(artifactId, onScreen && focused && !covered, interactions);
  return null;
}
