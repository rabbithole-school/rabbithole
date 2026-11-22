"use client";

/**
 * `/scholar/map` — the scholar's full-screen map.
 *
 * Launched from the Quests tab's "Your sky" band (`?view=sky&from=quests`,
 * whose back link returns to the Quests tab) and from the "Your Map" link in
 * the /scholar title bar. Hosts the Sky ⟷ Tree map on its own screen. The
 * Sky lens is the kid's own sky (components/sky/YourSky.tsx, TRA-699); the
 * web answer to the BunnyPad's pull-down from the Quests tab.
 *
 * Remote mode (`?remote=<scholarId>`): a teacher views the named scholar's
 * Tree; all reads route through that scholar's id and the back button
 * preserves the remote context. The Sky is the kid's own (`skyStars.forSelf`
 * reads only the signed-in scholar's stars), so remote mode has no Sky lens.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Flex, HStack, Spinner } from "@chakra-ui/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isTeacherRole } from "@/convex/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useLearnerContext } from "@/hooks/useLearnerContext";
import { useRemote } from "@/hooks/useRemote";
import { useMapGates } from "@/hooks/useMapGates";
import { ScholarPageHeader } from "@/components/ScholarPageHeader";
import { ScholarMapView, type MapMode } from "@/components/ScholarMapView";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

/** Where the back link returns when the Quests tab's "Your sky" band opened
 *  this page (`from=quests`). */
const QUESTS_TAB_HREF = "/scholar?tab=quests";

export default function ScholarMapPage() {
  return (
    <Suspense
      fallback={
        <Flex minH="100vh" bg="white" align="center" justify="center">
          <Spinner size="xl" color="violet.500" />
        </Flex>
      }
    >
      <ScholarMapInner />
    </Suspense>
  );
}

function ScholarMapInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading: isUserLoading } = useCurrentUser();
  const { hasLearnerContext, isLearnerContextLoading } =
    useLearnerContext(!!user);
  const { stamp } = useRemote();

  const remoteParam = searchParams.get("remote");
  // Deep-linked lens (`?view=tree|sky`, default sky). The daily-recap card links
  // here with `?view=tree` so the map opens on the Tree lens — the surface that
  // shows the movement the card names.
  const viewParam = searchParams.get("view");
  // Opened from the Quests tab's "Your sky" band: the back link returns there.
  const fromQuests = searchParams.get("from") === "quests";
  const [mapMode, setMapMode] = useState<"sky" | "tree">(
    viewParam === "tree" ? "tree" : "sky",
  );
  const isRemoteMode = !!(remoteParam && user && isTeacherRole(user.role));
  const remoteUserId = isRemoteMode ? (remoteParam as Id<"users">) : null;
  // The scholar whose map we're showing: the remote scholar when a teacher is
  // viewing-as, otherwise the caller themselves.
  const scholarId = remoteUserId ?? user?._id ?? null;

  // Milestone reveals (f6): a scholar sees the Tree once it has real data. A
  // teacher/parent/observer remote-view always sees the Tree, so the gate
  // query is enabled ONLY for a real scholar viewing their own maps (never
  // pre-auth, never for a teacher) and never gates otherwise. The Sky is the
  // kid's own record and opens for them always: an empty sky says how a
  // first star arrives. It has no remote view (see the header comment).
  const isSelfScholar =
    !!user &&
    (user.role === "scholar" || hasLearnerContext) &&
    !isRemoteMode;
  const gates = useMapGates(isSelfScholar);
  const skyAvailable = isSelfScholar;
  const treeAvailable = isRemoteMode || gates.tree;
  const anyAvailable = skyAvailable || treeAvailable;

  // Auth / role redirects (mirror /scholar): signed-out → sign-in, a teacher
  // who isn't viewing-as → their own home (they have no personal star map).
  useEffect(() => {
    if (isUserLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (
      isTeacherRole(user.role) &&
      !isRemoteMode &&
      !isLearnerContextLoading &&
      !hasLearnerContext
    ) {
      router.replace("/teacher");
    }
  }, [
    user,
    isUserLoading,
    router,
    isRemoteMode,
    hasLearnerContext,
    isLearnerContextLoading,
  ]);

  // Coerce the active lens to one that's actually available to this viewer, so
  // a deep-link like ?view=sky on a scholar whose Sky isn't ready falls to
  // their Tree (and vice-versa) instead of rendering a locked lens.
  const effectiveMode: MapMode =
    mapMode === "tree"
      ? treeAvailable
        ? "tree"
        : "sky"
      : skyAvailable
        ? "sky"
        : "tree";

  // Consume the one-time reveal on genuine ARRIVAL at a map's surface (J10(b)).
  // The Home reveal card teaches the access gesture ("tap Your Map") and stays
  // up until the scholar actually reaches the map HERE — the moment a lens
  // becomes visible we record ITS reveal, once per lens, and never again. So
  // the card doubles as onboarding for the gesture and retires itself on
  // arrival. Self-scholar only (a teacher / remote view never mints a reveal),
  // and never before the map view actually renders (guarded by scholarId &&
  // anyAvailable), so it can't fire on a route preload.
  const acknowledgeReveal = useMutation(api.mapGates.acknowledgeReveal);
  const consumedRef = useRef<Set<MapMode>>(new Set());
  useEffect(() => {
    if (!isSelfScholar || gates.isLoading) return;
    if (!scholarId || !anyAvailable) return;
    const m = effectiveMode;
    const pending = m === "sky" ? gates.skyRevealPending : gates.treeRevealPending;
    if (!pending || consumedRef.current.has(m)) return;
    consumedRef.current.add(m);
    void acknowledgeReveal({ map: m });
  }, [
    isSelfScholar,
    gates.isLoading,
    gates.skyRevealPending,
    gates.treeRevealPending,
    scholarId,
    anyAvailable,
    effectiveMode,
    acknowledgeReveal,
  ]);

  // One Sky-open event each time the Sky lens comes into view for a scholar
  // on their own map: arriving on it, or switching to it from the Tree
  // (skyOpens.record, TRA-669/TRA-676). The ref keeps a re-render, or React's
  // dev double-run of effects, from counting one open twice.
  const recordSkyOpen = useMutation(api.skyOpens.record);
  const skyShowing =
    isSelfScholar && !gates.isLoading && anyAvailable && effectiveMode === "sky";
  const skyShowingRef = useRef(false);
  useEffect(() => {
    if (skyShowing && !skyShowingRef.current) {
      void recordSkyOpen({}).catch((error) =>
        console.error("[sky] open not recorded", error),
      );
    }
    skyShowingRef.current = skyShowing;
  }, [skyShowing, recordSkyOpen]);

  const homeHref = stamp(fromQuests ? QUESTS_TAB_HREF : "/scholar");
  // Only offer the lens toggle when BOTH lenses are available to this viewer;
  // a scholar with just one map unlocked simply sees that one, no toggle.
  const mapModeToggle =
    skyAvailable && treeAvailable ? (
      <HStack gap={1} bg="gray.100" borderRadius="lg" p={1}>
        {(["sky", "tree"] as const).map((m: MapMode) => (
          <Button
            key={m}
            size="xs"
            minH="36px"
            variant={effectiveMode === m ? "solid" : "ghost"}
            colorPalette="violet"
            aria-pressed={effectiveMode === m}
            onClick={() => setMapMode(m)}
          >
            {m === "sky" ? "Your sky" : "Math skills tree"}
          </Button>
        ))}
      </HStack>
    ) : undefined;

  return (
    <Flex h={VIEWPORT_SHELL_HEIGHT} bg="white" flexDir="column">
      <ScholarPageHeader
        homeHref={homeHref}
        homeLabel={fromQuests ? "Back to Quests" : "Back to home"}
        showHomeLabel
        // With the lens toggle up, the toggle names the lens.
        title={!mapModeToggle && effectiveMode === "sky" ? "Your sky" : "Your Map"}
        centerSlot={mapModeToggle}
      />
      <Flex flex={1} minH={0} flexDir="column">
        {scholarId && anyAvailable ? (
          <ScholarMapView scholarId={scholarId} mode={effectiveMode} />
        ) : (
          <Flex flex={1} align="center" justify="center">
            <Spinner size="xl" color="violet.500" />
          </Flex>
        )}
      </Flex>
    </Flex>
  );
}
