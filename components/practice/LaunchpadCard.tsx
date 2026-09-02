"use client";

/**
 * LaunchpadCard — the instructional "Launchpad" doorway (instructional segments
 * v1). Shown ONCE, at the top of a daily whole-graph run, the first time a
 * scholar reaches a genuinely new strand that has verified content. It is the
 * deliberate answer to "the playlist feels too fully Socratic": a short, opt-in
 * instructional beat that sits ON the playlist but NEVER grades or moves mastery.
 *
 * Two equally-valid paths (pedagogy #1 — no path is the "right" one, neither is
 * remediation, both lead to the same first item with identical credit):
 *   - "Try it myself"    → record the choice, jump straight to the problem. The
 *                          same content stays reachable all run via the "See an
 *                          example" shelf (PracticeSession), so a try-then-miss
 *                          scholar can still pull the explainer up.
 *   - "Show me the move" → reveal a GENUINE worked example (named strategy +
 *                          steps + one fully-worked problem), then "Now you try".
 *
 * Fire-once, exactly like StoryMomentCard: on mount we CLAIM the impression via
 * `claimInstructionShown` (a query can't write, so the client claims). If the
 * claim is refused (already shown/terminal in another tab, or the ≤1/day cap is
 * hit) we proceed straight to practice rather than showing a card we shouldn't.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Box, Button, Flex, HStack, Heading, Text, VStack } from "@chakra-ui/react";
import { ArrowRight, Compass, PencilSimpleLine } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { InstructionEntry } from "@/convex/lib/practice/instructionEntries";
import {
  instructionWritesFor,
  type InstructionWrite,
} from "@/convex/lib/practice/instructionEntries";
import { LaunchpadAtoms } from "@/components/practice/LaunchpadContent";

const LAUNCHPAD_MOTION_CSS = `
@keyframes rh-lp-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.rh-lp-rise { animation: rh-lp-rise 0.4s cubic-bezier(0.22, 1, 0.36, 1) both; }
@media (prefers-reduced-motion: reduce) { .rh-lp-rise { animation: none; } }
`;

type CardPhase = "offer" | "example" | "tryTerminal";

/** Terminal copy shown when a teacher taps "Try it myself" in Rehearse
 *  (`preview`): there is no scholar item to proceed to, so instead of silently
 *  dismissing the dialog we explain what the scholar would experience. Sentence
 *  case per .claude/rules/visual-design.md. */
export const REHEARSE_TRY_FIRST_TERMINAL_COPY =
  "The scholar jumps straight to their first problem — the same example stays one tap away all run under “See an example”.";

/** In `preview` (teacher Rehearse) the try-fork has no item to proceed to, so it
 *  flips the card to a terminal explainer instead of dismissing the dialog; a
 *  live scholar proceeds to their first item exactly as before. */
export function launchpadTryFirstMode(preview: boolean): "preview-terminal" | "proceed" {
  return preview ? "preview-terminal" : "proceed";
}

export function LaunchpadCard({
  scholarId,
  entry,
  onProceed,
  preview = false,
}: {
  scholarId?: Id<"users">;
  entry: InstructionEntry;
  /** Leave the doorway and start the first item. Called on either fork choice
   *  (after recording it) and if the impression claim is refused. */
  onProceed: () => void;
  /** Teacher Rehearse ("play it"): render the EXACT scholar card, fully
   *  interactive, but write NOTHING — every lifecycle mutation below is gated on
   *  `!preview`, so a preview render claims no impression and records no choice/
   *  view/completion. There is no scholar to attribute a write to. */
  preview?: boolean;
}) {
  const claimShown = useMutation(api.instruction.claimInstructionShown);
  const recordChoice = useMutation(api.instruction.recordInstructionChoice);
  const recordViewed = useMutation(api.instruction.recordInstructionViewed);
  const recordCompleted = useMutation(api.instruction.recordInstructionCompleted);

  const [phase, setPhase] = useState<CardPhase>("offer");
  const proceededRef = useRef(false);

  // Execute the lifecycle-write plan for a UI event. The plan (which mutations,
  // in what order) comes from the SHARED `instructionWritesFor`, so preview
  // (Rehearse) and no-scholar renders invoke NOTHING — the card cannot record a
  // write the plan didn't authorize. Fire-and-forget: a write hiccup never traps
  // the scholar. Returns the plan so the mount path can key its promise off it.
  const runWrites = useCallback(
    (event: "mount" | "tryFirst" | "showMe" | "nowYouTry"): InstructionWrite[] => {
      const plan = instructionWritesFor(event, { preview, scholarId });
      if (!scholarId) return plan;
      for (const w of plan) {
        if (w.type === "recordChoice") {
          void recordChoice({ scholarId, key: entry.key, choice: w.choice }).catch(() => {});
        } else if (w.type === "recordViewed") {
          void recordViewed({ scholarId, key: entry.key }).catch(() => {});
        } else if (w.type === "recordCompleted") {
          void recordCompleted({ scholarId, key: entry.key }).catch(() => {});
        }
        // `claimShown` returns a value the mount effect needs, so it is invoked
        // there rather than fire-and-forget here (still gated by the same plan).
      }
      return plan;
    },
    [preview, scholarId, entry.key, recordChoice, recordViewed, recordCompleted],
  );

  // Claim the impression on mount (fire-once). If refused, this Launchpad
  // shouldn't render right now — go straight to practice. Deliberately NO
  // StrictMode guard: the mutation is idempotent within a scholar-local day.
  useEffect(() => {
    // Rehearse (preview) / no-scholar → the plan is empty, so no impression is
    // claimed and the card simply renders (the teacher walks both paths with no
    // ledger row). Keyed off the SAME plan the record handlers use.
    const willClaim = instructionWritesFor("mount", { preview, scholarId }).some(
      (w) => w.type === "claimShown",
    );
    if (!willClaim || !scholarId) return;
    let cancelled = false;
    void claimShown({ scholarId, key: entry.key })
      .then((res) => {
        if (cancelled) return;
        if (!res.claimed && !proceededRef.current) {
          proceededRef.current = true;
          onProceed();
        }
      })
      .catch(() => {
        // A claim hiccup shouldn't trap the scholar on the doorway — the card
        // still reads fine; the worst case is a duplicate impression, never a
        // lost turn.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const proceed = useCallback(() => {
    if (proceededRef.current) return;
    proceededRef.current = true;
    onProceed();
  }, [onProceed]);

  const onTryFirst = useCallback(() => {
    // Rehearse preview has no first item to proceed to — flip to a terminal
    // explainer rather than silently dismissing the dialog. A live scholar
    // (preview=false) records the choice and proceeds, byte-identical to before.
    if (launchpadTryFirstMode(preview) === "preview-terminal") {
      setPhase("tryTerminal");
      return;
    }
    runWrites("tryFirst");
    proceed();
  }, [preview, runWrites, proceed]);

  const onShowMe = useCallback(() => {
    runWrites("showMe");
    setPhase("example");
  }, [runWrites]);

  const onNowYouTry = useCallback(() => {
    runWrites("nowYouTry");
    proceed();
  }, [runWrites, proceed]);

  // The story hook frames the "why" up front on the offer; the method (explain +
  // worked example) is held for the Show path so "Try it myself" is a real choice.
  const hookAtom = entry.atoms.find((a) => a.kind === "story_hook");
  const methodAtoms = entry.atoms.filter((a) => a.kind !== "story_hook");

  return (
    <Box w="100%" maxW="460px" className="rh-lp-rise">
      <style dangerouslySetInnerHTML={{ __html: LAUNCHPAD_MOTION_CSS }} />
      <Box bg="#fffdfa" border="1px solid #ded8cb" borderRadius="18px" p={{ base: 5, md: 6 }}>
        <VStack align="stretch" gap={4}>
          <HStack gap={2} color="#16707e">
            <Compass weight="fill" size={16} />
            <Text fontSize="12px" fontWeight="700" textTransform="uppercase" letterSpacing="0.06em">
              New ground — a quick launchpad
            </Text>
          </HStack>

          <VStack align="stretch" gap={1}>
            <Heading
              as="h1"
              size="lg"
              color="#26332c"
              lineHeight="1.2"
              letterSpacing="-0.01em"
              style={{ textWrap: "balance" }}
            >
              {entry.title}
            </Heading>
            {entry.subtitle && (
              <Text fontSize="15px" color="#5a655d" lineHeight="1.5">
                {entry.subtitle}
              </Text>
            )}
          </VStack>

          {phase === "offer" ? (
            <>
              {hookAtom && hookAtom.kind === "story_hook" && (
                <Text fontSize="15.5px" color="#3f4a44" lineHeight="1.65">
                  {hookAtom.hook}
                </Text>
              )}

              <VStack align="stretch" gap={2.5} pt={1}>
                <Flex gap={2.5} direction={{ base: "column", sm: "row" }}>
                  <Button
                    flex="1"
                    size="lg"
                    bg="#2f8f5f"
                    color="white"
                    _hover={{ bg: "#278052" }}
                    _active={{ bg: "#226f47" }}
                    onClick={onTryFirst}
                    fontWeight="700"
                  >
                    <PencilSimpleLine weight="bold" /> {entry.fork.tryFirstLabel}
                  </Button>
                  <Button
                    flex="1"
                    size="lg"
                    bg="#16707e"
                    color="white"
                    _hover={{ bg: "#125d69" }}
                    _active={{ bg: "#0f4f59" }}
                    onClick={onShowMe}
                    fontWeight="700"
                  >
                    <Compass weight="bold" /> {entry.fork.showMeLabel}
                  </Button>
                </Flex>
                <Text fontSize="12.5px" color="#8a8f88" textAlign="center">
                  Either way works. You can pull up the example any time.
                </Text>
              </VStack>
            </>
          ) : phase === "tryTerminal" ? (
            // Rehearse preview only: there is no scholar item to jump to, so we
            // describe the scholar's experience instead of dismissing the
            // dialog. Exit is the dialog's own close button (no second one).
            <HStack
              align="flex-start"
              gap={3}
              className="rh-lp-rise"
              bg="#f7f4ec"
              borderRadius="12px"
              px={4}
              py={3.5}
            >
              <Box color="#2f8f5f" pt="2px" flexShrink={0}>
                <PencilSimpleLine weight="fill" size={18} />
              </Box>
              <Text fontSize="15px" color="#3f4a44" lineHeight="1.6">
                {REHEARSE_TRY_FIRST_TERMINAL_COPY}
              </Text>
            </HStack>
          ) : (
            <VStack align="stretch" gap={4} className="rh-lp-rise">
              <LaunchpadAtoms atoms={methodAtoms} />
              <Button
                size="lg"
                colorPalette="teal"
                onClick={onNowYouTry}
                fontWeight="700"
                mt={1}
              >
                Now you try <ArrowRight weight="bold" />
              </Button>
            </VStack>
          )}
        </VStack>
      </Box>
    </Box>
  );
}
