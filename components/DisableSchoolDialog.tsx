"use client";

/**
 * DISABLE SCHOOL — the confirmation surface for temporarily suspending an
 * institution. Distinct from delete: this is REVERSIBLE and destroys NOTHING.
 * The copy states plainly what pausing does and that it can be undone with one
 * click. Platform-admin only (the mutation re-checks; the button is defence in
 * depth, never the only guard). The server also refuses the primary school.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Heading,
  HStack,
  IconButton,
  Portal,
  Stack,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { PauseCircle, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import {
  disableSchoolCopy,
  type SchoolLifecycleNoun,
} from "@/components/schoolLifecycleCopy";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";

interface DisableSchoolDialogProps {
  open: boolean;
  onClose: () => void;
  institutionId: Id<"institutions">;
  schoolName: string;
  // The caller owns the vocabulary (T12): /school/settings passes "school",
  // /admin/institutions passes "institution". No default — every caller must
  // declare which word its surface speaks.
  noun: SchoolLifecycleNoun;
}

export function DisableSchoolDialog({
  open,
  onClose,
  institutionId,
  schoolName,
  noun,
}: DisableSchoolDialogProps) {
  const copy = disableSchoolCopy(noun);
  const disableInstitution = useMutation(
    api.institutionLifecycle.disableInstitution,
  );
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    if (submitting) return;
    setReason("");
    onClose();
  };

  const handleDisable = async () => {
    setSubmitting(true);
    try {
      await disableInstitution({
        institutionId,
        reason: reason.trim() || undefined,
      });
      toaster.success({
        title: `Paused ${schoolName}`,
        description: copy.successDescription,
      });
      setSubmitting(false);
      handleClose();
    } catch (e) {
      toaster.error({
        title: copy.errorTitle,
        description: e instanceof Error ? e.message : String(e),
      });
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => !d.open && handleClose()}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={6} pb={2}>
              <HStack gap={3} flex={1} minW={0} align="flex-start">
                <Box color="amber.500" mt={1}>
                  <PauseCircle size={24} weight="fill" />
                </Box>
                <Stack gap={0} flex={1} minW={0}>
                  <Text
                    fontSize="xs"
                    color="amber.600"
                    fontFamily="heading"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="0.05em"
                  >
                    Reversible — nothing is deleted
                  </Text>
                  <Heading
                    size="md"
                    color="navy.500"
                    fontFamily="heading"
                    fontWeight="700"
                    lineClamp={2}
                  >
                    Pause {schoolName}
                  </Heading>
                </Stack>
              </HStack>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  onClick={handleClose}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body px={6} pb={6} pt={2}>
              <VStack align="stretch" gap={4}>
                <Text fontFamily="body" color="charcoal.600">
                  {copy.accessPausedDescription}{" "}
                  <b>All of {schoolName}&apos;s data is kept exactly as it is.</b>{" "}
                  {copy.otherActiveSentence}{" "}
                  You can <b>resume with one click</b> to fully restore access.
                </Text>

                <Box>
                  <Text
                    fontFamily="heading"
                    fontWeight="600"
                    fontSize="sm"
                    color="charcoal.500"
                    mb={1}
                  >
                    Reason (optional)
                  </Text>
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. billing paused"
                    disabled={submitting}
                    bg="gray.50"
                    fontFamily="body"
                    rows={2}
                    aria-label={copy.reasonAriaLabel}
                  />
                </Box>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer px={6} pb={6} pt={0} gap={2}>
              <Button
                variant="ghost"
                fontFamily="heading"
                onClick={handleClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                bg="amber.500"
                color="white"
                _hover={{ bg: "amber.600" }}
                fontFamily="heading"
                onClick={() => void handleDisable()}
                loading={submitting}
                loadingText="Pausing…"
              >
                {copy.confirmButton}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
