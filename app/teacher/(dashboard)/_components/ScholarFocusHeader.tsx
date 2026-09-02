"use client";

import { type ReactNode, useMemo } from "react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { Avatar } from "@/components/Avatar";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// ── Scholar Focus Header ──────────────────────────────────────────────────
// The ONE way a teacher surface says "here is the scholar you are looking at":
// the child's name as the dominant element, with age and grade adjacent and
// subordinate, then whatever that surface's own subordinate facts are.
//
// It exists because three surfaces disagreed about it (T1, one canonical
// rendering per signal): the scholar tab header rendered a small name plus a
// metadata line, the mastery report rendered a mid-size name, and meeting mode
// rendered the LENS NAME ("Rounds" / "Whole Child") at size="lg" with the
// child demoted to a breadcrumb — on a surface that gets projected on a wall
// in a staff meeting, so the largest thing in the room was the name of the
// ritual everyone was already sitting in.
//
// Sizing is prop-driven (`scale`) because one consumer is a slim tab header
// and another is a full report; both scales live in ONE table below so they
// can't drift apart again. There is deliberately NO projection scale: Rounds
// is projected, but a browser already has a zoom control, and a bespoke
// oversized variant only made that one surface disagree with every other
// report. The optional slots are deliberately few — pager, lens, actions —
// and a fourth would need to justify itself.

export type ScholarFocusScale = "compact" | "report";

const SCALE: Record<
  ScholarFocusScale,
  {
    avatar: "sm" | "md" | "lg";
    name: string;
    meta: string;
    gap: number;
    px: number | { base: number; md: number };
    py: number;
  }
> = {
  /** A slim identity strip above a tab body. */
  compact: { avatar: "sm", name: "md", meta: "xs", gap: 3, px: 4, py: 2.5 },
  /** A focus report's header — room to breathe, still a screen-reading size. */
  report: { avatar: "lg", name: "2xl", meta: "sm", gap: 4, px: { base: 3, md: 5 }, py: 4 },
};

const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;

/**
 * Whole years since `dateOfBirth` (strict ISO `YYYY-MM-DD`), or `null` when the
 * date is missing or unparseable. `now` is always explicit so this never reads
 * the clock itself.
 */
export function ageInYears(
  dateOfBirth: string | null | undefined,
  now: Date,
): number | null {
  if (!dateOfBirth) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const dob = new Date(Date.UTC(year, month - 1, day));
  if (
    dob.getUTCFullYear() !== year ||
    dob.getUTCMonth() !== month - 1 ||
    dob.getUTCDate() !== day
  ) {
    return null;
  }
  const years = Math.floor((now.getTime() - dob.getTime()) / MS_PER_YEAR);
  return years >= 0 && years < 130 ? years : null;
}

/** "Kindergarten" / "Grade 4" — the house grade label. */
export function gradeLabel(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  if (trimmed.toUpperCase() === "K") return "Kindergarten";
  return `Grade ${trimmed}`;
}

export function ScholarFocusHeader({
  scholarId,
  name,
  image,
  dateOfBirth,
  gradeLevel,
  scale = "compact",
  detail,
  pager,
  lens,
  actions,
}: {
  scholarId: string;
  /** Optional identity seeds from a roster the caller already has. Anything
   *  omitted is resolved from the scholar's cached profile, so every surface
   *  shows the same name, age, and grade without each one plumbing them. */
  name?: string | null;
  image?: string | null;
  dateOfBirth?: string | null;
  gradeLevel?: string | null;
  scale?: ScholarFocusScale;
  /** This surface's own subordinate facts, appended after age · grade. */
  detail?: ReactNode;
  /** Prev / position / next through the surface's scholar set. */
  pager?: ReactNode;
  /** A lens control for surfaces that render the same scholar several ways. */
  lens?: ReactNode;
  /** Surface-level actions (Add, View as, Mark done). */
  actions?: ReactNode;
}) {
  const needsProfile =
    !name || dateOfBirth === undefined || gradeLevel === undefined;
  const profile = useQuery(
    api.scholars.getProfile,
    needsProfile ? { scholarId: scholarId as Id<"users"> } : "skip",
  );
  const resolved = profile?.scholar;

  const displayName = name || resolved?.name || "Scholar";
  const displayImage = image ?? resolved?.image ?? undefined;
  const dob = dateOfBirth ?? resolved?.dateOfBirth ?? null;
  const grade = gradeLevel ?? resolved?.gradeLevel ?? null;

  const facts = useMemo(() => {
    const age = ageInYears(dob, new Date());
    return [age === null ? null : `Age ${age}`, gradeLabel(grade)]
      .filter(Boolean)
      .join(" · ");
  }, [dob, grade]);

  const s = SCALE[scale];
  const trailing = pager || lens || actions;

  return (
    <Flex
      px={s.px}
      py={s.py}
      gap={s.gap}
      align="center"
      bg="white"
      borderBottom="1px solid"
      borderColor="gray.200"
      flexShrink={0}
      wrap="wrap"
    >
      <Avatar
        size={s.avatar}
        name={displayName}
        src={displayImage || undefined}
        colorKey={scholarId}
      />
      <Box minW={0} flex="1 1 260px">
        <Text
          fontFamily="heading"
          fontSize={s.name}
          fontWeight="700"
          color="navy.500"
          lineHeight="1.1"
          lineClamp={1}
        >
          {displayName}
        </Text>
        {(facts || detail) && (
          <HStack
            gap={1.5}
            mt={scale === "compact" ? 0 : 1}
            minW={0}
            color="charcoal.400"
            fontFamily="heading"
            fontSize={s.meta}
          >
            {facts && <Text lineClamp={1}>{facts}</Text>}
            {facts && detail && (
              <Text aria-hidden flexShrink={0}>
                ·
              </Text>
            )}
            {detail && (
              <Box minW={0} lineHeight="1.3">
                {detail}
              </Box>
            )}
          </HStack>
        )}
      </Box>

      {trailing && (
        <HStack gap={3} ml="auto" flexShrink={0}>
          {pager}
          {lens}
          {actions}
        </HStack>
      )}
    </Flex>
  );
}
