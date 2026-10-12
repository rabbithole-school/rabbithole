"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import {
  Box,
  Grid,
  HStack,
  Link as ChakraLink,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatRelative } from "@/lib/relativeTime";
import { ParentPortfolioItemGrid } from "@/components/parent/ParentPortfolioCard";
import type { ParentPortfolioItem } from "@/components/parent/ParentPortfolioViewer";
import {
  courseTileMeta,
  mediaReleaseNoticeCopy,
} from "@/components/parent/parentCoursePortfolio";

/** The consent state the family portal reads for photos and videos. The
 *  portal never interprets it further — the backend decides what is shared. */
export interface ParentMediaRelease {
  status: "not_applicable" | "granted" | "not_granted" | "form_missing";
  formPath: string | null;
}

export interface ParentCourseTile {
  groupId: Id<"scholarGroups">;
  name: string;
  emoji: string | null;
  latestWorkAt: number | null;
  workCount: number;
  sessionCount: number;
}

/** The quiet one-line note the portfolio uses for "nothing here yet". */
export function ParentPortfolioQuietLine({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Text fontFamily="body" fontSize="sm" color="charcoal.300">
      {children}
    </Text>
  );
}

/**
 * Visiting-student families share photos and videos through the media
 * release on their form. Until that is done there is nothing broken to
 * report — so this says, calmly, what would make media appear.
 */
export function ParentMediaReleaseNotice({
  mediaRelease,
  preview = false,
}: {
  mediaRelease: ParentMediaRelease | undefined;
  /** Staff "View as parent": a staff member cannot open a guardian's form,
   *  so the notice states the situation without offering the link. */
  preview?: boolean;
}) {
  const copy = mediaRelease
    ? mediaReleaseNoticeCopy(mediaRelease.status)
    : null;
  if (!mediaRelease || !copy) return null;
  const formPath = preview ? null : mediaRelease.formPath;
  return (
    <Box
      bg="violet.50"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="violet.100"
      p={5}
    >
      <Text fontFamily="body" fontSize="sm" color="charcoal.500">
        {copy.body}
        {formPath ? " " : ""}
        {formPath && (
          <ChakraLink asChild color="violet.600" textDecoration="underline">
            <Link href={formPath}>{copy.linkLabel}</Link>
          </ChakraLink>
        )}
      </Text>
    </Box>
  );
}

/**
 * The Portfolio tab. A child who is part of programs leads with one tile per
 * course — all of a course's work lives behind its tile — and everything
 * unfiled sits behind an "Other work" tile. A child with no courses keeps the
 * plain grid of everything their family can see.
 */
export function ParentPortfolioTab({
  scholarId,
  hrefQuery,
  preview = false,
}: {
  scholarId: Id<"users">;
  hrefQuery: string;
  preview?: boolean;
}) {
  const courses = useQuery(api.portfolio.coursesForGuardian, { scholarId });

  if (courses === undefined) {
    return <Spinner size="sm" color="violet.400" />;
  }

  const tiles: ParentCourseTile[] = courses.courses;

  return (
    <VStack align="stretch" gap={5}>
      <ParentMediaReleaseNotice
        mediaRelease={courses.mediaRelease}
        preview={preview}
      />
      {tiles.length === 0 ? (
        <ParentPortfolioFlatGrid scholarId={scholarId} />
      ) : (
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap={4}>
          {tiles.map((course) => (
            <CourseTile
              key={course.groupId}
              href={`/parent/portfolio/${course.groupId}${hrefQuery}`}
              emoji={course.emoji}
              name={course.name}
              meta={courseTileMeta(course.workCount, course.sessionCount)}
              latestWorkAt={course.latestWorkAt}
            />
          ))}
          {courses.otherWorkCount > 0 && (
            <CourseTile
              href={`/parent/portfolio/other${hrefQuery}`}
              emoji={null}
              name="Other work"
              meta={courseTileMeta(courses.otherWorkCount, 0)}
              latestWorkAt={null}
            />
          )}
        </Grid>
      )}
    </VStack>
  );
}

function CourseTile({
  href,
  emoji,
  name,
  meta,
  latestWorkAt,
}: {
  href: string;
  emoji: string | null;
  name: string;
  meta: string | null;
  latestWorkAt: number | null;
}) {
  return (
    <Link href={href} style={{ display: "block" }}>
      <Box
        bg="white"
        borderColor="gray.200"
        borderRadius="xl"
        borderWidth="1px"
        h="100%"
        p={5}
        _hover={{ borderColor: "violet.300" }}
      >
        <HStack align="start" gap={3}>
          {emoji && (
            <Text fontSize="2xl" lineHeight="1" aria-hidden="true">
              {emoji}
            </Text>
          )}
          <Box minW={0}>
            <Text
              fontFamily="heading"
              fontWeight="600"
              fontSize="md"
              color="charcoal.600"
            >
              {name}
            </Text>
            {meta && (
              <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={1}>
                {meta}
              </Text>
            )}
            {latestWorkAt !== null && (
              <Text fontFamily="body" fontSize="xs" color="charcoal.300" mt={1}>
                Updated {formatRelative(latestWorkAt)}
              </Text>
            )}
          </Box>
        </HStack>
      </Box>
    </Link>
  );
}

/**
 * Every family-visible piece of work in one grid — the portfolio a child
 * without courses sees, and (filtered to unfiled work) the "Other work"
 * course view.
 */
export function ParentPortfolioFlatGrid({
  scholarId,
  unfiledOnly = false,
}: {
  scholarId: Id<"users">;
  unfiledOnly?: boolean;
}) {
  const allItems = useQuery(api.portfolio.listForGuardian, { scholarId });

  if (allItems === undefined) {
    return <Spinner size="sm" color="violet.400" />;
  }
  const items: ParentPortfolioItem[] = unfiledOnly
    ? allItems.filter((item) => item.courseId === null)
    : allItems;
  if (items.length === 0) {
    return (
      <ParentPortfolioQuietLine>
        No family-visible work samples yet.
      </ParentPortfolioQuietLine>
    );
  }
  return <ParentPortfolioItemGrid items={items} />;
}
