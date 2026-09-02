"use client";

/**
 * Read renderers for the curriculum document view — one per altitude, styled
 * as calm "pages": a strong Hanken-Grotesk type ramp (unit ≫ lesson ≫ activity)
 * with metadata that recedes into a quiet gray strip under each headline.
 *
 * Round 5 folds two things into these read views so the document behaves less
 * like a form:
 *  - Every headline row carries a consistent RIGHT-ALIGNED maturity + next-step
 *    control (`NodeMaturityCta`) instead of a separate timeline block / bottom
 *    action row.
 *  - The prose fields (title, description, big idea, tutor prompt) are
 *    inline-editable in place (`InlineEditable`) — click to type, commit on
 *    blur — so the common edits happen with zero read↔edit layout shift. The
 *    full nodeEditor form (via DocPage's pencil) still owns the structural
 *    fields (kind, scheduling, process, deliverable, EQ/EU).
 * See review/curriculum-document-view-plan.html.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Skeleton, Stack, Text } from "@chakra-ui/react";
import { Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { NodeStatus } from "@/convex/lib/unitMaturity";
import { normalizeGranules } from "@/convex/lib/granules";
import { ACTIVITY_KIND, type ActivityKind } from "@/lib/activityKinds";
import { getGame } from "@/lib/games/catalog";
import type { Strand } from "@/lib/constants";
import { NodeMaturityControls, RehearseButton } from "./NodeMaturityCta";
import type { HubView } from "./MaturityHub";
import type { RehearseFixField } from "@/components/nodeEditor/rehearseResult";
import { InlineText, InlineProse } from "./InlineEditable";
import {
  EditableChip,
  activityKindSelectOptions,
  sameValue,
  strandSelectOptions,
  triggerStyles,
  type EditableChipSelectOption,
  type EditableChipValue,
} from "./EditableChip";
import { EditableBulletList } from "./EditableBulletList";
import { NodeFieldModal } from "./NodeFieldModal";
import { DeliverableKindIcon } from "@/components/DeliverableKindIcon";
import { type NodeOptionRow } from "./NodeOptions";
import { NodeActionsMenu } from "@/components/NodeActionsMenu";
import { Avatar } from "@/components/Avatar";

// ── shared page chrome ──────────────────────────────────────────────────────

/** The recessive gray meta strip that sits under a headline. Items are
 *  dot-separated and never compete with the reading flow. */
export function MetaStrip({ items }: { items: React.ReactNode[] }) {
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <HStack gap={2} flexWrap="wrap" mt={1.5}>
      {shown.map((item, i) => (
        <HStack key={i} gap={2}>
          {i > 0 && (
            <Box as="span" color="charcoal.200" fontSize="xs" aria-hidden>
              ·
            </Box>
          )}
          <Box
            as="span"
            fontSize="xs"
            color="charcoal.400"
            fontFamily="heading"
            fontWeight="500"
          >
            {item}
          </Box>
        </HStack>
      ))}
    </HStack>
  );
}

function PageLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontFamily="heading"
      fontSize="2xs"
      fontWeight="700"
      letterSpacing="0.09em"
      textTransform="uppercase"
      color="charcoal.300"
      mb={1.5}
    >
      {children}
    </Text>
  );
}

const noop = () => {};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── option sets for the ghost metadata chips ────────────────────────────────

const BLOOM_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;
type BloomLevel = (typeof BLOOM_LEVELS)[number];
const BLOOM_OPTIONS: EditableChipSelectOption<BloomLevel | null>[] = [
  { value: null, label: "Not set" },
  ...BLOOM_LEVELS.map((b) => ({ value: b, label: cap(b) })),
];

const STRAND_CHIP_OPTIONS: EditableChipSelectOption<Strand | null>[] = [
  { value: null, label: "No strand" },
  ...strandSelectOptions(),
];

const SELECTION_MODE_OPTIONS: EditableChipSelectOption<"sequence" | "choice">[] =
  [
    {
      value: "sequence",
      label: "Sequence",
      description: "Linear ladder — activities done in order",
    },
    {
      value: "choice",
      label: "Choice",
      description: "A menu — scholars complete some of the options",
    },
  ];

// Loose 1..6 preset; the server clamps to the real activity count at read time,
// the same looseness the free number input had.
const PICK_COUNT_OPTIONS: EditableChipSelectOption<number>[] = [
  1, 2, 3, 4, 5, 6,
].map((n) => ({ value: n, label: `Pick ${n}` }));

const DEFAULT_MODE_OPTIONS: EditableChipSelectOption<
  "classFocus" | "homework" | "either"
>[] = [
  { value: "either", label: "Either", description: "No auto-push on assign" },
  {
    value: "classFocus",
    label: "In class",
    description: "Dormant until pushed from the Run page",
  },
  {
    value: "homework",
    label: "Homework",
    description: "Lands on each scholar on assign",
  },
];

const RECIPE_OPTIONS: EditableChipSelectOption<
  "baseline" | "exitTicket" | null
>[] = [
  { value: null, label: "Regular" },
  {
    value: "baseline",
    label: "🌱 Baseline",
    description: "Opening pre-assessment conversation",
  },
  {
    value: "exitTicket",
    label: "🎟️ Exit ticket",
    description: "Closing conversation vs. the baseline",
  },
];

const SHAREBACK_RECIPE_OPTIONS: EditableChipSelectOption<
  "reflection" | "galleryWalk" | "exitTicket" | "debateDebrief" | "custom"
>[] = [
  { value: "reflection", label: "Reflection" },
  { value: "galleryWalk", label: "Gallery walk" },
  { value: "exitTicket", label: "Exit ticket" },
  { value: "debateDebrief", label: "Debate debrief" },
  { value: "custom", label: "Custom" },
];

const ANGLES_OPTIONS: EditableChipSelectOption<boolean>[] = [
  { value: false, label: "Off" },
  {
    value: true,
    label: "On",
    description: "Each scholar picks their own angle",
  },
];

function processChipOptions(
  processes:
    | { _id: Id<"processes">; title: string; emoji?: string }[]
    | undefined,
): EditableChipSelectOption<Id<"processes"> | null>[] {
  return [
    { value: null, label: "No process" },
    ...(processes ?? []).map((p) => ({
      value: p._id,
      label: `${p.emoji ?? "⚙️"} ${p.title}`,
    })),
  ];
}

function perspectiveChipOptions(
  perspectives:
    | { _id: Id<"perspectives">; title: string; icon?: string }[]
    | undefined,
): EditableChipSelectOption<Id<"perspectives"> | null>[] {
  return [
    { value: null, label: "No perspective" },
    ...(perspectives ?? []).map((p) => ({
      value: p._id,
      label: `${p.icon ?? "🔭"} ${p.title}`,
    })),
  ];
}

/** Gray summary strings for the collapsed NodeOptions row — `undefined` keeps a
 *  defaulted field hidden until the dialog is opened. */
function processSummary(
  processes: { _id: Id<"processes">; title: string; emoji?: string }[] | undefined,
  id: Id<"processes"> | null | undefined,
): string | undefined {
  const p = id ? processes?.find((x) => x._id === id) : undefined;
  return p ? `${p.emoji ?? "⚙️"} ${p.title}` : undefined;
}

function perspectiveSummary(
  perspectives: { _id: Id<"perspectives">; title: string; icon?: string }[] | undefined,
  id: Id<"perspectives"> | null | undefined,
): string | undefined {
  const p = id ? perspectives?.find((x) => x._id === id) : undefined;
  return p ? `${p.icon ?? "🔭"} ${p.title}` : undefined;
}

/** The menu-row value label for a select: the matching option's (string) label,
 *  or `fallback` when nothing matches (an unset/out-of-range value). */
function selectValueLabel<T extends EditableChipValue>(
  options: ReadonlyArray<EditableChipSelectOption<T>>,
  value: T,
  fallback: string,
): string {
  const match = options.find((o) => sameValue(o.value, value));
  return match && typeof match.label === "string" ? match.label : fallback;
}

/** A calm, left-aligned row of ghost metadata chips. The negative left margin
 *  cancels the first chip's internal padding so its text aligns with the prose
 *  above it. */
function MetaChipRow({ children }: { children: React.ReactNode }) {
  return (
    <HStack gap={0.5} rowGap={0.5} flexWrap="wrap" mt={2} ml={-2}>
      {children}
    </HStack>
  );
}

/**
 * Sticky-header offsets (px), relative to the top of the document scroll box.
 * The lesson subhead pins at 0; an activity's slim orientation bar pins just
 * below it. `ACTIVITY_STICKY_TOP` is only the initial guess — the real offset
 * is the *measured* height of the pinned lesson subhead, published through
 * `LessonHeaderHeightProvider` so the activity bar stays flush beneath it even
 * as the header's content (chips, a wrapped title) changes.
 */
export const LESSON_STICKY_TOP = 0;
export const ACTIVITY_STICKY_TOP = 44;

/** The measured pinned-lesson-header height, shared with the activities below so
 *  each activity's slim orientation bar pins exactly beneath it. */
const LessonHeaderHeightCtx = createContext<number>(ACTIVITY_STICKY_TOP);
export function useLessonHeaderHeight() {
  return useContext(LessonHeaderHeightCtx);
}
export function LessonHeaderHeightProvider({
  value,
  children,
}: {
  value: number;
  children: React.ReactNode;
}) {
  return (
    <LessonHeaderHeightCtx.Provider value={value}>
      {children}
    </LessonHeaderHeightCtx.Provider>
  );
}

/** Right-aligned cluster that carries a node's metadata alongside its headline,
 *  in ONE consistent grammar across all three sticky rows: **facts | workflow**.
 *  Zone 1 (`facts`) holds the quiet editable chips; Zone 2
 *  (`workflow`) holds the Rehearse button · maturity pill · ⋮ overflow. A single
 *  even hairline divides the two groups (a divider between groups, not an accent
 *  stripe). Wraps internally and stays flush-right so the reading column's left
 *  edge stays clean. */
export function HeaderMetaCluster({
  facts,
  workflow,
}: {
  facts: React.ReactNode;
  workflow: React.ReactNode;
}) {
  return (
    <HStack
      gap={2}
      rowGap={1}
      flexWrap="wrap"
      justify="flex-end"
      align="center"
      flexShrink={0}
    >
      <HStack
        gap={1.5}
        rowGap={1}
        flexWrap="wrap"
        justify="flex-end"
        align="center"
        minW={0}
      >
        {facts}
      </HStack>
      <Box w="1px" alignSelf="stretch" my={1} bg="gray.200" flexShrink={0} />
      <HStack gap={1.5} align="center" flexShrink={0}>
        {workflow}
      </HStack>
    </HStack>
  );
}

/** The type label (UNIT / LESSON N / ACTIVITY) lives in the document's LEFT
 *  MARGIN as marginalia, not in the reading column — so every headline starts
 *  flush-left at the column edge, aligned with the body text and chips below it.
 *  The label right-aligns to a single gridline shared across all three bands. */

/** One sticky header band. The title is the flush-left content (aligned with the
 *  body prose below); the type label hangs in the left margin as right-aligned
 *  marginalia, and the maturity cluster sits far-right. The marginalia hides when
 *  the column is too narrow to spare the margin. */
export function StickyHeaderRow({
  label,
  title,
  right,
}: {
  label: string;
  title: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <Flex w="full" align="center" minW={0}>
      {/* The title owns the label's positioning context so the marginalia is
          centered on the HEADLINE's box, independent of how tall the right
          cluster grows (chips can wrap). Its right edge pins to the column's
          left edge, so the title stays flush-left. */}
      <Box flex={1} minW={0} pr={3} position="relative">
        <Flex
          position="absolute"
          right="100%"
          top="50%"
          transform="translateY(-50%)"
          pr={2.5}
          display={{ base: "none", xl: "flex" }}
          pointerEvents="none"
          aria-hidden
        >
          <Text
            fontFamily="heading"
            fontSize="2xs"
            fontWeight="700"
            letterSpacing="0.09em"
            textTransform="uppercase"
            color="charcoal.300"
            whiteSpace="nowrap"
            lineHeight="1"
          >
            {label}
          </Text>
        </Flex>
        {title}
      </Box>
      {right && (
        <Flex flexShrink={0} align="center">
          {right}
        </Flex>
      )}
    </Flex>
  );
}

/** The ghost "Add …" affordance that stands in for an empty optional prose
 *  block (e.g. a lesson tutor prompt), grouped with the header chips. Clicking
 *  reveals the real inline editor, opened focused. Shares the exact empty-chip
 *  trigger treatment (size / weight / gray / hover / gap) so it sits flush with
 *  the "Add duration" / "Add strand" chips beside it. */
function AddFieldButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={onClick}
      {...triggerStyles({ empty: true })}
    >
      <Plus size={13} weight="bold" style={{ flexShrink: 0 }} />
      <Text as="span">{label}</Text>
    </Button>
  );
}

/** A calm labelled prose field for exposing a schema string (system prompt,
 *  rubric, transcript…). Always inline-editable; an empty value renders as a
 *  faint placeholder line rather than a boxed form, so nothing shouts. */
function DocSection({
  label,
  value,
  placeholder,
  ariaLabel,
  onCommit,
  mono,
}: {
  label: string;
  value: string;
  placeholder: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
  mono?: boolean;
}) {
  return (
    <Box>
      <PageLabel>{label}</PageLabel>
      <InlineProse
        value={value}
        onCommit={onCommit}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        textStyle={{
          fontSize: "sm",
          color: "charcoal.500",
          fontFamily: mono ? "mono" : "body",
          lineHeight: "1.6",
        }}
      />
    </Box>
  );
}

/** The editable twin of ProseBlock: same tinted box, but the body is an
 *  inline-editable prose field so read ↔ edit doesn't reflow. `missing` paints
 *  the box amber to flag a required-but-empty field (e.g. an online activity's
 *  tutor prompt). */
function EditableProseBlock({
  label,
  value,
  placeholder,
  onCommit,
  tint,
  missing,
  ariaLabel,
  startInEdit,
  onEditChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
  tint?: boolean;
  missing?: boolean;
  ariaLabel?: string;
  startInEdit?: boolean;
  onEditChange?: (editing: boolean, value: string) => void;
}) {
  return (
    <Box>
      <PageLabel>{label}</PageLabel>
      <Box
        bg={missing ? "orange.50" : tint ? "violet.50" : "gray.50"}
        borderWidth="1px"
        borderColor={missing ? "orange.200" : "gray.200"}
        borderRadius="lg"
        px={3.5}
        py={3}
      >
        <InlineProse
          value={value}
          onCommit={onCommit}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          startInEdit={startInEdit}
          onEditChange={onEditChange}
          textStyle={{
            fontSize: "sm",
            color: missing ? "orange.700" : "charcoal.600",
            fontFamily: "body",
            lineHeight: "1.62",
          }}
        />
      </Box>
    </Box>
  );
}

function LoadingLines() {
  return (
    <Stack gap={2.5} aria-hidden>
      <Skeleton height="26px" w="52%" borderRadius="md" />
      <Skeleton height="13px" w="90%" borderRadius="sm" />
      <Skeleton height="13px" w="70%" borderRadius="sm" />
    </Stack>
  );
}

// ── UNIT ─────────────────────────────────────────────────────────────────────

export function UnitReadView({ unitId }: { unitId: Id<"units"> }) {
  const unit = useQuery(api.units.get, { id: unitId });
  const counts = useQuery(api.units.structureCounts, { id: unitId });
  const updateUnit = useMutation(api.units.update);
  const setGranules = useMutation(api.units.setGranules);

  if (unit === undefined || counts === undefined) return <LoadingLines />;
  if (unit === null) {
    return (
      <Text fontSize="sm" color="charcoal.400">
        Unit not found
      </Text>
    );
  }

  const eqs = normalizeGranules(unit.essentialQuestions, "eq");
  const eus = normalizeGranules(unit.enduringUnderstandings, "eu");

  // Derived, non-editable facts stay a quiet dotted strip.
  const passive: React.ReactNode[] = [];
  if (counts.lessonCount > 0)
    passive.push(
      `${counts.lessonCount} lesson${counts.lessonCount === 1 ? "" : "s"}`,
    );
  if (counts.activityCount > 0)
    passive.push(
      `${counts.activityCount} activit${counts.activityCount === 1 ? "y" : "ies"}`,
    );
  if (unit.badgeOnCompletion)
    passive.push(
      `${unit.badgeOnCompletion.icon ?? "🏅"} ${unit.badgeOnCompletion.title}`,
    );
  if (counts.teacherName) passive.push(`Authored by ${counts.teacherName}`);

  return (
    <Stack gap={5}>
      <Box>
        <PageLabel>Overview</PageLabel>
        <InlineProse
          value={unit.description ?? ""}
          onCommit={(v) => updateUnit({ id: unitId, description: v })}
          placeholder="Add a short overview of this unit…"
          ariaLabel="Unit overview"
          textStyle={{
            fontSize: "md",
            color: "charcoal.500",
            fontFamily: "body",
            lineHeight: "1.55",
          }}
        />
        <MetaChipRow>
          <EditableChip
            type="text"
            label="Subject"
            value={unit.subject ?? null}
            placeholder="Add subject"
            trimOnCommit
            onCommit={(v) => updateUnit({ id: unitId, subject: v || null })}
          />
          <EditableChip
            type="text"
            label="Grade level"
            value={unit.gradeLevel ?? null}
            placeholder="Add grade"
            trimOnCommit
            onCommit={(v) => updateUnit({ id: unitId, gradeLevel: v || null })}
          />
          <EditableChip
            type="text"
            label="Math domain"
            value={unit.mathDomain ?? null}
            placeholder="Add math domain"
            trimOnCommit
            onCommit={(v) => updateUnit({ id: unitId, mathDomain: v || null })}
          />
        </MetaChipRow>
        <MetaStrip items={passive} />
      </Box>

      <EditableProseBlock
        label="Big idea"
        tint
        value={unit.bigIdea ?? ""}
        placeholder="What's the through-line of this unit?"
        ariaLabel="Big idea"
        onCommit={(v) => updateUnit({ id: unitId, bigIdea: v || null })}
      />

      <Box>
        <PageLabel>Essential questions</PageLabel>
        <EditableBulletList
          items={eqs}
          ariaLabel="Essential questions"
          placeholder="Add an essential question…"
          onCommit={(essentialQuestions) =>
            setGranules({ id: unitId, essentialQuestions })
          }
        />
      </Box>
      <Box>
        <PageLabel>Enduring understandings</PageLabel>
        <EditableBulletList
          items={eus}
          ariaLabel="Enduring understandings"
          placeholder="Add an enduring understanding…"
          onCommit={(enduringUnderstandings) =>
            setGranules({ id: unitId, enduringUnderstandings })
          }
        />
      </Box>

      <DocSection
        label="Scholar-facing blurb"
        value={unit.scholarDescription ?? ""}
        placeholder="Optional 2nd-person blurb shown to scholars (falls back to the overview)…"
        ariaLabel="Scholar-facing blurb"
        onCommit={(v) =>
          updateUnit({ id: unitId, scholarDescription: v || null })
        }
      />
      <EditableProseBlock
        label="Unit tutor prompt"
        value={unit.systemPrompt ?? ""}
        placeholder="Unit-level guidance threaded into every activity's tutor…"
        ariaLabel="Unit tutor prompt"
        onCommit={(v) => updateUnit({ id: unitId, systemPrompt: v })}
      />
      <DocSection
        label="Rubric"
        value={unit.rubric ?? ""}
        placeholder="Unit-level rubric or success criteria…"
        ariaLabel="Unit rubric"
        onCommit={(v) => updateUnit({ id: unitId, rubric: v })}
      />
      <Box>
        <MetaChipRow>
          <EditableChip
            type="text"
            label="Video URL"
            value={unit.youtubeUrl ?? null}
            placeholder="Add video URL"
            trimOnCommit
            onCommit={(v) => updateUnit({ id: unitId, youtubeUrl: v || null })}
          />
        </MetaChipRow>
        <DocSection
          label="Video transcript"
          value={unit.videoTranscript ?? ""}
          placeholder="Transcript of the unit video…"
          ariaLabel="Video transcript"
          onCommit={(v) => updateUnit({ id: unitId, videoTranscript: v || null })}
        />
      </Box>
    </Stack>
  );
}

/**
 * The unit's option rows (Target Bloom · Perspective · Process), in the shared
 * {@link NodeOptionRow} shape, feeding the unit's ⋮ menu (via
 * `UnitLifecycleActions` in `CurriculumDocumentView`). The two small
 * processes/perspectives queries are deduped client-side by Convex. Returns
 * `undefined` until the unit loads.
 */
export function useUnitOptionRows(
  unitId: Id<"units">,
): NodeOptionRow[] | undefined {
  const unit = useQuery(api.units.get, { id: unitId });
  const processes = useQuery(api.processes.list, {});
  const perspectives = useQuery(api.perspectives.list, {});
  const updateUnit = useMutation(api.units.update);
  if (!unit) return undefined;

  const perspectiveOptions = perspectiveChipOptions(perspectives);
  const processOptions = processChipOptions(processes);

  return [
    {
      label: "Target Bloom",
      hint: "The peak cognitive demand this unit aims for.",
      summary: unit.targetBloomLevel ? cap(unit.targetBloomLevel) : undefined,
      value: unit.targetBloomLevel ?? null,
      valueLabel: selectValueLabel(
        BLOOM_OPTIONS,
        unit.targetBloomLevel ?? null,
        "Not set",
      ),
      options: BLOOM_OPTIONS,
      onCommit: (v) => updateUnit({ id: unitId, targetBloomLevel: v }),
    },
    {
      label: "Perspective",
      hint: "An optional lens the tutor threads through the unit.",
      summary: perspectiveSummary(perspectives, unit.perspectiveId),
      value: unit.perspectiveId ?? null,
      valueLabel: selectValueLabel(
        perspectiveOptions,
        unit.perspectiveId ?? null,
        "No perspective",
      ),
      options: perspectiveOptions,
      onCommit: (v) => updateUnit({ id: unitId, perspectiveId: v }),
    },
    {
      label: "Process",
      hint: "An optional thinking routine scaffolded across the unit.",
      summary: processSummary(processes, unit.processId),
      value: unit.processId ?? null,
      valueLabel: selectValueLabel(
        processOptions,
        unit.processId ?? null,
        "No process",
      ),
      options: processOptions,
      onCommit: (v) => updateUnit({ id: unitId, processId: v }),
    },
  ];
}

/** The unit's shared header meta — its Duration chip — surfaced in the
 *  masthead's right cluster so it sits on the same gridline as every lesson's
 *  and activity's header chips (round 6). The unit-identity facts (subject,
 *  grade level, math domain) stay in the body overview; only the fields
 *  lessons/activities also carry ride up here. The unit's options (Target
 *  Bloom / Perspective / Process) live — value visible, labeled — in the unit
 *  ⋮ menu (`UnitLifecycleActions`, mounted by `CurriculumDocumentView`). */
export function UnitHeaderMeta({ unitId }: { unitId: Id<"units"> }) {
  const unit = useQuery(api.units.get, { id: unitId });
  const updateUnit = useMutation(api.units.update);
  if (!unit) return null;

  return (
    <EditableChip
      type="number"
      label="Duration"
      value={unit.durationMinutes ?? null}
      placeholder="Add duration"
      min={0}
      formatValue={(v) => `${v} min`}
      onCommit={(v) => updateUnit({ id: unitId, durationMinutes: v })}
    />
  );
}

/** The unit author, surfaced in the masthead's fact cluster so "whose unit is
 *  this" is legible from any tab (not just buried in the Summary body's meta
 *  strip). Avatar + name, hover tooltip spells out "Authored by …". */
export function UnitAuthorTag({ teacherId }: { teacherId: Id<"users"> }) {
  const author = useQuery(api.users.getUser, { userId: teacherId });
  const name = author?.name ?? null;
  if (!name) return null;
  return (
    <HStack gap={1.5} align="center" title={`Authored by ${name}`}>
      <Avatar name={name} colorKey={String(teacherId)} size="2xs" />
      <Text
        fontSize="xs"
        fontFamily="heading"
        fontWeight="600"
        color="charcoal.500"
        whiteSpace="nowrap"
      >
        {name}
      </Text>
    </HStack>
  );
}

// ── LESSON ───────────────────────────────────────────────────────────────────

export function LessonReadView({
  lessonId,
  unitId,
  index,
  onOpenMaturity,
  onDuplicate,
  onDelete,
}: {
  lessonId: Id<"lessons">;
  unitId: Id<"units">;
  index: number;
  status?: NodeStatus;
  /** Launch the maturity hub for this lesson (title threaded up for the header;
   *  optional `initialView` opens straight to a deeper surface, e.g. rehearse). */
  onOpenMaturity?: (title: string, initialView?: HubView) => void;
  onDuplicate?: () => Promise<void>;
  /** Open the confirm-guarded lesson delete (cascades its activities). */
  onDelete?: () => void;
}) {
  const lesson = useQuery(api.lessons.get, { id: lessonId });
  const processes = useQuery(api.processes.list, {});
  const updateLesson = useMutation(api.lessons.update);
  if (lesson === undefined) return <LoadingLines />;
  if (lesson === null) {
    return (
      <Text fontSize="sm" color="charcoal.400">
        Lesson not found
      </Text>
    );
  }

  const strandValue = (
    ["core", "connections", "practice", "identity"] as const
  ).includes(lesson.strand as never)
    ? (lesson.strand as Strand)
    : null;
  const isChoice = lesson.selectionMode === "choice";

  const lessonOptionRows: NodeOptionRow[] = [
    {
      label: "Activity flow",
      hint: "Sequence is a linear ladder; Choice is a menu scholars pick from.",
      summary: isChoice ? "Choice" : undefined,
      value: lesson.selectionMode ?? "sequence",
      valueLabel: selectValueLabel(
        SELECTION_MODE_OPTIONS,
        lesson.selectionMode ?? "sequence",
        "Sequence",
      ),
      options: SELECTION_MODE_OPTIONS,
      onCommit: (v) => updateLesson({ id: lessonId, selectionMode: v }),
    },
    ...(isChoice
      ? [
          {
            label: "Pick count",
            hint: "How many of the choice activities each scholar completes.",
            summary: `Pick ${lesson.choicePickCount ?? 1}`,
            value: lesson.choicePickCount ?? 1,
            valueLabel: `Pick ${lesson.choicePickCount ?? 1}`,
            options: PICK_COUNT_OPTIONS,
            onCommit: (v: number) =>
              updateLesson({ id: lessonId, choicePickCount: v }),
          } satisfies NodeOptionRow,
        ]
      : []),
    {
      label: "Process",
      hint: "An optional thinking routine for this lesson.",
      summary: processSummary(processes, lesson.processId),
      value: lesson.processId ?? null,
      valueLabel: selectValueLabel(
        processChipOptions(processes),
        lesson.processId ?? null,
        "No process",
      ),
      options: processChipOptions(processes),
      onCommit: (v) => updateLesson({ id: lessonId, processId: v }),
    },
  ];

  return (
    <StickyHeaderRow
      label={`Lesson ${index}`}
      title={
        <InlineText
          value={lesson.title}
          onCommit={(v) => v.trim() && updateLesson({ id: lessonId, title: v })}
          placeholder="Lesson title"
          ariaLabel="Lesson title"
          textStyle={{
            fontFamily: "heading",
            fontWeight: "700",
            fontSize: "lg",
            lineHeight: "1.25",
            color: "navy.500",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        />
      }
      right={
        <HeaderMetaCluster
          facts={
            <>
              <EditableChip
                type="select"
                label="Strand"
                value={strandValue}
                options={STRAND_CHIP_OPTIONS}
                placeholder="Add strand"
                onCommit={(v) => updateLesson({ id: lessonId, strand: v })}
              />
              <EditableChip
                type="number"
                label="Duration"
                value={lesson.durationMinutes ?? null}
                placeholder="Add duration"
                min={0}
                formatValue={(v) => `${v} min`}
                onCommit={(v) =>
                  updateLesson({ id: lessonId, durationMinutes: v })
                }
              />
            </>
          }
          workflow={
            <>
              {onOpenMaturity && (
                <RehearseButton
                  onOpen={() => onOpenMaturity(lesson.title, "rehearse")}
                />
              )}
              {onOpenMaturity && (
                <NodeMaturityControls
                  unitId={unitId}
                  lessonId={lessonId}
                  onOpen={() => onOpenMaturity(lesson.title)}
                />
              )}
              <NodeActionsMenu
                kind="lesson"
                optionRows={lessonOptionRows}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
              />
            </>
          }
        />
      }
    />
  );
}

/** The lesson tutor prompt, rendered as a NON-sticky block below the sticky
 *  lesson subhead (so a long prompt scrolls instead of bloating the pinned
 *  header). While empty and unrevealed it shows the "Add guidance" affordance
 *  IN THE BODY (moved out of the sticky header) — exactly where the editor
 *  appears once revealed; leaving it empty collapses it back to that button. */
export function LessonPrompt({
  lessonId,
  revealed,
  onReveal,
  onCollapse,
}: {
  lessonId: Id<"lessons">;
  revealed: boolean;
  /** Reveal the prompt editor from the body "Add guidance" affordance. */
  onReveal: () => void;
  onCollapse: () => void;
}) {
  const lesson = useQuery(api.lessons.get, { id: lessonId });
  const updateLesson = useMutation(api.lessons.update);
  const hasPrompt = !!lesson?.systemPrompt?.trim();
  if (!hasPrompt && !revealed) {
    return (
      <Box mt={2}>
        <AddFieldButton label="Add guidance" onClick={onReveal} />
      </Box>
    );
  }
  return (
    <Box mt={2}>
      <EditableProseBlock
        label="Lesson tutor prompt"
        value={lesson?.systemPrompt ?? ""}
        placeholder="Lesson-level guidance for the AI tutor…"
        ariaLabel="Lesson tutor prompt"
        startInEdit={revealed && !hasPrompt}
        onEditChange={(editing, val) => {
          if (!editing && !val.trim()) onCollapse();
        }}
        onCommit={(v) => updateLesson({ id: lessonId, systemPrompt: v || null })}
      />
    </Box>
  );
}


// ── ACTIVITY ─────────────────────────────────────────────────────────────────

/**
 * Whether a "fix this" scroll target for an inline field (Duration, Tutor
 * prompt — the two RehearseFixField targets with no NodeFieldModal to force
 * open) is currently pulsing. `signal` is a monotonically-increasing counter;
 * each new value re-triggers the highlight even if the field itself didn't
 * change. Fades after ~2.4s — a data-carrying, all-sides ring (never an
 * edge-only accent stripe; see .claude/rules/visual-design.md), not a
 * decorative glow.
 */
function useFixHighlight(active: boolean, signal?: number): boolean {
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!active) {
      const frame = requestAnimationFrame(() => setPulsing(false));
      return () => cancelAnimationFrame(frame);
    }
    if (signal === undefined) return;
    let pulseFrame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resetFrame = requestAnimationFrame(() => {
      setPulsing(false);
      pulseFrame = requestAnimationFrame(() => {
        setPulsing(true);
        timeout = setTimeout(() => setPulsing(false), 2400);
      });
    });
    return () => {
      cancelAnimationFrame(resetFrame);
      if (pulseFrame !== undefined) cancelAnimationFrame(pulseFrame);
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [active, signal]);
  return pulsing;
}

/** Wraps an inline field (Duration chip, Tutor prompt block) with the
 *  temporary all-sides highlight ring used to land a "Fix this" click. */
function FixHighlightBox({
  active,
  signal,
  children,
}: {
  active: boolean;
  signal?: number;
  children: React.ReactNode;
}) {
  const pulsing = useFixHighlight(active, signal);
  return (
    <Box
      borderRadius="md"
      transition="box-shadow 0.4s ease"
      boxShadow={pulsing ? "0 0 0 3px var(--chakra-colors-cyan-200)" : "0 0 0 0px transparent"}
    >
      {children}
    </Box>
  );
}

export function ActivityReadView({
  activityId,
  unitId,
  onOpenMaturity,
  onDuplicate,
  onDelete,
  fixTarget,
}: {
  activityId: Id<"activities">;
  unitId: Id<"units">;
  status?: NodeStatus;
  /** Launch the maturity hub for this activity (title threaded up for the hub
   *  header). Optional `initialView` opens straight to a deeper surface. */
  onOpenMaturity?: (title: string, initialView?: HubView) => void;
  onDuplicate?: () => Promise<void>;
  /** Open the confirm-guarded activity delete. */
  onDelete?: () => void;
  /** A Preflight finding's "Fix this" landed on THIS activity: force-open the
   *  Resources/Deliverable modal, or pulse-highlight the inline
   *  Duration/Tutor-prompt field. `signal` re-triggers on every click, even
   *  repeat clicks on the same field. */
  fixTarget?: { field: RehearseFixField; signal: number };
}) {
  const activity = useQuery(api.activities.get, { id: activityId });
  const presentations = useQuery(
    api.activityResources.presentationsForActivity,
    { activityId },
  );
  const processes = useQuery(api.processes.list, {});
  const updateActivity = useMutation(api.activities.update);
  const setArchived = useMutation(api.activities.setArchived);
  const lessonHeaderH = useLessonHeaderHeight();
  if (activity === undefined) return <LoadingLines />;
  if (activity === null) {
    return (
      <Text fontSize="sm" color="charcoal.400">
        Activity not found
      </Text>
    );
  }

  const kind = activity.kind as ActivityKind;
  const isOnline = kind === "online";
  // Vibecode reuses the activity's systemPrompt as its BUILD BRIEF (the same
  // field the online tutor prompt uses) — so it wants the same prose editor,
  // just relabeled.
  const isVibecode = kind === "vibecode";
  const isProblemSet = kind === "problem_set";
  const isArchived = !!activity.archivedAt;
  const missingSystemPrompt = (isOnline || isVibecode) && !activity.systemPrompt?.trim();

  const deliverableSummary = activity.deliverable?.prompt?.trim()
    ? "Deliverable set"
    : undefined;
  const rabbitPresentation = presentations?.find(
    (presentation) => presentation.source.kind === "rabbit_slides",
  );
  const googlePresentation = presentations?.find(
    (presentation) => presentation.source.kind === "google_slides",
  );
  const slidesSummary =
    rabbitPresentation?.title ??
    (googlePresentation?.source.kind === "google_slides"
      ? googlePresentation.source.name ?? googlePresentation.title
      : googlePresentation?.title);

  const shareBackRecipeSummary: string | undefined = activity.shareBackRecipe
    ? selectValueLabel(
        SHAREBACK_RECIPE_OPTIONS,
        activity.shareBackRecipe,
        activity.shareBackRecipe,
      )
    : undefined;

  const activityOptionRows: NodeOptionRow[] = [
    {
      label: "Default mode",
      hint: "Where this lands for scholars when the unit is assigned.",
      summary:
        activity.defaultMode === "homework"
          ? "Homework"
          : activity.defaultMode === "classFocus"
            ? "In class"
            : undefined,
      value: activity.defaultMode ?? "either",
      valueLabel: selectValueLabel(
        DEFAULT_MODE_OPTIONS,
        activity.defaultMode ?? "either",
        "Either",
      ),
      options: DEFAULT_MODE_OPTIONS,
      onCommit: (v) => updateActivity({ id: activityId, defaultMode: v }),
    },
    ...(isOnline
      ? [
          {
            label: "Conversation",
            hint: "Baseline or exit-ticket framing for the tutor chat.",
            summary:
              activity.recipe === "baseline"
                ? "🌱 Baseline"
                : activity.recipe === "exitTicket"
                  ? "🎟️ Exit ticket"
                  : undefined,
            value: activity.recipe ?? null,
            valueLabel: selectValueLabel(
              RECIPE_OPTIONS,
              activity.recipe ?? null,
              "Regular",
            ),
            options: RECIPE_OPTIONS,
            onCommit: (v) => updateActivity({ id: activityId, recipe: v }),
          } satisfies NodeOptionRow,
        ]
      : []),
    ...(kind === "shareBack"
      ? [
          {
            label: "Share-back recipe",
            summary: shareBackRecipeSummary,
            value: activity.shareBackRecipe ?? null,
            valueLabel: selectValueLabel(
              SHAREBACK_RECIPE_OPTIONS,
              activity.shareBackRecipe ?? null,
              "Pick recipe",
            ),
            options: SHAREBACK_RECIPE_OPTIONS,
            onCommit: (v) =>
              updateActivity({ id: activityId, shareBackRecipe: v }),
          } satisfies NodeOptionRow,
        ]
      : []),
    ...(isOnline
      ? [
          {
            label: "Scholar angles",
            hint: "Let each scholar pick their own angle on the topic.",
            summary: activity.hasScholarAngles ? "Scholar angles on" : undefined,
            value: activity.hasScholarAngles ?? false,
            valueLabel: selectValueLabel(
              ANGLES_OPTIONS,
              activity.hasScholarAngles ?? false,
              "Off",
            ),
            options: ANGLES_OPTIONS,
            onCommit: (v) =>
              updateActivity({ id: activityId, hasScholarAngles: v }),
          } satisfies NodeOptionRow,
        ]
      : []),
    {
      label: "Process",
      hint: "An optional thinking routine for this activity.",
      summary: processSummary(processes, activity.processId),
      value: activity.processId ?? null,
      valueLabel: selectValueLabel(
        processChipOptions(processes),
        activity.processId ?? null,
        "No process",
      ),
      options: processChipOptions(processes),
      onCommit: (v) => updateActivity({ id: activityId, processId: v }),
    },
  ];

  // The right-aligned workflow controls: a standing Rehearse button (opens the
  // hub straight to the rehearse surface — RehearsePane with its sims panel and
  // the "Drive it yourself" manual-rehearse button) beside the composed
  // Readiness+Sessions pill, which self-queries its rolled-up signals and
  // launches the two-panel hub.
  const rehearse: React.ReactNode = !isArchived && onOpenMaturity ? (
    <RehearseButton
      onOpen={() => onOpenMaturity(activity.title, "rehearse")}
    />
  ) : null;
  const cta: React.ReactNode = !isArchived && onOpenMaturity ? (
    <NodeMaturityControls
      unitId={unitId}
      activityId={activityId}
      onOpen={() => onOpenMaturity(activity.title)}
    />
  ) : null;

  // Chips the activity shares in common with a lesson — kind (≈ strand),
  // duration, and the options menu — ride in the sticky header's right cluster,
  // grid-aligned with the lesson header. Activity-specific "configure" and
  // read-only chips stay in the body row below the description.
  const kindChip = isProblemSet ? (
    <EditableChip
      type="text"
      label="Kind"
      value={ACTIVITY_KIND[kind]?.label ?? kind}
      readOnly
      readOnlyHint="Problem sets are authored in the Practice pool, not the curriculum document."
      readOnlyHref="/teacher/math-skills"
      readOnlyLinkLabel="Open Practice pool"
      onCommit={noop}
    />
  ) : (
    <EditableChip
      type="select"
      label="Kind"
      value={kind as Exclude<ActivityKind, "problem_set">}
      options={activityKindSelectOptions()}
      onCommit={(v) => updateActivity({ id: activityId, kind: v })}
    />
  );
  const durationChip = (
    <FixHighlightBox
      active={fixTarget?.field === "duration"}
      signal={fixTarget?.field === "duration" ? fixTarget.signal : undefined}
    >
      <EditableChip
        type="number"
        label="Duration"
        value={activity.durationMinutes ?? null}
        placeholder="Add duration"
        min={0}
        formatValue={(v) => `${v} min`}
        onCommit={(v) => updateActivity({ id: activityId, durationMinutes: v })}
      />
    </FixHighlightBox>
  );
  return (
    // Archived activities stay on the design surface but read as retired.
    <Stack gap={4} opacity={isArchived ? 0.6 : 1}>
      {/* Slim sticky orientation bar: the kind icon + title stay pinned just
          under the lesson subhead so a teacher stays oriented while scrolling a
          long activity. The maturity next-step rides along on the right. Its
          `top` is the *measured* lesson-header height so it never gets covered. */}
      <Box
        position="sticky"
        top={`${Math.max(0, lessonHeaderH - 1)}px`}
        zIndex={2}
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.100"
        py={1.5}
      >
        {/* Full-bleed white backing so this bar occludes the marginalia labels
            of the activities scrolling underneath it (clipped by the scroll
            body's overflowX:hidden). */}
        <Box
          aria-hidden
          position="absolute"
          top={0}
          bottom={0}
          left="-100%"
          right="-100%"
          bg="white"
          zIndex={-1}
          pointerEvents="none"
        />
        <StickyHeaderRow
          label="Activity"
          title={
            <InlineText
              value={activity.title}
              onCommit={(v) =>
                v.trim() && updateActivity({ id: activityId, title: v })
              }
              placeholder="Activity title"
              ariaLabel="Activity title"
              textStyle={{
                fontFamily: "heading",
                fontWeight: "700",
                fontSize: "sm",
                lineHeight: "1.2",
                color: "charcoal.600",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            />
          }
          right={
            <HeaderMetaCluster
              facts={
                <>
                  {isArchived && (
                    <EditableChip
                      type="text"
                      label="Archived"
                      value="Archived"
                      readOnly
                      readOnlyHint="Hidden from scholars and unschedulable. Unarchive from the ⋮ menu to restore it."
                      onCommit={noop}
                    />
                  )}
                  {kindChip}
                  {durationChip}
                </>
              }
              workflow={
                <>
                  {rehearse}
                  {cta}
                  <NodeActionsMenu
                    kind="activity"
                    optionRows={activityOptionRows}
                    onDuplicate={onDuplicate}
                    onArchive={
                      isArchived
                        ? undefined
                        : async () => {
                            await setArchived({ id: activityId, archived: true });
                          }
                    }
                    onUnarchive={
                      isArchived
                        ? async () => {
                            await setArchived({ id: activityId, archived: false });
                          }
                        : undefined
                    }
                    onDelete={onDelete}
                  />
                </>
              }
            />
          }
        />
      </Box>

      <Box>
        <PageLabel>Description (teacher-facing)</PageLabel>
        <InlineProse
          value={activity.description ?? ""}
          onCommit={(v) =>
            updateActivity({ id: activityId, description: v || null })
          }
          placeholder="Design intent and facilitation notes — never shown to scholars…"
          ariaLabel="Description (teacher-facing)"
          textStyle={{
            fontSize: "sm",
            color: "charcoal.500",
            fontFamily: "body",
            lineHeight: "1.55",
          }}
        />
      </Box>

      <DocSection
        label="Scholar description"
        value={activity.scholarDescription ?? ""}
        placeholder="Shown on the scholar's card — write to the scholar (2nd person). Left blank, they see a title-only card (no fallback)."
        ariaLabel="Scholar description"
        onCommit={(v) =>
          updateActivity({ id: activityId, scholarDescription: v || null })
        }
      />

      <MetaChipRow>
        <NodeFieldModal
          activityId={activityId}
          field="deliverable"
          value={deliverableSummary}
          openSignal={fixTarget?.field === "deliverable" ? fixTarget.signal : undefined}
        />
        <NodeFieldModal
          activityId={activityId}
          field="resources"
          openSignal={fixTarget?.field === "resources" ? fixTarget.signal : undefined}
        />
        {kind === "web" && (
          <NodeFieldModal
            activityId={activityId}
            field="web"
            value={activity.webUrl ? "Web set" : undefined}
          />
        )}
        {kind === "game" && (
          <NodeFieldModal
            activityId={activityId}
            field="game"
            value={
              activity.game?.gameId
                ? (getGame(activity.game.gameId)?.title ??
                  activity.game.gameId)
                : undefined
            }
          />
        )}
        {kind === "shareBack" && (
          <NodeFieldModal activityId={activityId} field="shareBack" />
        )}
        <NodeFieldModal
          activityId={activityId}
          field="slides"
          icon={<DeliverableKindIcon kind="slides" size={16} />}
          value={slidesSummary}
        />

        {/* Bot/preflight-owned fields — shown read-only so the teacher can
            still inspect them, but authored elsewhere. */}
        {activity.advanceRubric && (
          <EditableChip
            type="text"
            label="Advance rubric"
            value={`${activity.advanceRubric.criteria.length} criteria`}
            readOnly
            readOnlyHint="This chat 'ready to advance' rubric is authored by the Curriculum Bot / preflight."
            onCommit={noop}
          />
        )}
        {activity.probeSkillKeys && activity.probeSkillKeys.length > 0 && (
          <EditableChip
            type="text"
            label="Probe skills"
            value={`${activity.probeSkillKeys.length} skill${activity.probeSkillKeys.length === 1 ? "" : "s"}`}
            readOnly
            readOnlyHint="Outcome-probe skills for curriculum sims, keyed to the knowledge graph."
            onCommit={noop}
          />
        )}
        {isProblemSet && activity.problemSet && (
          <EditableChip
            type="text"
            label="Practice set"
            value={`${activity.problemSet.targetSkillKeys.length} skill${activity.problemSet.targetSkillKeys.length === 1 ? "" : "s"}`}
            readOnly
            readOnlyHint="Edit this practice set in the Practice pool."
            readOnlyHref="/teacher/math-skills"
            readOnlyLinkLabel="Open Practice pool"
            onCommit={noop}
          />
        )}
      </MetaChipRow>

      {isOnline && (
        <FixHighlightBox
          active={fixTarget?.field === "tutorPrompt"}
          signal={fixTarget?.field === "tutorPrompt" ? fixTarget.signal : undefined}
        >
          <EditableProseBlock
            label="Tutor prompt"
            value={activity.systemPrompt ?? ""}
            placeholder="What drives the AI tutor for this activity? Objectives, scaffolds, what 'done' looks like…"
            ariaLabel="Tutor prompt"
            missing={missingSystemPrompt}
            onCommit={(v) =>
              updateActivity({ id: activityId, systemPrompt: v || null })
            }
          />
        </FixHighlightBox>
      )}
      {isVibecode && (
        <EditableProseBlock
          label="Build brief"
          value={activity.systemPrompt ?? ""}
          placeholder="What should the scholar build? The AI builder sees this and greets them with the challenge…"
          ariaLabel="Build brief"
          missing={missingSystemPrompt}
          onCommit={(v) =>
            updateActivity({ id: activityId, systemPrompt: v || null })
          }
        />
      )}
      {kind === "shareBack" && (
        <DocSection
          label="Facilitation focus"
          value={activity.facilitationFocus ?? ""}
          placeholder="Steer the share-back digest (e.g. 'focus on word choice')…"
          ariaLabel="Facilitation focus"
          onCommit={(v) =>
            updateActivity({ id: activityId, facilitationFocus: v || null })
          }
        />
      )}
    </Stack>
  );
}
