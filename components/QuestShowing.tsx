"use client";

/**
 * "I'm ready to show": how a kid says their Quest is ready (TRA-684;
 * review/quests-rebuilt-proposal.html, figure 8, "Showing a Quest"). Since
 * TRA-720 it is the session header's action pill, the same pill and paper
 * plane as homework's "I'm done with this", on every Quest maker screen (the
 * chat with its bench or deck, and the app builder).
 *
 * The scholar session page knows once whether its session is an approved
 * Quest's (`QuestSessionProvider`, read from `questProposals.forSelf` by the
 * session's unit). Two things read it:
 *  - `QuestReadyToShowButton`, the pill. Tapping it opens a small pop-up,
 *    "How does it work? Say it in your own words" (one or two sentences,
 *    typed or said); Send calls `questShowing.markReadyToShow`, which posts
 *    the words in the Quest's thread and tells the advisor. After that the
 *    pill shows a checkmark and "Ready to show", and tapping it reopens the
 *    pop-up on the words they sent, with when, so they can update them. Once
 *    a teacher has awarded the badge the pill is gone: the Quests tab's row
 *    is the gold star by then.
 *  - the deliverable's "Finish and send" (ArtifactDeliverableButton), which a
 *    Quest's session doesn't offer: the pill is its one hand-in.
 *
 * Words: shared/questRows.ts QUEST_SHOWING_COPY, shared with the BunnyPad.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Button, Dialog, HStack, Portal, Text, Textarea } from "@chakra-ui/react";
import { Microphone, Stop } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TeacherHandoffPill } from "@/components/TeacherHandoffPill";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { useNow } from "@/hooks/useNow";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import {
  QUEST_SHOWING_COPY as COPY,
  QUEST_SHOWING_LIMITS,
  checkInMyWords,
  isShownQuest,
  questForSession,
  readyToShowWhen,
} from "@/shared/questRows";

type ApprovedQuest = FunctionReturnType<typeof api.questProposals.forSelf>["approved"][number];

/** The session's approved Quest; null when it isn't one; undefined while the
 *  read is on its way (so a hand-in doesn't flash up and vanish). */
const QuestSessionContext = createContext<ApprovedQuest | null | undefined>(null);

export function useQuestSession(): ApprovedQuest | null | undefined {
  return useContext(QuestSessionContext);
}

/** Looks the session's Quest up once for everything under it: the approved
 *  Quest whose maker activity this session is (shared/questRows.ts
 *  `questForSession`). `unitId` is null off the scholar's own view (remote or
 *  test mode), which is never a Quest session. A failed read counts as "not a
 *  Quest": the session keeps its ordinary hand-in. */
export function QuestSessionProvider({
  unitId,
  activityId,
  children,
}: {
  unitId: Id<"units"> | null | undefined;
  activityId: Id<"activities"> | null | undefined;
  children: React.ReactNode;
}) {
  const { data, error } = useContainedQuery(
    api.questProposals.forSelf,
    unitId ? {} : "skip",
  );
  const quest =
    !unitId || error
      ? null
      : data === undefined
        ? undefined
        : questForSession(data.approved, { unitId, activityId });
  return <QuestSessionContext.Provider value={quest}>{children}</QuestSessionContext.Provider>;
}

/** The header pill, on a Quest not yet shown. Draws nothing otherwise. */
export function QuestReadyToShowButton({ sessionId }: { sessionId: Id<"sessions"> }) {
  const quest = useQuestSession();
  if (!quest || isShownQuest(quest)) return null;
  return (
    <ReadyToShow
      // A fresh pop-up for each Quest: nothing typed carries across.
      key={String(quest.unitId)}
      sessionId={sessionId}
      unitId={quest.unitId}
      readyToShowAt={quest.readyToShowAt}
      sentWords={quest.inMyWords ?? ""}
    />
  );
}

function ReadyToShow({
  sessionId,
  unitId,
  readyToShowAt,
  sentWords,
}: {
  sessionId: Id<"sessions">;
  unitId: Id<"units">;
  readyToShowAt: number | null;
  sentWords: string;
}) {
  const markReady = useMutation(api.questShowing.markReadyToShow);
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(sentWords);
  const [sending, setSending] = useState(false);
  const ready = readyToShowAt != null;

  const dictation = useStreamingDictation((said) => {
    setText((current) => (current.trim() ? `${current.trim()} ${said.trim()}` : said.trim()));
  }, sessionId);
  const listening = dictation.state !== "idle";
  // Leaving the pop-up mid-take drops the take.
  const { cancelRecording } = dictation;
  useEffect(() => {
    if (!open) cancelRecording();
  }, [open, cancelRecording]);

  // Focus belongs in the box once the pop-up is open, after the words they
  // sent so they can add to them. The app's iframe holds focus until told
  // otherwise (and takes it back when it finishes loading), so typing would
  // land in the app: focus the box after the pop-up has painted, and again
  // shortly after in case the app re-grabbed it.
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    const focusBox = () => {
      const box = boxRef.current;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== box) active.blur();
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    };
    const frame = requestAnimationFrame(focusBox);
    const later = window.setTimeout(() => {
      if (document.activeElement !== boxRef.current) focusBox();
    }, 250);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(later);
    };
  }, [open]);

  const checked = checkInMyWords(text);
  const send = async () => {
    if (!checked.ok || sending) return;
    setSending(true);
    try {
      await markReady({ unitId, inMyWords: checked.words });
      setOpen(false);
    } catch (error) {
      console.error("[quest-showing] couldn't send", error);
      toaster.error({ title: serverErrorMessage(error, "Couldn't send that") });
    } finally {
      setSending(false);
    }
  };

  const close = () => {
    if (!sending) setOpen(false);
  };

  return (
    <>
      <TeacherHandoffPill
        done={ready}
        label={ready ? COPY.rowReady : COPY.readyToShow}
        ariaLabel={
          ready ? COPY.readyAt(readyToShowWhen(readyToShowAt, now)) : COPY.readyToShow
        }
        onClick={() => {
          // Opens on the words they sent, or empty the first time.
          setText(sentWords);
          setOpen(true);
        }}
      />
      {/* Dialog.Root stays mounted (open toggles): never remount an Ark
          dialog scope while open (engineering-principles.md). */}
      <Dialog.Root
        open={open}
        onOpenChange={(e) => {
          if (!e.open) close();
        }}
        placement="center"
        initialFocusEl={() => boxRef.current}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="md">
              <Dialog.Header px={6} pt={5} pb={1} flexDirection="column" alignItems="start">
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  {COPY.sheetTitle}
                </Dialog.Title>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  {COPY.sheetHint}
                </Text>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={COPY.sheetPlaceholder}
                  rows={3}
                  maxLength={QUEST_SHOWING_LIMITS.maxInMyWords + 200}
                  aria-label={COPY.sheetTitle}
                  ref={boxRef}
                />
                {!checked.ok && checked.reason ? (
                  <Text mt={2} fontSize="xs" color="red.600">
                    {checked.reason}
                  </Text>
                ) : null}
                {dictation.error ? (
                  <Text mt={2} fontSize="xs" color="red.600">
                    {dictation.error}
                  </Text>
                ) : null}
                {ready ? (
                  <Text mt={2} fontSize="xs" fontFamily="heading" color="charcoal.500">
                    {COPY.readyAt(readyToShowWhen(readyToShowAt, now))}
                  </Text>
                ) : null}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} justifyContent="space-between">
                <Button
                  size="sm"
                  variant="ghost"
                  color="charcoal.600"
                  fontFamily="heading"
                  onClick={() => void dictation.toggleRecording()}
                  disabled={dictation.isMicBusy && !listening}
                >
                  {listening ? <Stop size={14} weight="fill" /> : <Microphone size={14} weight="fill" />}
                  {listening ? COPY.micStop : COPY.mic}
                </Button>
                <HStack gap={2}>
                  <Button
                    size="sm"
                    variant="outline"
                    fontFamily="heading"
                    onClick={close}
                    disabled={sending}
                  >
                    {COPY.cancel}
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="violet"
                    fontFamily="heading"
                    onClick={() => void send()}
                    loading={sending}
                    disabled={!checked.ok || listening}
                  >
                    {ready ? COPY.update : COPY.send}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
