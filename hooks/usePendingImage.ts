"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

/** A locally-staged image awaiting send: the File plus an object-URL preview. */
export type PendingImage = { file: File; preview: string };

/**
 * Shared web image-attachment pipeline for chat-style composers. Stages a File
 * locally (with a preview URL) and uploads it to Convex storage on demand,
 * returning the `_storage` id to send alongside the message.
 *
 * Mirrors the native `useImageAttachment` hook and keeps the upload logic in
 * ONE place so the scholar tutor chat (SessionInterface) and the practice
 * "talk me through it" chat (PracticeSession) can't drift apart.
 */
export function usePendingImage() {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);

  const clear = useCallback(() => setPendingImage(null), []);

  /**
   * Upload the staged file (if any) and resolve to its storage id, or null when
   * nothing is staged. Throws are surfaced to the caller (never swallowed here)
   * so send handlers can decide whether to proceed text-only.
   */
  const upload = useCallback(async (): Promise<Id<"_storage"> | null> => {
    if (!pendingImage) return null;
    const uploadUrl = await generateUploadUrl();
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": pendingImage.file.type },
      body: pendingImage.file,
    });
    const { storageId } = await res.json();
    return storageId as Id<"_storage">;
  }, [pendingImage, generateUploadUrl]);

  return { pendingImage, setPendingImage, clear, upload };
}
