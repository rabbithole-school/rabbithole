"use client";

/**
 * GiveNowDialog — put an app, a file or a link in front of scholars now
 * (convex/pushes.ts `makeFocus`). WHO, then the give form's fading finishes
 * (components/GiveWindowFields.tsx, `mode="push"`; TRA-580): In that class,
 * For a while, Open until a date. Takes a `target` so the caller owns what is
 * given; this file owns who, the finish, the note and the confirmation copy.
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
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { shortDayLabel } from "@/shared/schoolClosures";
import {
  GiveWindowFields,
  giveButtonLabel,
  useMinuteNow,
  usableGiveChoices,
  type PushFinish,
} from "@/components/GiveWindowFields";

const ALL_SCHOLARS_VALUE = "__all__";

export type GiveNowTarget =
  | { kind: "activity"; activityId: Id<"activities"> }
  | { kind: "app"; externalAppId: Id<"externalApps"> }
  | { kind: "resource"; resourceId: Id<"activityResources"> }
  | { kind: "link"; url: string; title: string; media?: "video" | "page" };

export function GiveNowDialog({
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
  target: GiveNowTarget | null;
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
  const [pickedFinish, setFinish] = useState<PushFinish | null>(null);
  const groupId =
    groupValue === ALL_SCHOLARS_VALUE
      ? undefined
      : (groupValue as Id<"scholarGroups">);
  const nowMs = useMinuteNow();
  const choices = useSmoothedQuery(
    api.pushes.focusGiveChoices,
    open && institutionScope !== undefined
      ? { scope: institutionScope, groupId, nowMs }
      : "skip",
    { resetKey: `${institutionScope ?? ""}|${groupValue}` },
  );
  const [note, setNote] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmedUrl = linkUrl.trim();
  const composedTarget: GiveNowTarget | null = composeLink
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
    setFinish(null);
    setNote("");
    setLinkUrl("");
    setLinkTitle("");
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  // "In that class" can stop being possible when the audience changes (a
  // group with no classes today); it then needs picking again.
  const finish =
    pickedFinish?.kind === "inClass" &&
    usableGiveChoices(choices)?.inClass.unavailable
      ? null
      : pickedFinish;

  const audienceLabel = (() => {
    if (!groupId) return "all scholars";
    const group = groups?.find((g) => g._id === groupId);
    return group ? group.name : "that group";
  })();

  /** "for 30 min", "until 10:15 AM", "until the last bell, 2:45 PM",
   *  "open until Fri, Nov 13". */
  const finishPhrase = (chosen: PushFinish): string => {
    if (chosen.kind === "forAWhile") return `for ${chosen.minutes} min`;
    if (chosen.kind === "openUntil") {
      return `open until ${shortDayLabel(chosen.dayKey)}`;
    }
    const usable = usableGiveChoices(choices);
    if (!usable) return "in that class";
    const at = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: usable.timeZone,
    }).format(new Date(usable.inClass.endsAt));
    return usable.inClass.lastBell ? `until the last bell, ${at}` : `until ${at}`;
  };

  const handleSubmit = async () => {
    if (!composedTarget || !finish || busy) return;
    setBusy(true);
    try {
      await makeFocus({
        ...(institutionScope !== undefined ? { scope: institutionScope } : {}),
        ...(groupId ? { groupId } : {}),
        target: composedTarget,
        finish,
        note: note.trim() || undefined,
      });
      const title = composeLink ? linkTitle.trim() || trimmedUrl : targetTitle;
      toaster.success({
        title: "Given",
        description: `${title} → ${audienceLabel}, ${finishPhrase(finish)}`,
      });
      reset();
      onClose();
    } catch (err) {
      toaster.error({
        title: serverErrorMessage(err, "Couldn't give that"),
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
                  Give now
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

                <GiveWindowFields
                  mode="push"
                  choices={choices}
                  nowMs={nowMs}
                  finish={finish}
                  onFinishChange={setFinish}
                />

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
                  disabled={busy || !composedTarget || !finish}
                >
                  {busy ? "Giving…" : giveButtonLabel(finish)}
                </Button>
              </HStack>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
