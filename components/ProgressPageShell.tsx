"use client";

import { useMutation, useQuery } from "convex/react";
import { Box, Container, Flex, IconButton, Stack } from "@chakra-ui/react";
import { PencilSimple, ArrowClockwise } from "@phosphor-icons/react";
import Link from "next/link";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { BigPictureContent } from "./BigPictureContent";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { ScholarPageHeader } from "./ScholarPageHeader";

interface ProgressPageShellProps {
  sessionId: Id<"sessions">;
  /**
   * Teacher remote mode: when set, the page is being viewed by a
   * teacher as the named scholar. The header swaps to a "back to
   * curriculum" affordance, the home button routes to /teacher, and
   * the "Edit unit" affordance keys off the *remote scholar*
   * authoring the IS unit (not the viewing teacher).
   */
  remoteUserId?: Id<"users"> | null;
}

/**
 * Full-screen shell for the canonical Big Picture pages —
 * `/scholar/[sessionId]/progress`, `/scholar/quest/[questId]`,
 * `/scholar/unit/[unitId]`. Reads the project + getBigPicture and
 * derives the header from the project's actual context:
 *   • Quest project   → quest title + "QUEST" eyebrow
 *   • Lesson project  → unit title  + "UNIT" eyebrow
 *   • Other           → project title (no eyebrow)
 *
 * Uses the shared `<ScholarPageHeader>` so the title lives IN the
 * bar (not the body) — this way navigating into a project's chat
 * view via `<SessionHeader>` doesn't make the page title jump from
 * "body H1" to "header bar."
 */
export function ProgressPageShell({
  sessionId,
  remoteUserId = null,
}: ProgressPageShellProps) {
  const { user } = useCurrentUser();
  const session = useQuery(api.sessions.get, { id: sessionId });
  const updateSession = useMutation(api.sessions.update);
  const regenerate = useMutation(api.sessions.regenerateReflection);
  const bigPicture = useQuery(api.sessions.getBigPicture, { sessionId });
  // Pull the unit doc directly so we can spot IS-author ownership for
  // the "Edit unit" affordance. (project.get returns project fields,
  // not unit fields.)
  const unit = useQuery(
    api.units.get,
    session?.unitId ? { id: session.unitId } : "skip",
  );

  if (session === undefined || session === null) {
    return null;
  }
  // In remote mode "is this *my* IS unit" really means "is this the
  // remote scholar's IS unit" — the teacher shouldn't get an Edit
  // affordance just because they happen to be viewing.
  const ownerForIsCheck = remoteUserId ?? user?._id ?? null;
  const isMyIsUnit =
    !!ownerForIsCheck &&
    !!unit?.authorScholarId &&
    unit.authorScholarId === ownerForIsCheck;
  const homeHref = remoteUserId ? "/teacher/curriculum" : "/scholar";
  const homeLabel = remoteUserId
    ? "Back to curriculum"
    : "Back to my sessions";

  // Derive the page's title + kind eyebrow from the project's context.
  let pageTitle = session.title;
  let pageEyebrow: string | null = null;
  let pageSubtitle: string | null = null;
  if (bigPicture?.progress?.kind === "lesson") {
    pageTitle = bigPicture.progress.unitTitle;
    pageEyebrow = "Unit";
    pageSubtitle = bigPicture.progress.lessonTitle;
  }

  return (
    <Flex minH="100vh" bg="white" flexDir="column">
      <ScholarPageHeader
        homeHref={homeHref}
        homeLabel={homeLabel}
        eyebrow={pageEyebrow}
        title={pageTitle}
        subtitle={pageSubtitle}
        rightSlot={
          <>
            {isMyIsUnit && session.unitId && (
              <IconButton
                asChild
                aria-label="Edit this unit in the designer"
                title="Edit this unit"
                size="sm"
                variant="ghost"
                color="charcoal.400"
                _hover={{ color: "violet.500", bg: "gray.100" }}
              >
                <Link href={curriculumUnitHref(session.unitId)}>
                  <PencilSimple size={16} />
                </Link>
              </IconButton>
            )}
            {bigPicture?.reflection && (
              <IconButton
                aria-label="Refresh big-picture summary"
                size="sm"
                variant="ghost"
                color="charcoal.300"
                _hover={{ color: "violet.500", bg: "gray.100" }}
                onClick={async () => {
                  await regenerate({ sessionId });
                }}
              >
                <ArrowClockwise size={16} />
              </IconButton>
            )}
          </>
        }
      />

      <Box flex={1} overflowY="auto">
        <Container maxW="2xl" pt={8} pb={10} px={6}>
          <Stack gap={6}>
            <BigPictureContent
              sessionId={sessionId}
              sessionTitle={session.title}
              onRename={(next) =>
                updateSession({ id: sessionId, title: next })
              }
              variant="full"
              active
              hideTopHeader
            />
          </Stack>
        </Container>
      </Box>
    </Flex>
  );
}
