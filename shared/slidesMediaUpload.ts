/**
 * The shared ordering boundary for a client-created slide asset.
 *
 * Storage IDs are not permission to use a blob in a deck: clients must register
 * a successful upload before emitting the scene op that references it.
 */
export async function uploadAndRegisterSlideAsset<TStorageId extends string>({
  generateUploadUrl,
  upload,
  registerAsset,
}: {
  generateUploadUrl: () => Promise<string>;
  upload: (uploadUrl: string) => Promise<TStorageId>;
  registerAsset: (storageId: TStorageId) => Promise<unknown>;
}): Promise<TStorageId> {
  const uploadUrl = await generateUploadUrl();
  const storageId = await upload(uploadUrl);
  await registerAsset(storageId);
  return storageId;
}
