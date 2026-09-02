"use client";

import { useState } from "react";
import {
  Box,
  HStack,
  Popover,
  Portal,
  Text,
} from "@chakra-ui/react";
import { ProcessPanel, type ProcessDefinition, type ProcessStep } from "./ProcessPanel";

interface ProcessThumbnailProps {
  process: ProcessDefinition;
  currentStep: string;
  steps: ProcessStep[];
}

/**
 * Compact one-line process indicator. Lives at the top of the chat
 * column, sticky. Shows step-dots ●●○○○ + the current step label.
 * Clicking opens a popover with the full ProcessPanel (step-by-step
 * descriptions, commentary, etc.).
 *
 * Design rationale: the process pipeline used to live as a permanent
 * right-panel section that took up half the panel. It belongs near
 * the chat — that's where the scholar's attention is, and the
 * "where am I in the workflow" question is a chat-adjacent one,
 * not a document-adjacent one.
 */
export function ProcessThumbnail({
  process,
  currentStep,
  steps,
}: ProcessThumbnailProps) {
  const [open, setOpen] = useState(false);
  const currentIdx = steps.findIndex((s) => s.key === currentStep);
  const total = steps.length;
  const currentStepDef =
    process.steps.find((s) => s.key === currentStep) ?? process.steps[0];

  return (
    <Popover.Root
      open={open}
      onOpenChange={(d) => setOpen(d.open)}
      positioning={{ placement: "bottom-start" }}
    >
      <Popover.Trigger asChild>
        <Box
          as="button"
          textAlign="left"
          px={3}
          py={1.5}
          // Frosty translucent — chat content scrolling under the
          // sticky pill blurs through. Pairs with the floating input
          // chrome at the bottom for a consistent "glass" surface.
          bg="rgba(255,255,255,0.78)"
          backdropFilter="blur(12px) saturate(180%)"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="full"
          cursor="pointer"
          _hover={{ borderColor: "gray.300" }}
          transition="border-color 0.15s"
          shadow="0 4px 16px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)"
        >
          <HStack gap={2.5} align="center">
            {/* Step dots — single-hue progression so the whole
                indicator reads as one shape moving forward. Current
                step is a fatter pill, completed steps are filled but
                normal-width, future steps are gray. No green; the
                "done" step at the activity level is a different
                completion concept that lives on the rubric chip. */}
            <HStack gap={0.5}>
              {steps.map((s, i) => {
                const isCurrent = i === currentIdx;
                const isDone = s.status === "completed";
                return (
                  <Box
                    key={s.key}
                    // All dots share a slightly-oval shape — wider
                    // than tall but still close to a circle. Current
                    // step distinguishes itself by color alone, not
                    // by being a chunkier pill.
                    w="7px"
                    h="6px"
                    borderRadius="full"
                    bg={
                      isCurrent
                        ? "violet.500"
                        : isDone
                          ? "violet.400"
                          : "gray.300"
                    }
                    transition="all 0.15s"
                  />
                );
              })}
            </HStack>
            {/* Single line: "Step X of N · Step name". The step-name
                portion is bolded to anchor the reader's eye on what
                they're doing right now. */}
            <Text
              fontSize="xs"
              color="charcoal.500"
              fontFamily="body"
              lineHeight="1.2"
              minW={0}
              flex={1}
            >
              Step {currentIdx + 1} of {total}
              {currentStepDef?.title ? (
                <>
                  {" · "}
                  <Text
                    as="span"
                    fontFamily="heading"
                    fontWeight="700"
                    color="charcoal.700"
                  >
                    {currentStepDef.title}
                  </Text>
                </>
              ) : null}
            </Text>
          </HStack>
        </Box>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            maxW="420px"
            w="92vw"
            borderColor="gray.200"
            shadow="lg"
          >
            <Popover.Arrow />
            <Popover.Body p={0}>
              <Box
                p={3}
                borderBottomWidth="1px"
                borderBottomColor="gray.200"
              >
                <Text
                  fontFamily="heading"
                  fontWeight="600"
                  fontSize="sm"
                  color="navy.500"
                >
                  {process.title}
                </Text>
              </Box>
              <ProcessPanel
                process={process}
                currentStep={currentStep}
                steps={steps}
              />
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
