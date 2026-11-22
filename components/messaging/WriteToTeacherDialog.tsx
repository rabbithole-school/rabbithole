"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { pasteKeepingLinks } from "@/components/messaging/pasteKeepingLinks";
import { WRITE_TO_TEACHER_COPY as COPY } from "@/shared/writeToTeacher";

/**
 * A scholar writes to ONE teacher at their school
 * (`scholarMessages.startConversationWithTeacher`). The message lands in the
 * conversation they already have with that teacher, else opens one; `onSent`
 * gets that thread. Native twin: WriteToTeacherSheet.
 */
export function WriteToTeacherDialog({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (threadId: Id<"parentThreads">) => void;
}) {
  const teachers = useQuery(api.scholarMessages.listTeachersForScholar, {});
  const start = useMutation(api.scholarMessages.startConversationWithTeacher);
  const [teacherId, setTeacherId] = useState<Id<"users"> | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A school with one teacher has nobody to choose between.
  const chosen = teacherId ?? (teachers?.length === 1 ? teachers[0]._id : null);
  const hasDraft = !!body.trim() || teacherId !== null;

  const submit = async () => {
    if (busy) return;
    if (!chosen) return setError(COPY.chooseFirst);
    if (!body.trim()) return setError(COPY.writeFirst);
    setBusy(true);
    setError("");
    try {
      const { threadId } = await start({ teacherId: chosen, body: body.trim() });
      onSent(threadId);
    } catch (e) {
      setError(serverErrorMessage(e, COPY.failed));
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(e) => {
        if (!e.open) close();
      }}
      closeOnInteractOutside={!hasDraft}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                {COPY.title}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack align="stretch" gap={4}>
                <Box>
                  <Text fontSize="sm" color="charcoal.500" mb={2} fontFamily="heading">
                    {COPY.toLabel}
                  </Text>
                  {teachers === undefined ? (
                    <HStack justify="center" py={4}>
                      <Spinner size="sm" color="violet.400" />
                    </HStack>
                  ) : teachers.length === 0 ? (
                    <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                      {COPY.noTeachers}
                    </Text>
                  ) : (
                    <HStack gap={2} flexWrap="wrap" role="radiogroup">
                      {teachers.map((teacher) => {
                        const selected = chosen === teacher._id;
                        return (
                          <Button
                            key={teacher._id}
                            role="radio"
                            aria-checked={selected}
                            size="sm"
                            variant="outline"
                            borderRadius="full"
                            fontFamily="heading"
                            borderWidth="1px"
                            bg={selected ? "violet.500" : "white"}
                            borderColor={selected ? "violet.500" : "gray.200"}
                            color={selected ? "white" : "charcoal.600"}
                            _hover={{ bg: selected ? "violet.600" : "gray.50" }}
                            onClick={() => setTeacherId(teacher._id)}
                            disabled={busy}
                          >
                            <Avatar
                              name={teacher.name}
                              src={teacher.image ?? undefined}
                              size="2xs"
                              colorKey={teacher._id}
                            />
                            {teacher.name}
                          </Button>
                        );
                      })}
                    </HStack>
                  )}
                </Box>
                <Box>
                  <Text fontSize="sm" color="charcoal.500" mb={1} fontFamily="heading">
                    {COPY.messageLabel}
                  </Text>
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onPaste={(e) => pasteKeepingLinks(e, setBody)}
                    placeholder={COPY.placeholder}
                    rows={6}
                    fontFamily="body"
                    fontSize="sm"
                    bg="gray.50"
                    disabled={busy}
                  />
                  <Text fontFamily="body" fontSize="xs" color="charcoal.400" mt={1.5}>
                    {COPY.note}
                  </Text>
                </Box>
                {error && (
                  <Text fontSize="sm" color="red.500" fontFamily="body">
                    {error}
                  </Text>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
              <Button
                variant="ghost"
                fontFamily="heading"
                size="sm"
                color="charcoal.500"
                onClick={close}
                disabled={busy}
              >
                {COPY.cancel}
              </Button>
              <Button
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                size="sm"
                onClick={submit}
                disabled={busy || !chosen || !body.trim()}
                loading={busy}
              >
                <PaperPlaneTilt weight="fill" style={{ marginRight: 6 }} />
                {COPY.send}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
