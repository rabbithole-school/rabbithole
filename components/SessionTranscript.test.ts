import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, test } from "vitest";

import {
  reconcileSessionMessages,
  SessionAssistantMessageBody,
  SessionInputModality,
  SessionStreamStatus,
} from "@/components/SessionTranscript";
import { system } from "@/lib/theme";

describe("session transcript reconciliation", () => {
  test("replaces a streaming placeholder row without rendering a duplicate", () => {
    const messages = [
      { id: "user-1", role: "user", content: "Build a maze" },
      { id: "assistant-1", role: "assistant", content: "" },
    ];

    const reconciled = reconcileSessionMessages(messages, {
      streamingMsgId: "assistant-1",
      streamingContent: "I'll start with the maze.",
    });

    expect(reconciled).toHaveLength(2);
    expect(reconciled.filter(({ message }) => message.id === "assistant-1")).toHaveLength(1);
    expect(reconciled[1]).toMatchObject({
      message: {
        id: "assistant-1",
        content: "I'll start with the maze.",
      },
      isActiveStream: true,
    });
  });

  test("bridges the same row until persisted content reaches the query", () => {
    const reconciled = reconcileSessionMessages(
      [{ id: "assistant-1", role: "assistant", content: "" }],
      {
        streamingMsgId: null,
        streamingContent: "",
        lastStreamedContent: new Map([
          ["assistant-1", "The completed streamed response."],
        ]),
      },
    );

    expect(reconciled).toEqual([
      {
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "The completed streamed response.",
        },
        isActiveStream: false,
      },
    ]);
  });
});

describe("session transcript rendering", () => {
  test("shows a live tool chip while tool activity is running", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(
        ChakraProvider,
        {
          value: system,
          children: createElement(SessionStreamStatus, {
            isStreaming: true,
            streamingContent: "",
            toolActivity: [{ name: "create_code", status: "running" }],
            scholarSafe: true,
          }),
        },
      ),
    );

    expect(html).toContain("Writing some code");
  });

  test("uses the canonical chat markdown body for paragraph spacing", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(
        ChakraProvider,
        {
          value: system,
          children: createElement(SessionAssistantMessageBody, {
            content: "First paragraph.\n\nSecond paragraph.",
          }),
        },
      ),
    );

    expect(html).toContain("chat-markdown");
    expect(html.match(/<p>/g)).toHaveLength(2);
  });

  test.each([
    ["typed", "Typed input"],
    ["spoken", "Spoken input"],
  ] as const)("renders the %s staff transcript cue", (modality, label) => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(
        ChakraProvider,
        {
          value: system,
          children: createElement(SessionInputModality, { modality }),
        },
      ),
    );

    expect(html).toContain(label);
  });

  test("omits the cue when a historical message has no modality", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(
        ChakraProvider,
        {
          value: system,
          children: createElement(SessionInputModality, {}),
        },
      ),
    );

    expect(html).not.toContain("Typed input");
    expect(html).not.toContain("Spoken input");
  });
});
