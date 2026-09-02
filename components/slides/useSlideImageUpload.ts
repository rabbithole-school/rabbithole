"use client";

import { useCallback } from "react";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { uploadAndRegisterSlideAsset } from "@/shared/slidesMediaUpload";

/**
 * The one web path from image bytes to a slide-safe storage id. Both the
 * scholar and teacher editors use it for uploaded images and sketches.
 */
export function useSlideImageUpload() {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const registerAsset = useMutation(api.artifacts.registerSlideAsset);

  return useCallback(
    (file: File) =>
      uploadAndRegisterSlideAsset({
        generateUploadUrl,
        upload: async (uploadUrl) => {
          const response = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": file.type },
            body: file,
          });
          if (!response.ok) throw new Error(`Upload failed (${response.status})`);
          return ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
        },
        registerAsset: (storageId) => registerAsset({ storageId }),
      }),
    [generateUploadUrl, registerAsset],
  );
}
