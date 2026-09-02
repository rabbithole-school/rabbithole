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
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { ChatCircle, PaperPlaneTilt, Plus, Copy, Check } from "@phosphor-icons/react";
import { formatRelative } from "@/lib/relativeTime";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScholarPicker } from "@/components/ScholarPicker";
import { GuardianFacepile } from "@/components/messaging/GuardianFacepile";
import {
  MessageConversationRow,
  MessageThreadPane,
  MessageWorkspace,
} from "@/components/messaging/MessageWorkspace";
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

/** Format one guardian as an email "To"-field recipient: `"Name" <email>`. */
function toRecipient(p: { name: string; email: string | null }): string | null {
  if (!p.email) return null;
  return p.name ? `"${p.name}" <${p.email}>` : p.email;
}

/**
 * Teacher Messages — a two-pane inbox (thread list · open thread) plus a
 * compose dialog that targets a scholar's guardians (or several scholars for
 * a broadcast). Staff see the roster in their active institution context;
 * "Mine" filters to threads they authored. Recipients resolve through the
 * guardianship graph; a broadcast explodes per-parent (leak-safe) server-side.
 */
export function TeacherMessages() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [threadScope, setThreadScope] = useState<"all" | "mine">("all");
  const { scopeParam } = useActiveInstitution();
  const threads = useQuery(api.parentMessages.listMyThreads, {
    scope: threadScope,
    institutionScope: scopeParam,
  });
  const [composing, setComposing] = useState(false);
  const requestedThreadId = searchParams.get("thread");
  const openId =
    threads?.find((thread) => thread._id === requestedThreadId)?._id ?? null;
  const threadHref = (threadId: Id<"parentThreads"> | null) =>
    messageThreadHref(pathname, searchParams, threadId);
  const openThread = (threadId: Id<"parentThreads"> | null) => {
    router.replace(threadHref(threadId), { scroll: false });
  };

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
      >
        <ViewToggle<"all" | "mine">
          ariaLabel="Message scope"
          value={threadScope}
          onChange={setThreadScope}
          items={[
            { value: "all", label: "All" },
            { value: "mine", label: "Mine" },
          ]}
        />
        <Button
          size="sm"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          onClick={() => setComposing(true)}
        >
          <Plus style={{ marginRight: 4 }} /> New message
        </Button>
      </HStack>

      <MessageWorkspace
        list={
          threads === undefined ? (
            <HStack justify="center" py={10}>
              <Spinner size="sm" color="violet.400" />
            </HStack>
          ) : threads.length === 0 ? (
            <EmptyState
              icon={<ChatCircle weight="duotone" />}
              title="No conversations yet"
              hint="Start one with a family."
              cta={{
                label: "New message",
                icon: <Plus size={14} />,
                onClick: () => setComposing(true),
              }}
            />
          ) : (
            <VStack align="stretch" gap={0}>
              {threads.map((t) => {
                const active = t._id === openId;
                return (
                  <MessageConversationRow
                    key={t._id}
                    active={active}
                    unread={t.hasUnread}
                    leading={
                      t.viewer === "teacher" ? (
                        <GuardianFacepile guardians={t.guardians} />
                      ) : undefined
                    }
                    primary={t.parentName}
                    secondary={
                      t.scholarName ? `about ${t.scholarName}` : undefined
                    }
                    preview={`${t.lastAuthorType === "teacher" ? "You: " : ""}${t.lastPreview}`}
                    timestamp={formatRelative(t.lastMessageAt)}
                    href={threadHref(t._id)}
                  />
                );
              })}
            </VStack>
          )}
        detail={
          openId ? (
            <MessageThreadPane threadId={openId} surface="staff" />
          ) : (
            <Flex h="full" align="center" justify="center" px={6}>
              <EmptyState title="Select a conversation, or start a new message." />
            </Flex>
          )}
      />

      {composing && (
        <ComposeDialog
          onClose={() => setComposing(false)}
          onSent={(id) => {
            setComposing(false);
            openThread(id);
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
