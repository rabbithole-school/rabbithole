import type { Id } from "@/convex/_generated/dataModel";

/** A capability-scoped program target. The group stays fixed and the dialog
 *  schedules exactly one existing activity or newly created Handout through the
 *  program authorization boundary instead of accepting a client roster. */
export interface StartAssignmentProgramTarget {
  groupId: Id<"scholarGroups">;
  groupName: string;
  periodId: Id<"reportingPeriods">;
  subject?: string;
  scheduleTarget:
    | {
        mode: "classFocus";
        placementId: string;
        blockId: string;
        weekday: number;
        dateMs: number;
        weekStartMs: number;
        blockLabel: string;
        startLocal: string;
        endLocal: string;
      }
    | {
        mode: "homework";
        dueDateMs: number;
      };
}
