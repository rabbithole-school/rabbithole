"use client";

/**
 * "Give…" on a Run page activity row (TRA-571): the two-question form for one
 * activity on one assignment. "Now" goes live through `pushActivity`; a later
 * time plans it through `scheduleActivity`. Both send the teacher's finish
 * answer; the server maps it onto stored fields.
 *
 * Shell + inner form split for the same reason as ScheduleActivityDialog: the
 * Dialog.Root stays mounted and the form re-seeds by mounting only while open
 * (engineering-principles.md, the body-lock leak).
 */
import { useState } from "react";
import { Button, Dialog, Flex, HStack, Portal, Text } from "@chakra-ui/react";
import { HandArrowUp } from "@phosphor-icons/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import {
  GiveWindowFields,
  giveButtonLabel,
  showsUpAt,
  useGiveChoices,
  useMinuteNow,
  type GiveFinish,
  type ShowsUp,
} from "@/components/GiveWindowFields";

type GiveDialogProps = {
  open: boolean;
  onClose: () => void;
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  activityTitle: string;
  audienceLabel: string;
};

export function GiveDialog(props: GiveDialogProps) {
  const { open, onClose } = props;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => !d.open && onClose()}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="480px" w="92vw" borderRadius="xl">
            {open && <GiveForm {...props} />}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function GiveForm({
  onClose,
  assignmentId,
  activityId,
  activityTitle,
  audienceLabel,
}: GiveDialogProps) {
  const nowMs = useMinuteNow();
  const [showsUp, setShowsUp] = useState<ShowsUp>({ kind: "now" });
  const [finish, setFinish] = useState<GiveFinish | null>(null);
  const [saving, setSaving] = useState(false);
  const startsAt = showsUpAt(showsUp, nowMs);
  const choices = useGiveChoices(
    { assignmentId, activityId, startsAt },
    nowMs,
  );
  const pushActivity = useMutation(api.assignments.pushActivity);
  const scheduleActivity = useMutation(api.assignments.scheduleActivity);

  const give = async () => {
    if (!finish) return;
    setSaving(true);
    try {
      if (showsUp.kind === "now") {
        await pushActivity({ assignmentId, activityId, finish });
      } else {
        await scheduleActivity({
          assignmentId,
          activityId,
          startsAt: showsUp.at,
          finish,
        });
      }
      toaster.success({
        title: showsUp.kind === "now" ? "Given" : "Planned",
        description: activityTitle,
      });
      onClose();
    } catch (error) {
      toaster.error({
        title: "Couldn't give that",
        description: serverErrorMessage(error, "Check your connection and try again."),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog.Header px={6} pt={5} pb={3}>
        <HStack gap={2} align="flex-start">
          <HandArrowUp size={20} weight="duotone" />
          <Text fontFamily="heading" fontWeight="700" color="navy.500">
            Give &ldquo;{activityTitle}&rdquo; to {audienceLabel}
          </Text>
        </HStack>
      </Dialog.Header>
      <Dialog.Body px={6} pb={6} pt={0}>
        <GiveWindowFields
          choices={choices}
          nowMs={nowMs}
          showsUp={showsUp}
          onShowsUpChange={setShowsUp}
          finish={finish}
          onFinishChange={setFinish}
        />
        <Flex justify="flex-end" gap={2} pt={5}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            bg="violet.600"
            color="white"
            _hover={{ bg: "violet.700" }}
            disabled={!finish || saving}
            loading={saving}
            onClick={() => void give()}
          >
            {giveButtonLabel(finish)}
          </Button>
        </Flex>
      </Dialog.Body>
    </>
  );
}
