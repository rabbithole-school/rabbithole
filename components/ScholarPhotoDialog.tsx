"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  IconButton,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import { Camera, Image as ImageIcon, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";

// Mirror the server-side guard (convex validates MIME + size too). Keeping the
// client check in lockstep gives a friendly message instead of a raw rejection.
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024;

interface ScholarPhotoDialogProps {
  open: boolean;
  onClose: () => void;
  scholarName: string;
  currentImage?: string | null;
  /** Caller supplies the mutation (guardian- or staff-gated). Receives the
   *  uploaded file's storage id; should resolve once the photo is persisted. */
  onSave: (storageId: Id<"_storage">) => Promise<void>;
}

/**
 * Shared "set a scholar's profile photo" dialog. Two consumers wire it: the
 * parent portal (guardian sets their own child's photo) and the operations staff
 * directory (staff sets any scholar's). Both supply their own gated mutation
 * via `onSave`; this component only handles picking/capturing + uploading.
 */
export function ScholarPhotoDialog({
  open,
  onClose,
  scholarName,
  currentImage,
  onSave,
}: ScholarPhotoDialogProps) {
  // The Root's onOpenChange must ignore the focus-steal "outside click" the
  // live <video> triggers while the camera overlay is up. A ref (not state)
  // lets the event handler read the current value without a reset effect; the
  // form owns the actual camera state and clears the ref when it unmounts.
  const cameraOpenRef = useRef(false);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open && cameraOpenRef.current) return;
        if (!e.open) onClose();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            {/* Mount the form only while open so every per-open bit of state
                (preview, pending file, error) resets on each open — the safe
                alternative to re-keying Dialog.Root (which leaks the body lock). */}
            {open && (
              <ScholarPhotoForm
                scholarName={scholarName}
                currentImage={currentImage}
                onClose={onClose}
                onSave={onSave}
                cameraOpenRef={cameraOpenRef}
              />
            )}
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ScholarPhotoForm({
  scholarName,
  currentImage,
  onClose,
  onSave,
  cameraOpenRef,
}: {
  scholarName: string;
  currentImage?: string | null;
  onClose: () => void;
  onSave: (storageId: Id<"_storage">) => Promise<void>;
  cameraOpenRef: React.MutableRefObject<boolean>;
}) {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);

  const [preview, setPreview] = useState<string | undefined>(
    currentImage ?? undefined,
  );
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Track the current object URL so we can revoke it when it's replaced or the
  // form unmounts (a preview blob otherwise leaks for the page's lifetime).
  const objectUrlRef = useRef<string | null>(null);

  const setPreviewFromFile = useCallback((file: File) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setPreview(url);
  }, []);

  const selectFile = useCallback(
    (file: File) => {
      setError(null);
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError("Please choose a JPEG, PNG, WebP, or GIF image.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError("That image is larger than 5 MB. Please choose a smaller file.");
        return;
      }
      setPendingFile(file);
      setPreviewFromFile(file);
    },
    [setPreviewFromFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so re-selecting the same file fires onChange again.
      e.target.value = "";
      if (file) selectFile(file);
    },
    [selectFile],
  );

  const closeCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    cameraOpenRef.current = false;
    setShowCamera(false);
  }, [cameraOpenRef]);

  const openCamera = useCallback(async () => {
    setCameraError(false);
    cameraOpenRef.current = true;
    setShowCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
      }
    } catch {
      cameraOpenRef.current = false;
      setShowCamera(false);
      setCameraError(true);
    }
  }, [cameraOpenRef]);

  const capturePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      setCameraError(true);
      return;
    }
    // A real webcam doesn't deliver its first frame instantly; wait (up to ~3s)
    // for a non-zero frame before grabbing, or we'd capture a blank 0x0 image.
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      const ready = await new Promise<boolean>((resolve) => {
        const start = Date.now();
        const check = () => {
          if (video.videoWidth > 0 && video.videoHeight > 0) return resolve(true);
          if (Date.now() - start > 3000) return resolve(false);
          requestAnimationFrame(check);
        };
        check();
      });
      if (!ready) {
        closeCamera();
        setCameraError(true);
        return;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    closeCamera();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    if (!blob) {
      setCameraError(true);
      return;
    }
    const file = new File([blob], `scholar-photo-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });
    selectFile(file);
  }, [closeCamera, selectFile]);

  // Clean up any live stream + preview blob when the form unmounts.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      cameraOpenRef.current = false;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [cameraOpenRef]);

  const handleSave = useCallback(async () => {
    if (!pendingFile) return;
    setIsSaving(true);
    setError(null);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": pendingFile.type },
        body: pendingFile,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const { storageId } = await res.json();
      await onSave(storageId as Id<"_storage">);
      onClose();
    } catch (err) {
      console.error("Scholar photo save failed:", err);
      setError("Something went wrong saving the photo. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [pendingFile, generateUploadUrl, onSave, onClose]);

  return (
    <>
      <Dialog.Header px={6} pt={6} pb={0}>
        <Dialog.Title asChild>
          <Heading
            size="md"
            fontFamily="heading"
            color="navy.500"
            fontWeight="600"
          >
            {`${scholarName}'s photo`}
          </Heading>
        </Dialog.Title>
      </Dialog.Header>

      <Dialog.Body px={6} py={5}>
        <VStack gap={5} w="full">
          <Avatar name={scholarName} src={preview} size="xl" />

          <HStack gap={3}>
            <Button
              variant="outline"
              size="sm"
              borderColor="gray.300"
              color="charcoal.500"
              fontFamily="heading"
              fontWeight="500"
              _hover={{ borderColor: "violet.400", color: "violet.600" }}
              disabled={isSaving}
              onClick={() => fileRef.current?.click()}
            >
              <ImageIcon style={{ marginRight: "6px" }} />
              Choose a file
            </Button>
            <Button
              variant="outline"
              size="sm"
              borderColor="gray.300"
              color="charcoal.500"
              fontFamily="heading"
              fontWeight="500"
              _hover={{ borderColor: "violet.400", color: "violet.600" }}
              disabled={isSaving}
              onClick={() => void openCamera()}
            >
              <Camera style={{ marginRight: "6px" }} />
              Take a photo
            </Button>
          </HStack>

          <input
            ref={fileRef}
            type="file"
            accept=".jpg,.jpeg,image/jpeg,image/png,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={handleFileInput}
          />

          <Text
            fontSize="sm"
            fontFamily="heading"
            color="charcoal.300"
            textAlign="center"
          >
            JPEG, PNG, WebP, or GIF. Up to 5 MB.
          </Text>

          {cameraError && (
            <Text fontSize="sm" fontFamily="heading" color="red.500" textAlign="center">
              The camera didn&apos;t work. Check camera permissions, or use
              &ldquo;Choose a file&rdquo; to pick an image instead.
            </Text>
          )}
          {error && (
            <Text fontSize="sm" fontFamily="heading" color="red.500" textAlign="center">
              {error}
            </Text>
          )}
        </VStack>
      </Dialog.Body>

      <Dialog.Footer px={6} py={4} borderTop="1px solid" borderColor="gray.100">
        <HStack gap={3} w="full" justify="flex-end">
          <Button
            variant="ghost"
            size="sm"
            color="charcoal.400"
            fontFamily="heading"
            fontWeight="500"
            _hover={{ color: "violet.500" }}
            disabled={isSaving}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            fontWeight="500"
            px={8}
            disabled={!pendingFile || isSaving}
            onClick={() => void handleSave()}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </HStack>
      </Dialog.Footer>

      {/*
        Full-screen camera overlay. Rendered INSIDE Dialog.Content (not a
        separate portal) so the modal treats it as part of itself — pointer
        events and focus reach the shutter button (an outside portal gets its
        clicks swallowed by the modal's interaction layer).
      */}
      {showCamera && (
        <Flex
          position="fixed"
          inset={0}
          zIndex={2147483000}
          bg="black"
          flexDir="column"
          align="center"
          justify="center"
        >
          <Box
            position="relative"
            maxW="100%"
            maxH="100%"
            flex={1}
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <video
              ref={(el) => {
                (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current =
                  el;
                if (el && streamRef.current) {
                  el.srcObject = streamRef.current;
                  void el.play().catch(() => {});
                }
              }}
              autoPlay
              playsInline
              muted
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                transform: "scaleX(-1)",
              }}
            />
          </Box>
          <Flex gap={4} py={4}>
            <IconButton
              aria-label="Cancel"
              onClick={closeCamera}
              bg="whiteAlpha.200"
              color="white"
              _hover={{ bg: "whiteAlpha.400" }}
              borderRadius="full"
              size="lg"
              w={14}
              h={14}
            >
              <X size={24} />
            </IconButton>
            <IconButton
              aria-label="Take photo"
              onClick={() => void capturePhoto()}
              bg="white"
              color="gray.800"
              _hover={{ bg: "gray.200" }}
              borderRadius="full"
              size="lg"
              w={16}
              h={16}
            >
              <Camera size={28} />
            </IconButton>
          </Flex>
        </Flex>
      )}
    </>
  );
}
