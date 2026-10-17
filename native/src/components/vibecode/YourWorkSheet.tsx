/**
 * YourWorkSheet — the scholar's own work (writing, slides, map, photo) from
 * inside the full-screen app builder (TRA-519). A chat-primary session whose
 * app is a side project keeps its real deliverable here: the existing
 * DeliverablePanel, minus the app (which is the screen behind the sheet), so
 * the editors, flair and "Check my work" are the ones the chat view already
 * has — no second editor (T1).
 *
 * Mounted only while open (the Drawer unmounts its body once the slide-out
 * settles), so the panel's queries and editors cost nothing while closed.
 */
import { Drawer } from "@/components/ui/Drawer";
import { DeliverablePanel } from "@/components/DeliverablePanel";
import type { Doc, Id } from "@/lib/convex";
import { APP_SURFACE_COPY } from "../../../vendor/shared/appSurface";

export function YourWorkSheet({
  open,
  onClose,
  sessionId,
  activityId,
  checkDisabled,
  onAskCheck,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  activityId?: Id<"activities">;
  checkDisabled: boolean;
  onAskCheck: (
    artifact: Doc<"artifacts">,
    shouldCheck: boolean,
  ) => void | Promise<void>;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      title={APP_SURFACE_COPY.yourWork}
    >
      <DeliverablePanel
        hideCode
        sessionId={sessionId}
        activityId={activityId}
        checkDisabled={checkDisabled}
        onAskCheck={onAskCheck}
      />
    </Drawer>
  );
}
