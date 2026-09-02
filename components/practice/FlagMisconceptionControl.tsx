"use client";

/**
 * FlagMisconceptionControl — the ONE place in the app that creates a
 * misconception observation, extracted from the retired CohortFrontier so the
 * create path survives the table's deletion. It reuses
 * `api.masteryObservations.flagMisconception` UNCHANGED (a teacher-authored
 * concept label; the flow ends cleanly without scheduling practice — the
 * anti-offloading guardrail).
 *
 * Presented as a quiet leading icon affordance (T4 restraint): no button row,
 * just an outlined flag that opens the popover, anchored to one scholar. It is
 * keyboard-reachable and its labels are sentence case.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import {
  Button,
  HStack,
  Input,
  Popover,
  Portal,
  Spinner,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react";
import { Flag } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { flagMisconceptionArgs } from "./flagMisconceptionArgs";

export function FlagMisconceptionControl({
  scholarId,
  scholarName,
  domain,
  defaultLabel = "",
}: {
  scholarId: Id<"users">;
  /** Names the scholar in the trigger's accessible label. */
  scholarName?: string | null;
  domain?: string;
  /** Pre-fills the concept when a caller has an obvious candidate (unused on
   *  the roster, where the teacher types the misconception). */
  defaultLabel?: string;
}) {
  const flagMisconception = useMutation(api.masteryObservations.flagMisconception);
  const [open, setOpen] = useState(false);
  const [conceptLabel, setConceptLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [flagged, setFlagged] = useState(false);

  const submit = async () => {
    const args = flagMisconceptionArgs({ scholarId, conceptLabel, defaultLabel, domain });
    if (!args || saving) return;
    setSaving(true);
    try {
      await flagMisconception(args as Parameters<typeof flagMisconception>[0]);
      setFlagged(true);
    } finally {
      setSaving(false);
    }
  };

  const who = scholarName ? ` for ${scholarName}` : "";

  return (
    <Popover.Root
      open={open}
      onOpenChange={(d) => {
        setOpen(d.open);
        if (!d.open) {
          setFlagged(false);
          setConceptLabel("");
        }
      }}
      positioning={{ placement: "top-end" }}
    >
      <Popover.Trigger asChild>
        <chakra.button
          type="button"
          aria-label={`Flag misconception${who}`}
          title={`Flag misconception${who}`}
          cursor="pointer"
          flexShrink={0}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="30px"
          h="30px"
          borderRadius="md"
          color="charcoal.300"
          opacity={0}
          _groupHover={{ opacity: 1 }}
          _hover={{ bg: "gray.100", color: "charcoal.600" }}
          _focusVisible={{
            opacity: 1,
            outline: "2px solid",
            outlineColor: "violet.400",
            outlineOffset: "1px",
          }}
          _open={{ opacity: 1, color: "charcoal.600" }}
          transition="opacity 0.1s, color 0.1s, background 0.1s"
        >
          <Flag size={15} />
        </chakra.button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content maxW="320px" w="90vw" bg="white" borderColor="gray.200" shadow="lg">
            <Popover.Arrow />
            <Popover.Body p={3}>
              {flagged ? (
                <Stack gap={2}>
                  <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.600">
                    Flagged — worth revisiting (un-teaching, not first-teaching).
                  </Text>
                  <Button
                    size="xs"
                    variant="ghost"
                    fontFamily="heading"
                    onClick={() => setOpen(false)}
                    alignSelf="flex-start"
                  >
                    Done
                  </Button>
                </Stack>
              ) : (
                <Stack gap={2}>
                  <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.600">
                    What&apos;s the misconception?
                  </Text>
                  <Input
                    size="sm"
                    placeholder={defaultLabel || "e.g. thinks −2−(−7)=9"}
                    value={conceptLabel}
                    onChange={(e) => setConceptLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit();
                    }}
                    fontFamily="body"
                    fontSize="xs"
                    bg="white"
                    autoFocus
                  />
                  <HStack gap={2}>
                    <Button
                      size="xs"
                      bg="orange.500"
                      color="white"
                      _hover={{ bg: "orange.600" }}
                      fontFamily="heading"
                      onClick={submit}
                      disabled={saving || (!conceptLabel.trim() && !defaultLabel.trim())}
                    >
                      {saving ? <Spinner size="xs" /> : "Flag"}
                    </Button>
                    <Button size="xs" variant="ghost" fontFamily="heading" onClick={() => setOpen(false)}>
                      Cancel
                    </Button>
                  </HStack>
                </Stack>
              )}
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
