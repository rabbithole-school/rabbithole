"use client";

import { useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  GoogleDriveLogoIcon,
  PencilSimple,
  Plus,
  Robot,
  SlideshowIcon,
  X,
} from "@phosphor-icons/react";
import type { Id } from "@/convex/_generated/dataModel";
import { emptyDeck, validateDeck, type Deck } from "@/shared/slidesScene";
import { Field } from "./shared";
import { GooglePickerButton } from "../GooglePickerButton";
import { GoogleAccountConnect } from "../GoogleAccountConnect";
import { needsGoogleReconsent } from "../googleConsentStatus";
import { TeacherDeckEditor } from "../slides/TeacherDeckEditor";
import {
  SlidesDialogCloseButton,
  SlidesEditorDialogFrame,
} from "../slides/SlidesEditorDialogFrame";
import { openExternal } from "@/lib/native";

function parseDeck(value: string | undefined): Deck | null {
  if (!value) return null;
  try {
    const result = validateDeck(JSON.parse(value));
    return result.ok ? result.deck : null;
  } catch {
    return null;
  }
}

export function SlidesSection({
  activityId,
  askAi,
}: {
  activityId: Id<"activities">;
  /** Used to ask the Curriculum Bot to create a new deck. */
  askAi?: (prompt: string) => void;
}) {
  const activity = useQuery(api.activities.get, { id: activityId });
  const presentations = useQuery(
    api.activityResources.presentationsForActivity,
    { activityId },
  );
  const googleStatus = useQuery(api.googleAccounts.status);
  const attach = useMutation(api.activities.attachGoogleSlidesDeck);
  const detach = useMutation(api.activities.detachGoogleSlidesDeck);
  const saveRabbitDeck = useMutation(api.activities.saveTeacherSlidesDeck);
  const verifyDeck = useAction(api.slidesActions.verifyDeckAccess);
  const refreshMetadata = useAction(api.slidesActions.refreshDeckMetadata);

  const [busy, setBusy] = useState<
    null | "attach" | "createRabbit" | "detach" | "refresh"
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [editingDeck, setEditingDeck] = useState(false);
  const closeDeckRef = useRef<HTMLButtonElement | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);

  if (activity === undefined || presentations === undefined) {
    return (
      <Field label="Teacher slides">
        <Spinner size="sm" />
      </Field>
    );
  }
  if (activity === null) return null;

  const hasGoogleConnected =
    googleStatus?.connected &&
    !needsGoogleReconsent(googleStatus, "slides");
  const rabbitPresentation = presentations.find(
    (presentation) => presentation.source.kind === "rabbit_slides",
  );
  const googlePresentation = presentations.find(
    (presentation) => presentation.source.kind === "google_slides",
  );
  const rabbitDeck =
    rabbitPresentation?.source.kind === "rabbit_slides"
      ? parseDeck(rabbitPresentation.source.deck)
      : null;
  const googleSource =
    googlePresentation?.source.kind === "google_slides"
      ? googlePresentation.source
      : null;
  const googleTitle =
    googleSource?.name ?? googlePresentation?.title ?? "Google Slides";
  const googlePrincipalKind = googlePresentation?.principalKind;
  const canRefreshGoogle =
    !!googlePresentation?.canActAsPrincipal &&
    (googlePrincipalKind !== "personal_oauth" || !!hasGoogleConnected);

  const handlePicked = async (doc: {
    id: string;
    url?: string;
    name?: string;
  }) => {
    setBusy("attach");
    setError(null);
    try {
      const meta = await verifyDeck({ presentationId: doc.id });
      await attach({
        id: activityId,
        presentationId: doc.id,
        url:
          meta.webViewLink ??
          doc.url ??
          `https://docs.google.com/presentation/d/${doc.id}/edit`,
        ownedByUs: false,
        name: meta.name ?? doc.name,
        thumbnailUrl: meta.thumbnailLink,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to attach deck");
    } finally {
      setBusy(null);
    }
  };

  const handleDetach = async () => {
    if (!confirm("Detach this deck? The deck stays in Google Drive.")) return;
    setBusy("detach");
    setError(null);
    try {
      await detach({ id: activityId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detach failed");
    } finally {
      setBusy(null);
    }
  };

  const handleCreateRabbitDeck = async () => {
    setBusy("createRabbit");
    setError(null);
    try {
      const deck = emptyDeck("Untitled slides", "sl1");
      const result = await saveRabbitDeck({
        id: activityId,
        deckJson: JSON.stringify(deck),
        baseRevision: 0,
      });
      if (!result.ok) throw new Error(result.error);
      setEditingDeck(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to create Rabbit Slides",
      );
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      await refreshMetadata({ activityId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy(null);
    }
  };

  const hasRabbit = !!rabbitPresentation;
  const hasGoogle = !!googleSource;
  const rabbitReadable = rabbitDeck !== null;
  const rabbitSlideCount = rabbitDeck?.slides.length ?? 0;

  return (
    <Field label="Teacher slides">
      <VStack align="stretch" gap={3}>
        {hasRabbit && (
          <>
            <Flex
              align="center"
              justify="space-between"
              gap={4}
              p={4}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="md"
              wrap="wrap"
            >
              <HStack gap={3} minW={0}>
                <SlideshowIcon size={32} aria-hidden />
                <Box minW={0}>
                  <Text
                    fontFamily="heading"
                    fontSize="sm"
                    color="navy.500"
                    fontWeight="600"
                    truncate
                  >
                    {rabbitPresentation.title || "Rabbit Slides"}
                  </Text>
                  <Text fontSize="sm" color="charcoal.400">
                    {rabbitReadable
                      ? `${rabbitSlideCount} slide${rabbitSlideCount === 1 ? "" : "s"} · Rabbit Slides`
                      : "This Rabbit Slides deck couldn't be read, so it can't be edited or presented"}
                  </Text>
                </Box>
              </HStack>
              <HStack gap={2} flexWrap="wrap">
                <Button
                  size="sm"
                  variant="outline"
                  fontFamily="heading"
                  disabled={!rabbitReadable}
                  onClick={() => setEditingDeck(true)}
                  title={
                    rabbitReadable
                      ? "Edit this deck in Rabbithole"
                      : "This Rabbit Slides deck couldn't be read"
                  }
                >
                  <PencilSimple aria-hidden />
                  Edit deck
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  disabled={!rabbitReadable}
                  onClick={() =>
                    window.open(
                      `/teacher/activity/${activityId}/present`,
                      "_blank",
                      "noopener",
                    )
                  }
                  title="Present this deck full screen"
                >
                  <SlideshowIcon aria-hidden />
                  Present
                </Button>
              </HStack>
            </Flex>

            <Dialog.Root
              open={editingDeck}
              onOpenChange={(d) => !d.open && setEditingDeck(false)}
              size="full"
              placement="center"
              // The title input is now the first focusable thing in the dialog,
              // and opening an editor should never land with the deck's name
              // selected and one keystroke from being replaced.
              initialFocusEl={() => closeDeckRef.current}
              // Escape means "undo this rename", not "throw away the editor",
              // while the deck title has an uncommitted draft.
              onEscapeKeyDown={(event) => {
                if (titleEditing) event.preventDefault();
              }}
            >
              <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                  <SlidesEditorDialogFrame
                    title={rabbitPresentation.title || "Rabbit Slides"}
                    integratedHeader
                  >
                    {editingDeck && (
                      <TeacherDeckEditor
                        activityId={activityId}
                        onTitleEditingChange={setTitleEditing}
                        headerEnd={
                          <SlidesDialogCloseButton ref={closeDeckRef} />
                        }
                      />
                    )}
                  </SlidesEditorDialogFrame>
                </Dialog.Positioner>
              </Portal>
            </Dialog.Root>
          </>
        )}

        {hasGoogle && googleSource && (
          <Flex
            align="start"
            gap={3}
            p={4}
            bg="white"
            borderRadius="md"
            borderWidth="1px"
            borderColor="gray.200"
            wrap="wrap"
          >
            <Box flexShrink={0} w="112px" h="64px">
              {googleSource.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- Google thumbnails cannot use the Next image proxy
                <img
                  src={googleSource.thumbnailUrl}
                  alt={googleSource.name ?? "Google Slides deck thumbnail"}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    borderRadius: 4,
                    border: "1px solid var(--chakra-colors-gray-200)",
                    display: "block",
                  }}
                  referrerPolicy="no-referrer"
                />
              ) : (
                <Box
                  w="full"
                  h="full"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  bg="white"
                  borderRadius="sm"
                  borderWidth="1px"
                  borderColor="gray.200"
                >
                  <SlideshowIcon size={36} color="#F5BB1B" aria-hidden />
                </Box>
              )}
            </Box>
            <VStack align="stretch" gap={2} flex={1} minW={0}>
              <Box minW={0}>
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  color="navy.500"
                  fontWeight="600"
                  truncate
                >
                  {googleTitle}
                </Text>
                <Text fontSize="sm" color="charcoal.400">
                  Google Slides
                </Text>
              </Box>
              <HStack gap={2} flexWrap="wrap">
                <Button
                  size="sm"
                  variant="outline"
                  fontFamily="heading"
                  onClick={() => openExternal(googleSource.url)}
                >
                  <ArrowSquareOut aria-hidden />
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={handleRefresh}
                  disabled={busy !== null || !canRefreshGoogle}
                  title={
                    canRefreshGoogle
                      ? "Refresh the deck name and thumbnail from Google"
                      : googlePrincipalKind === "personal_oauth"
                        ? googlePresentation?.canActAsPrincipal
                          ? "Reconnect the Google account that attached this deck"
                          : "The teacher who attached this deck must refresh it"
                        : "Detach and reattach this deck to establish its Google credential"
                  }
                >
                  {busy === "refresh" ? (
                    <Spinner size="sm" />
                  ) : (
                    <ArrowClockwise aria-hidden />
                  )}
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={handleDetach}
                  disabled={busy !== null}
                  title="Detach the deck without deleting it from Google Drive"
                >
                  {busy === "detach" ? <Spinner size="sm" /> : <X aria-hidden />}
                  Detach
                </Button>
              </HStack>
              {googlePrincipalKind === "personal_oauth" &&
                googlePresentation?.canActAsPrincipal &&
                !hasGoogleConnected && (
                  <GoogleAccountConnect compact requiredAccess="slides" />
                )}
            </VStack>
          </Flex>
        )}

        {(!hasRabbit || !hasGoogle) && (
          <HStack gap={2} wrap="wrap">
            {!hasRabbit && (
              <>
                <Button
                  size="xs"
                  fontFamily="heading"
                  variant="outline"
                  onClick={handleCreateRabbitDeck}
                  disabled={busy !== null}
                >
                  {busy === "createRabbit" ? (
                    <Spinner size="sm" />
                  ) : (
                    <Plus size={16} aria-hidden />
                  )}
                  Add Rabbit Slides
                </Button>
                {askAi && (
                  <Button
                    size="sm"
                    fontFamily="heading"
                    variant="outline"
                    onClick={() =>
                      askAi(
                        `Create a new Rabbit Slides deck for activity ${activityId} ` +
                          `("${activity.title}") using the create_slides_deck tool. ` +
                          "Aim for 3-6 slides that work as a class visual aid.",
                      )
                    }
                    disabled={busy !== null}
                  >
                    <Robot size={16} aria-hidden />
                    Generate with Curriculum Bot
                  </Button>
                )}
              </>
            )}
            {!hasGoogle && hasGoogleConnected && (
              <GooglePickerButton
                label="Choose from Google Drive"
                icon={<GoogleDriveLogoIcon />}
                onPicked={handlePicked}
                disabled={busy !== null}
              />
            )}
            {!hasGoogle && !hasGoogleConnected && (
              <GoogleAccountConnect compact requiredAccess="slides" />
            )}
          </HStack>
        )}
        {busy === "attach" && (
          <HStack gap={2}>
            <Spinner size="sm" />
            <Text fontSize="sm">Attaching deck…</Text>
          </HStack>
        )}
        {error && (
          <Text fontSize="sm" color="red.500">
            {error}
          </Text>
        )}
      </VStack>
    </Field>
  );
}
