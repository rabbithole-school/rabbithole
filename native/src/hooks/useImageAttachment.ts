import { useCallback, useState } from "react";
import { Alert } from "react-native";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
} from "expo-image-picker";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { uploadImageUri } from "@/lib/uploadImage";

export type ImageUploadTarget = {
  url: string;
  headers?: Record<string, string>;
};

/**
 * Native image attachment — mirrors the web upload pipeline
 * (api.files.generateUploadUrl → upload the file → {storageId} → sendMessage
 * imageId), using expo-image-picker for the iPad camera + photo library.
 *
 * The bytes go up through the shared `uploadImageUri` helper; this hook adds the
 * composer-slot state (preview, pending storage id, uploading) around it.
 * Failures surface via an Alert (never silent).
 */
export function useImageAttachment() {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [imageId, setImageId] = useState<Id<"_storage"> | null>(null);
  const [uploading, setUploading] = useState(false);

  const clear = useCallback(() => {
    setPreviewUri(null);
    setImageId(null);
    setUploading(false);
  }, []);

  // Shared upload core: stream a picker-selected file:// uri to Convex storage and
  // set it as the pending attachment. Throws on non-2xx so callers can surface
  // their own error copy.
  const uploadUri = useCallback(
    async (
      uri: string,
      mime: string,
      target?: ImageUploadTarget,
    ): Promise<Id<"_storage">> => {
      setPreviewUri(uri);
      setUploading(true);
      try {
        const uploadUrl = target?.url ?? (await generateUploadUrl());
        const storageId = await uploadImageUri(
          uploadUrl,
          uri,
          mime,
          target?.headers,
        );
        setImageId(storageId);
        return storageId;
      } finally {
        setUploading(false);
      }
    },
    [generateUploadUrl],
  );

  const attach = useCallback(
    async (source: "camera" | "library", target?: ImageUploadTarget) => {
      try {
        const perm =
          source === "camera"
            ? await requestCameraPermissionsAsync()
            : await requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(
            source === "camera" ? "Camera access needed" : "Photo access needed",
            `Turn on ${source === "camera" ? "Camera" : "Photos"} access for Rabbithole in Settings to add a photo.`,
          );
          return null;
        }

        const result =
          source === "camera"
            ? await launchCameraAsync({ quality: 0.7, allowsEditing: false })
            : await launchImageLibraryAsync({ quality: 0.7, allowsEditing: false });
        if (result.canceled || !result.assets?.length) return null;

        const asset = result.assets[0];
        return await uploadUri(
          asset.uri,
          asset.mimeType ?? "image/jpeg",
          target,
        );
      } catch (e) {
        console.warn("[image] attach failed", e);
        Alert.alert("Couldn't add that photo", "Please try again.");
        clear();
        return null;
      }
    },
    [uploadUri, clear],
  );

  return { previewUri, imageId, uploading, attach, clear };
}
