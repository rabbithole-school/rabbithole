import { describe, expect, test } from "vitest";
import {
  MAX_EQUIPMENT_PHOTO_BYTES,
  withBoundedEquipmentPhoto,
} from "../equipmentPhotoBlob";

describe("withBoundedEquipmentPhoto", () => {
  test("rejects a 5,242,881-byte blob before reading bytes or invoking the model", async () => {
    let arrayBufferCalls = 0;
    let modelCalls = 0;
    const photo: Pick<Blob, "size" | "arrayBuffer"> = {
      size: 5_242_881,
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        return new ArrayBuffer(0);
      },
    };
    const model = async (_bytes: Uint8Array) => {
      modelCalls += 1;
      return "identified";
    };

    expect(MAX_EQUIPMENT_PHOTO_BYTES).toBe(5_242_880);
    await expect(withBoundedEquipmentPhoto(photo, model)).rejects.toThrow(
      "Photo is too large (max 5 MiB).",
    );
    expect(arrayBufferCalls).toBe(0);
    expect(modelCalls).toBe(0);
  });

  test("reads a bounded photo and passes its bytes to the model", async () => {
    const expected = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let arrayBufferCalls = 0;
    let modelCalls = 0;
    const photo: Pick<Blob, "size" | "arrayBuffer"> = {
      size: expected.byteLength,
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        return expected.buffer.slice(0);
      },
    };
    const model = async (bytes: Uint8Array) => {
      modelCalls += 1;
      return bytes;
    };

    await expect(withBoundedEquipmentPhoto(photo, model)).resolves.toEqual(
      expected,
    );
    expect(arrayBufferCalls).toBe(1);
    expect(modelCalls).toBe(1);
  });

  test("accepts a photo exactly at the 5 MiB limit", async () => {
    let arrayBufferCalls = 0;
    let modelCalls = 0;
    let receivedByteLength = 0;
    const photo: Pick<Blob, "size" | "arrayBuffer"> = {
      size: MAX_EQUIPMENT_PHOTO_BYTES,
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        return new ArrayBuffer(MAX_EQUIPMENT_PHOTO_BYTES);
      },
    };
    const model = async (bytes: Uint8Array) => {
      modelCalls += 1;
      receivedByteLength = bytes.byteLength;
      return "identified";
    };

    await expect(withBoundedEquipmentPhoto(photo, model)).resolves.toBe(
      "identified",
    );
    expect(arrayBufferCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(receivedByteLength).toBe(MAX_EQUIPMENT_PHOTO_BYTES);
  });
});
