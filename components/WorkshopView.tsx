"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import Link from "next/link";
import { Box, Flex, Heading, Text, Textarea, IconButton, Badge, Stack, Spinner } from "@chakra-ui/react";
import { ArrowRight, CaretDown, PaperPlaneTilt } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatRelative } from "@/lib/relativeTime";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import {
  WORKSHOP_INVITE_EYEBROW,
  WORKSHOP_INVITE_LEAD,
  WORKSHOP_SPARK_CHIPS,
} from "@/shared/workshopSparks";

// The Workshop's right column — the scholar's own view of building Rabbithole.
// The scholar's Workshop board. Its hierarchy is stable across flag states:
// You know best · My ideas · What's new · How it works. The last section owns
// both the static transparency page and the standing Ask Rabbithole chat.


/** The shared eyebrow — the SAME treatment for all four zones, flush-left, no
 *  icon. `mt` lets the leading zone sit tight while later zones get breathing
 *  room above them. */
function Eyebrow({ children, mt = 0 }: { children: React.ReactNode; mt?: number }) {
  return (
    <Heading
      as="h2"
      fontFamily="heading"
      fontSize="xs"
      fontWeight="700"
      letterSpacing="0.04em"
      textTransform="uppercase"
      color="charcoal.400"
      mt={mt}
      mb={3}
    >
      {children}
    </Heading>
  );
}

/** A tappable pill that seeds Ask Rabbithole's composer. */
function SeedChip({ label, onSpark }: { label: string; onSpark?: (phrase: string) => void }) {
  return (
    <Box
      as="button"
      onClick={() => onSpark?.(label)}
      bg="violet.50"
      color="violet.700"
      borderWidth="1px"
      borderColor="violet.200"
      borderRadius="full"
      px={3}
      py={1.5}
      fontFamily="heading"
      fontWeight="600"
      fontSize="sm"
      lineHeight="1.2"
      cursor="pointer"
      transition="background 0.15s, border-color 0.15s"
      _hover={{ bg: "violet.100", borderColor: "violet.300" }}
    >
      {label}
    </Box>
  );
}

/** "Answered" means A HUMAN WROTE BACK — so it keys off the reply itself, never
 *  the row's `status`. `status` is a staff-side concern (the open queue, the
 *  scholar's five-open cap); a staffer replying in the Slack thread
 *  deliberately does NOT close the idea, and the kid must still be able to read
 *  what they wrote. Parity with native/src/app/meta.tsx. */
function StatusChip({ answered }: { answered: boolean }) {
  return (
    <Badge
      bg={answered ? "green.100" : "gray.100"}
      color={answered ? "green.700" : "charcoal.500"}
      fontFamily="heading"
      fontSize="2xs"
      fontWeight="700"
      textTransform="none"
      px={2}
      py={0.5}
      borderRadius="full"
      flexShrink={0}
    >
      {answered ? "Answered" : "Sent"}
    </Badge>
  );
}

type MyIdea = {
  _id: string;
  title: string;
  archivedAt?: number;
  responderName: string | null;
  staffResponse?: { body: string } | null;
};

/** One idea = a self-contained card, separated from its neighbors by SPACING
 *  (never a hairline). An Answered idea collapses to title + chip + chevron;
 *  tapping expands its staff reply as a recessed, indented sub-panel INSIDE the
 *  same card — one click deep, never a floating sibling. A Sent idea is inert. */
function IdeaCard({
  idea,
  onSetArchived,
}: {
  idea: MyIdea;
  onSetArchived: (id: string, archived: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = !!idea.staffResponse;
  const archived = !!idea.archivedAt;

  const head = (
    <Flex align="flex-start" justify="space-between" gap={3}>
      <Text fontFamily="heading" fontWeight="600" fontSize="md" color="navy.500">
        {idea.title}
      </Text>
      <Flex align="center" gap={1.5} flexShrink={0} pt={0.5}>
        <StatusChip answered={canExpand} />
        {canExpand && (
          <Box
            color="charcoal.400"
            transform={expanded ? "rotate(180deg)" : "rotate(0deg)"}
            transition="transform 0.15s"
          >
            <CaretDown size={16} weight="bold" />
          </Box>
        )}
      </Flex>
    </Flex>
  );

  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: 4, md: 5 }}>
      {canExpand ? (
        <Box
          as="button"
          w="full"
          textAlign="left"
          cursor="pointer"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {head}
        </Box>
      ) : (
        head
      )}

      {canExpand && expanded && (
        <Box mt={3} ml={{ base: 2, md: 3 }} bg="gray.50" borderWidth="1px" borderColor="gray.100" borderRadius="lg" px={4} py={3}>
          <Text
            fontFamily="heading"
            fontSize="xs"
            fontWeight="700"
            letterSpacing="0.02em"
            color="charcoal.400"
            mb={1}
          >
            From {idea.responderName ?? "the Rabbithole team"}
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.600" lineHeight="1.6" whiteSpace="pre-wrap">
            {idea.staffResponse!.body}
          </Text>
        </Box>
      )}

      {/* The scholar's own lever: the five-open limit is a prioritization
          lesson pointed at THEM, so they decide when a slot frees. Quiet by
          design and LAST in the card — it never competes with the reply.
          Archive/Restore is the house pair for a scholar (ScholarPlate,
          ScholarHomeMirrorCard) — don't invent a warmer synonym here. */}
      <Flex justify="flex-end" mt={2}>
        <Box
          as="button"
          fontFamily="body"
          fontSize="xs"
          fontWeight="600"
          color="charcoal.400"
          _hover={{ color: "violet.500" }}
          cursor="pointer"
          onClick={() => onSetArchived(idea._id, !archived)}
        >
          {archived ? "Restore" : "Archive"}
        </Box>
      </Flex>
    </Box>
  );
}

export function WorkshopView({ onSpark }: { onSpark?: (phrase: string) => void }) {
  const ideas = useQuery(api.scholarSuggestions.listMine, {});
  const whatsNew = useQuery(api.changelog.listRecent, {});
  const flags = useQuery(api.metaChat.workshopFlags, {});
  const createMine = useMutation(api.scholarSuggestions.createMine);
  const setArchived = useMutation(api.scholarSuggestions.setArchivedMine);

  // When idea conversations are on, the reflection chat owns idea capture, so
  // the standalone composer here is redundant — hide it and show the finalized
  // eyebrow-zone cluster instead (flag-gated, server-authored). Fail-open: only
  // switch when we affirmatively know the flag is on, so a slow/absent flag
  // never breaks the flag-OFF submit path.
  const ideaConvos = flags?.ideaConvosEnabled === true;

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Archive/Restore lives in the ideas zone, NOT the composer — and the
  // composer is hidden entirely when idea conversations are on. A refusal
  // routed to the composer's `error` would be invisible exactly when the
  // scholar needs it (a restore over the five-open limit), so it gets its own
  // state rendered beside the board.
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const trimmed = text.trim();

  // Single-line composer that auto-grows to multi-line as the idea gets longer
  // (matches the reflection chat's composer). rows=1 collapses it back when empty.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [text]);

  const handleSubmit = async () => {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createMine({ text: trimmed });
      setText(""); // clear on success
    } catch (e) {
      setError(serverErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetArchived = async (suggestionId: string, archived: boolean) => {
    setArchiveError(null);
    try {
      await setArchived({
        suggestionId: suggestionId as Id<"scholarSuggestions">,
        archived,
      });
    } catch (e) {
      // Restoring one can hit the five-open limit — the server's message names
      // the number and what to do, so show it verbatim.
      setArchiveError(serverErrorMessage(e));
    }
  };

  // The board shows what's still on the kid's plate; what they've archived
  // lives in its own quiet section below it, never mixed in.
  const openIdeas = (ideas ?? []).filter((i) => !i.archivedAt);
  const archivedIdeas = (ideas ?? []).filter((i) => !!i.archivedAt);

  // ── Zone 3: My ideas ── (shared by both flag paths)
  const myIdeas = (
    <>
      <Eyebrow mt={ideaConvos ? 10 : 6}>My ideas</Eyebrow>
      {archiveError && (
        <Text
          fontFamily="body"
          fontSize="sm"
          color="orange.600"
          mb={3}
          lineHeight="1.5"
        >
          {archiveError}
        </Text>
      )}
      {ideas === undefined ? (
        <Flex justify="center" py={10}>
          <Spinner color="violet.500" />
        </Flex>
      ) : ideas.length === 0 ? (
        <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: 5, md: 6 }}>
          <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.500" mb={1.5}>
            No ideas yet.
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6">
            {ideaConvos
              ? "This is where your ideas land. Talk one through with Rabbithole in the chat and send it our way — we read every idea, and we write back."
              : "This is where you help us build Rabbithole. Something get in your way, or something you wish it could do? Send it in above — we read every idea, and we write back."}
          </Text>
        </Box>
      ) : (
        <Stack gap={3}>
          {openIdeas.map((idea) => (
            <IdeaCard
              key={idea._id}
              idea={idea}
              onSetArchived={handleSetArchived}
            />
          ))}
          {archivedIdeas.length > 0 && (
            <Box mt={openIdeas.length > 0 ? 4 : 0}>
              <Box
                as="button"
                fontFamily="heading"
                fontSize="xs"
                fontWeight="700"
                letterSpacing="0.02em"
                color="charcoal.400"
                _hover={{ color: "violet.500" }}
                cursor="pointer"
                mb={showArchived ? 3 : 0}
                onClick={() => setShowArchived((v) => !v)}
                aria-expanded={showArchived}
              >
                {showArchived ? "Hide" : "Show"} archived ({archivedIdeas.length})
              </Box>
              {showArchived && (
                <Stack gap={3} opacity={0.75}>
                  {archivedIdeas.map((idea) => (
                    <IdeaCard
                      key={idea._id}
                      idea={idea}
                      onSetArchived={handleSetArchived}
                    />
                  ))}
                </Stack>
              )}
            </Box>
          )}
        </Stack>
      )}
    </>
  );

  // ── Zone 4: What's new ── (shared by both flag paths; keep the credit line)
  const whatsNewZone = (
    <>
      <Eyebrow mt={10}>What&apos;s new</Eyebrow>
      {whatsNew === undefined ? (
        <Flex justify="center" py={6}>
          <Spinner color="violet.500" />
        </Flex>
      ) : whatsNew.length === 0 ? (
        <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: 4, md: 5 }}>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6">
            Nothing new yet. When we change Rabbithole, you&apos;ll see it here
            first.
          </Text>
        </Box>
      ) : (
        <Stack gap={3}>
          {whatsNew.map((entry) => (
            <Box
              key={entry._id}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="xl"
              p={{ base: 4, md: 5 }}
            >
              <Flex align="flex-start" justify="space-between" gap={3}>
                <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.500">
                  {entry.title}
                </Text>
                <Text
                  fontFamily="body"
                  fontSize="xs"
                  color="charcoal.400"
                  flexShrink={0}
                  mt={1}
                >
                  {formatRelative(entry.createdAt)}
                </Text>
              </Flex>
              <Text
                fontFamily="body"
                fontSize="sm"
                color="charcoal.600"
                lineHeight="1.6"
                mt={1.5}
                whiteSpace="pre-wrap"
              >
                {entry.kidBody}
              </Text>
              {entry.creditLine && (
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="600"
                  color="violet.600"
                  mt={2.5}
                >
                  {entry.creditLine}
                </Text>
              )}
            </Box>
          ))}
        </Stack>
      )}
    </>
  );

  const howItWorksZone = (
    <>
      <Eyebrow mt={10}>How it works</Eyebrow>
      <Stack gap={2}>
        {[
          {
            href: "/how-it-works",
            title: "Read how it works",
            detail: "The plain-language tour",
          },
          {
            href: "/scholar/workshop/ask",
            title: "Ask Rabbithole",
            detail: "A standing conversation about the app",
          },
        ].map((action) => (
          <Link
            key={action.href}
            href={action.href}
            style={{ textDecoration: "none" }}
          >
            <Flex
              align="center"
              justify="space-between"
              gap={3}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="xl"
              px={4}
              py={3}
              transition="border-color 0.15s, background 0.15s"
              _hover={{ borderColor: "violet.300", bg: "violet.50" }}
            >
              <Box>
                <Text
                  fontFamily="heading"
                  fontWeight="700"
                  fontSize="md"
                  color="navy.500"
                >
                  {action.title}
                </Text>
                <Text
                  fontFamily="body"
                  fontSize="sm"
                  color="charcoal.500"
                  mt={0.5}
                >
                  {action.detail}
                </Text>
              </Box>
              <Box color="violet.500" flexShrink={0}>
                <ArrowRight size={20} weight="bold" />
              </Box>
            </Flex>
          </Link>
        ))}
      </Stack>
    </>
  );

  return (
    <Box maxW="680px" mx="auto" px={{ base: 4, md: 6 }} pt={6} pb={16}>
      {ideaConvos ? (
        <>
          {/* YOU KNOW BEST. The invite: an open door, never pressure —
              no counts/badges, nothing escalates if ignored. Tapping a chip
              pre-fills Ask Rabbithole so the kid finishes the
              thought in their own words. */}
          <Eyebrow>{WORKSHOP_INVITE_EYEBROW}</Eyebrow>
          <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: 4, md: 5 }}>
            <Text fontFamily="body" fontSize="md" color="charcoal.600" lineHeight="1.6">
              {WORKSHOP_INVITE_LEAD}
            </Text>
            <Flex mt={3} gap={2} wrap="wrap">
              {WORKSHOP_SPARK_CHIPS.map((chip) => (
                <SeedChip key={chip} label={chip} onSpark={onSpark} />
              ))}
            </Flex>
          </Box>

          {myIdeas}
          {whatsNewZone}
        </>
      ) : (
        <>
          <Eyebrow>{WORKSHOP_INVITE_EYEBROW}</Eyebrow>
          <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: 4, md: 5 }} mb={6}>
            <Heading as="h2" fontFamily="heading" fontWeight="700" fontSize="lg" color="navy.500">
              Got an idea?
            </Heading>
            <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={1} mb={3}>
              We read every idea, and we always write back.
            </Text>
            <Flex gap={2} align="flex-end">
              <Textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="What should we do differently?"
                rows={1}
                resize="none"
                overflow="hidden"
                fontFamily="body"
                fontSize="md"
                borderColor="gray.200"
                _focus={{ borderColor: "violet.400", boxShadow: "none" }}
                py={2}
                px={3}
              />
              <IconButton
                aria-label="Send it to us"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
                borderRadius="lg"
                disabled={!trimmed || submitting}
                loading={submitting}
                onClick={handleSubmit}
              >
                <PaperPlaneTilt size={18} weight="fill" />
              </IconButton>
            </Flex>
            {error && (
              <Text fontFamily="body" fontSize="sm" color="orange.600" mt={2} lineHeight="1.5">
                {error}
              </Text>
            )}
          </Box>

          {myIdeas}
          {whatsNewZone}
        </>
      )}
      {howItWorksZone}
    </Box>
  );
}
