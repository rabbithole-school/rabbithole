"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Box, Flex, HStack, Heading, Spinner, VStack } from "@chakra-ui/react";
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

type ScholarThreadSummary = FunctionReturnType<
  typeof api.scholarMessages.listThreads
>["threads"][number];

type KindFilter = "all" | "mentor" | "workshop";

function kindFilterFrom(value: string | null): KindFilter {
  return value === "mentor" || value === "workshop" ? value : "all";
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
 * The scholar's Messages: mentor threads first (they're about the kid's own
 * work), then Workshop idea threads, in the shared messaging workspace. There
 * is no "new message" control — an adult opens every mentor thread, and ideas
 * are still filed from the Workshop. `?kind=workshop` is the Workshop's way in;
 * `?thread=` deep-links a conversation.
 */
export function ScholarMessages() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const result = useQuery(api.scholarMessages.listThreads, {});
  const threads = result?.threads;
  const kindFilter = kindFilterFrom(searchParams.get("kind"));
  const requestedThreadId = searchParams.get("thread");
  const openId =
    threads?.find((thread) => thread._id === requestedThreadId)?._id ?? null;
  const threadHref = (threadId: Id<"parentThreads"> | null) =>
    messageThreadHref(pathname, searchParams, threadId);

  const mentorThreads = (threads ?? []).filter((t) => t.kind === "mentor");
  const workshopThreads = (threads ?? []).filter((t) => t.kind === "workshop");
  // The filter only earns its place when there are two kinds to tell apart.
  const showFilter = mentorThreads.length > 0 && workshopThreads.length > 0;
  const kindHref = (kind: KindFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (kind === "all") params.delete("kind");
    else params.set("kind", kind);
    const query = params.toString();
    return `${pathname}${query ? `?${query}` : ""}`;
  };

  const row = (thread: ScholarThreadSummary) => (
    <MessageConversationRow
      key={thread._id}
      active={thread._id === openId}
      unread={thread.unread}
      leading={
        thread.kind === "mentor" ? (
          <Avatar
            name={thread.title}
            src={thread.staffParticipants[0]?.image ?? undefined}
            size="xs"
            colorKey={thread.staffParticipants[0]?._id ?? thread._id}
          />
        ) : undefined
      }
      primary={
        thread.kind === "workshop"
          ? thread.suggestionTitle ?? thread.topic ?? thread.title
          : thread.title
      }
      preview={threadPreview(
        thread.lastMessagePreview,
        thread.lastMessageAuthorName,
      )}
      timestamp={formatRelative(thread.lastMessageAt)}
      href={threadHref(thread._id)}
    />
  );

  // With only one kind there's no filter control, so a stale `?kind=` (an
  // old link, or the other kind's threads went away) must not blank the list.
  const activeFilter: KindFilter = showFilter ? kindFilter : "all";
  const showMentors = activeFilter !== "workshop" && mentorThreads.length > 0;
  const showWorkshop = activeFilter !== "mentor" && workshopThreads.length > 0;

  return (
    <Flex h="full" minH={0} direction="column">
      {showFilter && (
        <HStack
          px={4}
          py={2}
          bg="white"
          borderBottomWidth="1px"
          borderColor="gray.200"
          flexShrink={0}
        >
          <ViewToggle<KindFilter>
            ariaLabel="Show conversations"
            value={kindFilter}
            onChange={(kind) =>
              router.replace(kindHref(kind), { scroll: false })
            }
            hrefFor={kindHref}
            items={[
              { value: "all", label: "All" },
              { value: "mentor", label: "Mentors" },
              { value: "workshop", label: "Workshop" },
            ]}
          />
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
              {showMentors && (
                <>
                  <GroupEyebrow>Mentors</GroupEyebrow>
                  {mentorThreads.map(row)}
                </>
              )}
              {showWorkshop && (
                <>
                  <GroupEyebrow>Workshop</GroupEyebrow>
                  {workshopThreads.map(row)}
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
    </Flex>
  );
}
