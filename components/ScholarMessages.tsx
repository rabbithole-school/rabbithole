"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Heading, Spinner, VStack } from "@chakra-ui/react";
import { Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { ViewToggle } from "@/components/ui/ViewToggle";
import {
  MessageConversationRow,
  MessageThreadPane,
  MessageWorkspace,
  threadPreview,
} from "@/components/messaging/MessageWorkspace";
import { formatRelative } from "@/lib/relativeTime";
import { messageThreadHref } from "@/lib/messageThreadUrl";
import { MESSAGE_ABOUT_COPY, aboutLabel } from "@/shared/messageAbout";
import { flavorOf } from "@/shared/scholarThreadFlavor";
import { WRITE_TO_TEACHER_COPY } from "@/shared/writeToTeacher";
import { WriteToTeacherDialog } from "@/components/messaging/WriteToTeacherDialog";

type ScholarThreadSummary = FunctionReturnType<
  typeof api.scholarMessages.listThreads
>["threads"][number];

type KindFilter = "all" | "people" | "workshop";

function kindFilterFrom(value: string | null): KindFilter {
  // "mentor" is the old name of the People filter, kept for older links.
  if (value === "people" || value === "mentor") return "people";
  return value === "workshop" ? "workshop" : "all";
}

/** A list-group eyebrow — the Workshop board's eyebrow treatment, inset to
 *  the conversation rows. */
function GroupEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Heading
      as="h2"
      fontFamily="heading"
      fontSize="xs"
      fontWeight="700"
      letterSpacing="0.04em"
      textTransform="uppercase"
      color="charcoal.400"
      px={4}
      pt={4}
      pb={2}
    >
      {children}
    </Heading>
  );
}

/**
 * The scholar's Messages: conversations with people first (they're about the
 * kid's own work), then Workshop idea threads, in the shared messaging
 * workspace. "New message" writes to one teacher at the scholar's school
 * (WriteToTeacherDialog); ideas are still filed from the Workshop.
 * `?kind=workshop` is the Workshop's way in; `?thread=` deep-links a
 * conversation.
 */
export function ScholarMessages() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const result = useQuery(api.scholarMessages.listThreads, {});
  const [composing, setComposing] = useState(false);
  // "New message" only when there is someone to write to.
  const teachers = useQuery(api.scholarMessages.listTeachersForScholar, {});
  const canCompose = (teachers?.length ?? 0) > 0;
  // About threads (a wonder a teacher replied to, a Quest): their own read,
  // because a plain listThreads call leaves them out for old builds. (The old
  // `kind` argument until the narrow: this page can briefly meet a backend
  // that predates `flavor`.)
  const aboutResult = useQuery(api.scholarMessages.listThreads, { kind: "about" });
  // Both reads in, so a `?thread=` for an about thread never lands before it
  // can be found.
  const threads =
    result && aboutResult
      ? [...result.threads, ...aboutResult.threads].sort(
          (a, b) => b.lastMessageAt - a.lastMessageAt,
        )
      : undefined;
  const kindFilter = kindFilterFrom(searchParams.get("kind"));
  const requestedThreadId = searchParams.get("thread");
  const openId =
    threads?.find((thread) => thread._id === requestedThreadId)?._id ?? null;
  const threadHref = (threadId: Id<"parentThreads"> | null) =>
    messageThreadHref(pathname, searchParams, threadId);

  const peopleThreads = (threads ?? []).filter((t) => flavorOf(t) === "general");
  const workshopThreads = (threads ?? []).filter((t) => flavorOf(t) === "workshop");
  const aboutThreads = (threads ?? []).filter((t) => flavorOf(t) === "about");
  // The filter only earns its place when there are two kinds to tell apart.
  const showFilter = peopleThreads.length > 0 && workshopThreads.length > 0;
  const kindHref = (kind: KindFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (kind === "all") params.delete("kind");
    else params.set("kind", kind);
    const query = params.toString();
    return `${pathname}${query ? `?${query}` : ""}`;
  };

  const row = (thread: ScholarThreadSummary) => {
    const flavor = flavorOf(thread);
    return (
    <MessageConversationRow
      key={thread._id}
      active={thread._id === openId}
      unread={thread.unread}
      leading={
        flavor === "general" ? (
          <Avatar
            name={thread.title}
            src={thread.staffParticipants[0]?.image ?? undefined}
            size="xs"
            colorKey={thread.staffParticipants[0]?._id ?? thread._id}
          />
        ) : undefined
      }
      primary={
        flavor === "workshop"
          ? thread.suggestionTitle ?? thread.topic ?? thread.title
          : flavor === "about"
            ? thread.aboutTitle ?? thread.title
            : thread.title
      }
      secondary={flavor === "about" ? aboutLabel(thread.about) : null}
      preview={threadPreview(
        thread.lastMessagePreview,
        thread.lastMessageAuthorName,
      )}
      timestamp={formatRelative(thread.lastMessageAt)}
      href={threadHref(thread._id)}
    />
    );
  };

  // With only one kind there's no filter control, so a stale `?kind=` (an
  // old link, or the other kind's threads went away) must not blank the list.
  const activeFilter: KindFilter = showFilter ? kindFilter : "all";
  const showPeople = activeFilter !== "workshop" && peopleThreads.length > 0;
  const showWorkshop = activeFilter !== "people" && workshopThreads.length > 0;
  const showAbout = activeFilter === "all" && aboutThreads.length > 0;

  return (
    <Flex h="full" minH={0} direction="column">
      {(showFilter || canCompose) && (
        <HStack
          px={4}
          py={2}
          bg="white"
          borderBottomWidth="1px"
          borderColor="gray.200"
          flexShrink={0}
          justify="space-between"
        >
          {showFilter ? (
            <ViewToggle<KindFilter>
              ariaLabel="Show conversations"
              value={kindFilter}
              onChange={(kind) =>
                router.replace(kindHref(kind), { scroll: false })
              }
              hrefFor={kindHref}
              items={[
                { value: "all", label: "All" },
                { value: "people", label: "People" },
                { value: "workshop", label: "Workshop" },
              ]}
            />
          ) : (
            <Box />
          )}
          {canCompose && (
            <Button
              size="sm"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              onClick={() => setComposing(true)}
            >
              <Plus style={{ marginRight: 4 }} /> {WRITE_TO_TEACHER_COPY.button}
            </Button>
          )}
        </HStack>
      )}
      <MessageWorkspace
        list={
          threads === undefined ? (
            <HStack justify="center" py={10}>
              <Spinner size="sm" color="violet.400" />
            </HStack>
          ) : threads.length === 0 ? (
            <EmptyState title="No messages yet." />
          ) : (
            <VStack align="stretch" gap={0}>
              {showPeople && (
                <>
                  <GroupEyebrow>People</GroupEyebrow>
                  {peopleThreads.map(row)}
                </>
              )}
              {showWorkshop && (
                <>
                  <GroupEyebrow>Workshop</GroupEyebrow>
                  {workshopThreads.map(row)}
                </>
              )}
              {showAbout && (
                <>
                  <GroupEyebrow>{MESSAGE_ABOUT_COPY.listHeading}</GroupEyebrow>
                  {aboutThreads.map(row)}
                </>
              )}
            </VStack>
          )
        }
        detail={
          openId ? (
            <MessageThreadPane threadId={openId} conversation="scholar" />
          ) : (
            <Flex h="full" align="center" justify="center" px={6}>
              <Box>
                <EmptyState title="Pick a conversation to read it." />
              </Box>
            </Flex>
          )
        }
      />
      {composing && (
        <WriteToTeacherDialog
          onClose={() => setComposing(false)}
          onSent={(threadId) => {
            setComposing(false);
            // Open it in the People list, whatever filter was showing.
            const params = new URLSearchParams(searchParams.toString());
            params.delete("kind");
            params.set("thread", threadId);
            router.replace(`${pathname}?${params.toString()}`, { scroll: false });
          }}
        />
      )}
    </Flex>
  );
}
