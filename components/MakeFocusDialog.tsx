"use client";

/**
 * MakeFocusDialog — the "push this, to these scholars, for this long"
 * dialog behind every "Make focus" affordance (see convex/pushes.ts
 * `makeFocus`). Takes a `target` prop so the same dialog can be reused from
 * other surfaces later (a curriculum node, the Run page, …) — this file
 * only owns the WHO / HOW LONG / note collection + the confirmation
 * copy, never the target itself.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Button,
  Dialog,
  HStack,
  Heading,
  Portal,
  Stack,
  Input,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { FOCUS_DURATION_CHOICES_MIN } from "@/convex/lib/pushes";
import { pushSummaryLine } from "@/shared/pushCopy";

const ALL_SCHOLARS_VALUE = "__all__";
const DEFAULT_DURATION_MIN = 60;

export type MakeFocusTarget =
  | { kind: "activity"; activityId: Id<"activities"> }
  | { kind: "app"; externalAppId: Id<"externalApps"> }
  | { kind: "resource"; resourceId: Id<"activityResources"> }
  | { kind: "link"; url: string; title: string; media?: "video" | "page" };

export function MakeFocusDialog({
  open,
  onClose,
  target,
  targetTitle,
  composeLink = false,
}: {
  open: boolean;
  onClose: () => void;
  /** The push target — omitted while the caller has nothing selected yet
   * (the dialog is simply not opened in that state), or when `composeLink`
   * is on and the teacher is typing the URL here. */
  target: MakeFocusTarget | null;
  /** Human title used only in local confirmation copy. */
  targetTitle: string;
  /** Collect an arbitrary URL in this dialog instead of taking a `target`.
   * This is the ad-hoc "push this video for the next 20 minutes" path — the
   * whole reason a push doesn't need a catalog entry to exist. */
  composeLink?: boolean;
}) {
  const { activeInstitution } = useActiveInstitution(open);
  const institutionScope =
    activeInstitution === undefined
      ? undefined
      : activeInstitution.scope === "all"
        ? "all"
        : (activeInstitution.institutionSlug ?? "primary");

  const groups = useQuery(
    api.scholarGroups.list,
    open && institutionScope !== undefined ? { institutionScope } : "skip",
  );
  const makeFocus = useMutation(api.pushes.makeFocus);

  const [groupValue, setGroupValue] = useState(ALL_SCHOLARS_VALUE);
  const [durationMin, setDurationMin] = useState(DEFAULT_DURATION_MIN);
  const [note, setNote] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmedUrl = linkUrl.trim();
  const composedTarget: MakeFocusTarget | null = composeLink
    ? trimmedUrl
      ? {
          kind: "link",
          url: trimmedUrl,
          title: linkTitle.trim() || trimmedUrl,
          // A YouTube/Vimeo URL gets the video glyph and "Watch"; anything
          // else reads as a page. Cheap, and wrong only cosmetically.
          media: /youtube\.com|youtu\.be|vimeo\.com/i.test(trimmedUrl)
            ? "video"
            : "page",
        }
      : null
    : target;

  const reset = () => {
    setGroupValue(ALL_SCHOLARS_VALUE);
    setDurationMin(DEFAULT_DURATION_MIN);
    setNote("");
    setLinkUrl("");
    setLinkTitle("");
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const audienceLabel = (() => {
    if (groupValue === ALL_SCHOLARS_VALUE) return "the whole school";
    const group = groups?.find((g) => g._id === groupValue);
    return group ? group.name : "that group";
  })();

  const handleSubmit = async () => {
    if (!composedTarget || busy) return;
    setBusy(true);
    try {
      await makeFocus({
        ...(institutionScope !== undefined ? { scope: institutionScope } : {}),
        ...(groupValue === ALL_SCHOLARS_VALUE
          ? {}
          : { groupId: groupValue as Id<"scholarGroups"> }),
        target: composedTarget,
        durationMin,
        note: note.trim() || undefined,
      });
      toaster.success({
        title: "Made the class focus",
        description: pushSummaryLine({
          title: composeLink
            ? (linkTitle.trim() || trimmedUrl)
            : targetTitle,
          audienceLabel,
          minutes: durationMin,
        }),
      });
      reset();
      onClose();
    } catch (err) {
      toaster.error({
        title: serverErrorMessage(err, "Couldn't make that the focus"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && handleClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="sm">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Dialog.Title asChild>
                <Heading size="md" color="navy.500" fontFamily="heading">
                  Make focus
                </Heading>
              </Dialog.Title>
              <Text fontSize="sm" color="charcoal.400" fontFamily="body" mt={1}>
                {composeLink
                  ? "Paste a video or web page to put in front of scholars"
                  : targetTitle}
              </Text>
            </Dialog.Header>

            <Dialog.Body px={6} py={2}>
              <Stack gap={4}>
                {composeLink && (
                  <Stack gap={1.5}>
                    <Text
                      fontSize="xs"
                      color="charcoal.500"
                      fontFamily="heading"
                      fontWeight="700"
                      textTransform="uppercase"
                      letterSpacing="0.04em"
                    >
                      Link
                    </Text>
                    <Input
                      size="sm"
                      bg="white"
                      fontFamily="body"
                      placeholder="https://…"
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                    />
                    <Input
                      size="sm"
                      bg="white"
                      fontFamily="body"
                      placeholder="What scholars see it called"
                      value={linkTitle}
                      onChange={(e) => setLinkTitle(e.target.value)}
                    />
                  </Stack>
                )}

                <Stack gap={1.5}>
                  <Text
                    fontSize="xs"
                    color="charcoal.500"
                    fontFamily="heading"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                  >
                    Who
                  </Text>
                  <FieldSelect value={groupValue} onChange={setGroupValue}>
                    <option value={ALL_SCHOLARS_VALUE}>All scholars</option>
                    {(groups ?? []).map((g) => (
                      <option key={g._id} value={g._id}>
                        {g.emoji ? `${g.emoji} ` : ""}
                        {g.name}
                      </option>
                    ))}
                  </FieldSelect>
                </Stack>

                <Stack gap={1.5}>
                  <Text
                    fontSize="xs"
                    color="charcoal.500"
                    fontFamily="heading"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                  >
                    How long
                  </Text>
                  <HStack gap={2} flexWrap="wrap">
                    {FOCUS_DURATION_CHOICES_MIN.map((min) => (
                      <Button
                        key={min}
                        size="xs"
                        fontFamily="heading"
                        variant={durationMin === min ? "solid" : "outline"}
                        colorPalette="violet"
                        onClick={() => setDurationMin(min)}
                      >
                        {min} min
                      </Button>
                    ))}
                  </HStack>
                </Stack>

                <Stack gap={1.5}>
                  <Text
                    fontSize="xs"
                    color="charcoal.500"
                    fontFamily="heading"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                  >
                    Note (optional)
                  </Text>
                  <Textarea
                    size="sm"
                    fontFamily="body"
                    bg="white"
                    placeholder="Anything scholars should know"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                  />
                </Stack>
              </Stack>
            </Dialog.Body>

            <Dialog.Footer px={6} pb={6} pt={2}>
              <HStack gap={2} w="full" justify="flex-end">
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={handleClose}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  colorPalette="violet"
                  fontFamily="heading"
                  onClick={() => void handleSubmit()}
                  disabled={busy || !composedTarget}
                >
                  {busy ? "Making focus…" : "Make focus"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
