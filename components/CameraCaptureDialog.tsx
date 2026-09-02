"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Flex, IconButton, Text, Button } from "@chakra-ui/react";
import { Camera, CameraRotate, X } from "@phosphor-icons/react";

/**
 * Shared in-chat camera capture. Renders a full-bleed overlay with a live
 * <video> preview + capture / flip / close controls, snaps the current frame
 * to a JPEG File, and hands it back via onCapture. Used by BOTH the scholar
 * chat composer (SessionInterface) and the teacher curriculum-bot composer
 * (CurriculumAssistant) so the getUserMedia logic lives in exactly one place.
 *
 * The caller owns what happens to the File (SessionInterface stages it as
 * pendingImage; CurriculumAssistant uploads it via handleFilesSelected).
 */
export function CameraCaptureDialog({
  open,
  onClose,
  onCapture,
  /** Where the overlay anchors. "absolute" (default) fills the nearest
   *  positioned ancestor — the scholar chat pane, so the camera stays inside
   *  the chat column. "fixed" covers the viewport for composers with no such
   *  ancestor. */
  overlayPosition = "absolute",
  /** Burst mode: capture hands the File back but KEEPS the viewfinder live for
   *  the next shot (the School Space add-by-photo flow — snap-snap-snap). The
   *  three chat consumers leave this false and get the unchanged one-shot
   *  behavior (capture → close). */
  multiShot = false,
  /** How many shots the caller has registered this session — rendered as a
   *  small badge on the shutter in multiShot so the staffer sees them land. */
  capturedCount = 0,
  /** Which camera to open with. Defaults to "user" (selfie), the historical
   *  default the chat composers rely on. The add-by-photo flow passes
   *  "environment" (walking the school with the rear camera). */
  initialFacing = "user",
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  overlayPosition?: "absolute" | "fixed";
  multiShot?: boolean;
  capturedCount?: number;
  initialFacing?: "user" | "environment";
}) {
  // Selfie cam is the DEFAULT (Andy, on-device 2026-06-10): with the iPad
  // docked in the Folio, the rear camera faces away — you hold work up facing
  // yourself. The flip button covers the rear-camera case. `initialFacing`
  // lets the add-by-photo flow open rear-first instead.
  const [facing, setFacing] = useState<"user" | "environment">(initialFacing);
  const [error, setError] = useState<string | null>(null);
  // Brief white flash on a burst capture so the tap registers even though the
  // viewfinder stays live (no dialog close to signal the shot).
  const [flash, setFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Bumped on every stopStream(); a getUserMedia() call captures the generation
  // it started in and, once it resolves, bails (releasing its own tracks) if the
  // generation has moved on — i.e. the dialog was closed/unmounted or the stream
  // restarted while acquisition was still in flight. Without this, a stream that
  // resolves AFTER teardown gets parked in streamRef with nothing left to stop
  // it, leaving the camera (and its indicator light) on until page reload.
  const genRef = useRef(0);

  const stopStream = useCallback(() => {
    genRef.current++;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startStream = useCallback(
    async (face: "user" | "environment") => {
      setError(null);
      // getUserMedia is only exposed in a SECURE CONTEXT (https or localhost),
      // so navigator.mediaDevices is undefined over a plain-http origin — e.g.
      // an http dev shell. The camera works in the real https app; say that
      // instead of blaming "permissions" (the old, misleading message).
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError(
          "The camera needs a secure (https) connection. It works in the Rabbithole app and on the website — but not on a plain-http dev build.",
        );
        return;
      }
      try {
        stopStream();
        const gen = genRef.current;
        const stream = await navigator.mediaDevices
          .getUserMedia({ video: { facingMode: { ideal: face } } })
          .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
        // Closed/unmounted or restarted while we were acquiring: release the now-
        // orphaned stream instead of parking it in a ref nothing will ever stop.
        if (gen !== genRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access for Rabbithole, then try again."
            : name === "NotFoundError"
              ? "No camera was found on this device."
              : "Couldn't access the camera. Try again.",
        );
      }
    },
    [stopStream],
  );

  // Start the camera when the dialog opens; stop it when it closes/unmounts.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starting the camera (a side effect) is the whole point of opening the dialog
    if (open) void startStream(facing);
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `facing` is deliberately not a dep: flips restart the stream themselves; re-running this effect would double-start the camera
  }, [open, startStream, stopStream]);

  const handleClose = useCallback(() => {
    stopStream();
    onClose();
  }, [stopStream, onClose]);

  const flipCamera = useCallback(() => {
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    void startStream(next);
  }, [facing, startStream]);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `photo-${Date.now()}.jpg`, {
          type: "image/jpeg",
        });
        onCapture(file);
        if (multiShot) {
          // Keep the stream live for the next shot; just flash to confirm.
          setFlash(true);
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setFlash(false), 150);
        } else {
          handleClose();
        }
      },
      "image/jpeg",
      0.92,
    );
  }, [onCapture, handleClose, multiShot]);

  // Clear a pending flash timer on unmount so it can't setState afterward.
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  if (!open) return null;

  return (
    <Flex
      position={overlayPosition}
      inset={0}
      zIndex={10000}
      bg="black"
      flexDir="column"
      align="center"
      justify="center"
    >
      {error ? (
        <Flex flexDir="column" align="center" gap={5} px={8} maxW="md" textAlign="center">
          <Text color="white" fontFamily="heading" fontSize="md" lineHeight="1.5">
            {error}
          </Text>
          <Button
            onClick={handleClose}
            bg="whiteAlpha.200"
            color="white"
            _hover={{ bg: "whiteAlpha.400" }}
            borderRadius="full"
            fontFamily="heading"
          >
            Close
          </Button>
        </Flex>
      ) : (
        <>
          {flash && (
            <Box
              position="absolute"
              inset={0}
              bg="white"
              zIndex={1}
              pointerEvents="none"
            />
          )}
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
                videoRef.current = el;
                if (el && streamRef.current) el.srcObject = streamRef.current;
              }}
              autoPlay
              playsInline
              muted
              // Mirror only the selfie preview (like the system camera);
              // captures stay unmirrored so photographed text reads right.
              style={{
                // Fill the available space (not the video's small intrinsic
                // size, which left a big black letterbox); objectFit:contain
                // keeps the aspect ratio without cropping.
                width: "100%",
                height: "100%",
                objectFit: "contain",
                transform: facing === "user" ? "scaleX(-1)" : undefined,
              }}
            />
          </Box>
          <Flex gap={4} py={4} align="center">
            {multiShot ? (
              // In burst mode the close control finishes the run — make it a
              // clear labeled "Done" pill, not a corner glyph.
              <Button
                onClick={handleClose}
                bg="whiteAlpha.300"
                color="white"
                _hover={{ bg: "whiteAlpha.400" }}
                borderRadius="full"
                fontFamily="heading"
                fontSize="sm"
                size="lg"
                px={7}
                h={14}
              >
                Done
              </Button>
            ) : (
              <IconButton
                aria-label="Cancel"
                onClick={handleClose}
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
            )}
            <IconButton
              aria-label="Switch camera"
              onClick={flipCamera}
              bg="whiteAlpha.200"
              color="white"
              _hover={{ bg: "whiteAlpha.400" }}
              borderRadius="full"
              size="lg"
              w={14}
              h={14}
            >
              <CameraRotate size={24} />
            </IconButton>
            <Box position="relative">
              <IconButton
                aria-label="Take photo"
                onClick={capturePhoto}
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
              {multiShot && capturedCount > 0 && (
                <Flex
                  position="absolute"
                  top="-4px"
                  right="-4px"
                  minW="22px"
                  h="22px"
                  px={1.5}
                  bg="violet.500"
                  color="white"
                  borderWidth="1px"
                  borderColor="white"
                  borderRadius="full"
                  align="center"
                  justify="center"
                  fontFamily="heading"
                  fontSize="xs"
                  fontWeight="700"
                  pointerEvents="none"
                >
                  {capturedCount}
                </Flex>
              )}
            </Box>
          </Flex>
        </>
      )}
    </Flex>
  );
}
