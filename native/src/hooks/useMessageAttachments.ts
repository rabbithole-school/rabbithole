import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
} from "expo-image-picker";
import { deleteAsync, getInfoAsync } from "expo-file-system/legacy";
import { useMutation, type ReactMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { uploadFileUri } from "@/lib/uploadImage";
import { pickedPhotoFileName } from "@/lib/scholarMessages";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";
import { validateMessageAttachmentSelection } from "../../vendor/shared/messageAttachments";

export type PendingMessageAttachment = {
  attachmentId: Id<"parentMessageAttachments">;
  fileName: string;
  /** The picker's local file — the composer thumbnail. */
  localUri: string;
  sizeBytes: number;
};

/** Picker temp files live in expo's cache dir, so a delete is allowed — but
 *  it is cleanup, never product: a failure must not undo a finished upload
 *  (engineering-principles.md → expo-file-system). */
function discardLocalFile(uri: string) {
  void deleteAsync(uri, { idempotent: true }).catch((error) =>
    console.warn("[messages] temp photo cleanup failed", error),
  );
}

type PickedPhoto = {
  uri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

/** Ask for permission, then open the camera or Photos. null = the scholar
 *  cancelled or declined (a declined permission explains itself). */
async function pickPhoto(source: "camera" | "library"): Promise<PickedPhoto | null> {
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
      : await launchImageLibraryAsync({
          quality: 0.7,
          allowsEditing: false,
          mediaTypes: ["images"],
        });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  const mimeType = asset.mimeType ?? "image/jpeg";
  return {
    uri: asset.uri,
    fileName: pickedPhotoFileName(asset.fileName, mimeType, Date.now()),
    mimeType,
    // 0 = unknown; uploadPhoto reads the real size off disk, because the
    // upload reservation is for an exact byte count.
    sizeBytes: asset.fileSize ?? 0,
  };
}

/** The web's upload path, native bytes: reserve an upload for the file's exact
 *  size → stream the file → register it against that reservation (the server
 *  only accepts a blob of that size created after the reservation). */
async function uploadPhoto(
  photo: PickedPhoto,
  reserveUpload: ReactMutation<typeof api.parentMessages.generateAttachmentUploadUrl>,
  registerUpload: ReactMutation<typeof api.parentMessages.registerAttachmentUpload>,
): Promise<Id<"parentMessageAttachments">> {
  let sizeBytes = photo.sizeBytes;
  if (!sizeBytes) {
    const info = await getInfoAsync(photo.uri);
    sizeBytes = info.exists ? info.size : 0;
  }
  if (!sizeBytes) throw new Error("Couldn't read that photo. Try another one.");
  const { uploadUrl, reservationId } = await reserveUpload({ sizeBytes });
  const storageId = await uploadFileUri(uploadUrl, photo.uri, photo.mimeType);
  const { attachmentId } = await registerUpload({
    storageId,
    fileName: photo.fileName,
    mimeType: photo.mimeType,
    sizeBytes,
    reservationId,
  });
  return attachmentId;
}

/**
 * The scholar Messages composer's 📎 — the native twin of the web
 * `useFamilyMessageAttachments` (components/messaging/MessageAttachmentPicker):
 * the SAME upload path (parentMessages.generateAttachmentUploadUrl → storage
 * upload → parentMessages.registerAttachmentUpload), so the server stages a scholar's
 * photo exactly like a family's. Photos only on the iPad: camera or Photos.
 *
 * Staged-but-unsent uploads are discarded on unmount, like the web hook.
 */
export function useMessageAttachments() {
  const reserveUpload = useMutation(api.parentMessages.generateAttachmentUploadUrl);
  const registerUpload = useMutation(api.parentMessages.registerAttachmentUpload);
  const discardUpload = useMutation(api.parentMessages.discardAttachmentUpload);
  const [attachments, setAttachments] = useState<PendingMessageAttachment[]>([]);
  const pendingRef = useRef<PendingMessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const commit = useCallback((next: PendingMessageAttachment[]) => {
    pendingRef.current = next;
    setAttachments(next);
  }, []);

  const pick = useCallback(
    async (source: "camera" | "library") => {
      if (uploading) return;
      setError("");
      // Promise chains rather than try/catch: React Compiler bails on value
      // blocks inside a try, and this hook should stay compiled.
      const photo = await pickPhoto(source).catch((e: unknown) => {
        console.warn("[messages] photo pick failed", e);
        setError("That photo couldn't be added. Try again.");
        return null;
      });
      if (!photo) return;

      const current = pendingRef.current;
      const validationError = validateMessageAttachmentSelection(
        current.length,
        [{ name: photo.fileName, type: photo.mimeType, size: photo.sizeBytes }],
        current.reduce((total, a) => total + a.sizeBytes, 0),
      );
      if (validationError) {
        setError(validationError);
        discardLocalFile(photo.uri);
        return;
      }

      setUploading(true);
      await uploadPhoto(photo, reserveUpload, registerUpload).then(
        (attachmentId) =>
          commit([
            ...pendingRef.current,
            {
              attachmentId,
              fileName: photo.fileName,
              localUri: photo.uri,
              sizeBytes: photo.sizeBytes,
            },
          ]),
        (e: unknown) => {
          console.warn("[messages] attach failed", e);
          setError(serverErrorMessage(e, "That photo couldn't be added. Try again."));
        },
      );
      setUploading(false);
    },
    [commit, reserveUpload, registerUpload, uploading],
  );

  const remove = useCallback(
    async (attachmentId: Id<"parentMessageAttachments">) => {
      const target = pendingRef.current.find((a) => a.attachmentId === attachmentId);
      commit(pendingRef.current.filter((a) => a.attachmentId !== attachmentId));
      setError("");
      if (target) discardLocalFile(target.localUri);
      // Unclaimed uploads self-delete after 24h server-side; nothing to undo.
      await discardUpload({ attachmentId }).catch((e: unknown) =>
        console.warn("[messages] discard failed", e),
      );
    },
    [commit, discardUpload],
  );

  /** The message went out and claimed these uploads — forget them locally
   *  (without discarding server-side). */
  const clearSent = useCallback(() => {
    for (const a of pendingRef.current) discardLocalFile(a.localUri);
    commit([]);
    setError("");
  }, [commit]);

  useEffect(
    () => () => {
      const pending = pendingRef.current;
      pendingRef.current = [];
      for (const a of pending) {
        discardLocalFile(a.localUri);
        void discardUpload({ attachmentId: a.attachmentId }).catch(() => {});
      }
    },
    [discardUpload],
  );

  return {
    attachments,
    attachmentIds: attachments.map((a) => a.attachmentId),
    uploading,
    error,
    pick,
    remove,
    clearSent,
  };
}
