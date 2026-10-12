"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import {
  ChatCircle,
  PaperPlaneTilt,
  Plus,
  Copy,
  Check,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { formatRelative } from "@/lib/relativeTime";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScholarPicker } from "@/components/ScholarPicker";
import { GuardianFacepile } from "@/components/messaging/GuardianFacepile";
import {
  MessageConversationRow,
  MessageThreadPane,
  MessageWorkspace,
  threadPreview,
} from "@/components/messaging/MessageWorkspace";
import { staffWithLine } from "@/components/messaging/staffWithLine";
import {
  IncludeStaffPills,
  toggleInSet,
} from "@/components/messaging/IncludeStaff";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  MessageAttachmentPicker,
  useFamilyMessageAttachments,
} from "@/components/messaging/MessageAttachmentPicker";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { messageThreadHref } from "@/lib/messageThreadUrl";
import {
  DEFAULT_SCHOLAR_PARTICIPATION,
  type ScholarParticipationSelection,
} from "@/components/ScholarParticipationFilter";
import { pasteKeepingLinks } from "@/components/messaging/pasteKeepingLinks";

/** Format one guardian as an email "To"-field recipient: `"Name" <email>`. */
function toRecipient(p: { name: string; email: string | null }): string | null {
  if (!p.email) return null;
  return p.name ? `"${p.name}" <${p.email}>` : p.email;
}

type InboxKind = "families" | "scholars" | "workshop";
type InboxScope = "all" | "unread" | "mine";

const INBOX_KIND_LABELS: Record<InboxKind, string> = {
  families: "Families",
  scholars: "Scholars",
  workshop: "Workshop",
};

/** The conversation kind each scholar-side inbox lists. */
const SCHOLAR_THREAD_KIND = {
  scholars: "mentor",
  workshop: "workshop",
} as const;

function inboxKindFrom(value: string | null): InboxKind | null {
  return value === "families" || value === "scholars" || value === "workshop"
    ? value
    : null;
}

/**
 * Teacher Messages — the ONE staff inbox: a two-pane workspace (thread list ·
 * open thread) over three kinds of conversation, switched by a kind toggle
 * that shows only the kinds the caller may see (`scholarMessages.staffAccess`):
 *
 *  - Families — teacher↔guardian threads: compose targets a scholar's
 *    guardians (or several scholars for a broadcast). A broadcast explodes
 *    per-parent (leak-safe) server-side.
 *  - Scholars — mentor threads. "Message scholars" fans out into one thread
 *    per scholar, never a group chat.
 *  - Workshop — a scholar's ideas and bug reports, plus conversations the team
 *    starts.
 *
 * Every kind opens on "Mine": the conversations the viewer is part of, plus
 * any no one on staff has picked up yet (server-side, per kind). A
 * mentor-only staffer sees Scholars alone. Staff see the roster in their
 * active institution context.
 */
export function TeacherMessages() {
  const viewerId = useCurrentUser().user?._id;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [scopeChoice, setScopeChoice] = useState<
    Partial<Record<InboxKind, InboxScope>>
  >({});
  // Two lenses. Family threads follow the generic institution lens
  // (`scopeParam`). Scholar messaging has its OWN lens on the server
  // (teaching schools ∪ live mentor-grant schools), so it gets the REQUESTED
  // `?inst=` verbatim: the generic resolver doesn't know mentor standing and
  // would silently turn a mentor-only school back into the teacher's own.
  // "" (no `?inst=`) is the caller's home school; only "all" means every
  // school — never collapse "" to undefined, which the server reads as all.
  const { scopeParam, requestedScope } = useActiveInstitution();
  const messagingScope = requestedScope;
  const access = useQuery(api.scholarMessages.staffAccess, {
    institutionScope: messagingScope,
  });
  const allowedKinds: InboxKind[] = access
    ? [
        ...(access.family ? (["families"] as const) : []),
        ...(access.mentor ? (["scholars"] as const) : []),
        ...(access.workshop ? (["workshop"] as const) : []),
      ]
    : [];
  const mentorOnly = access?.mentorOnly === true;

  // `?thread=` is resolved on its own, never through the filtered list, so a
  // filter change can't unmount an open conversation (and its draft), and a
  // deep link lands on whichever kind actually holds the thread. The scholar
  // read returns null for anything that isn't a scholar thread the caller can
  // reach (the family read would throw instead). Same args as the open pane's
  // own query, so Convex serves both from one subscription.
  const requestedThreadId = searchParams.get("thread");
  const threadIdLooksValid =
    !!requestedThreadId && /^[0-9a-z]{20,40}$/.test(requestedThreadId);
  const requestedScholarThread = useQuery(
    api.scholarMessages.getThread,
    threadIdLooksValid && (access?.mentor || access?.workshop)
      ? { threadId: requestedThreadId as Id<"parentThreads"> }
      : "skip",
  );
  const deepLinkKind: InboxKind | null = requestedScholarThread
    ? requestedScholarThread.kind === "mentor"
      ? "scholars"
      : "workshop"
    : null;
  const requestedKind = inboxKindFrom(searchParams.get("kind"));
  const kind: InboxKind | null =
    deepLinkKind && allowedKinds.includes(deepLinkKind)
      ? deepLinkKind
      : requestedKind && allowedKinds.includes(requestedKind)
        ? requestedKind
        : (allowedKinds[0] ?? null);

  // Every kind opens on "Mine", for everyone. A mentor only ever sees
  // threads they're named on, so for them All is Mine and "Mine" isn't
  // offered.
  const defaultScope: InboxScope = mentorOnly ? "all" : "mine";
  const chosenScope = (kind && scopeChoice[kind]) ?? defaultScope;
  const effectiveScope: InboxScope =
    (kind === "families" && chosenScope === "unread") ||
    (mentorOnly && chosenScope === "mine")
      ? "all"
      : chosenScope;
  const setScope = (next: InboxScope) => {
    if (kind) setScopeChoice((current) => ({ ...current, [kind]: next }));
  };
  const scopeItems: { value: InboxScope; label: string }[] = [
    { value: "all", label: "All" },
    ...(kind === "families"
      ? []
      : [{ value: "unread" as const, label: "Unread" }]),
    ...(mentorOnly ? [] : [{ value: "mine" as const, label: "Mine" }]),
  ];

  const familyThreads = useQuery(
    api.parentMessages.listMyThreads,
    kind === "families"
      ? {
          scope: effectiveScope === "mine" ? "mine" : "all",
          institutionScope: scopeParam,
        }
      : "skip",
  );
  const scholarThreadsResult = useQuery(
    api.scholarMessages.listThreads,
    kind === "scholars" || kind === "workshop"
      ? {
          kind: SCHOLAR_THREAD_KIND[kind],
          filter: effectiveScope,
          institutionScope: messagingScope,
        }
      : "skip",
  );
  const scholarThreads = scholarThreadsResult?.threads;
  const [composing, setComposing] = useState<InboxKind | null>(null);
  // Family threads can only be confirmed through a list (their read throws on
  // a thread the caller can't reach), so remember every family id a list has
  // shown: an open family thread then survives a filter that drops its row.
  const [seenFamilyIds, setSeenFamilyIds] = useState<Set<string>>(
    () => new Set(),
  );
  if (
    familyThreads?.some((thread) => !seenFamilyIds.has(thread._id))
  ) {
    setSeenFamilyIds(
      new Set([...seenFamilyIds, ...familyThreads.map((thread) => thread._id)]),
    );
  }
  // A family thread reached by link (a reload, a shared URL, the Slack
  // mirror) that isn't in Mine opens under All rather than not at all: only
  // a list can vouch for a family thread. Waits until the link is known not
  // to be a scholar thread, and never overrides a filter the viewer picked.
  const linkMayBeFamily =
    !(access?.mentor || access?.workshop) || requestedScholarThread === null;
  if (
    kind === "families" &&
    threadIdLooksValid &&
    linkMayBeFamily &&
    effectiveScope === "mine" &&
    scopeChoice.families === undefined &&
    familyThreads !== undefined &&
    !familyThreads.some((thread) => thread._id === requestedThreadId) &&
    !seenFamilyIds.has(requestedThreadId)
  ) {
    setScopeChoice((current) => ({ ...current, families: "all" }));
  }
  const openId: Id<"parentThreads"> | null =
    kind === "families"
      ? requestedThreadId && seenFamilyIds.has(requestedThreadId)
        ? (requestedThreadId as Id<"parentThreads">)
        : null
      : requestedScholarThread && deepLinkKind === kind
        ? requestedScholarThread._id
        : null;
  const threadHref = (threadId: Id<"parentThreads"> | null) =>
    messageThreadHref(pathname, searchParams, threadId);
  const openThread = (threadId: Id<"parentThreads"> | null) => {
    router.replace(threadHref(threadId), { scroll: false });
  };
  const kindHref = (next: InboxKind) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("kind", next);
    params.delete("thread");
    return `${pathname}?${params.toString()}`;
  };
  const openKindThread = (
    next: InboxKind,
    threadId: Id<"parentThreads"> | null,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("kind", next);
    if (threadId) params.set("thread", threadId);
    else params.delete("thread");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const composeLabel =
    kind === "scholars"
      ? "Message scholars"
      : kind === "workshop"
        ? "New Workshop message"
        : "New message";
  const startCompose = () => {
    if (kind) setComposing(kind);
  };

  let list: React.ReactNode;
  if (access !== undefined && kind === null) {
    list = (
      <EmptyState icon={<ChatCircle weight="duotone" />} title="No conversations yet" />
    );
  } else if (
    access === undefined ||
    (kind === "families" ? familyThreads : scholarThreads) === undefined
  ) {
    list = (
      <HStack justify="center" py={10}>
        <Spinner size="sm" color="violet.400" />
      </HStack>
    );
  } else if (kind === "families" && familyThreads) {
    list =
      familyThreads.length === 0 ? (
        <EmptyState
          icon={<ChatCircle weight="duotone" />}
          title={
            effectiveScope === "mine"
              ? "No conversations of yours yet"
              : "No conversations yet"
          }
          hint={
            effectiveScope === "mine"
              ? "Threads you're part of show here, plus notes to the school team that no one has answered yet. All shows every family conversation at your school."
              : "Start one with a family."
          }
          cta={{
            label: "New message",
            icon: <Plus size={14} />,
            onClick: startCompose,
          }}
        />
      ) : (
        <VStack align="stretch" gap={0}>
          {familyThreads.map((t) => {
            const active = t._id === openId;
            return (
              <MessageConversationRow
                key={t._id}
                active={active}
                unread={t.hasUnread}
                leading={
                  t.viewer === "teacher" ? (
                    <GuardianFacepile
                      // `?? []`: a web build can go live before its backend.
                      guardians={[...t.guardians, ...(t.staff ?? [])]}
                      viewerId={viewerId}
                    />
                  ) : undefined
                }
                primary={t.parentName}
                secondary={
                  t.scholarName ? `about ${t.scholarName}` : undefined
                }
                preview={threadPreview(t.lastPreview, t.lastMessageAuthorName)}
                timestamp={formatRelative(t.lastMessageAt)}
                href={threadHref(t._id)}
              />
            );
          })}
        </VStack>
      );
  } else if (scholarThreads && scholarThreads.length > 0) {
    list = (
      <VStack align="stretch" gap={0}>
        {scholarThreads.map((t) => {
          const withLine = staffWithLine(t.staffParticipants, viewerId);
          return (
            <MessageConversationRow
              key={t._id}
              active={t._id === openId}
              unread={t.unread}
              leading={
                <GuardianFacepile
                  guardians={[
                    { _id: t.scholarId, name: t.scholarName },
                    ...t.staffParticipants,
                  ]}
                  viewerId={viewerId}
                />
              }
              primary={t.scholarName}
              secondary={
                t.kind === "workshop"
                  ? (t.suggestionTitle ?? t.topic)
                  : withLine
              }
              preview={threadPreview(
                t.lastMessagePreview,
                t.lastMessageAuthorName,
              )}
              timestamp={formatRelative(t.lastMessageAt)}
              href={threadHref(t._id)}
            />
          );
        })}
      </VStack>
    );
  } else if (effectiveScope === "unread") {
    list = (
      <EmptyState
        icon={<ChatCircle weight="duotone" />}
        title="You're all caught up"
      />
    );
  } else if (effectiveScope === "mine") {
    list = (
      <EmptyState
        icon={<ChatCircle weight="duotone" />}
        title="No conversations of yours yet"
        hint={
          kind === "scholars"
            ? "Threads you're named on show here. All shows every scholar conversation at your school."
            : "Threads you're part of show here, plus new ideas no one has answered yet. All shows every Workshop conversation."
        }
        cta={{
          label: composeLabel,
          icon: <Plus size={14} />,
          onClick: startCompose,
        }}
      />
    );
  } else if (kind === "scholars") {
    list = (
      <EmptyState
        icon={<ChatCircle weight="duotone" />}
        title="No scholar conversations yet"
        hint="Each scholar you message gets their own conversation."
        cta={{
          label: "Message scholars",
          icon: <Plus size={14} />,
          onClick: startCompose,
        }}
      />
    );
  } else {
    list = (
      <EmptyState
        icon={<ChatCircle weight="duotone" />}
        title="No Workshop conversations yet"
        hint="Ideas and bug reports scholars send land here."
        cta={{
          label: "New Workshop message",
          icon: <Plus size={14} />,
          onClick: startCompose,
        }}
      />
    );
  }

  return (
    <Box h="100%" display="flex" flexDirection="column" overflow="hidden">
      <HStack
        justify="space-between"
        px={4}
        py={2}
        borderBottom="1px solid"
        borderColor="gray.200"
        bg="white"
        flexShrink={0}
        gap={3}
        flexWrap="wrap"
      >
        <HStack gap={3} flexWrap="wrap">
          {kind && allowedKinds.length > 1 && (
            <ViewToggle<InboxKind>
              ariaLabel="Conversation kind"
              value={kind}
              onChange={(next) =>
                router.replace(kindHref(next), { scroll: false })
              }
              hrefFor={kindHref}
              items={allowedKinds.map((value) => ({
                value,
                label: INBOX_KIND_LABELS[value],
              }))}
            />
          )}
          {kind && (
            <ViewToggle<InboxScope>
              ariaLabel="Message scope"
              value={effectiveScope}
              onChange={setScope}
              items={scopeItems}
            />
          )}
        </HStack>
        {kind && (
          <Button
            size="sm"
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            onClick={startCompose}
          >
            <Plus style={{ marginRight: 4 }} /> {composeLabel}
          </Button>
        )}
      </HStack>

      <MessageWorkspace
        list={list}
        detail={
          openId ? (
            kind === "families" ? (
              <MessageThreadPane threadId={openId} surface="staff" />
            ) : (
              <MessageThreadPane threadId={openId} conversation="scholar" />
            )
          ) : (
            <Flex h="full" align="center" justify="center" px={6}>
              <EmptyState title="Select a conversation, or start a new message." />
            </Flex>
          )}
      />

      {composing === "families" && (
        <ComposeDialog
          onClose={() => setComposing(null)}
          onSent={(id) => {
            setComposing(null);
            openThread(id);
          }}
        />
      )}
      {composing === "scholars" && (
        <MessageScholarsDialog
          institutionScope={messagingScope}
          onClose={() => setComposing(null)}
          onSent={(id) => {
            setComposing(null);
            openKindThread("scholars", id);
          }}
        />
      )}
      {composing === "workshop" && (
        <WorkshopComposeDialog
          institutionScope={messagingScope}
          onClose={() => setComposing(null)}
          onSent={(id) => {
            setComposing(null);
            openKindThread("workshop", id);
          }}
        />
      )}
    </Box>
  );
}

function ComposeDialog({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (threadId: Id<"parentThreads"> | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [participation, setParticipation] =
    useState<ScholarParticipationSelection>(
      DEFAULT_SCHOLAR_PARTICIPATION,
    );
  const includeProgramGuests = participation.extendedEducation;
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attachmentState = useFamilyMessageAttachments();
  const updateParticipation = (next: ScholarParticipationSelection) => {
    if (includeProgramGuests && !next.extendedEducation) {
      setSelected(new Set());
    }
    setParticipation(next);
  };

  const scholarIds = useMemo(
    () => Array.from(selected) as Id<"users">[],
    [selected],
  );
  const preview = useQuery(
    api.parentMessages.resolveRecipients,
    scholarIds.length > 0
      ? { scholarIds, includeProgramGuests }
      : "skip",
  );
  const send = useMutation(api.parentMessages.sendMessage);

  const submit = async () => {
    if (
      scholarIds.length === 0 ||
      (!body.trim() && attachmentState.attachmentIds.length === 0) ||
      busy ||
      attachmentState.uploading
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await send({
        scholarIds,
        includeProgramGuests,
        body: body.trim(),
        attachmentIds: attachmentState.attachmentIds,
      });
      attachmentState.clearClaimed();
      // A single scholar produces one shared family thread, even with multiple
      // guardians.
      onSent(res.threadIds.length === 1 ? res.threadIds[0] : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    void attachmentState.discardAll();
    onClose();
  };

  const recipientCount = preview?.parents.length ?? 0;
  // Email-client-ready recipients (`"Name" <email>, …`) for the Copy action —
  // a useful secondary action for staff who want their own mail client. Drops
  // guardians with no email.
  const recipients = useMemo(
    () =>
      (preview?.parents ?? [])
        .map(toRecipient)
        .filter((r): r is string => r !== null),
    [preview],
  );
  const [copied, setCopied] = useState(false);
  const copyEmails = async () => {
    if (recipients.length === 0) return;
    try {
      await navigator.clipboard.writeText(recipients.join(", "));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // insecure context / no permission — values are still visible on screen.
    }
  };

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) close(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="2xl">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                New message to families
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack align="stretch" gap={4}>
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={2} fontFamily="heading">
                    Recipients — the guardians of these scholars
                  </Text>
                  <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2}>
                    <ScholarPicker
                      mode="multi"
                      selected={selected}
                      onChange={setSelected}
                      showAffinityToggle={false}
                      showParticipationFilter
                      participation={participation}
                      onParticipationChange={updateParticipation}
                      showEnrollmentStanding={includeProgramGuests}
                      maxH="180px"
                    />
                  </Box>
                  {scholarIds.length > 0 && (
                    <Text fontFamily="body" fontSize="xs" color="charcoal.400" mt={1.5}>
                      {recipientCount === 0
                        ? "No linked parents for the selected scholars yet."
                        : scholarIds.length === 1
                          ? `${recipientCount} guardian${recipientCount === 1 ? "" : "s"} will share one family thread.`
                          : `${recipientCount} guardians will receive this across ${scholarIds.length} scholar family threads.`}
                      {preview && preview.unlinkedScholarNames.length > 0 && (
                        <Text as="span" color="yellow.700">
                          {" "}
                          No parent linked for {preview.unlinkedScholarNames.join(", ")}.
                        </Text>
                      )}
                    </Text>
                  )}
                </Box>

                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Message
                  </Text>
                  <MessageAttachmentPicker
                    attachments={attachmentState.attachments}
                    uploading={attachmentState.uploading}
                    error={attachmentState.error}
                    disabled={busy}
                    onAddFiles={attachmentState.addFiles}
                    portfolioScholarId={
                      scholarIds.length === 1 ? scholarIds[0] : undefined
                    }
                    onAddPortfolioItem={
                      scholarIds.length === 1
                        ? (item) =>
                            void attachmentState.addPortfolioItem(
                              item._id,
                              scholarIds[0],
                            )
                        : undefined
                    }
                    onRemove={attachmentState.remove}
                  >
                    <Textarea
                      flex={1}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      onPaste={(e) => pasteKeepingLinks(e, setBody)}
                      placeholder="Write your message…"
                      rows={6}
                      fontFamily="body"
                      fontSize="sm"
                      bg="gray.50"
                    />
                  </MessageAttachmentPicker>
                </Box>
                {error && (
                  <Text fontSize="sm" color="red.500" fontFamily="body">
                    {error}
                  </Text>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
              <Button variant="ghost" fontFamily="heading" size="sm" color="charcoal.500" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                fontFamily="heading"
                onClick={copyEmails}
                disabled={recipients.length === 0}
                title={`Copy ${recipients.length} email recipient${recipients.length === 1 ? "" : "s"} for your mail app's "To" field`}
                variant="outline"
                borderColor="gray.200"
                color="charcoal.600"
              >
                {copied ? (
                  <Check style={{ marginRight: 6 }} />
                ) : (
                  <Copy style={{ marginRight: 6 }} />
                )}
                {copied ? "Copied!" : `Copy emails${recipients.length ? ` (${recipients.length})` : ""}`}
              </Button>
              <Button
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                size="sm"
                onClick={submit}
                disabled={
                  busy ||
                  attachmentState.uploading ||
                  recipientCount === 0 ||
                  (!body.trim() && attachmentState.attachmentIds.length === 0)
                }
                loading={busy}
              >
                <PaperPlaneTilt weight="fill" style={{ marginRight: 6 }} />
                Send{recipientCount > 1 ? ` to ${recipientCount}` : ""}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * The shared shell of the two scholar-side compose dialogs: a recipient
 * section, a note on where the message goes, and the body + attachments.
 */
function ScholarComposeDialog({
  title,
  recipients,
  note,
  canSend,
  sendLabel,
  onSend,
  onClose,
}: {
  title: string;
  recipients: React.ReactNode;
  note: string;
  canSend: boolean;
  sendLabel: string;
  onSend: (
    body: string,
    attachmentIds: Id<"parentMessageAttachments">[],
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attachmentState = useFamilyMessageAttachments();
  const hasContent =
    !!body.trim() || attachmentState.attachmentIds.length > 0;

  const submit = async () => {
    if (busy || attachmentState.uploading) return;
    if (!canSend || !hasContent) {
      setError(canSend ? "Write a message first." : "Choose who it's for first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // `onSend` resolves only once the server has created the thread(s); it
      // throws otherwise, and the draft stays exactly as it was.
      await onSend(body.trim(), attachmentState.attachmentIds);
      attachmentState.clearClaimed();
    } catch (e) {
      setError(serverErrorMessage(e, "Couldn't send this message."));
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    void attachmentState.discardAll();
    onClose();
  };

  // A draft is only ever discarded on purpose (Cancel / Escape). A stray
  // click outside the dialog — or on a popover the picker portals out of it —
  // must never throw away the recipient, message and uploads.
  const hasDraft = hasContent || canSend;

  return (
    <Dialog.Root
      open
      onOpenChange={(e) => {
        if (!e.open) close();
      }}
      closeOnInteractOutside={!hasDraft}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="2xl">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                {title}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack align="stretch" gap={4}>
                {recipients}
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Message
                  </Text>
                  <MessageAttachmentPicker
                    attachments={attachmentState.attachments}
                    uploading={attachmentState.uploading}
                    error={attachmentState.error}
                    disabled={busy}
                    onAddFiles={attachmentState.addFiles}
                    onRemove={attachmentState.remove}
                  >
                    <Textarea
                      flex={1}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      onPaste={(e) => pasteKeepingLinks(e, setBody)}
                      placeholder="Write your message…"
                      rows={6}
                      fontFamily="body"
                      fontSize="sm"
                      bg="gray.50"
                    />
                  </MessageAttachmentPicker>
                  <Text fontFamily="body" fontSize="xs" color="charcoal.400" mt={1.5}>
                    {note}
                  </Text>
                </Box>
                {error && (
                  <Text fontSize="sm" color="red.500" fontFamily="body">
                    {error}
                  </Text>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
              <Button variant="ghost" fontFamily="heading" size="sm" color="charcoal.500" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                size="sm"
                onClick={submit}
                disabled={
                  busy || attachmentState.uploading || !canSend || !hasContent
                }
                loading={busy}
              >
                <PaperPlaneTilt weight="fill" style={{ marginRight: 6 }} />
                {sendLabel}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * "Message scholars": one message, fanned out into a separate mentor thread
 * per scholar (recipients: `MessageableScholarPicker`, kind "mentor").
 */
function MessageScholarsDialog({
  institutionScope,
  onClose,
  onSent,
}: {
  institutionScope: string | undefined;
  onClose: () => void;
  onSent: (threadId: Id<"parentThreads"> | null) => void;
}) {
  const start = useMutation(api.scholarMessages.startMentorThreads);
  const [selected, setSelected] = useState<Set<Id<"users">>>(new Set());
  // Named adults to include: only people who can reach EVERY selected
  // scholar's thread (the server's rule), so the list follows the selection
  // and appears once at least one scholar is chosen.
  const selectedScholarIds = useMemo(() => [...selected], [selected]);
  const includable = useQuery(
    api.scholarMessages.listIncludableStaff,
    selectedScholarIds.length > 0
      ? { scholarIds: selectedScholarIds, institutionScope }
      : "skip",
  );
  const [staffIds, setStaffIds] = useState<Set<Id<"users">>>(new Set());
  // A pick that stops qualifying (the selection changed) silently drops out.
  const includedStaffIds = [...staffIds].filter((id) =>
    (includable ?? []).some((person) => person._id === id),
  );
  const toggle = (scholarId: Id<"users">) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(scholarId)) next.delete(scholarId);
      else next.add(scholarId);
      return next;
    });
  const setMany = (scholarIds: Id<"users">[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of scholarIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  return (
    <ScholarComposeDialog
      title="Message scholars"
      canSend={selected.size > 0}
      sendLabel={selected.size > 1 ? `Send to ${selected.size}` : "Send"}
      note={
        includedStaffIds.length > 0
          ? "Each scholar gets their own conversation with you and the people you included — never a group chat. Their teachers can read it."
          : "Each scholar gets their own conversation with you — never a group chat. Their teachers can read it."
      }
      onClose={onClose}
      onSend={async (body, attachmentIds) => {
        const { threadIds } = await start({
          scholarIds: [...selected],
          body,
          attachmentIds,
          ...(includedStaffIds.length > 0 ? { staffIds: includedStaffIds } : {}),
        });
        onSent(threadIds.length === 1 ? threadIds[0] : null);
      }}
      recipients={
        <VStack align="stretch" gap={4}>
          <MessageableScholarPicker
            kind="mentor"
            institutionScope={institutionScope}
            mode="multi"
            selected={selected}
            onToggle={toggle}
            onSetMany={setMany}
          />
          {includable && includable.length > 0 && (
            <Box>
              <Text fontSize="xs" color="charcoal.500" mb={2} fontFamily="heading">
                Include staff (optional)
              </Text>
              <IncludeStaffPills
                candidates={includable}
                selected={new Set(includedStaffIds)}
                onToggle={(id) => setStaffIds((current) => toggleInSet(current, id))}
              />
            </Box>
          )}
        </VStack>
      }
    />
  );
}

/** "New Workshop message": the Rabbithole team opens a Workshop conversation
 *  with ONE scholar about a fresh topic (its first line becomes the topic on
 *  the scholar's Workshop board). */
function WorkshopComposeDialog({
  institutionScope,
  onClose,
  onSent,
}: {
  institutionScope: string | undefined;
  onClose: () => void;
  onSent: (threadId: Id<"parentThreads">) => void;
}) {
  const start = useMutation(api.scholarMessages.startWorkshopThread);
  const [scholarId, setScholarId] = useState<Id<"users"> | null>(null);

  return (
    <ScholarComposeDialog
      title="New Workshop message"
      canSend={scholarId !== null}
      sendLabel="Send"
      note="It shows up in the scholar's Workshop. The first line becomes its title."
      onClose={onClose}
      onSend={async (body, attachmentIds) => {
        if (!scholarId) throw new Error("Choose who it's for first.");
        const { threadId } = await start({ scholarId, body, attachmentIds });
        onSent(threadId);
      }}
      recipients={
        <MessageableScholarPicker
          kind="workshop"
          institutionScope={institutionScope}
          mode="single"
          selected={scholarId ? new Set([scholarId]) : new Set()}
          onToggle={(id) =>
            setScholarId((current) => (current === id ? null : id))
          }
        />
      }
    />
  );
}

/**
 * The recipient list for both scholar compose dialogs, fed by
 * `listMessageableScholars` — exactly the scholars the server will let the
 * caller message for that `kind` (mentor: their grant or teaching schools;
 * Workshop: their teaching schools) in the requested scope. The roster-backed
 * ScholarPicker can't serve here: it would offer scholars the send then
 * refuses, and a mentor-only staffer has no roster access at all.
 */
function MessageableScholarPicker({
  kind,
  institutionScope,
  mode,
  selected,
  onToggle,
  onSetMany,
}: {
  kind: "mentor" | "workshop";
  institutionScope: string | undefined;
  mode: "single" | "multi";
  selected: ReadonlySet<Id<"users">>;
  onToggle: (scholarId: Id<"users">) => void;
  /** Multi mode: select or clear every scholar currently shown. */
  onSetMany?: (scholarIds: Id<"users">[], on: boolean) => void;
}) {
  // `institutionName` arrives only when the caller can message scholars at
  // more than one school — then each row says which school it's at.
  const scholars = useQuery(api.scholarMessages.listMessageableScholars, {
    kind,
    institutionScope,
  });
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (scholars ?? []).filter(
      (scholar) => !needle || scholar.name.toLowerCase().includes(needle),
    );
  }, [scholars, query]);
  // "Select all" acts on what the search currently shows, so filtering first
  // and then selecting all does the obvious thing.
  const allVisibleSelected =
    visible.length > 0 && visible.every((scholar) => selected.has(scholar._id));

  return (
    <Box>
      <Text fontSize="xs" color="charcoal.500" mb={2} fontFamily="heading">
        To
      </Text>
      <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2}>
        <Stack gap={3}>
          <Box position="relative">
            <Box
              position="absolute"
              left={2.5}
              top="50%"
              transform="translateY(-50%)"
              color="charcoal.300"
              pointerEvents="none"
            >
              <MagnifyingGlass size={14} />
            </Box>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search scholars…"
              size="sm"
              pl={8}
            />
          </Box>
          {mode === "multi" && (
            <Flex align="center" justify="space-between" gap={2}>
              <Text fontSize="xs" color="charcoal.400" fontFamily="heading" fontWeight="600">
                {selected.size} selected
                {scholars && scholars.length > 0 ? ` of ${scholars.length}` : ""}
              </Text>
              {onSetMany && visible.length > 0 && (
                <Box
                  as="button"
                  fontSize="xs"
                  fontFamily="heading"
                  fontWeight="600"
                  color="violet.600"
                  cursor="pointer"
                  _hover={{ color: "violet.700" }}
                  onClick={() =>
                    onSetMany(
                      visible.map((scholar) => scholar._id),
                      !allVisibleSelected,
                    )
                  }
                >
                  {allVisibleSelected ? "Clear" : "Select all"}
                </Box>
              )}
            </Flex>
          )}
          <Box maxH="180px" overflowY="auto">
            {scholars === undefined ? (
              <HStack justify="center" py={4}>
                <Spinner size="sm" color="violet.400" />
              </HStack>
            ) : visible.length === 0 ? (
              <Text fontSize="sm" color="charcoal.400" py={4} textAlign="center">
                {query.trim() ? "No matches." : "No scholars to message yet."}
              </Text>
            ) : (
              <Stack
                gap={1}
                role="listbox"
                aria-label="Scholars"
                aria-multiselectable={mode === "multi"}
              >
                {visible.map((scholar) => {
                  const isSelected = selected.has(scholar._id);
                  return (
                    <Flex
                      key={scholar._id}
                      as="button"
                      role="option"
                      aria-selected={isSelected}
                      align="center"
                      gap={2.5}
                      px={2}
                      py={1.5}
                      borderRadius="md"
                      borderWidth="1px"
                      borderColor={isSelected ? "violet.400" : "transparent"}
                      bg={isSelected ? "violet.50" : "transparent"}
                      cursor="pointer"
                      textAlign="left"
                      w="full"
                      _hover={{ bg: isSelected ? "violet.50" : "bg.subtle" }}
                      transition="background 0.1s"
                      onClick={() => onToggle(scholar._id)}
                    >
                      <Flex
                        w={4}
                        h={4}
                        flexShrink={0}
                        align="center"
                        justify="center"
                        borderRadius={mode === "single" ? "full" : "sm"}
                        borderWidth="1.5px"
                        borderColor={isSelected ? "violet.500" : "gray.300"}
                        bg={isSelected ? "violet.500" : "white"}
                        color="white"
                      >
                        {isSelected && <Check size={11} weight="bold" />}
                      </Flex>
                      <Avatar
                        size="xs"
                        name={scholar.name}
                        src={scholar.image ?? undefined}
                        colorKey={scholar._id}
                      />
                      <Box minW={0}>
                        <Text
                          fontFamily="heading"
                          fontSize="sm"
                          fontWeight="600"
                          color="navy.500"
                          truncate
                        >
                          {scholar.name}
                        </Text>
                        {scholar.institutionName && (
                          <Text fontFamily="body" fontSize="xs" color="charcoal.400" truncate>
                            {scholar.institutionName}
                          </Text>
                        )}
                      </Box>
                    </Flex>
                  );
                })}
              </Stack>
            )}
          </Box>
        </Stack>
      </Box>
    </Box>
  );
}
