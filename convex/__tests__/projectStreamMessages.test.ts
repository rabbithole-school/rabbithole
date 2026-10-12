import { describe, expect, test, vi } from "vitest";

import {
  assembleProjectStreamApiMessages,
  DICTATED_TURN_LABEL,
  IMAGE_NOT_REPLAYED_LABEL,
  IMAGE_UNAVAILABLE_LABEL,
  MAX_REPLAYED_IMAGE_BASE64_CHARS,
} from "../lib/projectStreamMessages";

const APP_REQUEST_PREFIX = "[APP REQUEST";
const APP_CONTEXT_PREFIX = "APP-PROVIDED CONTEXT";

describe("assembleProjectStreamApiMessages", () => {
  test("wraps only persisted app turns and gives context only to the current app turn", async () => {
    const resolveImagePart = vi.fn(async () => null);
    const apiMessages = await assembleProjectStreamApiMessages({
      chatHistory: [
        {
          id: "typed-1",
          sourceRole: "user",
          role: "user",
          content: "I think the orbit is too wide.",
          imageId: null,
          inputModality: "typed",
        },
        {
          id: "assistant-1",
          sourceRole: "assistant",
          role: "assistant",
          content: "What could you change?",
          imageId: null,
        },
        {
          id: "app-1",
          sourceRole: "user",
          role: "user",
          content: "Check the earlier orbit.",
          imageId: null,
          inputModality: "app",
        },
        {
          id: "assistant-2",
          sourceRole: "assistant",
          role: "assistant",
          content: "What do you notice?",
          imageId: null,
        },
        {
          id: "app-2",
          sourceRole: "user",
          role: "user",
          content: "Check the current orbit.",
          imageId: null,
          inputModality: "app",
        },
      ],
      appRequest: { context: { selectedPlanet: "Mars" } },
      resolveImagePart,
    });

    expect(apiMessages[0].content).toBe("I think the orbit is too wide.");
    expect(apiMessages[2].content).toContain(APP_REQUEST_PREFIX);
    expect(apiMessages[2].content).not.toContain(APP_CONTEXT_PREFIX);
    expect(apiMessages[4].content).toContain(APP_REQUEST_PREFIX);
    expect(apiMessages[4].content).toContain(APP_CONTEXT_PREFIX);
    expect(apiMessages[4].content).toContain('"selectedPlanet":"Mars"');
    expect(
      apiMessages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes(APP_REQUEST_PREFIX),
      ),
    ).toHaveLength(2);
    expect(
      apiMessages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes(APP_CONTEXT_PREFIX),
      ),
    ).toHaveLength(1);
    expect(resolveImagePart).not.toHaveBeenCalled();
  });

  test("does not trust an appRequest body when the stored current turn is typed", async () => {
    const apiMessages = await assembleProjectStreamApiMessages({
      chatHistory: [
        {
          id: "app-1",
          sourceRole: "user",
          role: "user",
          content: "Check the old state.",
          imageId: null,
          inputModality: "app",
        },
        {
          id: "typed-1",
          sourceRole: "user",
          role: "user",
          content: "This is my new idea.",
          imageId: null,
          inputModality: "typed",
        },
      ],
      appRequest: { context: { forged: true } },
      resolveImagePart: async () => null,
    });

    expect(apiMessages[0].content).toContain(APP_REQUEST_PREFIX);
    expect(apiMessages[0].content).not.toContain(APP_CONTEXT_PREFIX);
    expect(apiMessages[1].content).toBe("This is my new idea.");
    expect(JSON.stringify(apiMessages)).not.toContain('"forged":true');
  });

  test("marks dictated scholar turns so the tutor can tell voice from typing", async () => {
    const apiMessages = await assembleProjectStreamApiMessages({
      chatHistory: [
        {
          id: "spoken-1",
          sourceRole: "user",
          role: "user",
          content: "The krill starve because their food is gone.",
          imageId: null,
          inputModality: "spoken",
        },
        {
          id: "typed-1",
          sourceRole: "user",
          role: "user",
          content: "Food depleted",
          imageId: null,
          inputModality: "typed",
        },
        {
          id: "unknown-1",
          sourceRole: "user",
          role: "user",
          content: "Older turn from before the field existed.",
          imageId: null,
        },
      ],
      resolveImagePart: async () => null,
    });

    expect(apiMessages[0].content).toBe(
      `${DICTATED_TURN_LABEL} The krill starve because their food is gone.`,
    );
    // A typed turn and a pre-field turn must stay byte-identical, or the
    // fragment ask's mic offer reaches kids who are already dictating.
    expect(apiMessages[1].content).toBe("Food depleted");
    expect(apiMessages[2].content).toBe(
      "Older turn from before the field existed.",
    );
  });

  test("leaves an empty dictated turn empty rather than sending a bare marker", async () => {
    const apiMessages = await assembleProjectStreamApiMessages({
      chatHistory: [
        {
          id: "spoken-empty",
          sourceRole: "user",
          role: "user",
          content: "   ",
          imageId: null,
          inputModality: "spoken",
        },
      ],
      resolveImagePart: async () => null,
    });

    expect(apiMessages[0].content).toBe("   ");
  });

  test("labels a Magic Corners redraw differently from the tutor's own generated image", async () => {
    const imagePart = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png" as const, data: "x" },
    };
    const replay = (magicRedraw: boolean) =>
      assembleProjectStreamApiMessages({
        chatHistory: [
          {
            id: "tool-1",
            sourceRole: "tool",
            role: "user",
            content: "",
            imageId: "img",
            generatedImage: true,
            magicRedraw,
            imagePrompt: "an Arctic food web with a polar bear",
          },
        ],
        resolveImagePart: async () => imagePart,
      });
    const textOf = (messages: Awaited<ReturnType<typeof replay>>) =>
      (messages[0].content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

    const magic = textOf(await replay(true));
    const generated = textOf(await replay(false));

    expect(magic).not.toBe(generated);
    expect(magic).toContain("an Arctic food web with a polar bear");
  });

  describe("replayed image budget", () => {
    // A full-size iPad photo: ~3.3 MB raw is ~4.4M base64 characters.
    const PHOTO_CHARS = 4_400_000;
    const photo = (id: string) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/jpeg" as const,
        data: id.padEnd(PHOTO_CHARS, "A"),
      },
    });
    const photoTurns = (count: number) =>
      Array.from({ length: count }, (_, i) => [
        {
          id: `u${i}`,
          sourceRole: "user",
          role: "user" as const,
          // The real failing turns were often photo-only, with no text.
          content: i % 2 === 0 ? "" : `photo ${i}`,
          imageId: `img${i}`,
        },
        {
          id: `a${i}`,
          sourceRole: "assistant",
          role: "assistant" as const,
          content: `reply ${i}`,
          imageId: null,
        },
      ]).flat();
    const imageDataOf = (
      messages: Awaited<ReturnType<typeof assembleProjectStreamApiMessages>>,
    ) =>
      messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.flatMap((part) =>
              part.type === "image" ? [part.source.data] : [],
            )
          : [],
      );

    test("a session full of photos replays only the newest that fit, and never fetches the rest", async () => {
      const resolveImagePart = vi.fn(async (imageId: string) => photo(imageId));
      const messages = await assembleProjectStreamApiMessages({
        chatHistory: photoTurns(6),
        resolveImagePart,
      });

      const replayed = imageDataOf(messages);
      const replayedChars = replayed.reduce((n, data) => n + data.length, 0);
      expect(replayedChars).toBeLessThanOrEqual(MAX_REPLAYED_IMAGE_BASE64_CHARS);
      // The photo the scholar just sent is always among those replayed, and
      // the replayed run is the newest contiguous one.
      expect(replayed.map((data) => data.slice(0, 4))).toEqual(["img4", "img5"]);
      // Two fit; the third newest is fetched, found not to fit, and nothing
      // older is fetched at all.
      expect(resolveImagePart.mock.calls.map(([id]) => id)).toEqual([
        "img5",
        "img4",
        "img3",
      ]);
      // Every left-out photo still leaves a non-empty, labelled turn behind,
      // so the model is told an image existed and no turn goes empty.
      const leftOut = messages.slice(0, 8).filter((m) => m.role === "user");
      expect(leftOut).toHaveLength(4);
      for (const message of leftOut) {
        expect(typeof message.content).toBe("string");
        expect(String(message.content).startsWith(IMAGE_NOT_REPLAYED_LABEL)).toBe(
          true,
        );
      }
    });

    test("a photo that cannot be loaded is labelled as unavailable, not dropped to an empty turn", async () => {
      const messages = await assembleProjectStreamApiMessages({
        chatHistory: photoTurns(1),
        resolveImagePart: async () => null,
      });
      expect(messages[0]).toEqual({
        role: "user",
        content: IMAGE_UNAVAILABLE_LABEL,
      });
    });
  });
});
