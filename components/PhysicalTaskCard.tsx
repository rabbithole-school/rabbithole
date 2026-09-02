"use client";

/**
 * PhysicalTaskCard — the scholar-facing "Go do this" card for a tutor-suggested
 * hands-on task (Phase 2 of the physical-environment feature). Rendered inline
 * in the chat stream from a `role:"tool"` message whose `toolAction ===
 * "physical_task"` and whose `content` is the physicalTasks id.
 *
 * Two ways to return:
 *  - "I'm back" (physicalTasks.markDone) → a SUBTLE checkmark, not a
 *    celebration (we don't yet know what happened; the real learning is what
 *    they report next in chat).
 *  - "📸 Show what I found" (physicalTasks.attachPhoto) → the scholar returns
 *    with a PHOTO of what they built/found. It's uploaded via the SAME file-
 *    storage path the chat image attachment uses, lands as a `role:"user"`
 *    image message on the existing vision path (so the tutor reasons from the
 *    artifact next turn), and persists on the task row as evidence. On web we
 *    fall back to a file picker; native camera capture is a separate follow-up.
 *
 * Read-only (no buttons) when a teacher is viewing remotely.
 */

import { useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Box, Button, HStack, Image, Text, VStack } from "@chakra-ui/react";
import { Compass, MapPin, Check, Camera } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export function PhysicalTaskCard({
  physicalTaskId,
  readOnly = false,
}: {
  physicalTaskId: string;
  readOnly?: boolean;
}) {
  const task = useQuery(api.physicalTasks.getForCard, {
    id: physicalTaskId as Id<"physicalTasks">,
  });
  const markDone = useMutation(api.physicalTasks.markDone);
  const attachPhoto = useMutation(api.physicalTasks.attachPhoto);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Serving URL for the returned photo (only when one exists → cheap thumbnail).
  const photoUrl = useQuery(
    api.files.getUrl,
    task?.photoStorageId
      ? { storageId: task.photoStorageId as Id<"_storage"> }
      : "skip",
  );

  if (task === undefined || task === null) return null;
  const done = task.status === "completed";

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file || !file.type.startsWith("image/")) return;
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = await res.json();
      await attachPhoto({
        id: task.id as Id<"physicalTasks">,
        photoStorageId: storageId as Id<"_storage">,
      });
    } catch (err) {
      console.error("Photo return failed:", err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Box display="flex" justifyContent="center" py={2}>
      <Box
        maxW="440px"
        w="full"
        border="1px solid"
        borderColor="violet.200"
        bg="violet.50"
        borderRadius="xl"
        px={4}
        py={3.5}
      >
        <HStack gap={2} mb={1.5} align="center">
          <Box color="violet.600" display="flex">
            <Compass size={20} weight="duotone" />
          </Box>
          <Text
            fontFamily="heading"
            fontWeight="700"
            fontSize="sm"
            color="violet.700"
            textTransform="uppercase"
            letterSpacing="0.04em"
          >
            Go try this
          </Text>
        </HStack>

        <VStack align="stretch" gap={1}>
          <HStack gap={1.5} align="center">
            <Text fontFamily="heading" fontWeight="700" color="navy.600">
              {task.equipmentName}
            </Text>
            {task.spaceName && (
              <HStack gap={0.5} color="charcoal.400">
                <MapPin size={14} />
                <Text fontSize="xs">{task.spaceName}</Text>
              </HStack>
            )}
          </HStack>
          <Text fontSize="sm" color="charcoal.600" lineHeight="1.5">
            {task.prompt}
          </Text>
        </VStack>

        {done ? (
          // Subtle done state — a quiet checkmark, no celebration (we don't yet
          // know how it went; the report-back in chat is where the learning is).
          // If they returned WITH a photo, show a small thumbnail as evidence.
          <HStack gap={2} mt={3} align="center">
            {photoUrl && (
              <Image
                src={photoUrl}
                alt="What the scholar found"
                boxSize="40px"
                borderRadius="md"
                objectFit="cover"
                border="1px solid"
                borderColor="violet.200"
              />
            )}
            <HStack gap={1.5} color="charcoal.400">
              <Check size={15} weight="bold" />
              <Text fontSize="xs" fontWeight="600">
                Returned
              </Text>
            </HStack>
          </HStack>
        ) : readOnly ? null : (
          <HStack gap={2} mt={3}>
            <Button
              size="sm"
              colorPalette="violet"
              variant="outline"
              onClick={() => markDone({ id: task.id as Id<"physicalTasks"> })}
              disabled={uploading}
            >
              I&rsquo;m back
            </Button>
            <Button
              size="sm"
              colorPalette="violet"
              onClick={() => fileInputRef.current?.click()}
              loading={uploading}
              loadingText="Adding…"
            >
              <Camera size={16} weight="duotone" style={{ marginRight: 6 }} />
              Show what I found
            </Button>
          </HStack>
        )}

        {/* Hidden file input — web fallback for photo capture. `capture`
            biases mobile browsers toward the camera; desktop shows a picker. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onPickPhoto}
        />
      </Box>
    </Box>
  );
}
