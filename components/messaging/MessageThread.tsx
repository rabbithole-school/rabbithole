"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Button, HStack, Spinner, Text, Textarea, VStack } from "@chakra-ui/react";
import { PaperPlaneRight } from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import { useNow } from "@/hooks/useNow";
import { usePageVisible } from "@/hooks/usePageVisible";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import { GuardianFacepile } from "./GuardianFacepile";
import { AddStaffToThread } from "./IncludeStaff";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { staffWithLine } from "./staffWithLine";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { MessageRow, type MessageRowActions } from "./MessageRow";
import {
  MessageAttachmentPicker,
  useFamilyMessageAttachments,
} from "./MessageAttachmentPicker";
import { pasteKeepingLinks } from "./pasteKeepingLinks";

/**
 * Shared thread views. ONE layout, row, body and composer render every kind
 * of conversation; only the data source differs:
 *
 *  - `MessageThread` — a family (teacher↔parent) thread, used by BOTH the
 *    parent portal and the teacher Messages panel. `surface` is explicit
 *    because staff can also be guardians: /parent must act as the parent
 *    participant, while /teacher stays staff.
 *  - `ScholarMessageThread` — a mentor or Workshop thread (scholar↔staff),
 *    used by /scholar/messages and the staff inbox. The server derives the
 *    viewer from the caller.
 *
 * Both mark the thread read on open.
 */
type ThreadSurface = "parent" | "staff";

type AttachmentIds = Id<"parentMessageAttachments">[];

function hasPortfolioScholarId(
  value: unknown,
): value is { scholarId: Id<"users"> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "scholarId" in value &&
    typeof value.scholarId === "string"
  );
}

function ThreadLoading() {
  return (
    <HStack justify="center" py={10}>
      <Spinner size="sm" color="violet.400" />
    </HStack>
  );
}

function ThreadGone() {
  return (
    <Text fontFamily="body" color="charcoal.300" p={4}>
      This conversation is no longer available.
    </Text>
  );
}

function ThreadHeader({ children }: { children: ReactNode }) {
  return (
    <HStack
      gap={2}
      px={4}
      pt={4}
      pb={3}
      borderBottomWidth="1px"
      borderColor="gray.100"
      minW={0}
    >
      {children}
    </HStack>
  );
}

/** Header + scrolling message column + composer. Scrolls the message column
 *  (only it) to the newest message as the count grows. */
function ThreadLayout({
  header,
  caption,
  messageCount,
  children,
  composer,
}: {
  header?: ReactNode;
  caption?: string | null;
  messageCount: number;
  children: ReactNode;
  composer: ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Not `scrollIntoView`: that also scrolls every ancestor — overflow:
    // hidden ones included — and dragged the whole page up whenever the page
    // had any stray overflow.
    const scroller = scrollerRef.current;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [messageCount]);

  return (
    <VStack align="stretch" gap={0} h="100%">
      {header}
      {/* The open door, stated as a fact in the same quiet register as the
          tutor's "Your teacher can read this" line — never a warning. Pinned
          outside the transcript: a thread opens scrolled to the newest
          message, so a caption at the top of the scroll would never be seen. */}
      {caption && (
        <Text
          fontSize="xs"
          color="fg.muted"
          textAlign="center"
          fontFamily="heading"
          px={4}
          pt={2}
        >
          {caption}
        </Text>
      )}
      <VStack
        ref={scrollerRef}
        align="stretch"
        gap={3}
        flex={1}
        overflowY="auto"
        px={4}
        py={3}
      >
        {messageCount === 0 && (
          <Text fontFamily="body" fontSize="sm" color="charcoal.300" textAlign="center" py={8}>
            No messages yet.
          </Text>
        )}
        {children}
      </VStack>
      {composer}
    </VStack>
  );
}

function MessageComposer({
  send,
  placeholder = "Write a message…",
  portfolioScholarId,
}: {
  send: (body: string, attachmentIds: AttachmentIds) => Promise<unknown>;
  placeholder?: string;
  portfolioScholarId?: Id<"users">;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const attachmentState = useFamilyMessageAttachments();

  const submit = async () => {
    const body = draft.trim();
    if (
      (!body && attachmentState.attachmentIds.length === 0) ||
      busy ||
      attachmentState.uploading
    ) {
      return;
    }
    setBusy(true);
    const submitted = draft;
    try {
      await send(body, attachmentState.attachmentIds);
      // Clear only what was sent: anything typed while the send was in flight
      // stays in the box. (The attachment picker is disabled while busy, so
      // every staged attachment went with this send.)
      setDraft((current) =>
        current.startsWith(submitted)
          ? current.slice(submitted.length).trimStart()
          : current,
      );
      attachmentState.clearClaimed();
    } catch (e) {
      console.error("reply failed", e);
      toaster.create({
        title: "Couldn't send that",
        description: serverErrorMessage(e, "Please try again."),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box px={4} pt={2} pb={4} borderTopWidth="1px" borderColor="gray.100">
      <MessageAttachmentPicker
        attachments={attachmentState.attachments}
        uploading={attachmentState.uploading}
        error={attachmentState.error}
        disabled={busy}
        onAddFiles={attachmentState.addFiles}
        portfolioScholarId={portfolioScholarId}
        onAddPortfolioItem={
          portfolioScholarId
            ? (item) =>
                void attachmentState.addPortfolioItem(
                  item._id,
                  portfolioScholarId,
                )
            : undefined
        }
        onRemove={attachmentState.remove}
      >
        <Textarea
          flex={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => pasteKeepingLinks(e, setDraft)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={1}
          resize="none"
          fontFamily="body"
          fontSize="sm"
          bg="gray.50"
          maxH="120px"
        />
        <Button
          aria-label="Send message"
          onClick={submit}
          disabled={
            busy ||
            attachmentState.uploading ||
            (!draft.trim() && attachmentState.attachmentIds.length === 0)
          }
          loading={busy}
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          px={4}
        >
          <PaperPlaneRight weight="fill" />
        </Button>
      </MessageAttachmentPicker>
    </Box>
  );
}

export function MessageThread({
  threadId,
  surface,
}: {
  threadId: Id<"parentThreads">;
  surface?: ThreadSurface;
}) {
  const viewerId = useCurrentUser().user?._id;
  const thread = useQuery(
    api.parentMessages.getThread,
    surface ? { threadId, as: surface } : { threadId },
  );
  const threadAttachments = useQuery(
    api.parentMessages.getThreadAttachments,
    surface ? { threadId, as: surface } : { threadId },
  );
  const reply = useMutation(api.parentMessages.replyInThread);
  const markRead = useMutation(api.parentMessages.markThreadRead);
  const editMessage = useMutation(api.parentMessages.editMessage);
  const retractMessage = useMutation(api.parentMessages.retractMessage);
  const retractAttachment = useMutation(api.parentMessages.retractAttachment);
  const actions = useMemo<MessageRowActions>(() => {
    const asArg = surface ? { as: surface } : {};
    return {
      edit: (messageId, body) => editMessage({ messageId, body, ...asArg }),
      retract: (messageId) => retractMessage({ messageId, ...asArg }),
      retractAttachment: (attachmentId) =>
        retractAttachment({ attachmentId, ...asArg }),
    };
  }, [surface, editMessage, retractMessage, retractAttachment]);

  // One clock per thread: hides Edit/Withdraw once the window passes.
  const now = useNow(30_000);
  const msgCount = thread?.messages.length ?? 0;

  useEffect(() => {
    markRead(surface ? { threadId, as: surface } : { threadId }).catch(() => {});
  }, [threadId, surface, markRead, msgCount]);

  if (thread === undefined) return <ThreadLoading />;
  if (thread === null) return <ThreadGone />;

  const portfolioScholarId =
    surface === "staff" &&
    thread.viewer === "teacher" &&
    hasPortfolioScholarId(thread)
      ? thread.scholarId
      : undefined;

  return (
    <ThreadLayout
      messageCount={thread.messages.length}
      header={
        surface === "staff" ? (
          <ThreadHeader>
            {thread.viewer === "teacher" && (
              <GuardianFacepile
                // `?? []`: a web build can go live before its backend.
                guardians={[...thread.guardians, ...(thread.staff ?? [])]}
                viewerId={viewerId}
              />
            )}
            <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm" truncate>
              {thread.parentName}
            </Text>
            {thread.scholarName && (
              <Text fontFamily="body" color="charcoal.400" fontSize="xs" truncate>
                about {thread.scholarName}
              </Text>
            )}
          </ThreadHeader>
        ) : undefined
      }
      composer={
        <MessageComposer
          portfolioScholarId={portfolioScholarId}
          send={(body, attachmentIds) =>
            reply({
              threadId,
              body,
              attachmentIds,
              ...(surface ? { as: surface } : {}),
            })
          }
        />
      }
    >
      {thread.messages.map((m) => {
        // Each side reads as one voice: the family side on a guardian's
        // right, the whole staff side on staff's right (any staffer may write
        // here). Only the viewer's OWN words on their own side go unnamed —
        // another staffer or a co-guardian is named, as on scholar threads,
        // and so is a staff-guardian's note from their other role.
        const viewerSide =
          (thread.viewer === "parent" && m.authorType === "parent") ||
          (thread.viewer === "teacher" && m.authorType === "teacher");
        const ownWords = viewerSide && m.mine;
        return (
          <MessageRow
            key={m._id}
            message={m}
            mine={viewerSide}
            authorLabel={ownWords ? null : m.authorName}
            tombstoneLabel={ownWords ? "You" : m.authorName}
            attachments={
              threadAttachments?.filter(
                (attachment) => attachment.messageId === m._id,
              ) ?? []
            }
            actions={actions}
            surface={surface}
            now={now}
          />
        );
      })}
    </ThreadLayout>
  );
}

/**
 * A mentor or Workshop conversation. The scholar sees the counterpart and the
 * open-door caption; staff see the scholar plus the named staff side. Every
 * staff bubble carries its author's own name — a kid should know which human
 * answered.
 */
export function ScholarMessageThread({
  threadId,
}: {
  threadId: Id<"parentThreads">;
}) {
  const thread = useQuery(api.scholarMessages.getThread, { threadId });
  const viewerId = useCurrentUser().user?._id;
  const threadAttachments = useQuery(api.scholarMessages.getThreadAttachments, {
    threadId,
  });
  const reply = useMutation(api.scholarMessages.reply);
  const markRead = useMutation(api.scholarMessages.markRead);
  const editMessage = useMutation(api.scholarMessages.editMessage);
  const retractMessage = useMutation(api.scholarMessages.retractMessage);
  const retractAttachment = useMutation(api.scholarMessages.retractAttachment);
  const actions = useMemo<MessageRowActions>(
    () => ({
      edit: (messageId, body) => editMessage({ messageId, body }),
      retract: (messageId) => retractMessage({ messageId }),
      retractAttachment: (attachmentId) => retractAttachment({ attachmentId }),
    }),
    [editMessage, retractMessage, retractAttachment],
  );

  const now = useNow(30_000);
  const msgCount = thread?.messages.length ?? 0;
  const pageVisible = usePageVisible();

  // Read means SEEN: a message landing in a background tab stays unread until
  // the tab is back on screen, then this marks it.
  useEffect(() => {
    if (!pageVisible) return;
    markRead({ threadId }).catch(() => {});
  }, [threadId, markRead, msgCount, pageVisible]);

  if (thread === undefined) return <ThreadLoading />;
  if (thread === null) return <ThreadGone />;

  const subject =
    thread.kind === "workshop" ? thread.suggestion?.title ?? null : null;
  const withLine = staffWithLine(thread.staffParticipants, viewerId);

  const header =
    thread.viewer === "scholar" ? (
      <ThreadHeader>
        <Avatar
          name={thread.title}
          src={
            thread.kind === "mentor"
              ? thread.staffParticipants[0]?.image ?? undefined
              : undefined
          }
          size="xs"
          colorKey={thread.staffParticipants[0]?._id ?? thread._id}
        />
        <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm" truncate>
          {thread.title}
        </Text>
        {subject && (
          <Text fontFamily="body" color="charcoal.400" fontSize="xs" truncate>
            {subject}
          </Text>
        )}
      </ThreadHeader>
    ) : (
      <ThreadHeader>
        <GuardianFacepile
          guardians={[
            { _id: thread.scholarId, name: thread.scholarName },
            ...thread.staffParticipants,
          ]}
          viewerId={viewerId}
        />
        <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm" truncate>
          {thread.scholarName}
        </Text>
        <Text fontFamily="body" color="charcoal.400" fontSize="xs" truncate>
          {thread.kind === "mentor"
            ? withLine ?? "Conversation"
            : subject
              ? `Workshop · ${subject}`
              : "Workshop"}
        </Text>
        {thread.kind === "mentor" && thread.canReply && (
          // A failure in the add-people picker must never take down the thread.
          <ErrorBoundary fallback={null}>
          <AddStaffToThread
            threadId={thread._id}
            scholarId={thread.scholarId}
            excludeIds={
              new Set([
                ...thread.staffParticipants.map((p) => p._id),
                ...(viewerId ? [viewerId] : []),
              ])
            }
          />
          </ErrorBoundary>
        )}
      </ThreadHeader>
    );

  return (
    <ThreadLayout
      header={header}
      caption={thread.openDoorCaption}
      messageCount={thread.messages.length}
      composer={
        thread.canReply ? (
          <MessageComposer
            placeholder={
              thread.viewer === "scholar" ? "Write a reply…" : "Write a message…"
            }
            send={(body, attachmentIds) =>
              reply({ threadId, body, attachmentIds })
            }
          />
        ) : (
          <Text
            fontFamily="body"
            fontSize="xs"
            color="charcoal.400"
            textAlign="center"
            px={4}
            py={3}
            borderTopWidth="1px"
            borderColor="gray.100"
          >
            Replies are closed for this conversation.
          </Text>
        )
      }
    >
      {thread.messages.map((m) => (
        <MessageRow
          key={m._id}
          message={m}
          // Each side reads as one voice: the scholar's bubbles sit on the
          // scholar's right, the whole staff side on staff's right.
          mine={
            thread.viewer === "scholar"
              ? m.authorType === "scholar"
              : m.authorType === "teacher"
          }
          authorLabel={m.mine ? null : m.authorName}
          tombstoneLabel={m.mine ? "You" : m.authorName}
          attachments={
            threadAttachments?.filter(
              (attachment) => attachment.messageId === m._id,
            ) ?? []
          }
          actions={actions}
          now={now}
        />
      ))}
    </ThreadLayout>
  );
}
