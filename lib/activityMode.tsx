"use client";

/**
 * Single source of truth for how the two activity modes — class focus
 * vs homework — are drawn ANYWHERE in the app. One Phosphor icon, one
 * color tone, one label per mode. Every surface (assignment-list rows,
 * Run-page status badges, the scholar plate's section headings, the
 * activity designer's intent picker, the scholar "doing this now"
 * banner) renders through here so the iconography can't fragment again
 * the way it had (target emoji vs FiTarget vs 🏫 vs 📋 all meaning
 * "class focus").
 *
 *   classFocus → Target  (violet)      homework → House (orange)
 *
 * NOT for a scholar's real-time *engagement* — that's a different axis,
 * shown as the roster pulse sparkline, not an activity-mode icon. Don't
 * route engagement through here.
 */
import {
  Compass,
  House,
  SunHorizon,
  Target,
  Toolbox,
  type Icon,
  type IconWeight,
} from "@phosphor-icons/react";
import { Badge, HStack, Text } from "@chakra-ui/react";

export type ActivityMode = "classFocus" | "homework";

export const ACTIVITY_MODE: Record<
  ActivityMode,
  {
    /** Capitalized label for badges/headings: "Class focus". */
    label: string;
    /** Lowercase noun for count chips: "2 in class". */
    countNoun: string;
    /** Chakra color scale base — violet (class) / orange (homework). */
    tone: "violet" | "orange";
    Icon: Icon;
  }
> = {
  classFocus: {
    label: "Class focus",
    countNoun: "in class",
    tone: "violet",
    Icon: Target,
  },
  homework: {
    label: "Homework",
    countNoun: "homework",
    tone: "orange",
    Icon: House,
  },
};

/**
 * Independent study is the third "plate origin" alongside classFocus
 * and homework, but it is NOT an `activitySchedule` mode (scholars
 * author their own IS units; nothing gets pushed). So it's deliberately
 * not in `ACTIVITY_MODE` — but its icon lives here anyway so all three
 * section glyphs (class / homework / IS) are defined in ONE place and
 * can't drift. Canonical glyph: Phosphor Compass (self-directed
 * wayfinding), which also matches the pre-existing FiCompass IS usages.
 */
export function IndependentStudyIcon({
  size = 12,
  weight = "bold",
}: {
  size?: number;
  weight?: IconWeight;
}) {
  return <Compass size={size} weight={weight} />;
}

export function ActivityModeIcon({
  mode,
  size = 12,
  weight = "bold",
}: {
  mode: ActivityMode;
  size?: number;
  weight?: IconWeight;
}) {
  const { Icon } = ACTIVITY_MODE[mode];
  return <Icon size={size} weight={weight} />;
}

/**
 * The two standing Scholar's-Prep activity glyphs, kept here alongside the
 * mode icons so ALL Scholar's-Prep iconography has one home (the same reason
 * the mode + IS glyphs live here — so they can't fragment across surfaces).
 * Andy's final picks: reflection = sunset (SunHorizon), the Workshop = a
 * toolbox. Restrained, monochrome, plate-family line icons.
 */
export function ReflectionIcon({
  size = 12,
  weight = "bold",
}: {
  size?: number;
  weight?: IconWeight;
}) {
  return <SunHorizon size={size} weight={weight} />;
}

export function WorkshopIcon({
  size = 12,
  weight = "bold",
}: {
  size?: number;
  weight?: IconWeight;
}) {
  return <Toolbox size={size} weight={weight} />;
}

/**
 * The one mode chip. Two visual treatments:
 *   - "solid" (default): filled `.100/.700` Chakra Badge — Run-page
 *     status, ClassActiveView. Inline status next to a title.
 *   - "soft": low-saturation `.50/.200/.700` rounded pill — dense meta
 *     lines (assignment rows, homework activity rows). A count is
 *     status, not a warning, so it stays calm.
 *
 * `count` renders "N {countNoun}" ("2 in class"); otherwise the label
 * ("Class focus"), optionally with a `suffix` (" · due Mar 3").
 */
export function ActivityModeBadge({
  mode,
  variant = "solid",
  count,
  label,
  suffix,
}: {
  mode: ActivityMode;
  variant?: "solid" | "soft";
  count?: number;
  label?: string;
  suffix?: string;
}) {
  const m = ACTIVITY_MODE[mode];
  const text =
    count != null
      ? `${count} ${m.countNoun}`
      : `${label ?? m.label}${suffix ?? ""}`;

  if (variant === "soft") {
    return (
      <HStack
        gap={1}
        px={1.5}
        py={0.5}
        flexShrink={0}
        bg={`${m.tone}.50`}
        borderRadius="full"
        borderWidth="1px"
        borderColor={`${m.tone}.200`}
        color={`${m.tone}.700`}
        userSelect="none"
      >
        <ActivityModeIcon mode={mode} size={11} />
        <Text
          fontSize="2xs"
          fontFamily="heading"
          fontWeight="600"
          lineHeight="1"
          whiteSpace="nowrap"
        >
          {text}
        </Text>
      </HStack>
    );
  }

  return (
    <Badge
      bg={`${m.tone}.100`}
      color={`${m.tone}.700`}
      fontFamily="heading"
      fontSize="2xs"
      display="inline-flex"
      alignItems="center"
      gap={1}
      userSelect="none"
    >
      <ActivityModeIcon mode={mode} size={10} />
      {text}
    </Badge>
  );
}
