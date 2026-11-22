"use client";

/**
 * The "I wonder…" box (TRA-676), at the head of Today's wonders on
 * Scholar's Prep, its one home (Andy, 2026-11-15). Whatever a kid types or says
 * opens a chat that answers first, with no rocket and nobody's approval
 * (review/quests-rebuilt-proposal.html, "The model").
 *
 * Asking: `wonders.ask({ question, askedOn })` saves the wonder and opens its
 * chat; the words go to the chat screen (lib/wonderFirstTurn), which sends them
 * as the first turn through its own send path. A spoken take is sent as soon
 * as it is transcribed, the way the chat composer sends one.
 *
 * Words: shared/wonderRows.ts (`WONDER_COPY`), shared with the BunnyPad twin.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { Box, Flex, IconButton, Text, Textarea } from "@chakra-ui/react";
import { ArrowUp } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { DictationMicButton } from "@/components/DictationMicButton";
import type { MessageInputModality } from "@/components/SessionTranscript";
import { setWonderFirstTurn } from "@/lib/wonderFirstTurn";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import { WONDER_COPY } from "@/shared/wonderRows";

const BOX_ID = "wonder-box";

/** Set when the box was asked for before it was on screen (the Now tab's
 *  quiet-day "Start a Quest" switches to Prep first); the box takes the focus
 *  as it mounts. */
let focusRequested = false;

function focusBox(el: HTMLElement): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus({ preventScroll: true });
}

/** Bring the box into view and put the cursor in it, now if it is on screen,
 *  else as soon as it mounts. */
export function focusWonderBox(): void {
  const el = document.getElementById(BOX_ID);
  if (el) {
    focusRequested = false;
    focusBox(el);
  } else {
    focusRequested = true;
  }
}

export function WonderBox() {
  const router = useRouter();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusRequested && fieldRef.current) {
      focusRequested = false;
      focusBox(fieldRef.current);
    }
  }, []);
  const ask = useMutation(api.wonders.ask);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);

  const submit = async (raw: string, inputModality: MessageInputModality) => {
    const question = raw.trim();
    if (!question || asking) return;
    setAsking(true);
    try {
      const { sessionId } = await ask({ question, askedOn: { surface: "prep" } });
      setWonderFirstTurn(sessionId, { text: question, inputModality });
      router.push(`/scholar/${sessionId}`);
      // Navigation unmounts the box; `asking` stays up until it does.
    } catch (error) {
      console.error("[wonder-box] ask failed", error);
      toaster.error({ title: serverErrorMessage(error, "Couldn't ask that") });
      setAsking(false);
    }
  };

  return (
    <Box
      as="form"
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        void submit(text, "typed");
      }}
    >
      <Flex
        align="flex-end"
        gap={1}
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        pl={3}
        pr={1.5}
        py={1.5}
        _focusWithin={{ borderColor: "violet.400" }}
      >
        <Textarea
          id={BOX_ID}
          ref={fieldRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit(text, "typed");
            }
          }}
          placeholder={WONDER_COPY.boxPlaceholder}
          aria-label={WONDER_COPY.boxPlaceholder}
          autoresize
          rows={1}
          maxH="160px"
          // 16px keeps iOS Safari from zooming into the field.
          fontSize="16px"
          fontFamily="body"
          border="none"
          px={0}
          py={2}
          minH="40px"
          resize="none"
          _focusVisible={{ outline: "none", boxShadow: "none" }}
          disabled={asking}
        />
        <DictationMicButton
          size="md"
          borderRadius="full"
          disabled={asking}
          onTranscript={(spoken) =>
            void submit(text.trim() ? `${text.trim()} ${spoken}` : spoken, "spoken")
          }
        />
        <IconButton
          type="submit"
          aria-label={WONDER_COPY.boxSend}
          size="md"
          borderRadius="full"
          colorPalette="violet"
          variant="solid"
          loading={asking}
          disabled={!text.trim() || asking}
        >
          <ArrowUp />
        </IconButton>
      </Flex>
      <Text mt={1.5} px={1} fontSize="xs" color="charcoal.400" fontFamily="heading">
        {WONDER_COPY.boxHint}
      </Text>
    </Box>
  );
}
