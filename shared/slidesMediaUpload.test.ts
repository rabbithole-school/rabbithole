import { describe, expect, test, vi } from "vitest";
import { uploadAndRegisterSlideAsset } from "./slidesMediaUpload";

describe("uploadAndRegisterSlideAsset", () => {
  test("uploads before registering, then returns the registered storage id", async () => {
    const calls: string[] = [];
    const generateUploadUrl = vi.fn(async () => {
      calls.push("url");
      return "https://upload.test";
    });
    const upload = vi.fn(async (url: string) => {
      calls.push(`upload:${url}`);
      return "storage-photo" as const;
    });
    const registerAsset = vi.fn(async (storageId: "storage-photo") => {
      calls.push(`register:${storageId}`);
    });

    await expect(
      uploadAndRegisterSlideAsset({ generateUploadUrl, upload, registerAsset }),
    ).resolves.toBe("storage-photo");
    expect(calls).toEqual([
      "url",
      "upload:https://upload.test",
      "register:storage-photo",
    ]);
  });

  test("does not register an upload that failed", async () => {
    const registerAsset = vi.fn();
    await expect(
      uploadAndRegisterSlideAsset({
        generateUploadUrl: async () => "https://upload.test",
        upload: async () => {
          throw new Error("upload failed (500)");
        },
        registerAsset,
      }),
    ).rejects.toThrow("upload failed (500)");
    expect(registerAsset).not.toHaveBeenCalled();
  });
});
