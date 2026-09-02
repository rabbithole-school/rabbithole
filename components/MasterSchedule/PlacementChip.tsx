"use client";

/**
 * PlacementChip — the ONE enriched chip that renders a scheduled class across
 * every master-schedule surface: the Day/Week grid cell (compact), the "Now"
 * happening-now cross-section, and the Scholars roster (expanded, with
 * execution state + action affordances nested as children).
 *
 * Visual system (review/now-view-redesign.html §5):
 *  - EVEN borders on all sides — never a fat left stripe. Link/mode status is a
 *    subtle corner PIP (small dot), per the visual-design SOP
 *    (.claude/rules/visual-design.md "No edge-only accent stripes").
 *  - Avatar follows the lens: teacher avatar in By-group, group emoji in
 *    By-teacher; a scholar avatar can lead in the Scholars surface.
 *  - The compact variant keeps calendar cells small; the expanded variant adds
 *    the linked activity title, a mode badge, and an actions slot.
 */
import { Box, HStack, Text, VStack, chakra } from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";

export type Lens = "group" | "teacher";

/** The subset of a grid placement the chip needs. Structurally compatible with
 *  the `grid` query's enriched placement rows. */
export type PlacementChipData = {
  subject: string;
  teacherName?: string | null;
  teacherUsername?: string | null;
  groupId: string;
  activityTitle?: string | null;
  unitTitle?: string | null;
  assignmentId?: string | null;
  activityId?: string | null;
  isProgramHandout?: boolean;
  sequenceId?: string | null;
  sequenceIndex?: number | null;
  sequenceRank?: number | null;
  sequenceLength?: number | null;
  mode?: "classFocus" | "homework" | null;
  linkState?: "live" | "planned" | "none";
  note?: string | null;
};

/** A placement is "awaiting an activity" when it carries no scheduled work of any
 *  kind — no linked assignment/activity, no unit-sequence step, no homework. It's
 *  a bare class slot (PE, Studio Time, Science) a teacher may later fill. These
 *  render in a lighter, dashed placeholder style so an empty slot doesn't read as
 *  a filled activity card. */
export function isAwaitingActivity(p: PlacementChipData): boolean {
  return (
    !p.assignmentId &&
    !p.activityId &&
    !p.activityTitle &&
    !p.sequenceId &&
    p.mode !== "homework" &&
    p.linkState !== "live" &&
    p.linkState !== "planned"
  );
}

/** The status pip encodes the chip's release state at a glance, WITHOUT an
 *  asymmetric border: green = live class focus, blue = homework/async, violet =
 *  planned linked activity, gray = bare class (no Rabbithole content). */
export function chipStatus(p: PlacementChipData): {
  color: string;
  label: string;
} {
  if (p.linkState === "live") return { color: "green.400", label: "Live" };
  if (p.mode === "homework") return { color: "blue.400", label: "Homework" };
  if (p.linkState === "planned")
    return { color: "violet.400", label: "Planned" };
  if (p.assignmentId) return { color: "violet.300", label: "Linked" };
  return { color: "gray.300", label: "No activity linked" };
}

function ChipAvatar({
  p,
  lens,
  groupEmoji,
  size = "2xs",
}: {
  p: PlacementChipData;
  lens: Lens;
  groupEmoji?: string | null;
  size?: "2xs" | "xs";
}) {
  if (lens === "group") {
    return p.teacherName ? (
      <Avatar
        name={p.teacherName}
        size={size}
      />
    ) : (
      <Box
        w={size === "xs" ? 6 : 4.5}
        h={size === "xs" ? 6 : 4.5}
        borderRadius="full"
        border="1px dashed"
        borderColor="gray.300"
        flexShrink={0}
        title="No teacher assigned"
      />
    );
  }
  return (
    <Box fontSize={size === "xs" ? "md" : "sm"} flexShrink={0} lineHeight={1}>
      {groupEmoji ?? "•"}
    </Box>
  );
}

/** A small pill badge (mode / status), even-bordered. */
function ChipBadge({
  children,
  color = "charcoal.400",
  bg = "gray.100",
}: {
  children: React.ReactNode;
  color?: string;
  bg?: string;
}) {
  return (
    <Box
      as="span"
      px={1.5}
      py={0.5}
      borderRadius="sm"
      bg={bg}
      color={color}
      fontSize="2xs"
      fontWeight="600"
      lineHeight={1.3}
      whiteSpace="nowrap"
    >
      {children}
    </Box>
  );
}

/**
 * Block title — a bare class (subject + teacher, no linked activity) reads as the
 * *title of the block* it sits in, not a movable chip. In the default schedule
 * view the common action is filling a block with an activity; re-timing a block
 * is a rarer, separate (locked) edit-schedule mode. So this renders as a passive
 * label — no border, no card, no drag affordance — letting clicks fall through to
 * the cell's "add an activity here" target.
 */
function BlockTitle({
  p,
  lens,
  groupEmoji,
}: {
  p: PlacementChipData;
  lens: Lens;
  groupEmoji?: string | null;
}) {
  return (
    <HStack gap={1.5} align="center" px={1} py={1} minW={0}>
      <ChipAvatar p={p} lens={lens} groupEmoji={groupEmoji} />
      <VStack align="start" gap={0} minW={0} flex={1}>
        <Text
          fontSize="xs"
          fontWeight="600"
          color="charcoal.400"
          lineClamp={2}
          lineHeight={1.15}
          letterSpacing="0.01em"
        >
          {p.subject}
        </Text>
        {p.note && (
          <Text fontSize="2xs" color="charcoal.300" lineClamp={1}>
            {p.note}
          </Text>
        )}
      </VStack>
    </HStack>
  );
}

/**
 * Compact chip for the calendar grid: avatar + subject, an optional secondary
 * line (linked activity title, else free note), and a corner status pip. A bare
 * class (no linked activity) instead renders as a passive BlockTitle when
 * `asBlockTitle` is set — see that component.
 */
export function PlacementChip({
  p,
  lens,
  groupEmoji,
  dragging,
  flagged,
  outOfOrder,
  asBlockTitle,
  fill,
  flat,
  suppressSubjectEyebrow,
}: {
  p: PlacementChipData;
  lens: Lens;
  groupEmoji?: string | null;
  dragging?: boolean;
  flagged?: boolean;
  outOfOrder?: boolean;
  asBlockTitle?: boolean;
  /** Stretch to fill the host cell (grid) so a full block reads as full, with
   *  its content vertically centered. */
  fill?: boolean;
  /** Render without its own card chrome (no border, shadow, radius, or pip) so it
   *  can sit fused inside a single elevated block card in the grid's edit mode. */
  flat?: boolean;
  /** Drop the CLASS-subject eyebrow (T3 — don't restate): set only by the grid
   *  cell when the SAME cell already renders that class's header (a bare
   *  recurring row + its concrete cascaded chip), so the class isn't named
   *  twice stacked. The activity title stays the chip's heading. Everywhere the
   *  chip stands alone (chip-only cells, the drawers, the Now view) the eyebrow
   *  remains — it's the only thing naming the class there. */
  suppressSubjectEyebrow?: boolean;
}) {
  if (asBlockTitle) {
    return <BlockTitle p={p} lens={lens} groupEmoji={groupEmoji} />;
  }
  const status = chipStatus(p);
  // Consistent hierarchy on the chip AND the detail drawer: when a placement
  // links an activity, the CLASS subject is a quiet eyebrow above the emphasized
  // ACTIVITY title, with the unit + step ("How Chatbots Think · 3 of 15") below.
  // A chip with no linked activity keeps the class subject as its title + note.
  const hasActivity = Boolean(p.activityTitle);
  const eyebrow = hasActivity && !suppressSubjectEyebrow ? p.subject : null;
  const primary = hasActivity ? p.activityTitle! : p.subject;
  let secondary: string | null;
  if (hasActivity) {
    const parts: string[] = [];
    if (p.unitTitle) parts.push(p.unitTitle);
    const sequenceRank =
      p.sequenceRank ??
      (p.sequenceIndex != null ? p.sequenceIndex + 1 : null);
    if (sequenceRank != null && p.sequenceLength) {
      parts.push(`${sequenceRank} of ${p.sequenceLength}`);
    }
    secondary = parts.join(" · ") || p.note || null;
  } else {
    secondary = p.note ?? null;
  }
  return (
    <Box
      position="relative"
      h={fill ? "full" : undefined}
      bg={flat || fill ? "transparent" : "white"}
      borderWidth={flat || fill ? "0" : "1px"}
      borderStyle="solid"
      borderColor={
        flat || fill
          ? "transparent"
          : flagged || outOfOrder
            ? "amber.400"
            : p.linkState === "live"
              ? "green.300"
              : "gray.200"
      }
      borderRadius={flat || fill ? "0" : "md"}
      px={fill ? 1 : 1.5}
      py={1}
      pr={flat ? 1.5 : fill ? 3 : 4}
      boxShadow={flat || fill ? "none" : dragging ? "lg" : "sm"}
    >
      {/* Status pip — top corner, replaces the banned left stripe. Hidden when
          flat: the fused block card carries the status through its activity. When
          `fill`, the CELL shell is the card, so the chip drops its own chrome but
          keeps the pip. */}
      {!flat && (
        <Box
          position="absolute"
          top={1.5}
          right={1.5}
          w={1.5}
          h={1.5}
          borderRadius="full"
          bg={status.color}
          title={status.label}
        />
      )}
      <HStack gap={1.5} align={outOfOrder ? "start" : "center"}>
        <ChipAvatar p={p} lens={lens} groupEmoji={groupEmoji} />
        <VStack align="start" gap={0.5} minW={0} flex={1}>
          {eyebrow && (
            <Text
              fontFamily="heading"
              fontSize="2xs"
              fontWeight="700"
              color="charcoal.400"
              textTransform="uppercase"
              letterSpacing="0.05em"
              lineHeight={1.1}
              lineClamp={1}
            >
              {eyebrow}
            </Text>
          )}
          <Text
            fontSize="xs"
            fontWeight="600"
            color="navy.700"
            lineClamp={2}
            lineHeight={1.15}
          >
            {primary}
          </Text>
          {secondary && (
            <Text fontSize="2xs" color="charcoal.300" lineClamp={1}>
              {secondary}
            </Text>
          )}
          {outOfOrder && (
            <HStack
              as="span"
              gap={0.5}
              px={1}
              py={0.5}
              borderRadius="sm"
              bg="amber.50"
              color="amber.700"
              fontSize="2xs"
              fontWeight="700"
              lineHeight={1.1}
              title="This activity is out of its unit's planned order"
            >
              <chakra.span aria-hidden="true">⇅</chakra.span>
              <chakra.span>Out of order</chakra.span>
            </HStack>
          )}
        </VStack>
      </HStack>
    </Box>
  );
}

/**
 * Expanded chip for Now / Scholars: the same base, opened up with the linked
 * activity title, a mode badge, a status badge, and a slot for action
 * affordances (Open run / assign next …) passed as children.
 */
export function PlacementChipExpanded({
  p,
  lens,
  groupEmoji,
  actions,
}: {
  p: PlacementChipData;
  lens: Lens;
  groupEmoji?: string | null;
  actions?: React.ReactNode;
}) {
  const status = chipStatus(p);
  // Consistent with the compact chip: when an activity is linked, the CLASS
  // subject is a quiet eyebrow (sharing its row with the status pill) above the
  // emphasized ACTIVITY title. A bare class (no activity) keeps the subject as
  // its heading.
  const hasActivity = Boolean(p.activityTitle);
  const statusPill = (
    <HStack
      as="span"
      gap={1}
      flexShrink={0}
      color="charcoal.300"
      fontSize="2xs"
    >
      <Box w={1.5} h={1.5} borderRadius="full" bg={status.color} />
      <chakra.span>{status.label}</chakra.span>
    </HStack>
  );
  return (
    <Box
      position="relative"
      bg="white"
      borderWidth="1px"
      borderStyle="solid"
      borderColor={p.linkState === "live" ? "green.300" : "gray.200"}
      borderRadius="md"
      px={3}
      py={2.5}
      boxShadow="xs"
    >
      <HStack gap={2.5} align="start">
        <ChipAvatar p={p} lens={lens} groupEmoji={groupEmoji} size="xs" />
        <VStack align="start" gap={1} flex={1} minW={0}>
          {hasActivity ? (
            <>
              <HStack gap={2} flexWrap="wrap" align="center">
                <Text
                  fontFamily="heading"
                  fontSize="2xs"
                  fontWeight="700"
                  color="charcoal.400"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                  lineClamp={1}
                >
                  {p.subject}
                </Text>
                {statusPill}
              </HStack>
              <Text
                fontSize="sm"
                fontWeight="700"
                color="navy.700"
                lineClamp={2}
              >
                {p.activityTitle}
              </Text>
            </>
          ) : (
            <HStack gap={2} flexWrap="wrap" align="center">
              <Text
                fontSize="sm"
                fontWeight="700"
                color="navy.700"
                lineClamp={1}
              >
                {p.subject}
              </Text>
              {statusPill}
            </HStack>
          )}
          <HStack gap={1.5} flexWrap="wrap">
            {p.mode && (
              <ChipBadge>
                {p.mode === "homework" ? "homework" : "class focus"}
              </ChipBadge>
            )}
            {p.note && (
              <Text fontSize="2xs" color="charcoal.300" lineClamp={1}>
                {p.note}
              </Text>
            )}
          </HStack>
          {actions && (
            <HStack gap={2} pt={1}>
              {actions}
            </HStack>
          )}
        </VStack>
      </HStack>
    </Box>
  );
}
