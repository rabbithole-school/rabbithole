"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Dialog,
  Portal,
  HStack,
  VStack,
  Text,
  Button,
  IconButton,
  Spinner,
} from "@chakra-ui/react";
import { Camera, CameraRotate, Trash, CloudArrowUp, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";

/**
 * Take Photo → multi-page scan. Reuses the getUserMedia capture path from the
 * profile-photo flow, but lets the teacher snap 1+ pages, then combines them
 * into a single multi-page PDF (pdf-lib, client-side) and pushes it through the
 * normal scan ingest pipeline (so it gets segmented/rotated/scholar+assignment
 * tagged like any other scan).
 */
export function CameraScanDialog({
  open,
  onClose,
  scope,
}: {
  open: boolean;
  onClose: () => void;
  scope?: string;
}) {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const ingestUploadedScan = useAction(api.portfolioActions.ingestUploadedScan);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [pages, setPages] = useState<Blob[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Selfie cam is the DEFAULT (Andy, on-device 2026-06-10): with the iPad
  // docked in the Folio the rear camera faces away — you hold the page up
  // facing yourself. The flip button covers the rear-camera case.
  const [facing, setFacing] = useState<"user" | "environment">("user");

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async (face: "user" | "environment") => {
    setError(null);
    // getUserMedia is only exposed in a SECURE CONTEXT (https or localhost), so
    // navigator.mediaDevices is undefined when the app is loaded over a
    // plain-http origin — e.g. the iPad dev build served at http://<lan-ip>.
    // The camera works in the real https app; it can't on an http dev shell.
    // Say that instead of blaming "permissions" (the old, misleading message).
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(
        "The camera needs a secure (https) connection. It works in the Rabbithole app and on the website — but not on a plain-http dev build.",
      );
      return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices
        .getUserMedia({ video: { facingMode: { ideal: face } } })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
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
  }, [stopCamera]);

  const flipCamera = useCallback(() => {
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    void startCamera(next);
  }, [facing, startCamera]);

  // Start/stop with the dialog; revoke object URLs on cleanup.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starting the camera (a side effect) is the whole point of opening the dialog
    if (open) void startCamera(facing);
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `facing` is deliberately not a dep: flips restart the stream themselves; re-running this effect would double-start the camera
  }, [open, startCamera, stopCamera]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const reset = () => {
    urls.forEach((u) => URL.revokeObjectURL(u));
    setPages([]);
    setUrls([]);
    setError(null);
    setBusy(false);
  };

  const handleClose = () => {
    if (busy) return;
    stopCamera();
    reset();
    onClose();
  };

  // Cap to keep client-side PDF assembly tractable. 20 full-res JPEGs is
  // already ~30-60MB in memory; a Chromebook will OOM well before 50.
  const MAX_PAGES = 20;

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) {
      setError("Camera not ready yet — try again in a moment.");
      return;
    }
    if (pages.length >= MAX_PAGES) {
      setError(`Max ${MAX_PAGES} pages per scan — upload these and start another.`);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    if (!blob) {
      setError("Capture failed — try again.");
      return;
    }
    setPages((p) => [...p, blob]);
    setUrls((u) => [...u, URL.createObjectURL(blob)]);
  }, [pages.length]);

  const removePage = (i: number) => {
    URL.revokeObjectURL(urls[i]);
    setPages((p) => p.filter((_, idx) => idx !== i));
    setUrls((u) => u.filter((_, idx) => idx !== i));
  };

  const finish = async () => {
    if (pages.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Combine the captured JPEGs into one multi-page PDF (client-side).
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      for (const blob of pages) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const img = await pdf.embedJpg(bytes);
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      const pdfBytes: Uint8Array = await pdf.save();
      const ab = pdfBytes.buffer.slice(
        pdfBytes.byteOffset,
        pdfBytes.byteOffset + pdfBytes.byteLength,
      ) as ArrayBuffer;

      const url = await generateUploadUrl();
      const put = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Blob([ab], { type: "application/pdf" }),
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const { storageId } = (await put.json()) as { storageId: Id<"_storage"> };

      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      await ingestUploadedScan({
        storageId,
        fileMimeType: "application/pdf",
        title: `Photo scan ${stamp}`,
        source: "photo",
        scope,
      });
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    // Non-modal: this dialog opens from inside the scanner Upload drawer, and a
    // modal dialog stacked over the still-open drawer leaves document.body
    // pointer-events:none stuck on close (see the comment in ScannerPanel).
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && handleClose()} placement="center" modal={false}>
      <Portal>
        {/* Non-modal dialog → outside-click doesn't auto-dismiss; close on
            backdrop click explicitly. */}
        <Dialog.Backdrop onClick={() => handleClose()} />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={5} pb={2}>
              <HStack justify="space-between">
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  Take photo scan
                </Dialog.Title>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" onClick={handleClose} disabled={busy}>
                  <X />
                </IconButton>
              </HStack>
            </Dialog.Header>
            <Dialog.Body px={6} pb={5} pt={2}>
              <VStack gap={3} align="stretch">
                <Box bg="black" borderRadius="md" overflow="hidden" position="relative" h="300px">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    // Mirror only the selfie preview (like the system camera);
                    // captures stay unmirrored so the scanned text reads right.
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      transform: facing === "user" ? "scaleX(-1)" : undefined,
                    }}
                  />
                  <IconButton
                    aria-label="Switch camera"
                    size="sm"
                    position="absolute"
                    top={2}
                    right={2}
                    bg="blackAlpha.600"
                    color="white"
                    _hover={{ bg: "blackAlpha.800" }}
                    borderRadius="full"
                    onClick={flipCamera}
                    disabled={busy}
                  >
                    <CameraRotate size={18} />
                  </IconButton>
                </Box>

                {pages.length > 0 && (
                  <HStack gap={2} overflowX="auto" py={1}>
                    {urls.map((u, i) => (
                      <Box key={u} position="relative" flexShrink={0}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={u} alt={`Page ${i + 1}`} style={{ width: 56, height: 72, objectFit: "cover", borderRadius: 6, border: "1px solid #e2e8f0" }} />
                        <Box position="absolute" top="-6px" left="-6px" bg="violet.500" color="white" borderRadius="full" w="18px" h="18px" fontSize="10px" fontFamily="heading" display="flex" alignItems="center" justifyContent="center">
                          {i + 1}
                        </Box>
                        <IconButton aria-label="Remove" size="2xs" variant="solid" bg="red.500" color="white" _hover={{ bg: "red.600" }} position="absolute" bottom="-6px" right="-6px" onClick={() => removePage(i)}>
                          <Trash size={10} />
                        </IconButton>
                      </Box>
                    ))}
                  </HStack>
                )}

                {error && (
                  <Text fontSize="sm" color="red.500" fontFamily="body">
                    {error}
                  </Text>
                )}

                <HStack justify="space-between">
                  <Button
                    size="sm"
                    variant="outline"
                    fontFamily="heading"
                    onClick={() => void capture()}
                    disabled={busy || pages.length >= MAX_PAGES}
                  >
                    <Camera style={{ marginRight: "6px" }} />
                    {pages.length === 0
                      ? "Capture page"
                      : pages.length >= MAX_PAGES
                        ? `Max ${MAX_PAGES} pages`
                        : "Capture another"}
                  </Button>
                  <Button
                    size="sm"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    fontFamily="heading"
                    disabled={pages.length === 0 || busy}
                    onClick={() => void finish()}
                  >
                    {busy ? <Spinner size="xs" mr={2} /> : <CloudArrowUp style={{ marginRight: "6px" }} />}
                    Upload {pages.length || ""} page{pages.length === 1 ? "" : "s"}
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
