"use client";

/**
 * Dialog host for document-view activity metadata that is too large for an
 * inline chip popover. The trigger is a stable ghost chip; the heavy controls
 * are portaled in a Dialog so opening them never reflows the document page.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Flex,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { DeliverableSection } from "@/components/nodeEditor/DeliverableSection";
import { WebActivityFields } from "@/components/nodeEditor/WebActivityFields";
import { GameActivityFields } from "@/components/nodeEditor/GameActivityFields";
import { ShareBackSection } from "@/components/nodeEditor/ShareBackSection";
import { SlidesSection } from "@/components/nodeEditor/SlidesFields";
import { ResourcesEditor } from "@/components/nodeEditor/ResourcesSection";

export type NodeFieldModalField =
  | "deliverable"
  | "resources"
  | "web"
  | "game"
  | "shareBack"
  | "slides";

export interface NodeFieldModalProps {
  activityId: Id<"activities">;
  field: NodeFieldModalField;
  label?: string;
  icon?: ReactNode;
  value?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  highlightMissingSources?: boolean;
  askAi?: (prompt: string) => void;
  /**
   * Force this dialog open whenever this value CHANGES (not on its initial
   * value) — the "Fix this" routing from a Preflight finding. A ref tracks
   * the last-seen value so re-renders with the same signal don't reopen a
   * dialog the teacher already closed.
   */
  openSignal?: number;
  "data-testid"?: string;
}

const FIELD_COPY: Record<
  NodeFieldModalField,
  { label: string; title: string; eyebrow: string; emptyValue: string }
> = {
  deliverable: {
    label: "Deliverable",
    title: "Edit deliverable",
    eyebrow: "Activity metadata",
    emptyValue: "Deliverable",
  },
  resources: {
    label: "Materials",
    title: "Edit activity materials",
    eyebrow: "Activity materials",
    emptyValue: "Materials",
  },
  web: {
    label: "Web",
    title: "Edit web assignment",
    eyebrow: "Activity metadata",
    emptyValue: "Configure web",
  },
  game: {
    label: "Game",
    title: "Edit game",
    eyebrow: "Activity metadata",
    emptyValue: "Pick a game",
  },
  shareBack: {
    label: "Share Back",
    title: "Edit share back",
    eyebrow: "Activity metadata",
    emptyValue: "Configure share back",
  },
  slides: {
    label: "Slides",
    title: "Edit teacher slides",
    eyebrow: "Activity metadata",
    emptyValue: "Slides",
  },
};

function triggerStyles(open: boolean) {
  return {
    h: "26px",
    minW: "auto",
    px: 2,
    borderRadius: "full",
    borderWidth: "1px",
    borderColor: "transparent",
    bg: open ? "bg.subtle" : "transparent",
    color: "charcoal.500",
    fontFamily: "heading",
    fontSize: "xs",
    fontWeight: "650",
    lineHeight: "1",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    transition: "background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease",
    _hover: { bg: "bg.subtle", color: "charcoal.700" },
    _focusVisible: {
      outline: "2px solid",
      outlineColor: "violet.200",
      outlineOffset: "1px",
      boxShadow: "none",
    },
  };
}

function WebActivityDialogBody({ activityId }: { activityId: Id<"activities"> }) {
  const activity = useQuery(api.activities.get, { id: activityId });
  const update = useMutation(api.activities.update);
  const [webUrl, setWebUrl] = useState("");
  const [webHosts, setWebHosts] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWebUrl(activity?.webUrl ?? "");
  }, [activity?.webUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWebHosts((activity?.webAllowedHosts ?? []).join(", "));
  }, [activity?.webAllowedHosts]);

  if (activity === undefined) {
    return (
      <Flex align="center" justify="center" py={10} color="charcoal.400">
        <Spinner size="sm" />
      </Flex>
    );
  }
  if (activity === null) return null;

  const missingWebUrl = activity.kind === "web" && !activity.externalAppId && !webUrl.trim();

  return (
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
  );
}

function GameActivityDialogBody({ activityId }: { activityId: Id<"activities"> }) {
  const activity = useQuery(api.activities.get, { id: activityId });
  const update = useMutation(api.activities.update);

  if (activity === undefined) {
    return (
      <Flex align="center" justify="center" py={10} color="charcoal.400">
        <Spinner size="sm" />
      </Flex>
    );
  }
  if (activity === null) return null;

  return (
    <GameActivityFields
      activityId={activityId}
      gameId={activity.game?.gameId ?? null}
      missingGame={activity.kind === "game" && !activity.game?.gameId}
      update={update}
    />
  );
}

function DialogBodyForField({
  activityId,
  field,
  highlightMissingSources,
  askAi,
}: Pick<
  NodeFieldModalProps,
  "activityId" | "field" | "highlightMissingSources" | "askAi"
>) {
  switch (field) {
    case "deliverable":
      return <DeliverableSection activityId={activityId} />;
    case "resources":
      return <ResourcesEditor activityId={activityId} />;
    case "web":
      return <WebActivityDialogBody activityId={activityId} />;
    case "game":
      return <GameActivityDialogBody activityId={activityId} />;
    case "shareBack":
      return (
        <ShareBackSection
          activityId={activityId}
          highlightMissingSources={highlightMissingSources}
        />
      );
    case "slides":
      return <SlidesSection activityId={activityId} askAi={askAi} />;
  }
}

export function NodeFieldModal({
  activityId,
  field,
  label,
  icon,
  value,
  hint,
  disabled,
  highlightMissingSources,
  askAi,
  openSignal,
  "data-testid": testId,
}: NodeFieldModalProps) {
  const [open, setOpen] = useState(false);
  const lastOpenSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (openSignal === undefined) return;
    if (lastOpenSignalRef.current === openSignal) return;
    lastOpenSignalRef.current = openSignal;
    setOpen(true);
  }, [openSignal]);
  const resourceRows = useQuery(
    api.activityResources.listForActivity,
    field === "resources" ? { activityId } : "skip",
  );
  const copy = FIELD_COPY[field];
  const triggerLabel = label ?? copy.label;
  const display =
    value ??
    (field === "resources" && resourceRows && resourceRows.length > 0
      ? `${resourceRows.length} resource${resourceRows.length === 1 ? "" : "s"}`
      : copy.emptyValue);

  return (
    <Box
      as="span"
      display="inline-flex"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Dialog.Root
        open={open}
        onOpenChange={(details) => setOpen(details.open)}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Dialog.Trigger asChild>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label={`Edit ${triggerLabel}`}
            data-testid={testId}
            data-open={open ? "true" : undefined}
            {...triggerStyles(open)}
          >
            {icon}
            <Text as="span" truncate>
              {display}
            </Text>
          </Button>
        </Dialog.Trigger>
        {open && (
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <StyledDialogContent maxW="xl" w="94vw">
                <Dialog.Header px={6} pt={5} pb={3}>
                  <Flex align="center" justify="space-between" gap={4}>
                    <Box minW={0}>
                      <Text
                        fontFamily="heading"
                        fontSize="2xs"
                        fontWeight="800"
                        letterSpacing="0.08em"
                        textTransform="uppercase"
                        color="charcoal.400"
                      >
                        {copy.eyebrow}
                      </Text>
                      <Dialog.Title asChild>
                        <Text
                          fontFamily="heading"
                          fontSize="lg"
                          fontWeight="800"
                          color="navy.500"
                        >
                          {copy.title}
                        </Text>
                      </Dialog.Title>
                      {hint && (
                        <Text
                          mt={1}
                          fontSize="sm"
                          color="charcoal.400"
                          fontFamily="body"
                        >
                          {hint}
                        </Text>
                      )}
                    </Box>
                    <Dialog.CloseTrigger asChild>
                      <CloseButton size="sm" />
                    </Dialog.CloseTrigger>
                  </Flex>
                </Dialog.Header>
                <Dialog.Body
                  maxH="min(72vh, 720px)"
                  overflowY="auto"
                  px={field === "resources" ? 0 : 6}
                  py={field === "resources" ? 0 : 4}
                  bg="white"
                >
                  <Stack gap={4}>
                    <DialogBodyForField
                      activityId={activityId}
                      field={field}
                      highlightMissingSources={highlightMissingSources}
                      askAi={askAi}
                    />
                  </Stack>
                </Dialog.Body>
              </StyledDialogContent>
            </Dialog.Positioner>
          </Portal>
        )}
      </Dialog.Root>
    </Box>
  );
}
