"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  HStack,
  Input,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { WarningCircle } from "@phosphor-icons/react";
import { ScholarAngleIcon } from "@/lib/scholarAngle";
import { ActivityModeIcon } from "@/lib/activityMode";
import { ProcessPicker } from "../ProcessPicker";
import {
  // DeliverableCollationPanel + ScholarAnglesPanel were dropped here
  // when the Assignments split moved execution data to the Run page.
} from "../ActivityDetailPanels";
import { DeliverableSection } from "./DeliverableSection";
import {
  ConfirmDeleteDialog,
  Field,
  KindToggle,
  Scroll,
  SegmentedButtonGroup,
  SectionHeader,
} from "./shared";
import { SlidesSection } from "./SlidesFields";
import { WebActivityFields } from "./WebActivityFields";
import { GameActivityFields } from "./GameActivityFields";
import { SimulatorSpecEditor } from "@/components/simulatorTeacher/SimulatorSpecEditor";
import { ShareBackSection } from "./ShareBackSection";
import { NodeEditorSkeleton } from "./NodeEditorSkeleton";
import { ResourcesSection } from "./ResourcesSection";
import { NodeActionsMenu } from "@/components/NodeActionsMenu";

export function ActivityFields({
  activityId,
  onAfterDelete,
  onAfterDuplicate,
  askAi,
}: {
  activityId: Id<"activities">;
  onAfterDelete?: () => void;
  onAfterDuplicate?: (activityId: Id<"activities">) => void;
  askAi?: (prompt: string) => void;
}) {
  const activity = useQuery(api.activities.get, { id: activityId }) as
    | (Doc<"activities"> | null)
    | undefined;
  const update = useMutation(api.activities.update);
  const remove = useMutation(api.activities.remove);
  const setArchived = useMutation(api.activities.setArchived);
  const duplicateActivity = useMutation(api.activities.duplicate);
  // Rehearse (sims) + Rehearse manually now live in the unit surface's
  // Rehearse tab (review/curriculum-rehearse-and-maturity.md), not on the
  // activity editor header — so the editor stays focused on editing.

  const [description, setDescription] = useState("");
  const [scholarDescription, setScholarDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [webHosts, setWebHosts] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    // Reset local draft when remote activity value changes (e.g., switching activities).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDescription(activity?.description ?? "");
  }, [activity?.description]);
  useEffect(() => {
    // Reset local draft when remote activity value changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScholarDescription(activity?.scholarDescription ?? "");
  }, [activity?.scholarDescription]);
  useEffect(() => {
    // Reset local draft when remote activity value changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSystemPrompt(activity?.systemPrompt ?? "");
  }, [activity?.systemPrompt]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWebUrl(activity?.webUrl ?? "");
  }, [activity?.webUrl]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWebHosts((activity?.webAllowedHosts ?? []).join(", "));
  }, [activity?.webAllowedHosts]);
  // Deliverable state lives inside <DeliverableSection> — that component
  // owns its own local draft + persist-on-blur, so ActivityFields doesn't
  // need to keep a mirror.

  if (activity === null)
    return (
      <Flex h="full" align="center" justify="center" color="charcoal.400">
        <Text fontSize="sm">Activity not found.</Text>
      </Flex>
    );
  // useQuery returns undefined while loading. Render the skeleton
  // (matching layout) instead of null so we don't flash an empty
  // panel between activity selections.
  if (activity === undefined) return <NodeEditorSkeleton kind="activity" />;

  const handleConfirmDelete = async () => {
    await remove({ id: activityId });
    onAfterDelete?.();
  };

  const handleDuplicate = async () => {
    const copyId = await duplicateActivity({ activityId });
    onAfterDuplicate?.(copyId);
  };

  const isArchived = !!activity.archivedAt;
  const handleArchive = async () => {
    await setArchived({ id: activityId, archived: true });
  };
  const handleUnarchive = async () => {
    await setArchived({ id: activityId, archived: false });
  };

  const isOnline = activity.kind === "online";
  const isShareBack = activity.kind === "shareBack";
  const isWeb = activity.kind === "web";
  const isGame = activity.kind === "game";
  const isSimulator = activity.kind === "simulator";
  const isVibecode = activity.kind === "vibecode";

  // Compute activity-level warnings up-front so the banner under the
  // header tells the teacher what's wrong before they scroll, and each
  // applicable field can pick up a matching red border below.
  const missingSystemPrompt = isOnline && !systemPrompt.trim();
  const missingShareBackSources =
    isShareBack && (activity.sourceActivityIds ?? []).length === 0;
  // A web activity needs a URL UNLESS it's linked to a catalog app (the
  // app supplies the URL). Only freehand/custom web activities can lack one.
  const missingWebUrl = isWeb && !activity.externalAppId && !webUrl.trim();
  // A game activity is inert until a game is picked — there is nothing for
  // the iPad to open.
  const missingGame = isGame && !activity.game?.gameId;
  const warnings: Array<{ id: string; message: string }> = [];
  if (missingShareBackSources) {
    warnings.push({
      id: "shareBackSources",
      message:
        "Pick at least one source activity — the AI digest can't generate without scholar submissions to collate.",
    });
  }
  if (missingWebUrl) {
    warnings.push({
      id: "webUrl",
      message:
        "No website URL yet — scholars can't start this assignment without one.",
    });
  }
  if (missingGame) {
    warnings.push({
      id: "game",
      message:
        "No game picked yet — scholars can't start this assignment without one.",
    });
  }

  return (
    <Scroll>
      <SectionHeader
        title={activity.title}
        subtitle="Activity"
        placeholder="Untitled activity"
        onTitleChange={(title) => update({ id: activityId, title })}
        rightSlot={
          <NodeActionsMenu
            kind="activity"
            onDuplicate={handleDuplicate}
            onArchive={isArchived ? undefined : handleArchive}
            onUnarchive={isArchived ? handleUnarchive : undefined}
            onDelete={() => setConfirmOpen(true)}
          />
        }
      />
      {/* Warnings banner — promote any "this activity isn't shippable
          yet" messages to a single block under the header so the
          teacher doesn't have to scroll to spot the problem. Each
          warning's corresponding field also gets a red border below. */}
      {warnings.length > 0 && (
        <Box
          borderWidth="1px"
          borderColor="red.300"
          bg="red.50"
          borderRadius="md"
          px={3}
          py={2}
        >
          <Stack gap={1}>
            {warnings.map((w) => (
              <HStack key={w.id} gap={1.5} align="flex-start" color="red.600">
                <Box mt="2px" flexShrink={0}>
                  <WarningCircle size={12} />
                </Box>
                <Text fontSize="xs" fontFamily="heading" lineHeight="1.5">
                  {w.message}
                </Text>
              </HStack>
            ))}
          </Stack>
        </Box>
      )}
      {/* Duration now lives in the Scheduling section below, alongside
          "Days after previous" — so the kind picker stands on its own. */}
      <Field label="Kind">
        <KindToggle
          value={activity.kind}
          onChange={(kind) => update({ id: activityId, kind })}
        />
      </Field>

      {/* OPTIONS — flags that classify the activity. Each gets a
          one-line inline hint so the toggle teaches itself.
          Room for more flags here later. Homework moved out to the
          assignment level (StartAssignmentDialog). */}
      {/* Per-scholar angles only makes sense for online activities —
          it relies on the AI tutor's kickoff phase, which doesn't
          exist on teacher-facing offline / shareBack activities. */}
      {isOnline && (
        <Field label="Options">
          <Stack gap={2.5}>
            <Box>
              <Switch.Root
                checked={!!activity.hasScholarAngles}
                onCheckedChange={(d) =>
                  update({ id: activityId, hasScholarAngles: !!d.checked })
                }
                colorPalette="violet"
                size="sm"
              >
                <Switch.HiddenInput />
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Switch.Label
                  fontFamily="heading"
                  fontSize="sm"
                  color="charcoal.600"
                >
                  <HStack gap={1.5}>
                    <ScholarAngleIcon size={14} />
                    <span>Per scholar angles</span>
                  </HStack>
                </Switch.Label>
              </Switch.Root>
              <Text fontSize="2xs" color="charcoal.400" pl={6} mt={0.5}>
                Each scholar picks their own angle. The tutor runs a
                quick kickoff to capture it before diving in.
              </Text>
            </Box>
          </Stack>
        </Field>
      )}
      {/* Conversation recipe — pre-shaped EQ assessment activities.
          Baseline elicits current thinking without teaching (stealth
          pre-assessment); Exit ticket revisits the EQs against the
          scholar's baseline answers. Online activities run it through the
          tutor; offline activities assess the uploaded written artifact
          (convex/granuleAssessment.ts). Both feed the Understanding grid. */}
      {(isOnline || activity.kind === "offline") && (
        <Field
          label="Conversation type"
          hint={
            isOnline
              ? "Baseline opens the unit: the tutor draws out current thinking on the essential questions without teaching. Exit ticket closes it: the tutor revisits the questions against each scholar's starting answers. Both feed the Understanding grid on the assignment page."
              : "Baseline opens the unit, exit ticket closes it. For an offline activity, the scholar's uploaded written work is assessed against the essential questions — both feed the Understanding grid on the assignment page."
          }
        >
          <SegmentedButtonGroup
            value={activity.recipe ?? null}
            options={[
              { value: null, label: "Regular" },
              { value: "baseline", label: "🌱 Baseline" },
              { value: "exitTicket", label: "🎟️ Exit ticket" },
            ]}
            onChange={(recipe) => update({ id: activityId, recipe })}
          />
        </Field>
      )}
      {/* Design-time intent — informs how the activity lands in an
          Assignment's schedule on create. "Homework" activities
          auto-push as homework for the cohort; "In class" activities
          stay dormant until the teacher pushes them from the Run
          page; "Either" doesn't show any intent hint. */}
      {!isShareBack && (
        <Field
          label="Intended for"
          hint="When this unit is assigned, homework activities land on each scholar's plate immediately. Class activities sit dormant until the teacher pushes them."
        >
          {/* One attached segmented control (tabs), not three loose
              buttons — the active segment fills violet. */}
          <SegmentedButtonGroup
            value={activity.defaultMode ?? "either"}
            options={[
              { value: "either", label: "Either" },
              {
                value: "classFocus",
                label: "In class",
                icon: <ActivityModeIcon mode="classFocus" size={12} />,
              },
              {
                value: "homework",
                label: "Homework",
                icon: <ActivityModeIcon mode="homework" size={12} />,
              },
            ]}
            onChange={(defaultMode) => update({ id: activityId, defaultMode })}
          />
        </Field>
      )}

      {/* Scheduling — how long the activity runs and how it paces
          relative to the previous one when the unit is assigned. */}
      <Stack gap={3}>
        <SectionHeader title="Scheduling" />
        <Flex gap={4} align="flex-start">
          <Box maxW="160px">
            <Field label="Duration (min)">
              <Input
                size="sm"
                type="number"
                value={activity.durationMinutes ?? ""}
                onChange={(e) => {
                  const v = e.target.value ? parseInt(e.target.value) : null;
                  update({ id: activityId, durationMinutes: v });
                }}
                placeholder="optional"
                fontFamily="heading"
                fontSize="sm"
                borderColor="gray.200"
                _focus={{ borderColor: "violet.400", boxShadow: "none" }}
              />
            </Field>
          </Box>
        </Flex>
      </Stack>

      {!isShareBack && (
        <>
          <Field
            label="Description (teacher-facing)"
            hint="Design intent and facilitation notes — visible to teachers; for online activities the AI tutor also sees it. Never shown to scholars."
          >
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() =>
                update({ id: activityId, description: description || null })
              }
              rows={3}
              fontSize="sm"
              fontFamily="body"
              borderColor="gray.200"
              _focus={{ borderColor: "violet.400", boxShadow: "none" }}
            />
          </Field>
          <Field
            label="Scholar description"
            hint="Shown on the scholar's card and activity nav — write to the scholar, 2nd person. Left blank, they see a title-only card (no fallback)."
          >
            <Textarea
              value={scholarDescription}
              onChange={(e) => setScholarDescription(e.target.value)}
              onBlur={() =>
                update({
                  id: activityId,
                  scholarDescription: scholarDescription || null,
                })
              }
              rows={2}
              placeholder="e.g. You'll design a terrarium, then predict what happens when…"
              fontSize="sm"
              fontFamily="body"
              borderColor="gray.200"
              _focus={{ borderColor: "violet.400", boxShadow: "none" }}
            />
          </Field>
        </>
      )}
      {isWeb && (
        <WebActivityFields
          activityId={activityId}
          webUrl={webUrl}
          webHosts={webHosts}
          externalAppId={activity.externalAppId ?? null}
          missingWebUrl={missingWebUrl}
          setWebUrl={setWebUrl}
          setWebHosts={setWebHosts}
          update={update}
        />
      )}
      {isGame && (
        <GameActivityFields
          activityId={activityId}
          gameId={activity.game?.gameId ?? null}
          missingGame={missingGame}
          update={update}
        />
      )}
      {/* A World's Edit tab is its spec editor — template + criterion + species
          + budgets over a code-owned physics template (plan §8). */}
      {isSimulator && (
        <Box mx={-6}>
          <SimulatorSpecEditor activityId={activityId} />
        </Box>
      )}
      {(isOnline || isVibecode) && (
        <>
          <Field label="Process">
            <ProcessPicker
              value={activity.processId ?? null}
              onChange={(next) => update({ id: activityId, processId: next })}
            />
          </Field>
          <Field
            label={isVibecode ? "Build brief" : "Activity system prompt"}
            hint={
              isVibecode
                ? "What the scholar should build. The AI builder sees this and greets them with the challenge."
                : "This is what drives the AI tutor when a scholar starts this activity. Be specific about objectives, scaffolds, and what 'done' looks like."
            }
          >
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              onBlur={() =>
                update({ id: activityId, systemPrompt: systemPrompt || null })
              }
              rows={10}
              fontSize="xs"
              fontFamily="body"
              borderColor={missingSystemPrompt ? "red.400" : "gray.200"}
              _focus={{
                borderColor: missingSystemPrompt ? "red.400" : "violet.400",
                boxShadow: "none",
              }}
              placeholder="Instructions for the AI tutor during this activity..."
            />
          </Field>

          {/* Vibecode has no deliverable capture — the built app is the
              artifact — so the deliverable block stays online-only. */}
          {isOnline && <DeliverableSection activityId={activityId} />}
        </>
      )}
      <ResourcesSection activityId={activityId} />
      {/* Teacher slides: irrelevant on Share Backs — the digest's
          facilitation view IS the deck (and Generate Slides would
          create a second, competing presentation surface). */}
      {!isShareBack && (
        <SlidesSection activityId={activityId} askAi={askAi} />
      )}

      {/* Share Back — offline activities only. Wire to earlier online
          activities; AI digests the submissions for live facilitation. */}
      {isShareBack && (
        <ShareBackSection
          activityId={activityId}
          highlightMissingSources={missingShareBackSources}
        />
      )}

      {/* Per-activity teacher-facing panels — silently empty when
          there's no data. Lifted out of the Curriculum tab's detail
          pane in the standardize-on-designer pass; now the
          per-scholar angles + submissions view live in the same
          editor surface that owns every other activity field. */}
      {/* Execution-side panels (submissions, per-scholar angles) used
          to live here. Post the Assignments split (review/design-vs-
          execution-split.md) the Curriculum tab is Design only —
          submissions and digests live on the per-Assignment Run page
          at /teacher/schedule/<id>, cohort-scoped. */}

      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete activity?"
        message={`Delete activity "${activity.title}"? This cannot be undone.`}
        confirmLabel="Delete activity"
        onConfirm={handleConfirmDelete}
      />
    </Scroll>
  );
}
