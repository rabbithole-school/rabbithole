"use client";

/**
 * The Now | Day | Week | List segmented toggle for the Assignments tab. Lives in
 * its own file because every surface renders it: the schedule folds it into its
 * consolidated header rail, and the Now / List views show it in a thin bar above
 * the finder. A thin wrapper over the shared {@link ./ui/ViewToggle} lens
 * switcher (rounded pill track) with compact icons.
 *
 * The four views are alternate lenses on the same assignment-land: Now is the
 * live cross-section, Day/Week are the timetable, and List is the exhaustive
 * assignment/standing-practice inventory (the finder + Run page).
 */
import { CalendarDot, GridFour, Lightning, ListBullets } from "@phosphor-icons/react";
import { ViewToggle } from "@/components/ui/ViewToggle";

export type AssignmentsView = "now" | "day" | "week" | "list";

export function AssignmentsViewToggle({
  view,
  onChange,
  includeNow = true,
}: {
  view: AssignmentsView;
  onChange: (v: AssignmentsView) => void;
  includeNow?: boolean;
}) {
  const items = [
    ...(includeNow
      ? [{ value: "now" as const, label: "Now", icon: <Lightning size={14} /> }]
      : []),
    { value: "day" as const, label: "Day", icon: <CalendarDot size={14} /> },
    { value: "week" as const, label: "Week", icon: <GridFour size={14} /> },
    { value: "list" as const, label: "List", icon: <ListBullets size={14} /> },
  ];

  return (
    <ViewToggle<AssignmentsView>
      ariaLabel="Assignments view"
      value={view}
      onChange={onChange}
      items={items}
    />
  );
}
