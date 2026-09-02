"use client";

/**
 * LaunchpadContent — the shared, presentation-only renderer for a Launchpad's
 * instructional atoms (instructional segments v1). Used BOTH inline on the
 * doorway card's "Show me the move" path (LaunchpadCard) and inside the
 * "See an example" sheet (InstructionExampleSheet), so the worked example reads
 * identically wherever the scholar meets it.
 *
 * It renders five atom kinds, in authored order:
 *  - `story_hook`   — a short real-world framing (why this move exists),
 *  - `micro_explain`— the plain statement of the move,
 *  - `worked_example`— a GENUINE worked example: a named strategy, ordered
 *    steps, and one fully-worked problem WITH its answer. The answer is shown on
 *    purpose — the example uses its OWN canonical numbers, decoupled from any
 *    live item, so seeing it can never leak a graded answer (the load-bearing
 *    invariant from the adversarial review).
 *  - `try_it`       — the INTERACTIVE twin of `worked_example`: the same steps,
 *    but the final answer is FADED and the scholar produces it, graded
 *    CLIENT-SIDE with the shared `gradeTryItAtom` (the same `parseAnswer`/
 *    `answersEqual` path). Records nothing, touches no mastery.
 *  - `manipulative` — an UNGRADED instance of the existing manipulative
 *    primitive, rendered by the SAME `Manipulative` frame (standalone mode: no
 *    `onCommit`, so its own `isSolved` self-check drives the "you did it" chip).
 *    Never a forked renderer, never a mastery write.
 *
 * Purely visual: no mutations, no lifecycle. The parent owns claim/record. The
 * interactive atoms carry only LOCAL, ungraded self-check state.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, HStack, Input, Text, VStack } from "@chakra-ui/react";
import { CaretDown, Check, Compass, ListNumbers, Play, X } from "@phosphor-icons/react";
import { useTTSQueue } from "@/hooks/useTTSQueue";
import { FractionText } from "@/components/FractionText";
import { hasPracticeMath } from "@/shared/fractions";
import { superscriptExponents } from "@/shared/mathNotation";
import { Manipulative } from "@/components/manipulative/Manipulative";
import { MultiStepSequenceChallenge } from "@/components/manipulative/challenges/MultiStepSequenceChallenge";
import { parseInstructionManipulative } from "@/lib/manipulative/types";
import { WorkedSteps } from "@/components/practice/WorkedSteps";
import type { FadeResult } from "@/convex/lib/practice/fadedSteps";
import type { AnswerType } from "@/convex/lib/practice/answers";
import {
  gradeTryItAtom,
  instructionVideoEmbedUrl,
  tryItFade,
  type InstructionAtom,
  type InstructionVideoAtom,
} from "@/convex/lib/practice/instructionEntries";

/** Render a math-bearing string with the app's fraction/exponent treatment. */
function MathText({
  value,
  fontSize = "15px",
  color = "#3f4a44",
  weight = 400,
}: {
  value: string;
  fontSize?: string;
  color?: string;
  weight?: number;
}) {
  if (hasPracticeMath(value)) {
    return <FractionText value={value} inline fontSize={parseInt(fontSize, 10)} color={color} align="center" />;
  }
  return (
    <Text as="span" fontSize={fontSize} color={color} fontWeight={weight} lineHeight="1.6">
      {superscriptExponents(value)}
    </Text>
  );
}

function StoryHook({ hook }: { hook: string }) {
  return (
    <Box bg="#f7f4ec" borderRadius="12px" px={4} py={3}>
      <HStack gap={2} align="flex-start">
        <Box color="#8a7b52" pt="2px" flexShrink={0}>
          <Compass weight="fill" size={18} />
        </Box>
        <Text fontSize="14.5px" color="#5c5540" lineHeight="1.6" fontStyle="italic">
          {hook}
        </Text>
      </HStack>
    </Box>
  );
}

function MicroExplain({ text }: { text: string }) {
  return (
    <Text fontSize="16px" color="#2f3b34" lineHeight="1.65">
      {superscriptExponents(text)}
    </Text>
  );
}

/** Copy for the accumulating "Show me the move" reveal (shared web/native). */
export const WORKED_NEXT_STEP_LABEL = "Show me the next step";
export const WORKED_SEE_IT_WORK_LABEL = "See it work";

/**
 * Pure reveal state for the accumulating worked example (F2). The scholar starts
 * with only step 1 visible and taps to append the next step below the prior ones
 * (earlier steps never hide — working-memory support); the FINAL reveal is the
 * "See it work" example prompt + answer, so the answer is not pre-spoiled. There
 * are `stepCount + 1` reveals in all (the +1 is the answer). No timer, no
 * auto-advance — revealing a step is the scholar's own tap.
 */
export function workedExampleReveal(
  stepCount: number,
  revealed: number,
): { visibleStepCount: number; showAnswer: boolean; hasMore: boolean; nextLabel: string } {
  const total = stepCount + 1;
  const clamped = Math.max(1, Math.min(revealed, total));
  const visibleStepCount = Math.min(clamped, stepCount);
  const showAnswer = clamped > stepCount;
  const hasMore = clamped < total;
  // The reveal that uncovers the answer is labelled "See it work"; every earlier
  // tap just appends the next step.
  const nextLabel = clamped >= stepCount ? WORKED_SEE_IT_WORK_LABEL : WORKED_NEXT_STEP_LABEL;
  return { visibleStepCount, showAnswer, hasMore, nextLabel };
}

function WorkedExample({
  strategyLabel,
  steps,
  examplePrompt,
  exampleAnswer,
}: {
  strategyLabel: string;
  steps: string[];
  examplePrompt: string;
  exampleAnswer: string;
}) {
  // Start with only step 1 visible; each tap appends the next step below, and
  // the last tap reveals the "See it work" answer (see `workedExampleReveal`).
  const [revealed, setRevealed] = useState(1);
  const fade = useMemo<FadeResult>(
    () => ({ revealed: steps.map((text) => ({ text })), faded: [] }),
    [steps],
  );
  const { visibleStepCount, showAnswer, hasMore, nextLabel } = workedExampleReveal(
    steps.length,
    revealed,
  );

  return (
    <Box
      w="100%"
      bg="#fbfaf6"
      border="1px solid #e4dfd2"
      borderRadius="14px"
      p={4}
    >
      <VStack align="stretch" gap={3.5}>
        <HStack gap={2} color="#2f6b52">
          <ListNumbers weight="bold" size={18} />
          <Text fontSize="13px" fontWeight="700" letterSpacing="0.01em" textTransform="uppercase">
            {strategyLabel}
          </Text>
        </HStack>

        {/* Accumulating reveal through the SAME faded-scaffold surface (F2);
            tap-to-hear each step via `speakable`, never auto-played. */}
        <WorkedSteps
          steps={fade}
          label="Step by step"
          speakable
          revealedCount={visibleStepCount}
        />

        {showAnswer && (
          <Box borderTop="1px solid #ece7da" pt={3}>
            <Text fontSize="12px" fontWeight="700" color="#7c8a86" textTransform="uppercase" letterSpacing="0.05em" mb={1.5}>
              See it work
            </Text>
            <Box mb={1}>
              <MathText value={examplePrompt} fontSize="15px" color="#3f4a44" />
            </Box>
            <HStack gap={2} align="baseline">
              <Text fontSize="13px" color="#7c8a86">gives</Text>
              <MathText value={exampleAnswer} fontSize="18px" color="#1f6b48" weight={700} />
            </HStack>
          </Box>
        )}

        {hasMore && (
          <Button
            size="sm"
            alignSelf="flex-start"
            variant="outline"
            colorPalette="teal"
            onClick={() => setRevealed((r) => r + 1)}
            fontWeight="700"
          >
            {nextLabel} <CaretDown weight="bold" />
          </Button>
        )}
      </VStack>
    </Box>
  );
}

/**
 * `try_it` — the interactive twin of `WorkedExample`. Same strategy + numbered
 * steps, but instead of revealing the answer it fades the final step: the
 * scholar types the answer, and it's graded CLIENT-SIDE with the shared
 * `gradeTryItAtom`. Ungraded, records nothing — the local state below is the
 * ONLY state it owns, and no mutation is ever called.
 */
function TryItAtom({
  strategyLabel,
  steps,
  examplePrompt,
  exampleAnswer,
  answerType,
}: {
  strategyLabel: string;
  steps: string[];
  examplePrompt: string;
  exampleAnswer: string;
  answerType?: AnswerType;
}) {
  const [input, setInput] = useState("");
  const [attempt, setAttempt] = useState<{ correct: boolean; input: string } | null>(null);

  // The faded scaffold: every step revealed EXCEPT the final answer-producing
  // one, rendered through the SAME `WorkedSteps` surface the post-miss teaching
  // moment uses — so the answer is never shown verbatim (finding: try_it must fade).
  const fade = useMemo(() => tryItFade(steps) as FadeResult, [steps]);
  // Once attempted, fill the blank with the scholar's value (right) or the
  // correct answer (wrong) — mirrors `TeachingStep`'s completed scaffold.
  const completed: FadeResult = {
    revealed: [...fade.revealed, { text: attempt?.correct ? attempt.input : exampleAnswer }],
    faded: [],
  };

  const onCheck = () => {
    if (!input.trim() || attempt) return;
    setAttempt({ correct: gradeTryItAtom(input, { exampleAnswer, answerType }), input: input.trim() });
  };

  return (
    <VStack align="stretch" gap={3} w="100%">
      <HStack gap={2} color="#2f6b52">
        <ListNumbers weight="bold" size={18} />
        <Text fontSize="13px" fontWeight="700" letterSpacing="0.01em" textTransform="uppercase">
          {strategyLabel}
        </Text>
      </HStack>

      <Box>
        <MathText value={examplePrompt} fontSize="15px" color="#3f4a44" weight={600} />
      </Box>

      <WorkedSteps steps={attempt ? completed : fade} label="Now you try — finish the last step" showWhenOnlyFaded />

      {attempt ? (
        attempt.correct ? (
          <HStack gap={1.5} color="#146c43">
            <Check weight="bold" />
            <Text fontWeight="700" fontSize="15px">
              That&apos;s it! <MathText value={exampleAnswer} fontSize="16px" color="#146c43" weight={700} />
            </Text>
          </HStack>
        ) : (
          <HStack gap={1.5} color="#8a6d16">
            <X weight="bold" />
            <Text fontSize="14px">
              Not quite — the answer is <MathText value={exampleAnswer} fontSize="15px" color="#8a6d16" weight={700} />.
            </Text>
          </HStack>
        )
      ) : (
        <HStack gap={2}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCheck();
            }}
            placeholder="type the last step"
            size="md"
            maxW="200px"
            bg="white"
          />
          <Button colorPalette="teal" onClick={onCheck} disabled={!input.trim()}>
            Check
          </Button>
        </HStack>
      )}
    </VStack>
  );
}

/**
 * `manipulative` — an UNGRADED "try the move" instance of the existing
 * manipulative primitive. Reuses the SAME `Manipulative` frame verbatim in its
 * standalone mode (no `onCommit`): the frame's own `isSolved` self-check drives
 * the "you did it" chip and NOTHING is submitted or written. A spec that won't
 * parse degrades to nothing rather than crashing the card.
 */
function ManipulativeAtom({ spec: specJson }: { spec: string }) {
  const parsed = parseInstructionManipulative(specJson);
  if (!parsed) return null;
  return (
    <Box w="100%">
      {parsed.mode === "sequence" ? (
        // A GUIDED sequence — the staged concrete teaching arc (explore →
        // directed steps → one bare step). Rendered by the SAME generic Model-A
        // renderer graded practice uses; ungraded here purely because nothing
        // above the spec boundary submits anything.
        <MultiStepSequenceChallenge spec={parsed.spec} />
      ) : (
        <Manipulative spec={parsed.spec} />
      )}
    </Box>
  );
}

/**
 * The eyebrow voice for the video atom — "see the move", not the literal word
 * "Video" and never "Watch this video". Kept as an exported constant so the
 * copy is asserted in a test rather than only in a screenshot.
 */
export const VIDEO_EYEBROW_LABEL = "See the move";

/**
 * The no-autoplay guarantee, as a pure seam: the player frame's `src` is `null`
 * until the scholar taps play, so NO iframe (and therefore no network/media
 * request) exists before the tap. Autoplay and auto-sound are standing bans
 * (`.claude/rules/rabbithole-practice-engine.md`). `playing === true` only ever
 * follows a tap, so this is the single decision that keeps watching active.
 * Uses the shared `instructionVideoEmbedUrl` (privacy-enhanced, clipped) — the
 * renderer never hand-builds a YouTube URL.
 */
export function videoIframeSrc(
  atom: Pick<InstructionVideoAtom, "videoId" | "startSec" | "endSec">,
  playing: boolean,
  origin?: string,
): string | null {
  if (!playing) return null;
  const src = instructionVideoEmbedUrl(atom);
  const runtimeOrigin = origin ?? (
    typeof window === "undefined" ? undefined : window.location?.origin
  );
  return runtimeOrigin
    ? `${src}&enablejsapi=1&origin=${encodeURIComponent(runtimeOrigin)}`
    : src;
}

/** The clock poll wins the race to hide YouTube's end-screen suggestion grid. */
export function videoHasReachedEnd(currentTime: number | undefined, endSec: number): boolean {
  return typeof currentTime === "number" && currentTime >= endSec - 0.1;
}

/**
 * `video` — a clipped, tap-to-play instructional clip (plan §7). Doctrine baked
 * into the shape of this renderer:
 *  - TAP TO PLAY, never autoplay: the iframe is not mounted until the scholar
 *    taps (`videoIframeSrc` returns `null` first). The poster carries the play
 *    affordance; playing pauses the app-wide TTS singleton.
 *  - The `src` comes ONLY from `instructionVideoEmbedUrl` (youtube-nocookie,
 *    clipped) — no hand-built URL, no switching off nocookie.
 *  - The YouTube player is NEVER overlaid or restyled (YouTube prohibits
 *    obscuring its controls/branding) — all Rabbithole chrome sits OUTSIDE the
 *    16:9 frame, above the player (why-watch).
 *  - NO per-clip "Source: …" link below the player: the source credit lives on
 *    the pre-auth /sources page (which carries Khan Academy's required notice
 *    verbatim), and the embedded player itself shows the channel branding.
 */
function VideoAtom({ atom }: { atom: InstructionVideoAtom }) {
  const [playing, setPlaying] = useState(false);
  const [watched, setWatched] = useState(false);
  const { stop } = useTTSQueue();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const src = videoIframeSrc(atom, playing);

  const onPlay = () => {
    // The app owns a single utterance app-wide; a starting video stops it so the
    // clip's audio never overlaps a spoken label (no second audio manager).
    stop();
    setPlaying(true);
  };

  useEffect(() => {
    if (!playing || !src) return;

    const iframeOrigin = new URL(src).origin;
    const finish = () => {
      // Unmounting is what prevents YouTube's suggestion grid from painting.
      setPlaying(false);
      setWatched(true);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data as { event?: string; info?: unknown };
      } catch {
        return;
      }

      // The clock poll is primary: it receives infoDelivery before the player's
      // own ENDED state, which is late enough for YouTube to show suggestions.
      if (
        data.event === "infoDelivery" &&
        typeof (data.info as { currentTime?: unknown } | undefined)?.currentTime === "number" &&
        videoHasReachedEnd((data.info as { currentTime: number }).currentTime, atom.endSec)
      ) {
        finish();
      } else if (data.event === "onStateChange" && data.info === 0) {
        finish();
      }
    };
    const requestCurrentTime = () => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "getCurrentTime", args: [] }),
        iframeOrigin,
      );
    };

    window.addEventListener("message", onMessage);
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening" }), iframeOrigin);
    requestCurrentTime();
    const timer = window.setInterval(requestCurrentTime, 100);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
    };
  }, [atom.endSec, playing, src]);

  return (
    <VStack align="stretch" gap={3} w="100%">
      {/* Eyebrow + one-line "why watch" ABOVE the player. */}
      <VStack align="stretch" gap={1}>
        <HStack gap={2} color="#2f6b52">
          <Play weight="fill" size={18} />
          <Text fontSize="13px" fontWeight="700" letterSpacing="0.01em" textTransform="uppercase">
            {VIDEO_EYEBROW_LABEL}
          </Text>
        </HStack>
        <Text fontSize="15px" color="#3f4a44" lineHeight="1.6">
          {atom.captionText}
        </Text>
      </VStack>

      {/* 16:9 fluid frame. Deliberately NO min-width: the Launchpad card is
          maxW 460px (LaunchpadCard) and the Rehearse dialog 520px, so pinning
          YouTube's *recommended* 480px would overflow the card horizontally on
          the surface this actually renders in. 480×270 is a recommendation; the
          documented hard floor is 200×200, which a fluid 16:9 frame clears in
          every container we render into. */}
      <Box
        position="relative"
        w="100%"
        aspectRatio="16 / 9"
        borderRadius="12px"
        borderWidth="1px"
        borderColor="#e2ded2"
        overflow="hidden"
        bg="#1c1f1d"
      >
        {src ? (
          <iframe
            ref={iframeRef}
            title={atom.captionText}
            src={src}
            // Rabbithole never overlays or restyles the YouTube player — the
            // iframe fills the frame verbatim.
            width="100%"
            height="100%"
            allow="encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              border: 0,
              display: "block",
            }}
          />
        ) : (
          // Poster/placeholder with a play affordance — the ONLY thing that
          // mounts the iframe. No YouTube pixel is loaded before this tap.
          <Button
            onClick={onPlay}
            aria-label="Play video"
            position="absolute"
            top={0}
            left={0}
            w="100%"
            h="100%"
            borderRadius={0}
            bg="transparent"
            _hover={{ bg: "rgba(255,255,255,0.06)" }}
            display="flex"
            flexDirection="column"
            gap={2}
            color="#f4f1e8"
          >
            <Box
              w="56px"
              h="56px"
              borderRadius="9999px"
              bg="rgba(0,0,0,0.55)"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Play weight="fill" size={26} />
            </Box>
            <Text fontSize="14px" fontWeight="600">
              {watched ? "Watch again" : "Tap to play"}
            </Text>
          </Button>
        )}
      </Box>
    </VStack>
  );
}

/** Render a Launchpad's atoms in authored order. Unknown kinds are skipped. */
export function LaunchpadAtoms({ atoms }: { atoms: InstructionAtom[] }) {
  return (
    <VStack align="stretch" gap={4} w="100%">
      {atoms.map((atom, i) => {
        if (atom.kind === "story_hook") return <StoryHook key={i} hook={atom.hook} />;
        if (atom.kind === "micro_explain") return <MicroExplain key={i} text={atom.text} />;
        if (atom.kind === "worked_example") {
          return (
            <WorkedExample
              key={i}
              strategyLabel={atom.strategyLabel}
              steps={atom.steps}
              examplePrompt={atom.examplePrompt}
              exampleAnswer={atom.exampleAnswer}
            />
          );
        }
        if (atom.kind === "try_it") {
          return (
            <TryItAtom
              key={i}
              strategyLabel={atom.strategyLabel}
              steps={atom.steps}
              examplePrompt={atom.examplePrompt}
              exampleAnswer={atom.exampleAnswer}
              answerType={atom.answerType}
            />
          );
        }
        if (atom.kind === "manipulative") {
          return <ManipulativeAtom key={i} spec={atom.spec} />;
        }
        if (atom.kind === "video") {
          return <VideoAtom key={i} atom={atom} />;
        }
        return null;
      })}
    </VStack>
  );
}
