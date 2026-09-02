"use client";

/**
 * "Report a bug" dialog (web) — the typed-first twin of the native held-gesture
 * report. Mounted once as a sibling of the AccountMenu; a signed-in user of any
 * role types what went wrong (optionally dictating it, optionally attaching a
 * screenshot) and it lands as one `bugReports` row for the platform-ops triage
 * pipeline. See review/bug-reporting-gesture-plan.html §4.
 *
 * Body-lock discipline: `Dialog.Root` stays stably mounted (we only toggle
 * `open`) and the whole form + its state lives in an inner `{open && <Form/>}`
 * child, so per-open state re-seeds via a fresh mount without ever remounting
 * the Ark dialog scope (engineering-principles.md "Chakra/Ark Dialog Gotchas").
 *
 * Works while impersonating / remote-viewing on purpose — that viewing state is
 * exactly what a report should capture, and the backend submit mutation is the
 * one write that stays available during view-as.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  Field,
  Flex,
  HStack,
  IconButton,
  Image,
  Portal,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { X, Paperclip, Trash, CheckCircle } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { DictationMicButton } from "@/components/DictationMicButton";
import { useViewingContext } from "@/hooks/useViewingContext";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// The backend (convex/bugReports.ts) only stores PNG/JPEG; reject anything else
// client-side before we ever preview or upload it, so retry isn't trapped on an
// unsupported pending file.
const ACCEPTED_IMAGE_MIME = new Set(["image/png", "image/jpeg"]);

// Pure MIME + size guard shared by manual attach and the auto-capture staging.
function isAcceptableImage(file: File): boolean {
  return ACCEPTED_IMAGE_MIME.has(file.type) && file.size <= MAX_IMAGE_BYTES;
}

interface BugReportDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * A page screenshot auto-captured when the report flow opened (or null when
   * capture was declined/unsupported). Staged as the initial "Include
   * screenshot" shot; the blob is kept in memory for the dialog's lifetime so
   * unchecking then re-checking can restore it.
   */
  initialCapture?: File | null;
  /**
   * Called when the form has discarded the captured screenshot (on successful
   * submit) so the parent can release its retained `capturedShot` reference
   * BEFORE the saved state renders.
   */
  onScreenshotDiscarded?: () => void;
}

export function BugReportDialog({
  open,
  onClose,
  initialCapture = null,
  onScreenshotDiscarded,
}: BugReportDialogProps) {
  // The form owns the async "busy" state; mirror it into a ref the stable shell
  // can read from `onOpenChange` so ESC/backdrop can't discard an in-flight
  // submission (the textarea would unmount mid-upload). No re-render needed —
  // the handler reads the ref at event time.
  const busyRef = useRef(false);
  const setBusy = useCallback((b: boolean) => {
    busyRef.current = b;
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => {
        if (!d.open && !busyRef.current) onClose();
      }}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            {open && (
              <BugReportForm
                onClose={onClose}
                onBusyChange={setBusy}
                initialCapture={initialCapture}
                onScreenshotDiscarded={onScreenshotDiscarded}
              />
            )}
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

type ImageSource = "capture" | "manual";
type PendingImage = { file: File; preview: string; source: ImageSource };

function BugReportForm({
  onClose,
  onBusyChange,
  initialCapture,
  onScreenshotDiscarded,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  initialCapture: File | null;
  onScreenshotDiscarded?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const remoteParam = searchParams?.get("remote") ?? null;
  const { mode: viewingMode } = useViewingContext({
    remoteUserId: remoteParam,
    pathname,
  });

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const submit = useMutation(api.bugReports.submit);

  const [description, setDescription] = useState("");
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The auto-captured page screenshot, retained for the dialog's lifetime so
  // unchecking "Include screenshot" (which clears `pending` and revokes its
  // object URL) can be undone by re-checking. Cleared on successful submit.
  // `hasCapture` gates whether the checkbox is offered at all.
  const capturedFileRef = useRef<File | null>(null);
  const [hasCapture, setHasCapture] = useState(false);

  // The object URL is owned by a ref (not derived inside a state updater) so
  // creation/revocation happen exactly once even under Strict Mode's
  // double-invoked updaters, and unmount can always revoke the live one.
  const previewRef = useRef<string | null>(null);
  // Guards async completion from touching state after the form unmounts, and a
  // synchronous double-submit latch.
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  // Revoke + clear the staged image (any source) and reset the file input.
  const clearStaged = useCallback(() => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    setPending(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Validate (same MIME + size guard as manual attach) then stage. A manual
  // failure surfaces an inline error; a capture that somehow fails validation
  // degrades silently (no error, nothing staged) — the helper already bounds
  // capture size, this is the belt-and-braces guard. Returns whether it staged.
  const stageFile = useCallback(
    (file: File, source: ImageSource): boolean => {
      if (!ACCEPTED_IMAGE_MIME.has(file.type)) {
        if (source === "manual") setError("Attach a PNG or JPEG screenshot.");
        if (fileInputRef.current) fileInputRef.current.value = "";
        return false;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        if (source === "manual")
          setError("That screenshot is over 8 MB — attach a smaller one.");
        if (fileInputRef.current) fileInputRef.current.value = "";
        return false;
      }
      setError(null);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      const url = URL.createObjectURL(file);
      previewRef.current = url;
      setPending({ file, preview: url, source });
      return true;
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    // Stage the auto-captured shot with "Include screenshot" checked. Validated
    // with the same guard as manual attach so it can't bypass the size/MIME
    // check; the object URL is created here as a side effect (not in render / a
    // lazy initializer) so it's created once and always revocable on unmount.
    if (initialCapture && isAcceptableImage(initialCapture)) {
      capturedFileRef.current = initialCapture;
      const url = URL.createObjectURL(initialCapture);
      previewRef.current = url;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount staging of the captured shot
      setPending({ file: initialCapture, preview: url, source: "capture" });
      setHasCapture(true);
    }
    return () => {
      mountedRef.current = false;
      if (previewRef.current) {
        URL.revokeObjectURL(previewRef.current);
        previewRef.current = null;
      }
    };
    // Runs once for the dialog's lifetime; initialCapture is fixed at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the shell's busy ref in sync; always clear it on unmount.
  useEffect(() => {
    onBusyChange(submitting);
    return () => onBusyChange(false);
  }, [submitting, onBusyChange]);

  const stageImage = useCallback(
    (file: File) => {
      stageFile(file, "manual");
    },
    [stageFile],
  );

  const removeImage = useCallback(() => {
    clearStaged();
  }, [clearStaged]);

  // "Include screenshot" checkbox — checked means "a screenshot IS included"
  // (`pending != null`), NOT "the pending image came from capture". Unchecking
  // removes whichever source is staged; checking restores the captured shot from
  // memory (kept for the dialog's lifetime). If nothing is in memory to restore,
  // checking is a no-op (and the checkbox is disabled in that state), so the box
  // never reads checked while nothing is staged.
  const toggleInclude = useCallback(
    (include: boolean) => {
      if (!include) {
        clearStaged();
        return;
      }
      const captured = capturedFileRef.current;
      if (!captured) return;
      stageFile(captured, "capture");
    },
    [clearStaged, stageFile],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const item = Array.from(e.clipboardData.items).find((i) =>
        i.type.startsWith("image/"),
      );
      if (!item) return;
      const blob = item.getAsFile();
      if (!blob) return;
      e.preventDefault();
      const ext = blob.type === "image/png" ? "png" : "jpg";
      stageImage(
        new File([blob], `pasted-screenshot.${ext}`, { type: blob.type }),
      );
    },
    [stageImage],
  );

  const canSubmit = !submitting && (!!description.trim() || !!pending);

  const handleSubmit = useCallback(async () => {
    if (inFlightRef.current) return;
    const text = description.trim();
    if (!text && !pending) return;
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      let screenshotStorageId: Id<"_storage"> | undefined;
      if (pending) {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": pending.file.type },
          body: pending.file,
        });
        if (!res.ok) throw new Error("The screenshot couldn't be uploaded.");
        const { storageId } = await res.json();
        screenshotStorageId = storageId as Id<"_storage">;
      }

      const search = searchParams?.toString();
      const url = `${pathname ?? "/"}${search ? `?${search}` : ""}`;

      const result = await submit({
        surface: "web",
        url,
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        appVersion:
          process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || undefined,
        viewingMode: viewingMode ?? undefined,
        viewedUserId:
          viewingMode === "inspect" && remoteParam
            ? (remoteParam as Id<"users">)
            : undefined,
        description: text || undefined,
        screenshotStorageId,
      });

      if (!mountedRef.current) return;
      if (!result.ok) {
        // Preserve everything (pending, previewRef, capturedFileRef) so retry
        // still works.
        setError(result.error);
        return;
      }
      // SUCCESS: discard the screenshot before rendering the saved state —
      // revoke + clear the preview, drop the staged file and the retained
      // capture bytes, reset the file input, and tell the parent to release its
      // `capturedShot` reference.
      if (previewRef.current) {
        URL.revokeObjectURL(previewRef.current);
        previewRef.current = null;
      }
      setPending(null);
      capturedFileRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
      onScreenshotDiscarded?.();
      setSaved(true);
    } catch (e) {
      if (mountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : "Something went wrong saving your report.",
        );
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    description,
    pending,
    generateUploadUrl,
    submit,
    pathname,
    searchParams,
    viewingMode,
    remoteParam,
    onScreenshotDiscarded,
  ]);

  if (saved) {
    return (
      <>
        <Dialog.Header px={6} pt={6} pb={2}>
          <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
            Thanks for the report
          </Dialog.Title>
        </Dialog.Header>
        <Dialog.Body px={6} py={4}>
          <HStack gap={3} align="flex-start">
            <Box color="green.500" mt={0.5}>
              <CheckCircle size={22} weight="fill" />
            </Box>
            <Text fontSize="sm" fontFamily="body" color="charcoal.600" lineHeight="1.5">
              Saved — we&apos;ll take it from here.
            </Text>
          </HStack>
        </Dialog.Body>
        <Box px={6} pb={5} pt={2}>
          <Flex justify="flex-end">
            <Button
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              onClick={onClose}
            >
              Done
            </Button>
          </Flex>
        </Box>
      </>
    );
  }

  return (
    <>
      <Dialog.Header px={6} pt={6} pb={2}>
        <Stack gap={0} flex={1} minW={0}>
          <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
            Report a bug
          </Dialog.Title>
        </Stack>
        <Dialog.CloseTrigger asChild>
          <IconButton
            aria-label="Close"
            size="sm"
            variant="ghost"
            color="charcoal.400"
            _hover={{ bg: "gray.100" }}
            disabled={submitting}
          >
            <X />
          </IconButton>
        </Dialog.CloseTrigger>
      </Dialog.Header>

      <Dialog.Body px={6} py={3}>
        <Stack gap={3}>
          <Field.Root invalid={!!error}>
            <Field.Label
              fontSize="xs"
              color="charcoal.400"
              fontFamily="heading"
              fontWeight="600"
            >
              What went wrong?
            </Field.Label>
            <HStack align="flex-start" gap={2} w="full">
              <Textarea
                autoFocus
                flex={1}
                placeholder="Tell us what happened, and what you expected instead."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                rows={4}
              />
              <DictationMicButton
                onTranscript={(t) =>
                  setDescription((prev) => (prev ? `${prev} ${t}` : t))
                }
                disabled={submitting}
                ariaLabel="Dictate what went wrong"
              />
            </HStack>
            {error && (
              <Field.ErrorText aria-live="polite">{error}</Field.ErrorText>
            )}
          </Field.Root>

          {hasCapture && (
            <Checkbox.Root
              size="sm"
              checked={pending != null}
              onCheckedChange={(d) => toggleInclude(d.checked === true)}
              disabled={submitting}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label
                fontSize="sm"
                color="charcoal.600"
                fontFamily="heading"
              >
                Include screenshot
              </Checkbox.Label>
            </Checkbox.Root>
          )}

          {pending ? (
            <HStack
              gap={3}
              p={2}
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="md"
              align="center"
            >
              <Image
                src={pending.preview}
                alt="Screenshot preview"
                boxSize="48px"
                objectFit="cover"
                borderRadius="sm"
              />
              <Text
                flex={1}
                fontSize="xs"
                color="charcoal.500"
                fontFamily="body"
                lineClamp={1}
              >
                {pending.source === "capture"
                  ? "Page screenshot"
                  : pending.file.name}
              </Text>
              {pending.source === "manual" && (
                <IconButton
                  aria-label="Remove screenshot"
                  size="xs"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                  onClick={removeImage}
                  disabled={submitting}
                >
                  <Trash />
                </IconButton>
              )}
            </HStack>
          ) : (
            <Button
              size="sm"
              variant="outline"
              alignSelf="flex-start"
              fontFamily="heading"
              color="charcoal.500"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
            >
              <Paperclip />
              Attach a screenshot
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) stageImage(file);
            }}
          />

          <Text fontSize="2xs" color="charcoal.300" fontFamily="body">
            {pending
              ? "Includes: screenshot, current page, app info."
              : "Includes: current page, app info."}
          </Text>
        </Stack>
      </Dialog.Body>

      <Box px={6} pb={5} pt={2}>
        <Button
          w="full"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          fontWeight="700"
          onClick={handleSubmit}
          disabled={!canSubmit}
          loading={submitting}
          loadingText="Saving…"
        >
          Send report
        </Button>
      </Box>
    </>
  );
}
