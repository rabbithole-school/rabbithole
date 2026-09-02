"use client";

/**
 * InstructionExampleSheet — the persistent "See an example" explainer
 * (instructional segments v1). A scholar who skipped the Launchpad ("Try it
 * myself") or who just missed an item can pull the SAME strand-level worked
 * example up on demand, from a quiet shelf affordance in the practice loop.
 *
 * This is the pedagogy-#1/#2 guarantee that skipping is never a trap: the
 * explanation is always one tap away for any item whose strand has verified
 * content (resolved by `instruction.instructionContentForSkill`). Opening it
 * records a NON-terminal `retrieval` (source `idea_shelf` or `post_miss`) — pure
 * telemetry, never a deficit signal, never a mastery/credit effect.
 *
 * Post-miss escalation (§4.2): when opened `post_miss` AND the caller supplies
 * `nodeFirstContent` (the node-first-with-strand-fallback resolution §4.1's
 * `instructionContentForNode` returns), a quiet "Learn this from the start"
 * pull swaps the sheet's content to it. This is an OFFER on top of the
 * existing explainer, not a second forced beat — mechanism 2 (teachingStep)
 * is already the push after "I don't know this"; this is a further PULL a
 * scholar who is still stuck can reach for, reconciled with (not stacked on)
 * what's already showing. Logged as its own `post_miss` retrieval.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { Box, Button, Dialog, HStack, IconButton, Portal, Spinner, Text, VStack } from "@chakra-ui/react";
import { ArrowClockwise, Compass, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { InstructionAtom } from "@/convex/lib/practice/instructionEntries";
import { LaunchpadAtoms } from "@/components/practice/LaunchpadContent";

type WorkedExampleAtom = Extract<InstructionAtom, { kind: "worked_example" }>;

/** Cap on-demand generations per sheet-open — plenty of variety, gentle floor
 *  against runaway model calls (a server-side rate limit is a follow-up). */
const MAX_GENERATIONS = 6;

export type InstructionExampleContent = {
  key: string;
  title: string;
  subtitle?: string;
  atoms: InstructionAtom[];
};

export function InstructionExampleSheet({
  open,
  onClose,
  scholarId,
  skillKey,
  content,
  source,
  logRetrieval = true,
  allowGeneration = true,
  nodeFirstContent,
}: {
  open: boolean;
  onClose: () => void;
  scholarId: Id<"users">;
  /** nodeKey of the served item, so we can generate another example for its strand. */
  skillKey: string;
  content: InstructionExampleContent | null;
  /** Where the reopen came from — logged as retrieval telemetry only. */
  source: "idea_shelf" | "post_miss";
  /** Whether opening this sheet should write the retrieval telemetry.
   *  Defaults to true (the practice loop's own "See an example" shelf, which
   *  only ever renders for the scholar's own sitting). Set false for a
   *  READ-ONLY render — e.g. a teacher/parent viewing a scholar's node drawer
   *  reference (§4.3), or a staff REHEARSAL preview: they may see the SAME
   *  content, but their open must never mint or append to that scholar's
   *  `instructionEvents` ledger. */
  logRetrieval?: boolean;
  /** Whether the "Show me another" ON-DEMAND GENERATION is offered. Defaults to
   *  true. Set false for a fully read-only render (rehearsal): the generation
   *  action (`generateAnotherWorkedExample`) writes AI-usage telemetry
   *  server-side, so a zero-write preview must not be able to invoke it — the
   *  button is hidden and `onAnother` becomes a no-op. Pairs with
   *  `logRetrieval={false}` to make the sheet mint nothing at all. */
  allowGeneration?: boolean;
  /** Post-miss escalation (§4.2): the node-first resolution for the current
   *  item (§4.1's `instructionContentForNode` — node grain first, falling
   *  back to the same strand content already shown). Only meaningful when
   *  `source === "post_miss"`; ignored for `idea_shelf` opens (the drawer/map
   *  reference already IS the node-first render). Omit or pass null/undefined
   *  to render exactly the pre-§4.2 behavior. */
  nodeFirstContent?: InstructionExampleContent | null;
}) {
  const recordRetrieval = useMutation(api.instruction.recordInstructionRetrieval);
  const generateAnother = useAction(api.practiceGen.generateAnotherWorkedExample);
  const loggedForRef = useRef<string | null>(null);
  const loggedEscalationForRef = useRef<string | null>(null);

  // Post-miss escalation (§4.2): a scholar-initiated PULL that swaps the
  // sheet's displayed content to the node-first resolution. Never auto-fires.
  const [showingNodeFirst, setShowingNodeFirst] = useState(false);
  const canOfferEscalation = source === "post_miss" && !!nodeFirstContent;
  const displayContent = showingNodeFirst && nodeFirstContent ? nodeFirstContent : content;

  // On-demand "Show me another" state — a transient worked_example that swaps in
  // for the canonical one, the prompts already seen (so we never repeat), and
  // the loading/error/cap bookkeeping.
  const [override, setOverride] = useState<WorkedExampleAtom | null>(null);
  const [seenPrompts, setSeenPrompts] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [genCount, setGenCount] = useState(0);

  // Reset the on-demand example whenever the sheet (re)opens or the strand
  // changes, seeding "seen" with the canonical example so we never regenerate
  // it. Done during render (React's endorsed "adjust state on prop change"
  // pattern) rather than in an effect, so there is no extra render pass.
  const [resetToken, setResetToken] = useState<string | null>(null);
  const token = `${content?.key ?? ""}:${open ? "open" : "closed"}`;
  if (resetToken !== token) {
    setResetToken(token);
    setOverride(null);
    setMoreError(null);
    setGenCount(0);
    setShowingNodeFirst(false);
    const basePrompt = content?.atoms.find(
      (a): a is WorkedExampleAtom => a.kind === "worked_example",
    )?.examplePrompt;
    setSeenPrompts(basePrompt ? [basePrompt] : []);
  }

  // Log a retrieval once per open (keyed by content key + source, so reopening
  // for a different reason or a different strand logs again, but a re-render of
  // the same open sheet does not). Skipped entirely when `logRetrieval` is
  // false — a read-only render (teacher/parent viewing a scholar's node
  // drawer reference) must produce ZERO writes.
  useEffect(() => {
    if (!open || !content || !logRetrieval) return;
    const logToken = `${content.key}:${source}`;
    if (loggedForRef.current === logToken) return;
    loggedForRef.current = logToken;
    void recordRetrieval({ scholarId, key: content.key, source }).catch(() => {});
  }, [open, content, source, scholarId, recordRetrieval, logRetrieval]);

  // Log the ESCALATION pull as its OWN post_miss retrieval, distinct from the
  // sheet's own open-log above — a scholar who takes this further offer is a
  // second deliberate signal, not a duplicate of the first.
  useEffect(() => {
    if (!open || !showingNodeFirst || !nodeFirstContent || !logRetrieval) return;
    const logToken = `${nodeFirstContent.key}:escalation`;
    if (loggedEscalationForRef.current === logToken) return;
    loggedEscalationForRef.current = logToken;
    void recordRetrieval({ scholarId, key: nodeFirstContent.key, source: "post_miss" }).catch(() => {});
  }, [open, showingNodeFirst, nodeFirstContent, logRetrieval, scholarId, recordRetrieval]);

  useEffect(() => {
    if (!open) {
      loggedForRef.current = null;
      loggedEscalationForRef.current = null;
    }
  }, [open]);

  // The atoms actually shown: the displayed content (canonical, or the
  // node-first escalation once pulled), with its worked_example swapped for
  // the freshly generated one when the scholar asked for another.
  const displayAtoms = useMemo<InstructionAtom[]>(() => {
    if (!displayContent) return [];
    if (!override) return displayContent.atoms;
    let replaced = false;
    return displayContent.atoms.map((a) => {
      if (a.kind === "worked_example" && !replaced) {
        replaced = true;
        return override;
      }
      return a;
    });
  }, [displayContent, override]);

  const hasWorkedExample = useMemo(
    () => (displayContent?.atoms ?? []).some((a) => a.kind === "worked_example"),
    [displayContent],
  );
  const atCap = genCount >= MAX_GENERATIONS;

  const onAnother = async () => {
    if (!allowGeneration || !displayContent || loadingMore || atCap) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await generateAnother({ scholarId, skillKey, avoidPrompts: seenPrompts });
      if (!next) {
        setMoreError("Couldn't make a fresh one just now — try again.");
        return;
      }
      setOverride(next);
      setSeenPrompts((prev) => [...prev, next.examplePrompt].filter(Boolean));
      setGenCount((n) => n + 1);
    } catch {
      setMoreError("Something went wrong — try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      placement="center"
      motionPreset="slide-in-bottom"
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="480px" w="95vw">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Box flex={1} minW={0}>
                <Text fontSize="12px" fontWeight="700" color="#16707e" textTransform="uppercase" letterSpacing="0.05em">
                  Here&apos;s the idea
                </Text>
                <Dialog.Title fontWeight="700" color="#26332c" fontSize="xl" lineHeight="1.25" mt={1}>
                  {displayContent?.title ?? "See an example"}
                </Dialog.Title>
                {displayContent?.subtitle && (
                  <Text fontSize="14px" color="#5a655d" mt={0.5}>
                    {displayContent.subtitle}
                  </Text>
                )}
              </Box>
              <Dialog.CloseTrigger asChild>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="#8a8f88" _hover={{ bg: "#f0ede5" }}>
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body px={6} pt={2} pb={6} maxH="66vh" overflowY="auto">
              {displayContent ? (
                <VStack align="stretch" gap={4}>
                  <LaunchpadAtoms atoms={displayAtoms} />
                  {hasWorkedExample && allowGeneration && (
                    <VStack align="stretch" gap={2}>
                      {moreError && (
                        <Text fontSize="13px" color="#b4552d">
                          {moreError}
                        </Text>
                      )}
                      <Button
                        onClick={onAnother}
                        disabled={loadingMore || atCap}
                        variant="outline"
                        size="sm"
                        alignSelf="flex-start"
                        borderColor="#cfe3e6"
                        color="#16707e"
                        _hover={{ bg: "#eef7f8" }}
                      >
                        <HStack as="span" gap={2}>
                          {loadingMore ? <Spinner size="xs" /> : <ArrowClockwise weight="bold" />}
                          <Text as="span">
                            {loadingMore
                              ? "Thinking of another…"
                              : atCap
                                ? "That's plenty of examples for now"
                                : "Show me another"}
                          </Text>
                        </HStack>
                      </Button>
                    </VStack>
                  )}
                  {/* Post-miss escalation (§4.2): a quiet further pull, never a
                      second forced beat. Shown only on a post_miss open with a
                      node-first resolution available, and hidden once taken
                      (the sheet is already showing it). */}
                  {canOfferEscalation && !showingNodeFirst && (
                    <Button
                      onClick={() => setShowingNodeFirst(true)}
                      variant="ghost"
                      size="sm"
                      alignSelf="flex-start"
                      color="#5a655d"
                      _hover={{ bg: "#f4f2ec" }}
                    >
                      <HStack as="span" gap={2}>
                        <Compass weight="bold" />
                        <Text as="span">Learn this from the start</Text>
                      </HStack>
                    </Button>
                  )}
                </VStack>
              ) : (
                <VStack py={6}>
                  <Text color="#65706a" fontSize="14px">
                    No example is available for this one yet.
                  </Text>
                </VStack>
              )}
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
