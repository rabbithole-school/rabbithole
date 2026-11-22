/**
 * When a card's finish moves it into the Homework due row (a due date, or
 * open until a date), the class it came from still met in its block. The cell
 * keeps the class's block title ("Language Arts") and the activity shows only
 * in the Homework due row.
 *
 * The title is a copy of the placement with its work stripped, so the grid's
 * existing "bare class" rendering (isAwaitingActivity → block title) draws it.
 * It gets its own id so it never collides with the real card's drag handle,
 * and `railedFrom` names the real placement for the click (its detail drawer)
 * and for anything that has to tell the two apart.
 */

type RailablePlacement = {
  _id: string;
  blockId?: string | null;
  weekday?: number | null;
  railWeekday?: number | null;
  assignmentId?: string | null;
  activityId?: string | null;
  activityTitle?: string | null;
  unitTitle?: string | null;
  mode?: "classFocus" | "homework" | null;
  linkState?: "live" | "planned" | "none";
};

export type RailedClassTitle<P> = P & { railedFrom: string };

/** The class-only title a railed card leaves in its class cell, or null when
 *  the card stays in its cell or sits in the homework block itself. */
export function railedClassTitle<P extends RailablePlacement>(
  p: P,
  isHomeworkBlock: (blockId: string) => boolean,
): RailedClassTitle<P> | null {
  if (p.railWeekday == null || p.blockId == null) return null;
  if (isHomeworkBlock(String(p.blockId))) return null;
  return {
    ...p,
    _id: `${p._id}:class`,
    assignmentId: null,
    activityId: null,
    activityTitle: null,
    unitTitle: null,
    mode: null,
    linkState: "none",
    railedFrom: String(p._id),
  };
}
