"use client";

import { useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Image,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  Camera,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CameraCaptureDialog } from "@/components/CameraCaptureDialog";
import { FlairChips } from "./FlairChips";
import { toaster } from "@/lib/toaster";

/**
 * Photo-kind deliverable surface (Phase 1). Replaces the generic "No documents
 * yet" empty state for a `deliverable.kind === "photo"` activity with a real
 * submission path:
 *   - empty: the deliverable prompt + "Take Photo" / "Upload" CTAs.
 *   - submitted: the photo, a Retake/Replace affordance, and (when the activity
 *     has rubric criteria) a "Check my work" action that runs the
 *     multimodal assessment against the STORED file.
 *
 * A photo submission is a real `deliverables` row (deliverables.submit with
 * fileStorageId) — NOT a chat image attachment. Unlike text/artifact
 * deliverables there is no artifact document, so this panel owns its own state.
 */
export function PhotoDeliverablePanel({
  sessionId,
  activityId,
  prompt,
  mode,
  criteria,
  criteriaStatus,
  criteriaError,
  disabled = false,
  animateFlairArrivals = true,
}: {
  sessionId: Id<"sessions">;
  activityId: Id<"activities">;
  prompt: string;
  mode: "manual" | "auto" | "none";
  criteria: Array<{ id: string; label: string; description?: string }>;
  criteriaStatus?: "pending" | "ready" | "error" | null;
  criteriaError?: string | null;
  /** True while a chat stream is in flight — matches the text Check gating. */
  disabled?: boolean;
  /** False in the teacher remote view: newly earned flair is the scholar's own
   *  live event, so an observer's chips stay static. */
  animateFlairArrivals?: boolean;
}) {
  const existing = useQuery(api.deliverables.getForSessionActivity, {
    sessionId,
    activityId,
  });
  const fileUrl = useQuery(
    api.files.getUrl,
    existing?.fileStorageId ? { storageId: existing.fileStorageId } : "skip",
  );

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const submit = useMutation(api.deliverables.submit);
  const retrySetup = useMutation(api.sessions.ensureActivitySetup);
  const assess = useAction(api.deliverableAssess.assessSubmittedDeliverable);

  const [showCamera, setShowCamera] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [retryingSetup, setRetryingSetup] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasPhoto = !!existing?.fileStorageId;
  const hasCriteria = criteria.length > 0;
  const criteriaUnavailable = mode === "auto" && !hasCriteria;
  const setupFailed = criteriaStatus === "error";

  const uploadAndSubmit = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await submit({ activityId, sessionId, fileStorageId: storageId });
    } catch (e) {
      toaster.error({
        title: "Couldn't submit that photo",
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file still fires onChange.
    e.target.value = "";
    if (file) void uploadAndSubmit(file);
  };

  const runCheck = async () => {
    if (!existing || checking) return;
    setChecking(true);
    try {
      const r = await assess({ deliverableId: existing._id });
      toaster.success({
        title:
          r.overall === "full"
            ? "Goal met"
            : r.overall === "half"
              ? "Almost there"
              : "Keep going",
        description: r.conceptLabel,
      });
    } catch (e) {
      toaster.error({
        title: "Check failed",
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      setChecking(false);
    }
  };

  const runSetupRetry = async () => {
    if (!setupFailed || retryingSetup) return;
    setRetryingSetup(true);
    try {
      await retrySetup({ sessionId, retryErroredCriteria: true });
    } catch (error) {
      toaster.error({
        title: "Couldn't prepare the check",
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setRetryingSetup(false);
    }
  };

  const busy = uploading || existing === undefined;

  return (
    <Flex flex={1} flexDir="column" bg="gray.50" overflow="hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onFileChange}
      />

      <Flex
        flex={1}
        flexDir="column"
        align="center"
        justify={hasPhoto ? "flex-start" : "center"}
        gap={4}
        p={6}
        overflowY="auto"
      >
        {/* Prompt — always shown so the scholar knows what to photograph. */}
        <Stack gap={1} maxW="md" textAlign="center">
          <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="violet.500" letterSpacing="0.04em">
            PHOTO DELIVERABLE
          </Text>
          <Text fontSize="sm" fontFamily="body" color="charcoal.600" lineHeight="1.5">
            {prompt}
          </Text>
        </Stack>

        {hasPhoto && fileUrl ? (
          <Stack gap={3} w="full" maxW="lg" align="center">
            <Box
              borderRadius="lg"
              overflow="hidden"
              borderWidth="1px"
              borderColor="gray.200"
              bg="white"
              shadow="0 1px 3px rgba(0,0,0,0.08)"
              w="full"
            >
              <Image
                src={fileUrl}
                alt="Your submitted photo"
                w="full"
                maxH="420px"
                objectFit="contain"
                bg="gray.100"
              />
            </Box>

            <FlairChips
              // A photo deliverable has no artifact, so the activity IS the
              // identity this baseline belongs to.
              key={activityId}
              flairEarned={existing?.flairEarned}
              criteria={criteria}
              deliverableId={existing?._id}
              resolved={existing !== undefined}
              animateArrivals={animateFlairArrivals}
            />

            <HStack gap={2}>
              <Button
                size="sm"
                variant="outline"
                colorPalette="violet"
                onClick={() => setShowCamera(true)}
                disabled={busy}
              >
                <Camera />
                Retake
              </Button>
              <Button
                size="sm"
                variant="outline"
                colorPalette="violet"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <UploadSimple />
                Replace
              </Button>
              {criteriaUnavailable ? (
                <Button
                  size="sm"
                  colorPalette="violet"
                  variant={setupFailed ? "outline" : "solid"}
                  onClick={runSetupRetry}
                  disabled={!setupFailed || retryingSetup}
                >
                  {setupFailed && !retryingSetup ? (
                    <WarningCircle />
                  ) : (
                    <Spinner size="xs" />
                  )}
                  {setupFailed
                    ? "Try preparing check again"
                    : "Preparing check…"}
                </Button>
              ) : hasCriteria ? (
                <Button
                  size="sm"
                  colorPalette="violet"
                  onClick={runCheck}
                  disabled={busy || checking || disabled}
                >
                  {checking ? <Spinner size="xs" /> : null}
                  Check my work
                </Button>
              ) : null}
            </HStack>

            {setupFailed && (
              <Text fontSize="xs" color="red.600" role="alert">
                {criteriaError
                  ? "The check could not be prepared. Your photo is still saved."
                  : "The check could not be prepared. Try again."}
              </Text>
            )}

            {uploading && (
              <HStack gap={2} color="charcoal.400">
                <Spinner size="xs" />
                <Text fontSize="xs">Uploading…</Text>
              </HStack>
            )}

            {existing?.rubricFeedback && !checking && (
              <Box w="full" maxW="md" bg="white" borderRadius="lg" borderWidth="1px" borderColor="gray.200" p={4}>
                <Stack gap={1}>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" fontWeight="600">
                    {existing.rubricCheckedBy === "teacher"
                      ? "Note from your teacher"
                      : "Rabbithole note"}
                  </Text>
                  <Text fontSize="sm" color="charcoal.600" fontFamily="body" lineHeight="1.5">
                    {existing.rubricFeedback}
                  </Text>
                </Stack>
              </Box>
            )}
          </Stack>
        ) : (
          <HStack gap={3}>
            <Button
              colorPalette="violet"
              onClick={() => setShowCamera(true)}
              disabled={busy}
            >
              {uploading ? <Spinner size="xs" /> : <Camera weight="fill" />}
              Take Photo
            </Button>
            <Button
              variant="outline"
              colorPalette="violet"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <UploadSimple />
              Upload
            </Button>
          </HStack>
        )}
        {!hasPhoto && uploading && (
          <HStack gap={2} color="charcoal.400">
            <Spinner size="xs" />
            <Text fontSize="xs">Uploading…</Text>
          </HStack>
        )}
      </Flex>

      <CameraCaptureDialog
        open={showCamera}
        onClose={() => setShowCamera(false)}
        onCapture={(file) => void uploadAndSubmit(file)}
        overlayPosition="fixed"
      />
    </Flex>
  );
}
