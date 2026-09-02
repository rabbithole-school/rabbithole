"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Field,
  Flex,
  HStack,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { ChatCircle, Plus, WhatsappLogo } from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { formatRelative } from "@/lib/relativeTime";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  MessageConversationRow,
  MessageThreadPane,
  MessageWorkspace,
} from "@/components/messaging/MessageWorkspace";
import {
  MessageAttachmentPicker,
  useFamilyMessageAttachments,
} from "@/components/messaging/MessageAttachmentPicker";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { messageThreadHref } from "@/lib/messageThreadUrl";

/**
 * The parent portal Messages inbox. A parent sees ONLY their own threads
 * (server-scoped), can open a thread with a teacher, reply, and start a new
 * message to the school.
 */
export function ParentMessages({
  scholarId,
  programGuest,
}: {
  scholarId: Id<"users">;
  programGuest: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const threads = useQuery(api.parentMessages.listMyGuardianThreads, {});
  const channels = useQuery(api.parentMessages.getMyChannels, {});
  const recipientTeachers = useQuery(
    api.parentMessages.listParentRecipientTeachers,
    { scholarId },
  );
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
    <Flex h="full" minH={0} direction="column">
      <HStack
        justify="flex-end"
        px={4}
        py={2}
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.200"
        flexShrink={0}
      >
        <Button
          size="sm"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          flexShrink={0}
          onClick={() => {
            setComposing(true);
            openThread(null);
          }}
        >
          <Plus style={{ marginRight: 4 }} /> New message
        </Button>
      </HStack>

      <MessageWorkspace
        list={
          <>
            {channels?.whatsappConfigured && (
              <Box p={3}>
                <WhatsAppOptIn channels={channels} />
              </Box>
            )}
            {threads === undefined ? (
              <HStack justify="center" py={10}>
                <Spinner size="sm" color="violet.400" />
              </HStack>
            ) : threads.length === 0 ? (
              <EmptyState
                icon={<ChatCircle weight="duotone" />}
                title="No conversations yet"
                hint="Start one with the school."
                cta={{
                  label: "New message",
                  icon: <Plus size={14} />,
                  onClick: () => {
                    setComposing(true);
                    openThread(null);
                  },
                }}
              />
            ) : (
              <VStack align="stretch" gap={0}>
                {threads.map((thread) => (
                  <MessageConversationRow
                    key={thread._id}
                    active={thread._id === openId && !composing}
                    unread={thread.hasUnread}
                    primary={thread.teacherName ?? "School"}
                    secondary={
                      thread.scholarName
                        ? `about ${thread.scholarName}`
                        : undefined
                    }
                    preview={`${thread.lastAuthorType === "parent" ? "You: " : ""}${thread.lastPreview}`}
                    timestamp={formatRelative(thread.lastMessageAt)}
                    href={threadHref(thread._id)}
                    onNavigate={() => setComposing(false)}
                  />
                ))}
              </VStack>
            )}
          </>
        }
        detail={
          composing ? (
            <ComposeNew
              scholarId={scholarId}
              programGuest={programGuest}
              teachers={recipientTeachers ?? []}
              onDone={(id) => {
                setComposing(false);
                openThread(id);
              }}
            />
          ) : openId ? (
            <MessageThreadPane threadId={openId} surface="parent" />
          ) : (
            <Flex h="full" align="center" justify="center" px={6}>
              <EmptyState title="Select a conversation, or start a new message." />
            </Flex>
          )
        }
      />
    </Flex>
  );
}

function ComposeNew({
  scholarId,
  programGuest,
  teachers,
  onDone,
}: {
  scholarId: Id<"users">;
  programGuest: boolean;
  teachers: { _id: Id<"users">; name: string }[];
  onDone: (id: Id<"parentThreads">) => void;
}) {
  const start = useMutation(api.parentMessages.startThread);
  const [body, setBody] = useState("");
  const [teacherId, setTeacherId] = useState<Id<"users"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attachmentState = useFamilyMessageAttachments();
  const effectiveTeacherId =
    teacherId ?? (programGuest && teachers.length === 1 ? teachers[0]._id : null);

  const submit = async () => {
    const text = body.trim();
    if (
      (!text && attachmentState.attachmentIds.length === 0) ||
      busy ||
      attachmentState.uploading
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { threadId } = await start({
        body: text,
        as: "parent",
        scholarId,
        teacherId: effectiveTeacherId ?? undefined,
        attachmentIds: attachmentState.attachmentIds,
      });
      attachmentState.clearClaimed();
      onDone(threadId);
    } catch (e) {
      console.error("startThread failed", e);
      setError(e instanceof Error ? e.message : "Couldn't start this message.");
      setBusy(false);
    }
  };

  return (
    <Box h="full" bg="white" p={4} overflowY="auto">
      <Text
        fontFamily="heading"
        fontWeight="700"
        color="navy.500"
        mb={3}
      >
        New message
      </Text>
      <Text fontFamily="body" fontSize="xs" color="charcoal.400" mb={3}>
        {programGuest
          ? "Send a message to a teacher from this program."
          : "Send a message to the school team or a teacher."}
      </Text>
      <Field.Root maxW="sm" mb={3}>
        <Field.Label fontFamily="heading" fontSize="xs">
          To
        </Field.Label>
        <FieldSelect
          value={effectiveTeacherId ?? ""}
          onChange={(value) =>
            setTeacherId(
              teachers.find((teacher) => teacher._id === value)?._id ?? null,
            )
          }
          fieldProps={{ "aria-label": "Message recipient" }}
        >
          {!programGuest && <option value="">School team</option>}
          {programGuest && teachers.length !== 1 && (
            <option value="">Choose a program teacher</option>
          )}
          {teachers.map((teacher) => (
            <option key={teacher._id} value={teacher._id}>
              {teacher.name}
            </option>
          ))}
        </FieldSelect>
      </Field.Root>
      {programGuest && teachers.length === 0 && (
        <Text color="orange.700" fontFamily="body" fontSize="sm" mb={3}>
          No program teacher is available yet. Ask the school team to update this
          group.
        </Text>
      )}
      {error && (
        <Text color="red.600" fontFamily="body" fontSize="sm" mb={3}>
          {error}
        </Text>
      )}
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
          placeholder="Write your message…"
          rows={5}
          fontFamily="body"
          fontSize="sm"
          bg="gray.50"
          autoFocus
        />
      </MessageAttachmentPicker>
      <HStack justify="flex-end" mt={3}>
        <Button
          onClick={submit}
          disabled={
            busy ||
            attachmentState.uploading ||
            (programGuest && effectiveTeacherId === null) ||
            (!body.trim() && attachmentState.attachmentIds.length === 0)
          }
          loading={busy}
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
        >
          Send
        </Button>
      </HStack>
    </Box>
  );
}

/**
 * Self-serve WhatsApp opt-in (only shown when the school has a WhatsApp number
 * configured). Tapping the link messages the school number with a prefilled
 * "optin:<id>" token, which links the parent's WhatsApp on inbound — no manual
 * number entry. Once on, the parent can pause it here.
 */
function WhatsAppOptIn({
  channels,
}: {
  channels: {
    whatsappOptInLink: string | null;
    channels: { _id: Id<"parentChannelIdentities">; channel: string; identity: string; optedIn: boolean; stopped: boolean }[];
  };
}) {
  const setStopped = useMutation(api.parentMessages.setMyChannelStopped);
  const wa = channels.channels.find((c) => c.channel === "whatsapp");
  const on = wa?.optedIn;

  return (
    <Box
      bg="green.50"
      borderWidth="1px"
      borderColor="green.200"
      borderRadius="lg"
      px={4}
      py={3}
    >
      <HStack justify="space-between" gap={3} align="start">
        <HStack gap={2.5} minW={0} align="start">
          <Box color="#25D366" flexShrink={0} mt={0.5}>
            <WhatsappLogo size={22} weight="fill" />
          </Box>
          <Box minW={0}>
            <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600">
              {on ? "You're connected on WhatsApp" : "Chat with us on WhatsApp"}
            </Text>
            <Text fontFamily="body" fontSize="xs" color="charcoal.400">
              {on
                ? `Connected · ${wa?.identity}. Reply to your teacher anytime, right from WhatsApp.`
                : "Get your teacher's messages here and reply from WhatsApp. Just message us once to connect."}
            </Text>
          </Box>
        </HStack>
        {on && wa ? (
          <Button
            size="xs"
            variant="outline"
            borderColor="green.300"
            fontFamily="heading"
            flexShrink={0}
            onClick={() => setStopped({ channelId: wa._id, stopped: true }).catch(() => {})}
          >
            Pause
          </Button>
        ) : channels.whatsappOptInLink ? (
          <Button
            asChild
            size="md"
            bg="#25D366"
            color="white"
            _hover={{ bg: "#1da851" }}
            fontFamily="heading"
            flexShrink={0}
          >
            <a href={channels.whatsappOptInLink} target="_blank" rel="noreferrer">
              Connect
            </a>
          </Button>
        ) : null}
      </HStack>

      {/* Desktop → phone bridge: scan to open WhatsApp pre-filled on a phone. */}
      {!on && channels.whatsappOptInLink ? (
        <HStack
          mt={3}
          pt={3}
          gap={3}
          borderTopWidth="1px"
          borderColor="green.200"
          align="center"
        >
          <Box bg="white" p={1.5} borderRadius="md" flexShrink={0} lineHeight={0}>
            <QRCodeSVG value={channels.whatsappOptInLink} size={72} marginSize={0} />
          </Box>
          <Text fontFamily="body" fontSize="xs" color="charcoal.400">
            On a computer? Scan this with your phone&apos;s camera to open WhatsApp and
            connect.
          </Text>
        </HStack>
      ) : null}
    </Box>
  );
}
