import { describe, expect, test, vi } from "vitest";
import { uploadAndRegisterSlideAsset } from "../../../vendor/shared/slidesMediaUpload";

describe("native slide media upload", () => {
  test("registers the file-system upload before the editor receives its asset id", async () => {
    const calls: string[] = [];
    const upload = vi.fn(async (url: string) => {
      expect(url).toBe("https://upload.test");
      calls.push("upload");
      return "storage-photo";
    });
    const registerAsset = vi.fn(async (storageId: string) => {
      expect(storageId).toBe("storage-photo");
      calls.push("register");
    });

    await expect(
      uploadAndRegisterSlideAsset({
        generateUploadUrl: async () => "https://upload.test",
        upload,
        registerAsset,
      }),
    ).resolves.toBe("storage-photo");
    expect(calls).toEqual(["upload", "register"]);
  });
});
