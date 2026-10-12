"use client";

/**
 * React wiring for Web Assignments (kind="web" activities).
 *
 * `launch()` is the single entry point every scholar surface uses
 * (class-focus Join button, homework rows, the progress navigator).
 * It opens a webActivitySessions row, then opens the external site in a
 * new tab and surfaces the done-prompt so the scholar can mark it done
 * when they're back.
 *
 * `donePrompt` drives <WebAssignmentDoneDialog/> — shown after a
 * session ends, asking the scholar whether they're done. Mount the dialog
 * next to any surface that calls launch().
 */

import { useCallback, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { haptic } from "@/lib/native";
import { toaster } from "@/lib/toaster";

export type WebDonePrompt = {
  sessionId: Id<"webActivitySessions">;
  activityTitle: string;
};

export type LaunchWebAssignmentArgs = {
  activityId: Id<"activities">;
  assignmentId?: Id<"assignments">;
  /** Pass when the caller already has them (saves a query). */
  title?: string | null;
  webUrl?: string | null;
  webAllowedHosts?: string[] | null;
};

export function useWebAssignment() {
  const convex = useConvex();
  const [donePrompt, setDonePrompt] = useState<WebDonePrompt | null>(null);
  const [launching, setLaunching] = useState(false);

  const launch = useCallback(
    async (args: LaunchWebAssignmentArgs) => {
      if (launching) return;
      setLaunching(true);
      try {
        let { title, webUrl } = args;
        if (!webUrl) {
          const activity = await convex.query(api.activities.getPublic, {
            id: args.activityId,
          });
          title = title ?? activity?.title ?? null;
          webUrl = activity?.webUrl ?? null;
        }
        if (!webUrl) {
          toaster.error({
            title: "No website set up for this assignment yet",
            description: "Ask your teacher to add the website URL.",
          });
          return;
        }
        const { sessionId } = await convex.mutation(
          api.webActivitySessions.start,
          { activityId: args.activityId, assignmentId: args.assignmentId },
        );
        const activityTitle = title ?? "Web assignment";

        window.open(webUrl, "_blank", "noopener,noreferrer");
        setDonePrompt({ sessionId, activityTitle });
      } catch (err) {
        console.error("Web assignment launch failed:", err);
        toaster.error({ title: "Couldn't open the website. Try again." });
      } finally {
        setLaunching(false);
      }
    },
    [convex, launching],
  );

  /** Scholar answered the "all done?" prompt. */
  const resolveDonePrompt = useCallback(
    async (markDone: boolean) => {
      const prompt = donePrompt;
      setDonePrompt(null);
      if (!prompt) return;
      try {
        const result = await convex.mutation(api.webActivitySessions.finalize, {
          sessionId: prompt.sessionId,
          markDone: markDone || undefined,
        });
        if (result.completed) {
          haptic("success");
          const completionId = result.completionId;
          toaster.success({
            title: "Marked complete",
            // Undo only a mark this tap created — the scholar's own. A row a
            // teacher or scan already wrote isn't theirs to take back.
            ...(result.undoAvailable && completionId
              ? {
                  duration: 8000,
                  action: {
                    label: "Undo",
                    onClick: () => {
                      void convex
                        .mutation(api.activityCompletions.undoHomeworkDoneForSelf, {
                          completionId,
                        })
                        .then((undo) => {
                          if (!undo.ok) toaster.error({ title: undo.message });
                        })
                        .catch(() =>
                          toaster.error({ title: "Couldn't undo that. Try again." }),
                        );
                    },
                  },
                }
              : {}),
          });
        } else if (markDone && result.refusal) {
          // A Done tap that can't record must say so — it used to close
          // silently, so a scholar tapped Done on the same video 59 times.
          toaster.error({ title: result.refusal.message });
        }
      } catch (err) {
        console.error("Web assignment finalize failed:", err);
        if (markDone) {
          toaster.error({ title: "Couldn't mark it done. Try again." });
        }
      }
    },
    [convex, donePrompt],
  );

  return { launch, launching, donePrompt, resolveDonePrompt };
}
