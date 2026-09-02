"use client";

/**
 * Scholar-facing dialog: "Start a Quest." A two-step flow:
 *   1. Details — what do you want to learn? (title + optional context)
 *   2. Choose your path — the SAME live "choose your path" menu a topic-seed
 *      quest shows (`BakePathPicker`): "Endless chat" or one of 2-4 bot-
 *      suggested structured ways in.
 *
 * On launch it creates a Unit (with authorScholarId set to the scholar), drops
 * the scholar straight into an ad-lib session, and fires the background "bake"
 * — threading the chosen path so the quest is designed around that angle (DRY
 * with the seed flow; see review/seed-to-unit-bake-plan.md). "Endless chat"
 * bakes with no chosen angle, exactly like before this menu existed.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  Portal,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Lock, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { BakePathPicker } from "@/components/BakePathPicker";
import { ENDLESS_CHAT, type PathChoice } from "@/lib/bakePaths";
import { api } from "@/convex/_generated/api";
import { toaster } from "@/lib/toaster";

interface CreateQuestDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * The live class-focus lock (from the scholar Home). When set, a new custom
   * quest would open an out-of-focus session that lands on the read-only wall,
   * so the creation flow is GATED AT ENTRY: the form is replaced with a quiet
   * locked notice and creation cannot proceed. `label` names what the class is
   * on right now. Null = no lock (or teacher remote view).
   */
  focusLock?: { unitId: string | null; label: string | null } | null;
  prepMode?: boolean;
}

export function CreateQuestDialog({
  open,
  onClose,
  focusLock = null,
  prepMode = false,
}: CreateQuestDialogProps) {
  const router = useRouter();
  const [step, setStep] = useState<"details" | "path">("details");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<PathChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const createQuest = useMutation(api.units.createQuest);
  const createSession = useMutation(api.sessions.create);
  const scheduleBake = useMutation(api.units.scheduleCustomQuestBake);
  const addSessionToPlan = useMutation(api.takeHomePlans.addSessionToPlan);

  // A live class focus locks NEW quest creation — the fresh quest opens an
  // anchorless (out-of-focus) session that would hit the read-only wall. Gate
  // the whole flow at ENTRY.
  const locked = !!focusLock?.unitId;

  const reset = () => {
    setStep("details");
    setTitle("");
    setDescription("");
    setChosen(null);
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
    reset();
  };

  const goToPath = () => {
    if (!title.trim() || locked) return;
    setStep("path");
  };

  const handleCreate = async () => {
    if (submitting || !chosen || locked) return;
    const t = title.trim();
    if (!t) return;
    setSubmitting(true);
    try {
      const result = await createQuest({
        title: t,
        description: description.trim() || undefined,
      });
      // Drop the scholar straight into an exploration session on their new
      // quest so they can start chatting with the AI tutor immediately (the
      // unit gives it a title + a completion badge as the container).
      const session = await createSession({ unitId: result.unitId });
      // Fire the background "bake": design a real lesson + activities for this
      // quest and upgrade the session in place once it lands — the scholar
      // never waits for it. "Endless chat" → no chosen angle (a plain bake);
      // any other choice steers the bake. Best-effort; the ad-lib session
      // works regardless.
      const bakePath =
        chosen === ENDLESS_CHAT
          ? undefined
          : { title: chosen.title, blurb: chosen.blurb };
      try {
        await scheduleBake({
          unitId: result.unitId,
          sessionId: session.id,
          ...(bakePath ? { bakePath } : {}),
        });
      } catch {
        // Non-fatal — the quest still works as an ad-lib exploration.
      }
      if (prepMode) {
        await addSessionToPlan({ sessionId: session.id });
        toaster.success({ title: "Quest added to tonight", description: `"${t}" is ready when you are.` });
        onClose();
        reset();
        return;
      }
      router.push(`/scholar/${session.id}`);
      toaster.success({
        title: "Quest created",
        description: `"${t}" — start exploring!`,
      });
      onClose();
      reset();
    } catch (e) {
      toaster.error({
        title: "Couldn't create",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
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
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1} minW={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Quest
                </Text>
                {locked ? (
                  <Heading
                    size="md"
                    color="navy.500"
                    fontFamily="heading"
                    fontWeight="700"
                  >
                    New quests are paused
                  </Heading>
                ) : step === "details" ? (
                  <Heading
                    size="md"
                    color="navy.500"
                    fontFamily="heading"
                    fontWeight="700"
                  >
                    {prepMode ? "Shape a new quest" : "What do you want to learn?"}
                  </Heading>
                ) : (
                  <Heading
                    size="md"
                    color="navy.500"
                    fontFamily="heading"
                    fontWeight="700"
                    lineClamp={2}
                  >
                    {title.trim()}
                  </Heading>
                )}
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                  disabled={submitting}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            {locked ? (
              <>
                <Dialog.Body px={6} py={4}>
                  <Stack gap={3} align="flex-start">
                    <HStack gap={2} color="charcoal.400">
                      <Lock size={16} />
                      <Text fontSize="sm" fontFamily="heading" fontWeight="600">
                        {focusLock?.label
                          ? `After you finish: ${focusLock.label}`
                          : "After you finish your class focus"}
                      </Text>
                    </HStack>
                    <Text fontSize="sm" color="charcoal.500" fontFamily="body" lineHeight="1.5">
                      Your class is focused on{" "}
                      {focusLock?.label ? (
                        <Text as="span" fontWeight="600" color="charcoal.600">
                          {focusLock.label}
                        </Text>
                      ) : (
                        "something"
                      )}{" "}
                      right now. You can start a new quest once you&apos;ve
                      finished it.
                    </Text>
                  </Stack>
                </Dialog.Body>
                <Box px={6} pb={5} pt={2}>
                  <Flex justify="flex-end">
                    <Button
                      bg="violet.500"
                      color="white"
                      _hover={{ bg: "violet.600" }}
                      onClick={handleClose}
                    >
                      Got it
                    </Button>
                  </Flex>
                </Box>
              </>
            ) : step === "details" ? (
              <>
                <Dialog.Body px={6} py={4}>
                  <Stack gap={3}>
                    <Box>
                      <Text
                        fontSize="xs"
                        color="charcoal.400"
                        fontFamily="heading"
                        fontWeight="600"
                        textTransform="uppercase"
                        letterSpacing="0.04em"
                        mb={1}
                      >
                        Title
                      </Text>
                      <Input
                        autoFocus
                        placeholder="e.g. Why do octopuses have 3 hearts?"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            goToPath();
                          }
                        }}
                      />
                    </Box>
                    <Box>
                      <Text
                        fontSize="xs"
                        color="charcoal.400"
                        fontFamily="heading"
                        fontWeight="600"
                        textTransform="uppercase"
                        letterSpacing="0.04em"
                        mb={1}
                      >
                        A little more (optional)
                      </Text>
                      <Textarea
                        placeholder="What got you curious about this? What would you like to know?"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={3}
                      />
                    </Box>
                    <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                      Next you&apos;ll pick how to explore it — just chat, or a
                      guided way in. You earn a 🏆 badge when you finish.
                    </Text>
                  </Stack>
                </Dialog.Body>
                <Box px={6} pb={5} pt={2}>
                  <Button
                    w="full"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    onClick={goToPath}
                    disabled={!title.trim()}
                    fontWeight="700"
                  >
                    Continue
                  </Button>
                </Box>
              </>
            ) : (
              <>
                <Dialog.Body px={6} py={3}>
                  <BakePathPicker
                    source={{
                      kind: "topic",
                      topic: title.trim(),
                      ...(description.trim()
                        ? { rationale: description.trim() }
                        : {}),
                    }}
                    onSelect={setChosen}
                  />
                </Dialog.Body>
                <Box px={6} pb={5} pt={3}>
                  <Button
                    w="full"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    onClick={handleCreate}
                    disabled={!chosen || submitting}
                    loading={submitting}
                    loadingText="Starting…"
                    fontWeight="700"
                  >
                    {prepMode ? "Create & add to tonight" : "Start exploring →"}
                  </Button>
                  <Text textAlign="center" fontSize="2xs" color="charcoal.300" mt={2.5}>
                    Every path goes somewhere real — these are just different ways in.
                  </Text>
                </Box>
              </>
            )}
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
