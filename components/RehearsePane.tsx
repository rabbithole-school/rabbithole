"use client";

/**
 * The activity-level Rehearse / Debrief surface (the un-drawered
 * RehearseBody). See review/curriculum-rehearse-and-maturity.md.
 *
 * Rehearse and Debrief are now two TABS on an activity (not an in-panel
 * toggle). Online activities use scholar-bot sims, Vibecode uses a manual
 * workshop rehearsal, and Worlds keep their native Preflight/Debrief surfaces.
 *
 * Other activity kinds get a pointer empty state. The unit-level **Review** is
 * its own unit tab now (UnitReviewView), no longer routed through here.
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Box, Button, Flex, HStack, Stack, Text, Tooltip, Portal } from "@chakra-ui/react";
import { SteeringWheel } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { rehearsalSurfaceForActivityKind } from "@/lib/rehearsalActivityKinds";
import { toaster } from "@/lib/toaster";
import { RehearseBody } from "./nodeEditor/RehearsePanel";
import type { RehearseFixField } from "./nodeEditor/rehearseResult";
import { SimulatorPreflightPanel } from "./simulatorTeacher/SimulatorPreflightPanel";
import { SimulatorDebrief } from "./simulatorTeacher/SimulatorDebrief";

export function RehearsePane({
  activityId,
  view,
  askAi,
  onFixFinding,
}: {
  activityId: Id<"activities">;
  view: "rehearse" | "debrief";
  askAi?: (prompt: string) => void;
  /** Routes a Preflight finding's "Fix this" (online-activity Results view)
   *  to the EXISTING Resources / Deliverable / Duration / Tutor-prompt
   *  editor for this activity. Undefined on hosts that don't wire an editor
   *  (findings still render — just without a "Fix this" button). */
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  const router = useRouter();
  const activity = useQuery(api.activities.get, { id: activityId });
  const createSession = useMutation(api.sessions.create);
  const [launching, setLaunching] = useState(false);

  // Rehearse manually = a teacher-driven manual-rehearsal session (no scholar
  // data written); routes into the scholar UI with the cyan banner.
  const handleManual = async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await createSession({ activityId, isTestDrive: true });
      router.push(`/scholar/${result.id}`);
    } catch (err) {
      console.error("Rehearse manually failed:", err);
      toaster.error({ title: "Couldn't start — try again." });
      setLaunching(false);
    }
  };

  if (activity === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Loading…
        </Text>
      </Flex>
    );
  }
  if (activity === null) {
    return <RehearseEmpty title="Activity not found" body="" />;
  }
  const surface = rehearsalSurfaceForActivityKind(activity.kind);

  // A Simulator meets its Preflight (achievability + red-team) and Debrief (digest +
  // decks + gallery) surfaces here — the same tab strip, Simulator-native content
  // (plan §8). Manual rehearsal opens the same Workbench scholars use.
  if (surface === "simulator") {
    return (
      <Flex h="full" flexDir="column" overflow="hidden">
        {view === "rehearse" && (
          <HStack px={5} pt={2} justify="flex-end">
            <ManualRehearsalButton
              launching={launching}
              onClick={handleManual}
              tooltip="Open the scholar Workbench yourself — nothing is saved to a scholar"
            />
          </HStack>
        )}
        <Box flex={1} minH={0} overflow="hidden">
          {view === "rehearse" ? (
            <SimulatorPreflightPanel
              key={activityId}
              activityId={activityId}
              activityTitle={activity.title}
              askAi={askAi}
            />
          ) : (
            <SimulatorDebrief activityId={activityId} />
          )}
        </Box>
      </Flex>
    );
  }

  if (surface === "vibecode") {
    return (
      <VibecodeRehearsal
        view={view}
        launching={launching}
        onManual={handleManual}
      />
    );
  }

  if (surface === "unavailable") {
    return (
      <RehearseEmpty
        title="This activity runs offline"
        body="Scholar-bot rehearsal is for online activities — the ones where a scholar works with the AI tutor. Switch the activity to Online in the Edit tab to rehearse it."
      />
    );
  }

  return (
    <Box h="full" overflowY="auto" px={8} pt={2} pb={8}>
      {/* The two ways to drive a session — sims (below) or you, by hand.
          Manual driving is a rehearsal action, so it sits on the Rehearse
          tab; the Debrief tab stays focused on comparing to real scholars. */}
      {view === "rehearse" && (
        <HStack maxW="900px" mb={3} justify="flex-end">
          <ManualRehearsalButton
            launching={launching}
            onClick={handleManual}
            tooltip="Drive the scholar turns yourself — nothing is saved"
          />
        </HStack>
      )}

      <Box maxW="900px">
        {/* key by activityId so the panel's run state resets when the teacher
            switches activities in the outline. The `view` prop changes (not
            the key) across the Rehearse↔Debrief tabs, so a run's state
            survives that switch. */}
        <RehearseBody
          key={activityId}
          activityId={activityId}
          view={view}
          durationMinutes={activity.durationMinutes ?? null}
          onManualRehearsal={handleManual}
          askAi={askAi}
          onFixFinding={onFixFinding}
        />
      </Box>
    </Box>
  );
}

function ManualRehearsalButton({
  launching,
  onClick,
  tooltip,
}: {
  launching: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <Tooltip.Root openDelay={300} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <Button
          size="xs"
          variant="outline"
          borderColor="cyan.400"
          color="cyan.700"
          _hover={{ bg: "cyan.50" }}
          fontFamily="heading"
          fontWeight="600"
          onClick={onClick}
          loading={launching}
          loadingText="Starting…"
        >
          <SteeringWheel
            size={14}
            weight="duotone"
            style={{ marginRight: 4 }}
          />
          Rehearse manually
        </Button>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content>{tooltip}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

function VibecodeRehearsal({
  view,
  launching,
  onManual,
}: {
  view: "rehearse" | "debrief";
  launching: boolean;
  onManual: () => void;
}) {
  return (
    <Flex h="full" align="center" justify="center" px={8}>
      <Stack
        gap={3}
        maxW="440px"
        textAlign="center"
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        p={6}
      >
        <Text fontFamily="heading" fontSize="md" color="charcoal.500">
          Sims don&apos;t build apps yet
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          {view === "rehearse"
            ? "Rehearse this app-building activity manually in the scholar workshop."
            : "There is no scholar-bot debrief for Vibecode yet; rehearse the app manually instead."}
        </Text>
        {view === "rehearse" && (
          <Box pt={1}>
            <ManualRehearsalButton
              launching={launching}
              onClick={onManual}
              tooltip="Open the scholar workshop yourself — nothing is saved to a scholar"
            />
          </Box>
        )}
      </Stack>
    </Flex>
  );
}

function RehearseEmpty({ title, body }: { title: string; body: string }) {
  return (
    <Flex h="full" align="center" justify="center" px={8}>
      <Stack
        gap={3}
        maxW="420px"
        textAlign="center"
        color="charcoal.300"
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        p={6}
      >
        <Text fontFamily="heading" fontSize="md" color="charcoal.400">
          {title}
        </Text>
        {body && (
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            {body}
          </Text>
        )}
      </Stack>
    </Flex>
  );
}
