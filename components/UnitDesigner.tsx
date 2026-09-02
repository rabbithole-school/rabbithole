"use client";

import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Box,
  Flex,
  Text,
  Splitter,
} from "@chakra-ui/react";
import {
  UnitOutlineTree,
  type ActivityCreationPreset,
  type TreeSelection,
} from "./UnitOutlineTree";
import { NodeEditor } from "./NodeEditor";
import { UnitSummary } from "./UnitSummary";
import { LessonSummary } from "./LessonSummary";
import { ActivitySummary } from "./ActivitySummary";
import { UnitReviewView } from "./UnitReviewView";
import { RehearsePane } from "./RehearsePane";
import { AssignPane } from "./AssignPane";
import { RollupPane } from "./RollupPane";
import { UnitLifecycleActions } from "./UnitLifecycleActions";
import {
  useAideDockOptional,
  useSetAideScope,
  type AideScope,
} from "./aide/AideDockProvider";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isCurriculumRole } from "@/convex/lib/roles";
import { ContextTabs } from "@/components/ui/ContextTabs";

// The unit surface is one route with a persistent outline spine + a
// two-column body (outline | center), and a CONTEXTUAL tab strip atop the
// center column. The Curriculum Bot is no longer a third splitter pane — it's
// the global header Robot → docked panel, scoped to this unit via
// `useSetAideScope`, and the editor pushes prompts into it through the dock's
// imperative `send()`. The SAME five tabs are offered at every altitude —
// Summary · Edit · Preflight · Assign · Debrief — as a stake in the ground
// that every operation makes sense at every level. Where an op has no native
// form at an altitude (rehearsing a whole unit, debriefing a lesson) the tab
// shows a roll-up of its children + drill-down links. "Preflight" is the
// pre-ship quality PHASE (the coherence Review at the unit; running the sims —
// "Rehearse" — at an activity); see review/curriculum-rehearse-and-maturity.md.
// The tab + node selection live in search params so the page stays mounted
// across every switch (subscriptions, splitter persist; only the center body
// swaps).
export type UnitTab = "summary" | "edit" | "preflight" | "assign" | "debrief";
type NodeType = "unit" | "lesson" | "activity";

const TAB_LABEL: Record<UnitTab, string> = {
  summary: "Summary",
  edit: "Edit",
  preflight: "Preflight",
  assign: "Assign",
  debrief: "Debrief",
};

// The tab set for a node altitude — uniform: every level gets all five.
// hideBot (a scholar editing their own IS unit) gets only Summary + Edit;
// the quality/execution tabs are curriculum/teacher-only.
function tabsForType(_type: NodeType, hideBot: boolean): UnitTab[] {
  if (hideBot) return ["summary", "edit"];
  return ["summary", "edit", "preflight", "assign", "debrief"];
}

interface UnitDesignerProps {
  unitId: Id<"units">;
  selectedLessonId?: Id<"lessons">;
  selectedActivityId?: Id<"activities">;
  tab?: UnitTab;
}

// URL builder for the Curriculum column-view route:
//   /teacher/curriculum/<unitId>[/<pane>]?lesson=…|activity=…
// The pane is a PATH segment (summary = the bare unit path); the node
// selection (lesson/activity) is a query param so the path stays shallow.
// CurriculumColumnView parses this back out (parseCurriculumPath +
// useSearchParams). URLSearchParams handles id encoding.
function buildHref(
  unitId: Id<"units">,
  opts: {
    lessonId?: Id<"lessons">;
    activityId?: Id<"activities">;
    tab?: UnitTab;
  } = {},
) {
  const qs = new URLSearchParams();
  if (opts.activityId) qs.set("activity", opts.activityId);
  else if (opts.lessonId) qs.set("lesson", opts.lessonId);
  const s = qs.toString();
  const paneSeg = opts.tab && opts.tab !== "summary" ? `/${opts.tab}` : "";
  return `/teacher/curriculum/${encodeURIComponent(unitId)}${paneSeg}${s ? `?${s}` : ""}`;
}

export function UnitDesigner({
  unitId,
  selectedLessonId,
  selectedActivityId,
  tab = "summary",
}: UnitDesignerProps) {
  const router = useRouter();
  const { user } = useCurrentUser();
  const unit = useQuery(api.units.get, { id: unitId });
  // Supplemental curriculum access lets an operations staffer design material without
  // inheriting teacher execution access. Like a scholar editing their own
  // Independent Study unit, that context gets the structural editor only:
  // Summary + Edit, without the bot, rehearsal, assignment, or debrief queries.
  const supplementalCurriculumAccess =
    !!user?.hasCurriculumAccess && !isCurriculumRole(user.role);
  const hideBot =
    !!user &&
    ((user.role === "scholar" &&
      !!unit?.authorScholarId &&
      unit.authorScholarId === user._id) ||
      supplementalCurriculumAccess);
  const createLesson = useMutation(api.lessons.create);
  const createActivity = useMutation(api.activities.create);

  // For activity-URL routes the lessonId isn't in the path; fetch from
  // the activity doc so downstream consumers (NodeEditor's "delete
  // activity → go back to lesson", chat panel's selectedLessonId) work.
  const selectedActivity = useQuery(
    api.activities.get,
    selectedActivityId ? { id: selectedActivityId } : "skip"
  );

  // The Curriculum Bot now lives in the global header dock, not a splitter
  // pane. `askAi` (used by the editor's "Generate slides" etc.) pushes a
  // prompt into it via the dock's imperative `send()`, which opens the dock
  // and — once the unit-scope chat mounts — fires the prompt. No local chat
  // state / ref / render-timing dance to manage anymore.
  const dock = useAideDockOptional();
  const askAi = hideBot ? undefined : (prompt: string) => dock?.send(prompt);

  // Selection is derived from the URL props. While an activity URL is
  // loading the underlying activity doc, selection is null briefly.
  //
  // Subtlety: `selectedActivity` is a useQuery result that lags one
  // render behind a URL change (`?activity=A` → `?activity=B`). Without
  // the `_id === selectedActivityId` guard, between the URL flipping
  // and the new query resolving we'd return a selection shape with B's
  // activityId but A's lessonId — wrong NodeEditor panel and wrong
  // lessonId fed to the chat. Treat the stale-doc window the same as
  // "still loading" → null selection (NodeEditor's EmptyState).
  const selection: TreeSelection | null = useMemo(() => {
    if (selectedActivityId) {
      if (!selectedActivity) return null;
      if (selectedActivity._id !== selectedActivityId) return null;
      // Lesson-anchored activities only — quest-only activities can't be
      // selected from a unit's designer tree.
      if (!selectedActivity.lessonId) return null;
      return {
        type: "activity",
        unitId,
        lessonId: selectedActivity.lessonId,
        activityId: selectedActivityId,
      };
    }
    if (selectedLessonId) {
      return { type: "lesson", unitId, lessonId: selectedLessonId };
    }
    return { type: "unit", unitId };
  }, [unitId, selectedLessonId, selectedActivityId, selectedActivity]);

  // Publish this unit as the aide's scope so the global header Robot pops the
  // Curriculum Bot for THIS unit, with the current outline node as soft
  // context. Keyed by unit (in the dock) so changing the lesson/activity
  // updates context without dropping the active chat. A scholar editing their
  // own IS unit (hideBot) gets no unit bot — fall back to global (and they're
  // outside the teacher dashboard anyway, so this is a no-op for them).
  const aideScope = useMemo<AideScope>(() => {
    if (hideBot) return { kind: "global" };
    return {
      kind: "unit",
      unitId,
      lessonId:
        selection?.type === "lesson"
          ? selection.lessonId
          : selection?.type === "activity"
            ? selection.lessonId
            : null,
      activityId: selection?.type === "activity" ? selection.activityId : null,
    };
  }, [hideBot, unitId, selection]);
  useSetAideScope(aideScope);

  // The URL args that pin the CURRENT selection — reused when switching
  // tabs (keep the selected node) and by the rail's deep-link. Derived
  // straight from the URL props (NOT the resolved `selection`, which lags
  // a render behind while the activity doc loads) so a tab click during
  // that load window doesn't drop the selection.
  const selArgs = useMemo(
    () =>
      selectedActivityId
        ? { activityId: selectedActivityId }
        : selectedLessonId
          ? { lessonId: selectedLessonId }
          : {},
    [selectedActivityId, selectedLessonId],
  );

  // Selecting a node keeps the current tab if it exists at the new
  // altitude — Summary/Edit always do, so they're "sticky"; a quality tab
  // that doesn't (an activity's Debrief → a unit) falls back to Summary.
  // The tab is always written into the href so an in-app click never
  // round-trips through page.tsx's "bare node → edit" default.
  const clampTab = (type: NodeType): UnitTab =>
    tabsForType(type, hideBot).includes(tab) ? tab : "summary";

  const getHref = (sel: TreeSelection) => {
    const t = clampTab(sel.type);
    if (sel.type === "unit") return buildHref(unitId, { tab: t });
    if (sel.type === "lesson")
      return buildHref(unitId, { lessonId: sel.lessonId, tab: t });
    return buildHref(unitId, { activityId: sel.activityId, tab: t });
  };

  const navigateTo = (sel: TreeSelection) => {
    router.push(getHref(sel));
  };

  // Switch tabs while keeping the selected node.
  const tabHref = (t: UnitTab) => buildHref(unitId, { ...selArgs, tab: t });

  // No top-level loading gate — render the 3-pane splitter immediately so the
  // surface goes straight to its real shape. Each pane handles its own load:
  // the outline shows a tree skeleton, the center tab shows its own skeleton,
  // the bot renders. (`unit`/`lessons` aren't needed to lay out the splitter —
  // selection + tabs derive from the URL.) Only a confirmed-missing unit
  // short-circuits to a not-found message.
  if (unit === null) {
    return (
      <Flex w="100vw" h="100vh" align="center" justify="center" direction="column" gap={3}>
        <Text fontFamily="heading" color="charcoal.400">
          Unit not found
        </Text>
        <Link href="/teacher/curriculum" style={{ textDecoration: "none" }}>
          <Text
            fontFamily="heading"
            fontSize="sm"
            color="violet.500"
            cursor="pointer"
            _hover={{ textDecoration: "underline" }}
          >
            Back to Curriculum
          </Text>
        </Link>
      </Flex>
    );
  }

  const handleAddLesson = async () => {
    const lessonId = await createLesson({
      unitId,
      title: "New lesson",
    });
    router.push(buildHref(unitId, { lessonId, tab: "edit" }));
  };

  const handleAddActivity = async (
    lessonId: Id<"lessons">,
    preset: ActivityCreationPreset,
  ) => {
    const activityId = await createActivity({
      lessonId,
      title: preset === "handout" ? "New handout" : "New activity",
      kind: "offline",
      defaultMode: preset === "handout" ? "homework" : undefined,
    });
    router.push(buildHref(unitId, { activityId, tab: "edit" }));
    return activityId;
  };

  // The selected node's altitude drives the contextual tab set. Derived
  // from the URL ids (stable; the resolved `selection` lags a render while
  // an activity doc loads).
  const selType: NodeType = selectedActivityId
    ? "activity"
    : selectedLessonId
      ? "lesson"
      : "unit";
  const availTabs = tabsForType(selType, hideBot);
  // Clamp the requested tab to what this altitude offers (an activity-only
  // Rehearse with the unit selected → Summary).
  const activeTab: UnitTab = availTabs.includes(tab) ? tab : "summary";

  const treePanel = (
    <Flex
      h="full"
      direction="column"
      overflow="hidden"
      bg="white"
      boxShadow="2px 0 8px -5px rgba(24, 28, 38, 0.32)"
      position="relative"
      zIndex={1}
    >
      <Box flex={1} overflowY="auto">
        <UnitOutlineTree
          unitId={unitId}
          mode="design"
          selected={selection}
          onSelect={navigateTo}
          getHref={getHref}
          onAddLesson={handleAddLesson}
          onAddActivity={handleAddActivity}
          showStatus={!hideBot}
        />
      </Box>
    </Flex>
  );

  // The Edit body — the NodeEditor for the selected node (shared by every
  // altitude's Edit tab).
  const editBody = (
    <Box flex={1} minW={0} overflow="hidden">
      <NodeEditor
        unitId={unitId}
        selection={selection}
        // When selection is null we may know what the URL is steering
        // toward (activity-load in flight). Tell NodeEditor so it can
        // show a layout-matching skeleton instead of the "click
        // anything in the outline" EmptyState.
        loadingKind={
          selection
            ? null
            : selectedActivityId
              ? "activity"
              : selectedLessonId
                ? "lesson"
                : null
        }
        // No bot pane for scholar-owned IS units — don't offer ask-AI
        // affordances that would queue a prompt into a chat that never
        // mounts.
        askAi={hideBot ? undefined : askAi}
        onAfterDuplicateLesson={(lessonId) =>
          router.push(buildHref(unitId, { lessonId, tab: "edit" }))
        }
        onAfterDuplicateActivity={(activityId) =>
          router.push(buildHref(unitId, { activityId, tab: "edit" }))
        }
        onAfterDeleteLesson={() => router.push(buildHref(unitId, { tab: "edit" }))}
        onAfterDeleteActivity={() => {
          if (selection?.type === "activity") {
            router.push(
              buildHref(unitId, { lessonId: selection.lessonId, tab: "edit" }),
            );
          } else {
            router.push(buildHref(unitId, { tab: "edit" }));
          }
        }}
      />
    </Box>
  );

  // Body for the active (clamped) tab at the selected node's altitude.
  // Summary uses the URL ids directly so it doesn't wait on the resolved
  // selection. Preflight/Debrief render the real surface at their native
  // altitude (activity = Rehearse sims / sims-vs-real; unit Preflight = the
  // coherence Review) and a roll-up of children everywhere else.
  const activityLessonId =
    selection?.type === "activity" ? selection.lessonId : undefined;
  let tabBody: React.ReactNode;
  if (activeTab === "summary") {
    tabBody =
      selType === "activity" && selectedActivityId ? (
        <ActivitySummary unitId={unitId} activityId={selectedActivityId} />
      ) : selType === "lesson" && selectedLessonId ? (
        <LessonSummary unitId={unitId} lessonId={selectedLessonId} />
      ) : (
        <UnitSummary
          unitId={unitId}
          actions={
            !hideBot ? (
              <UnitLifecycleActions
                unitId={unitId}
                variant="icons"
                onDeleted={() => router.push("/teacher/curriculum")}
                onDuplicated={(copyId) =>
                  router.push(buildHref(copyId, { tab: "edit" }))
                }
              />
            ) : undefined
          }
        />
      );
  } else if (activeTab === "edit" || hideBot) {
    tabBody = editBody;
  } else if (activeTab === "preflight") {
    // Pre-ship quality: sims at the activity, the coherence Review at the
    // unit, a rehearsal roll-up at the lesson.
    tabBody =
      selType === "activity" && selectedActivityId ? (
        <RehearsePane activityId={selectedActivityId} view="rehearse" askAi={askAi} />
      ) : selType === "lesson" && selectedLessonId ? (
        <RollupPane unitId={unitId} lessonId={selectedLessonId} op="preflight" />
      ) : (
        <UnitReviewView unitId={unitId} askAi={askAi} />
      );
  } else if (activeTab === "assign") {
    // Go live — prefilled to whatever node is selected.
    tabBody =
      selType === "activity" && selectedActivityId ? (
        <AssignPane
          unitId={unitId}
          lessonId={activityLessonId}
          activityId={selectedActivityId}
          nodeLabel="activity"
        />
      ) : selType === "lesson" && selectedLessonId ? (
        <AssignPane unitId={unitId} lessonId={selectedLessonId} nodeLabel="lesson" />
      ) : (
        <AssignPane unitId={unitId} nodeLabel="unit" />
      );
  } else if (activeTab === "debrief") {
    // Sims vs. real at the activity; a debrief roll-up at unit/lesson.
    tabBody =
      selType === "activity" && selectedActivityId ? (
        <RehearsePane activityId={selectedActivityId} view="debrief" askAi={askAi} />
      ) : selType === "lesson" && selectedLessonId ? (
        <RollupPane unitId={unitId} lessonId={selectedLessonId} op="debrief" />
      ) : (
        <RollupPane unitId={unitId} op="debrief" />
      );
  } else {
    tabBody = editBody;
  }

  // Contextual tab strip — the center column's header. A Chakra enclosed tab
  // control (segmented pill), URL-driven. Navigation goes through
  // router.push in onValueChange — NOT an asChild <Link> — because Ark's
  // Trigger onClick clobbers NextLink's client-nav handler, which made the
  // anchor fall back to a FULL PAGE RELOAD (the layout trick can't persist
  // across a hard nav, so tabs flickered).
  const tabStrip = (
    <Flex
      minH="72px"
      px={6}
      pt={4}
      pb={4}
      flexShrink={0}
      align="center"
      justify="center"
    >
      <ContextTabs
        value={activeTab}
        onChange={(nextTab) => router.push(tabHref(nextTab))}
        ariaLabel="Curriculum node sections"
        items={availTabs.map((tabValue) => ({
          value: tabValue,
          label: TAB_LABEL[tabValue],
        }))}
      />
    </Flex>
  );

  // The center column = its own contextual tab header + the active body.
  const centerBody = (
    <Flex h="full" direction="column" overflow="hidden" bg="gray.50">
      {tabStrip}
      <Box flex={1} minH={0} display="flex" flexDirection="column" overflow="hidden">
        {tabBody}
      </Box>
    </Flex>
  );

  // Two-column body — outline | center. The Curriculum Bot is the global
  // header dock (scoped to this unit above), not a third pane. Using
  // `defaultSize` (not the controlled `size`) keeps the drag handle live; the
  // pane set is fixed now, so no re-mount key is needed.
  return (
    <Flex direction="row" h="full" w="full" overflow="hidden" bg="gray.50">
      {/* No chunky header — in the column-view world "back" is the Units rail
          on the left (owned by CurriculumColumnView) and the unit's identity +
          lifecycle ⋮ live on the outline's top row. The splitter is the body:
          outline | center column (contextual tabs + body). */}
      <Splitter.Root
        flex={1}
        minW={0}
        overflow="hidden"
        defaultSize={[30, 70]}
        panels={[
          { id: "tree", minSize: 15 },
          { id: "center", minSize: 25 },
        ]}
      >
        <Splitter.Panel id="tree">{treePanel}</Splitter.Panel>
        <Splitter.ResizeTrigger
          id="tree:center"
          css={{ "--splitter-border-size": "0.5px" }}
        />
        <Splitter.Panel id="center">{centerBody}</Splitter.Panel>
      </Splitter.Root>
    </Flex>
  );
}
