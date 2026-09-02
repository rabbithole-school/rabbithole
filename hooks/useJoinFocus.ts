"use client";

/**
 * useJoinFocus — the shared "open a teacher-pushed activity" action.
 *
 * Extracted from the scholar Home's ClassFocusPin so the Scholar's-Prep
 * chooser can reuse the exact same behavior for its teacher-scheduled
 * segments: a kind="web" activity launches the (locked, on iPad) webview via
 * useWebAssignment; a normal activity opens/creates its chat session and
 * navigates to it; a focus with no specific activity falls back to the caller's
 * picker (`onNeedsPicker`). Keeping one implementation means the two entry
 * points can never drift.
 *
 * kind="game" is the third branch: games are native-only as POLICY, so on the
 * web `join` raises the capability notice instead of launching anything. That
 * keeps the honest answer in ONE place rather than in each caller's row
 * handler.
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useWebAssignment } from "@/hooks/useWebAssignment";
import { useGameActivity } from "@/hooks/useGameActivity";
import { toaster } from "@/lib/toaster";

/** The subset of an enriched `currentClassFocusForMe` entry join needs. */
export type JoinableFocus = {
  activityId: Id<"activities"> | null;
  activityKind: string | null;
  activityTitle: string | null;
  assignmentId: Id<"assignments">;
  webUrl: string | null;
  webAllowedHosts: string[] | null;
  /** Set for kind="game" focuses; drives the web capability notice. */
  gameId?: string | null;
  /** Set for a scheduled single-node problem set. */
  practiceSkillKey?: string | null;
};

export function useJoinFocus() {
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const webAssignment = useWebAssignment();
  const gameActivity = useGameActivity();

  const join = useCallback(
    async (
      focus: JoinableFocus,
      opts?: { onNeedsPicker?: () => void },
    ) => {
      // Web assignments open the external site (locked webview on the iPad,
      // plain tab on desktop) — no chat session gets created.
      if (focus.activityId && focus.activityKind === "web") {
        await webAssignment.launch({
          activityId: focus.activityId,
          assignmentId: focus.assignmentId,
          title: focus.activityTitle,
          webUrl: focus.webUrl,
          webAllowedHosts: focus.webAllowedHosts,
        });
        return;
      }
      // Games don't run in a browser (D-5, policy). Say so plainly rather
      // than creating a chat session the scholar didn't ask for.
      if (focus.activityId && focus.activityKind === "game") {
        await gameActivity.launch({
          activityId: focus.activityId,
          title: focus.activityTitle,
          gameId: focus.gameId ?? null,
        });
        return;
      }
      if (focus.activityKind === "problem_set" && focus.practiceSkillKey) {
        router.push(
          `/scholar/practice?skill=${encodeURIComponent(focus.practiceSkillKey)}`,
        );
        return;
      }
      // A specific activity → create its session and open it. Otherwise defer
      // to the caller's picker (pre-filtered to the unit on the Home surface).
      if (focus.activityId) {
        try {
          const result = await createSession({
            activityId: focus.activityId,
            assignmentId: focus.assignmentId,
          });
          if (result) router.push(`/scholar/${result.id}`);
        } catch (err) {
          console.error("Activity session launch failed:", err);
          toaster.error({
            title: "Couldn't start that activity",
            description: "Please try again.",
          });
        }
        return;
      }
      opts?.onNeedsPicker?.();
    },
    [createSession, router, webAssignment, gameActivity],
  );

  return {
    join,
    launching: webAssignment.launching || gameActivity.launching,
    donePrompt: webAssignment.donePrompt,
    resolveDonePrompt: webAssignment.resolveDonePrompt,
    gamePrompt: gameActivity.prompt,
    dismissGamePrompt: gameActivity.dismiss,
  };
}
