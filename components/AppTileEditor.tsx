"use client";

/**
 * Setting an app tile's mark — the staff side of `shared/appTileMark.ts`.
 *
 * The catalog has carried `iconUrl`/`color` since the launcher shipped, but
 * nothing in the UI ever wrote either one, so every app a teacher added came
 * out as an initial on the same violet squircle. This is that missing input:
 * an emoji (the rung most apps land on — no upload, no third-party request,
 * and it renders offline on the iPads) plus an optional tile color, previewed
 * live through the same `AppTileIcon` the scholar sees.
 *
 * `AppTileFields` is the editor body, used both inline in the "New app" form
 * and inside `AppTileEditorDialog` for an app already in the catalog.
 */

import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppTileIcon } from "@/components/ui/AppTileIcon";
import { EmojiPickerButton } from "@/components/ui/EmojiPickerButton";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { APP_TILE_TINTS, appTileImageSrc, appTileTint } from "@/shared/appTileMark";

export interface AppTileDraft {
  emoji: string;
  /** "" means automatic — the hue `appTileTint` derives from the name. */
  color: string;
}

export function AppTileFields({
  name,
  iconUrl,
  draft,
  onChange,
}: {
  name: string;
  iconUrl?: string | null;
  draft: AppTileDraft;
  onChange: (next: AppTileDraft) => void;
}) {
  const previewName = name.trim() || "New app";
  // What the tile will ACTUALLY show, decided by the same resolver the scholar
  // renders through — an icon value the resolver rejects (an app route, a
  // non-image scheme) is no more a logo than a blank field is, and the emoji
  // rung only exists once an emoji is set.
  const hasImage = appTileImageSrc(iconUrl) !== null;
  const hasEmoji = !!draft.emoji.trim();

  return (
    <Stack gap={3}>
      <HStack gap={3} align="center">
        <AppTileIcon
          name={previewName}
          iconUrl={iconUrl}
          iconEmoji={draft.emoji}
          color={draft.color || null}
          boxSize="56px"
          radius="24%"
          markFontSize="22px"
          // A live preview of the field below it, labeled "Tile".
          decorative
        />
        <Box flex={1} minW={0}>
          <Text
            fontSize="xs"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.500"
          >
            Tile
          </Text>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
            {hasImage
              ? hasEmoji
                ? "Scholars see this app’s logo. The emoji shows if it can’t load."
                : "Scholars see this app’s logo. The app’s initial shows if it can’t load."
              : hasEmoji
                ? "Scholars see the emoji on the tile color."
                : "Scholars see the app’s initial on the tile color. Pick an emoji to change that."}
          </Text>
        </Box>
        <EmojiPickerButton
          value={draft.emoji}
          onChange={(emoji) => onChange({ ...draft, emoji })}
          ariaLabel="Choose a tile emoji"
          height="40px"
          minW="52px"
          fontSize="xl"
        />
        {draft.emoji ? (
          <Button
            size="xs"
            variant="ghost"
            fontFamily="heading"
            onClick={() => onChange({ ...draft, emoji: "" })}
          >
            Clear
          </Button>
        ) : null}
      </HStack>

      <Box>
        <Text
          fontSize="2xs"
          fontFamily="heading"
          fontWeight="600"
          color="charcoal.400"
          mb={1.5}
        >
          Tile color
        </Text>
        <HStack gap={2} wrap="wrap">
          <TintSwatch
            tint={appTileTint({ name: previewName })}
            label="Automatic"
            selected={draft.color === ""}
            onSelect={() => onChange({ ...draft, color: "" })}
            auto
          />
          {APP_TILE_TINTS.map((tint) => (
            <TintSwatch
              key={tint}
              tint={tint}
              label={tint}
              selected={draft.color === tint}
              onSelect={() => onChange({ ...draft, color: tint })}
            />
          ))}
        </HStack>
      </Box>
    </Stack>
  );
}

function TintSwatch({
  tint,
  label,
  selected,
  onSelect,
  auto = false,
}: {
  tint: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  auto?: boolean;
}) {
  return (
    <Box
      as="button"
      aria-label={auto ? "Automatic tile color" : `Tile color ${label}`}
      aria-pressed={selected}
      onClick={onSelect}
      w="30px"
      h="30px"
      borderRadius="24%"
      bg={tint}
      borderWidth="2px"
      borderColor={selected ? "navy.500" : "transparent"}
      boxShadow="0 1px 3px rgba(20,24,50,0.18)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      cursor="pointer"
    >
      {auto ? (
        <Text fontSize="2xs" fontWeight="800" color="white" lineHeight="1">
          A
        </Text>
      ) : null}
    </Box>
  );
}

export function AppTileEditorDialog({
  app,
  onClose,
}: {
  app: AppTileEditorTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={!!app}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="420px" w="95vw">
            <Dialog.Header px={6} pt={5} pb={3}>
              <Flex align="center" flex={1} minW={0}>
                <Dialog.Title
                  fontFamily="heading"
                  fontWeight="700"
                  color="navy.500"
                  fontSize="lg"
                  lineClamp={1}
                >
                  {app?.name ?? "App"} tile
                </Dialog.Title>
              </Flex>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            {/* Keyed on the app so each open starts from that app's saved
                tile rather than syncing state in an effect. */}
            {app ? (
              <TileEditorBody key={app._id} app={app} onClose={onClose} />
            ) : null}
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

export interface AppTileEditorTarget {
  _id: Id<"externalApps">;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
}

function TileEditorBody({
  app,
  onClose,
}: {
  app: AppTileEditorTarget;
  onClose: () => void;
}) {
  const updateCatalogApp = useMutation(api.externalApps.updateCatalogApp);
  const [draft, setDraft] = useState<AppTileDraft>({
    emoji: app.iconEmoji ?? "",
    color: app.color ?? "",
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Empty string clears the field, per the catalog patch convention.
      await updateCatalogApp({
        appId: app._id,
        iconEmoji: draft.emoji,
        color: draft.color,
      });
      toaster.success({ title: `${app.name} tile updated` });
      onClose();
    } catch (err) {
      toaster.error({
        title: err instanceof Error ? err.message : "Could not save the tile",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Body px={6} pt={0} pb={5}>
      <AppTileFields
        name={app.name}
        iconUrl={app.iconUrl}
        draft={draft}
        onChange={setDraft}
      />
      <HStack gap={2} justify="flex-end" mt={5}>
        <Button size="sm" variant="ghost" fontFamily="heading" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          colorPalette="violet"
          fontFamily="heading"
          loading={saving}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
      </HStack>
    </Dialog.Body>
  );
}
