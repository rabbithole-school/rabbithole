"use client";

/**
 * React wiring for Game Activities (kind="game") on the WEB app.
 *
 * On the web there is nothing to launch. Games are native-only as POLICY
 * (see `lib/games/contract.ts` → `GamePlatform`): there is no web renderer,
 * no degraded substitute, and no per-game exception. So `launch()` here
 * resolves the game's declared platform and raises an honest capability
 * notice instead of pretending.
 *
 * This is the exact shape of `useWebAssignment()` on purpose — every scholar
 * launch surface already knows how to call `launch()` and mount a dialog, so
 * adding games costs those surfaces one branch and no new concept.
 *
 * Reviewing is NOT playing: a teacher on a laptop still reads every game
 * session's digest through the ordinary review surfaces. Only gameplay is
 * gated.
 */

import { useCallback, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getGame, isGameId } from "@/lib/games/catalog";
import { platformNotice, type GamePlatform } from "@/lib/games/contract";

export type GameCapabilityPrompt = {
  activityTitle: string;
  /** The one-sentence notice, built from the game's own platform declaration. */
  notice: string;
  platform: GamePlatform;
};

export type LaunchGameActivityArgs = {
  activityId: Id<"activities">;
  /** Pass when the caller already has them (saves a query). */
  title?: string | null;
  gameId?: string | null;
};

/**
 * Resolve the notice without any I/O when the caller already knows the gameId.
 * Exported so non-hook surfaces (row subtitles, assignment summaries) can show
 * the SAME sentence the launch dialog would show.
 */
export function gameCapabilityPrompt(
  title: string | null | undefined,
  gameId: string | null | undefined,
): GameCapabilityPrompt {
  const entry = gameId && isGameId(gameId) ? getGame(gameId) : null;
  const activityTitle = title ?? entry?.title ?? "This game";
  // An unregistered gameId still gets the honest answer: whatever it is, it
  // isn't playable in this browser. Defaulting to "ipad" here is not a guess —
  // it's the only platform games have.
  const platform: GamePlatform = entry?.platform ?? "ipad";
  return {
    activityTitle,
    platform,
    notice: platformNotice(activityTitle, platform),
  };
}

export function useGameActivity() {
  const convex = useConvex();
  const [prompt, setPrompt] = useState<GameCapabilityPrompt | null>(null);
  const [launching, setLaunching] = useState(false);

  const launch = useCallback(
    async (args: LaunchGameActivityArgs) => {
      if (launching) return;
      setLaunching(true);
      try {
        let { title, gameId } = args;
        if (!gameId) {
          const activity = await convex.query(api.activities.getPublic, {
            id: args.activityId,
          });
          title = title ?? activity?.title ?? null;
          gameId = activity?.gameId ?? null;
        }
        setPrompt(gameCapabilityPrompt(title, gameId));
      } catch (err) {
        console.error("Game activity lookup failed:", err);
        // Even a failed lookup has an honest answer to give.
        setPrompt(gameCapabilityPrompt(args.title, args.gameId));
      } finally {
        setLaunching(false);
      }
    },
    [convex, launching],
  );

  const dismiss = useCallback(() => setPrompt(null), []);

  return { launch, launching, prompt, dismiss };
}
