"use client";

import { useState } from "react";
import { Button, Dialog, Portal, Text } from "@chakra-ui/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { TeacherHandoffPill } from "@/components/TeacherHandoffPill";
import {
  HOMEWORK_DONE_CONFIRMED,
  HOMEWORK_DONE_HEADER,
  HOMEWORK_DONE_LABEL,
} from "@/shared/homeworkFraming";

/**
 * Homework's "I'm done with this", in the session header's right side. It is
 * the SAME `activityCompletions` toggle the Big picture drawer offers, given
 * a place a child can see — not a second way to finish
 * (review/homework-flow-plan.html barred that). The paper plane and the
 * pop-up match the iPad app builder's Send to teacher (native
 * TeacherHandoffSheet): the pill only opens the pop-up, which asks first;
 * once done the pill shows "Done" and the pop-up holds the undo.
 */
export function HomeworkDoneButton({
  done,
  onSetDone,
}: {
  done: boolean;
  /** Explicit, never a flip: the pop-up's answer must not invert if the
   *  state changed while it was open (e.g. from the Big picture drawer). */
  onSetDone: (done: boolean) => Promise<void>;
}) {
  // Which pop-up to show, fixed at open time and kept through the close fade,
  // so the copy never swaps while it is on screen (not when the save lands,
  // not while it fades out).
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<"ask" | "done">("ask");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const close = () => {
    if (saving) return;
    setFailed(false);
    setOpen(false);
  };

  // The mutation can legitimately reject (offline, a lesson-less activity),
  // and this is CHILD-facing: say so in their words inside the pop-up, never
  // as a raw error.
  const save = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await onSetDone(next);
      setSaving(false);
      setOpen(false);
    } catch (error) {
      console.warn("[session] homework completion change failed", error);
      setSaving(false);
      setFailed(true);
    }
  };

  const copy = sheet === "done" ? HOMEWORK_DONE_HEADER.done : HOMEWORK_DONE_HEADER.ask;

  return (
    <>
      <TeacherHandoffPill
        done={done}
        label={done ? HOMEWORK_DONE_HEADER.doneLabel : HOMEWORK_DONE_LABEL}
        ariaLabel={done ? HOMEWORK_DONE_CONFIRMED : HOMEWORK_DONE_LABEL}
        onClick={() => {
          setSheet(done ? "done" : "ask");
          setOpen(true);
        }}
      />
      {/* Dialog.Root stays mounted (open toggles) — never remount an Ark
          dialog scope while open (engineering-principles.md). */}
      <Dialog.Root
        open={open}
        onOpenChange={(e) => {
          if (!e.open) close();
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  {copy.title}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  {copy.body}
                </Text>
                {failed && (
                  <Text mt={2} fontSize="sm" fontFamily="body" color="orange.700">
                    {HOMEWORK_DONE_HEADER.failed}
                  </Text>
                )}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                {sheet === "done" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      fontFamily="heading"
                      loading={saving}
                      loadingText={HOMEWORK_DONE_HEADER.saving}
                      onClick={() => void save(false)}
                    >
                      {HOMEWORK_DONE_HEADER.done.undo}
                    </Button>
                    <Button
                      size="sm"
                      colorPalette="violet"
                      fontFamily="heading"
                      disabled={saving}
                      onClick={close}
                    >
                      {HOMEWORK_DONE_HEADER.done.close}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      fontFamily="heading"
                      disabled={saving}
                      onClick={close}
                    >
                      {HOMEWORK_DONE_HEADER.ask.cancel}
                    </Button>
                    <Button
                      size="sm"
                      colorPalette="violet"
                      fontFamily="heading"
                      loading={saving}
                      loadingText={HOMEWORK_DONE_HEADER.saving}
                      onClick={() => void save(true)}
                    >
                      {HOMEWORK_DONE_HEADER.ask.confirm}
                    </Button>
                  </>
                )}
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
