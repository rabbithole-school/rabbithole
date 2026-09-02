/**
 * Resolves the current skin's four pieces of charm artwork (robot, wall,
 * goal, treasure) via `useThemeIcon` and pushes them into the sandbox as they
 * arrive.
 *
 * Production's rule is "never block on art": the sandbox already has vector
 * fallbacks and renders immediately, so this never gates anything — it just
 * calls `sendCharms` again, additively, whenever another URL resolves.
 *
 * It does wait for `actionsReady`, though. Not to block art, but because a
 * dispatch made before the sandbox registers its actions is discarded, and
 * this hook stamps `lastSentRef` at send time — so a lost first send would
 * pin the scholar to vector fallbacks for the whole session. Art URLs
 * normally resolve after a Convex round trip and win anyway; a warm cache is
 * exactly the case that would not.
 */
import { useEffect, useRef } from "react";

import { useThemeIcon } from "@/components/manipulatives/useThemeIcon";

import {
  STUDIO_DEFAULT_SKIN_ID,
  STUDIO_SKINS,
  studioCharmKey,
} from "./studioCharms";

export function useStudioCharms(
  sendCharms: (urls: Record<string, string>) => void,
  actionsReady: boolean,
) {
  const skin = STUDIO_SKINS[STUDIO_DEFAULT_SKIN_ID];

  // Four independent lookups, not a loop over the entity list — useThemeIcon
  // is a hook, and calling it a variable number of times (e.g. inside
  // `.map()`) would violate the rules of hooks even though the entity count
  // happens to be static today.
  const robotUrl = useThemeIcon({ fill: { label: studioCharmKey(skin.id, "robot") } });
  const wallUrl = useThemeIcon({ fill: { label: studioCharmKey(skin.id, "wall") } });
  const goalUrl = useThemeIcon({ fill: { label: studioCharmKey(skin.id, "goal") } });
  const treasureUrl = useThemeIcon({
    fill: { label: studioCharmKey(skin.id, "treasure") },
  });

  const lastSentRef = useRef("");

  useEffect(() => {
    if (!actionsReady) return;

    const urls: Record<string, string> = {};
    if (robotUrl) urls[studioCharmKey(skin.id, "robot")] = robotUrl;
    if (wallUrl) urls[studioCharmKey(skin.id, "wall")] = wallUrl;
    if (goalUrl) urls[studioCharmKey(skin.id, "goal")] = goalUrl;
    if (treasureUrl) urls[studioCharmKey(skin.id, "treasure")] = treasureUrl;

    // Nothing resolved yet — the sandbox's own vector fallbacks are already
    // on screen, so there is nothing to send and nothing to wait for.
    if (Object.keys(urls).length === 0) return;

    const signature = JSON.stringify(urls);
    if (signature === lastSentRef.current) return;
    lastSentRef.current = signature;
    sendCharms(urls);
  }, [robotUrl, wallUrl, goalUrl, treasureUrl, sendCharms, skin.id, actionsReady]);
}
