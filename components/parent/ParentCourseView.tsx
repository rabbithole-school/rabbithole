"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import {
  Box,
  Heading,
  HStack,
  Link as ChakraLink,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ArrowLeft, ArrowSquareOut } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ParentPortfolioItemGrid } from "@/components/parent/ParentPortfolioCard";
import type { ParentPortfolioItem } from "@/components/parent/ParentPortfolioViewer";
import {
  ParentMediaReleaseNotice,
  ParentPortfolioFlatGrid,
  ParentPortfolioQuietLine,
} from "@/components/parent/ParentPortfolioTab";
import {
  sessionBreadcrumb,
  sessionDateLabel,
} from "@/components/parent/parentCoursePortfolio";

export interface ParentCourseResource {
  _id: Id<"activityResources">;
  title: string;
  source: "file" | "link" | "video";
  url: string | null;
  mimeType: string | null;
  fileName: string | null;
}

export interface ParentCourseSession {
  key: string;
  scheduledAt: number | null;
  kind: "lesson" | "handout";
  unitTitle: string | null;
  lessonTitle: string | null;
  activityTitle: string;
  work: ParentPortfolioItem[];
  resources: ParentCourseResource[];
}

/**
 * One course behind its tile: the program's scheduled sessions in schedule
 * order, each with the child's shared work and the teacher's family-visible
 * resources. `/parent/portfolio/other` reuses this shell for the work that
 * isn't filed to any course.
 */
export function ParentCourseView({
  scholarId,
  groupId,
  hrefQuery,
  preview = false,
}: {
  scholarId: Id<"users">;
  groupId: string;
  hrefQuery: string;
  preview?: boolean;
}) {
  const isOther = groupId === "other";
  // One subscription for the whole view. `courseForGuardian` takes the raw URL
  // segment (junk and "other" normalise to a null course) and carries the
  // media-release state, so the course view never re-runs the tile pipeline.
  const result = useQuery(api.portfolio.courseForGuardian, {
    scholarId,
    groupId,
  });
  const course = result === undefined ? undefined : result.course;
  const backHref = `/parent/portfolio${hrefQuery}`;

  if (isOther) {
    return (
      <VStack align="stretch" gap={5}>
        <BackLink href={backHref} />
        <ParentMediaReleaseNotice
          mediaRelease={result?.mediaRelease}
          preview={preview}
        />
        <Heading size="lg" fontFamily="heading" color="navy.500">
          Other work
        </Heading>
        <ParentPortfolioFlatGrid scholarId={scholarId} unfiledOnly />
      </VStack>
    );
  }

  if (course === undefined) {
    return (
      <VStack align="stretch" gap={5}>
        <BackLink href={backHref} />
        <Spinner size="sm" color="violet.400" />
      </VStack>
    );
  }

  if (course === null) {
    return (
      <VStack align="stretch" gap={4}>
        <BackLink href={backHref} />
        <ParentPortfolioQuietLine>
          This course isn&apos;t part of your child&apos;s portfolio.
        </ParentPortfolioQuietLine>
      </VStack>
    );
  }

  const sessions: ParentCourseSession[] = course.sessions;
  const otherWork: ParentPortfolioItem[] = course.otherWork;

  return (
    <VStack align="stretch" gap={5}>
      <BackLink href={backHref} />
      <ParentMediaReleaseNotice
        mediaRelease={result?.mediaRelease}
        preview={preview}
      />
      <HStack gap={3} align="center">
        {course.emoji && (
          <Text fontSize="2xl" lineHeight="1" aria-hidden="true">
            {course.emoji}
          </Text>
        )}
        <Heading size="lg" fontFamily="heading" color="navy.500">
          {course.name}
        </Heading>
      </HStack>

      {sessions.length === 0 && otherWork.length === 0 ? (
        <ParentPortfolioQuietLine>
          Nothing has been shared from this course yet.
        </ParentPortfolioQuietLine>
      ) : (
        <VStack align="stretch" gap={5}>
          {sessions.map((session) => (
            <SessionBlock key={session.key} session={session} />
          ))}
          {otherWork.length > 0 && (
            <Box
              bg="white"
              borderColor="gray.200"
              borderRadius="xl"
              borderWidth="1px"
              p={5}
            >
              <Heading
                size="sm"
                fontFamily="heading"
                color="navy.500"
                mb={3}
              >
                Other work in this course
              </Heading>
              <ParentPortfolioItemGrid items={otherWork} />
            </Box>
          )}
        </VStack>
      )}
    </VStack>
  );
}

function BackLink({ href }: { href: string }) {
  return (
    <ChakraLink
      asChild
      color="violet.600"
      fontFamily="heading"
      fontSize="sm"
      alignSelf="start"
    >
      <Link href={href}>
        <ArrowLeft size={14} weight="bold" /> Portfolio
      </Link>
    </ChakraLink>
  );
}

function SessionBlock({ session }: { session: ParentCourseSession }) {
  const dateLabel = sessionDateLabel(session.scheduledAt);
  const isEmpty = session.work.length === 0 && session.resources.length === 0;
  return (
    <Box
      bg="white"
      borderColor="gray.200"
      borderRadius="xl"
      borderWidth="1px"
      p={5}
    >
      <Heading size="sm" fontFamily="heading" color="navy.500">
        {sessionBreadcrumb(session)}
      </Heading>
      {dateLabel && (
        <Text fontFamily="body" fontSize="xs" color="charcoal.300" mt={1}>
          {dateLabel}
        </Text>
      )}

      <VStack align="stretch" gap={4} mt={4}>
        {isEmpty && (
          <ParentPortfolioQuietLine>Nothing shared yet</ParentPortfolioQuietLine>
        )}
        {session.work.length > 0 && (
          <ParentPortfolioItemGrid items={session.work} />
        )}
        {session.resources.length > 0 && (
          <Box>
            <Text
              fontFamily="heading"
              fontSize="sm"
              fontWeight="600"
              color="charcoal.600"
              mb={2}
            >
              Resources from the teacher
            </Text>
            <VStack align="stretch" gap={2}>
              {session.resources.map((resource) => (
                <ResourceRow key={resource._id} resource={resource} />
              ))}
            </VStack>
          </Box>
        )}
      </VStack>
    </Box>
  );
}

function ResourceRow({ resource }: { resource: ParentCourseResource }) {
  const hint =
    resource.source === "file"
      ? (resource.fileName ?? resource.mimeType ?? null)
      : resource.source === "video"
        ? "Video"
        : "Link";
  const label = (
    <HStack gap={2} align="baseline">
      <Text fontFamily="body" fontSize="sm" color="inherit">
        {resource.title}
      </Text>
      {hint && (
        <Text fontFamily="body" fontSize="xs" color="charcoal.300">
          {hint}
        </Text>
      )}
      <ArrowSquareOut size={14} />
    </HStack>
  );
  if (!resource.url) {
    return <Box color="charcoal.600">{label}</Box>;
  }
  return (
    <ChakraLink
      asChild
      color="violet.600"
      alignSelf="start"
      _hover={{ textDecoration: "underline" }}
    >
      <a href={resource.url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    </ChakraLink>
  );
}
