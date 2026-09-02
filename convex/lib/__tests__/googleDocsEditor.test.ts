import { afterEach, describe, expect, test, vi } from "vitest";
import basicDocument from "./fixtures/googleDocs/basic.json";
import legacyDocument from "./fixtures/googleDocs/legacy.json";
import structureDocument from "./fixtures/googleDocs/structure.json";
import {
  GoogleDocsEditor,
  type GoogleDocsEditorCommand,
} from "../googleDocsEditor";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
) {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return await handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

function requestBody(call: FetchCall): {
  requests: unknown[];
  writeControl?: { requiredRevisionId?: string };
} {
  if (typeof call.init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(call.init.body) as {
    requests: unknown[];
    writeControl?: { requiredRevisionId?: string };
  };
}

function basicRevision(
  revisionId: string,
  replacements: Record<string, string> = {},
) {
  const document = structuredClone(basicDocument);
  document.revisionId = revisionId;
  visit(document);
  return document;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") {
      let content = record.content;
      for (const [from, to] of Object.entries(replacements)) {
        if (from.length !== to.length) {
          throw new Error("Fixture replacements must preserve Docs indexes");
        }
        content = content.replaceAll(from, to);
      }
      record.content = content;
    }
    Object.values(record).forEach(visit);
  }
}

function tabDocument(revisionId: string, text: string) {
  return {
    documentId: "doc-basic",
    title: "Test document",
    revisionId,
    tabs: [
      {
        tabProperties: { tabId: "tab-basic", title: "Basic" },
        documentTab: {
          body: {
            content: [
              { endIndex: 1, sectionBreak: { sectionStyle: {} } },
              {
                startIndex: 1,
                endIndex: 1 + text.length,
                paragraph: {
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                  elements: [
                    {
                      startIndex: 1,
                      endIndex: 1 + text.length,
                      textRun: { content: text, textStyle: {} },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  };
}

function legacyRevision(revisionId: string, text: string) {
  return {
    documentId: "doc-legacy",
    title: "Legacy document",
    revisionId,
    body: {
      content: [
        { endIndex: 1, sectionBreak: { sectionStyle: {} } },
        {
          startIndex: 1,
          endIndex: 1 + text.length,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 1 + text.length,
                textRun: { content: text, textStyle: {} },
              },
            ],
          },
        },
      ],
    },
  };
}

function context(toolUseId: string) {
  return { toolUseId };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("GoogleDocsEditor", () => {
  test("views numbered text, carries the viewed revision, and advances it after each write", async () => {
    const afterFirst = basicRevision("rev-2", { Alpha: "Omega" });
    const afterSecond = basicRevision("rev-3", {
      Alpha: "Sigma",
    });
    const stub = stubFetch(({ url, init }, index) => {
      if (index === 0) {
        expect(url).toContain(
          "/documents/doc-basic?includeTabsContent=true",
        );
        return json(basicDocument);
      }
      if (index === 1) {
        expect(url).toContain("/documents/doc-basic:batchUpdate");
        expect(requestBody({ url, init })).toEqual({
          requests: [
            {
              deleteContentRange: {
                range: {
                  tabId: "tab-basic",
                  startIndex: 1,
                  endIndex: 6,
                },
              },
            },
            {
              insertText: {
                location: { tabId: "tab-basic", index: 1 },
                text: "Omega",
              },
            },
          ],
          writeControl: { requiredRevisionId: "rev-basic" },
        });
        return json({});
      }
      if (index === 2) return json(afterFirst);
      if (index === 3) {
        expect(requestBody({ url, init }).writeControl).toEqual({
          requiredRevisionId: "rev-2",
        });
        return json({});
      }
      if (index === 4) return json(afterSecond);
      throw new Error(`Unexpected request ${index}: ${url}`);
    });
    restoreFetch = stub.restore;

    const editor = new GoogleDocsEditor();
    const view = await editor.execute(
      "token",
      {
        command: "view",
        path: "https://docs.google.com/document/d/doc-basic/edit?tab=tab-basic",
      },
      context("view-1"),
    );
    expect(view).toContain("Revision: rev-basic");
    expect(view).toContain("1: Alpha target omega");
    expect(view).toContain("2: Second target line");

    const first = await editor.execute(
      "token",
      {
        command: "str_replace",
        path: "doc-basic",
        old_str: "Alpha",
        new_str: "Omega",
      },
      context("edit-1"),
    );
    expect(first).toContain("EDIT_APPLIED");
    expect(first).toContain("Revision: rev-2");
    expect(first).toContain("1: Omega target omega");

    const second = await editor.execute(
      "token",
      {
        command: "str_replace",
        path: "doc-basic",
        old_str: "Omega",
        new_str: "Sigma",
      },
      context("edit-2"),
    );
    expect(second).toContain("Revision: rev-3");
    expect(stub.calls).toHaveLength(5);
  });

  test("returns STALE_DOCUMENT without retrying, then recovers after a new view", async () => {
    const staleEnvelope = {
      error: {
        code: 400,
        status: "FAILED_PRECONDITION",
        message: "The required revision ID is stale.",
      },
    };
    const humanRevision = basicRevision("rev-human");
    const finalRevision = basicRevision("rev-final", { Alpha: "Omega" });
    const stub = stubFetch(({ url, init }, index) => {
      if (index === 0) return json(basicDocument);
      if (index === 1) {
        expect(requestBody({ url, init }).writeControl).toEqual({
          requiredRevisionId: "rev-basic",
        });
        return json(staleEnvelope, 400);
      }
      if (index === 2) return json(humanRevision);
      if (index === 3) {
        expect(requestBody({ url, init }).writeControl).toEqual({
          requiredRevisionId: "rev-human",
        });
        return json({});
      }
      if (index === 4) return json(finalRevision);
      throw new Error(`Unexpected request ${index}: ${url}`);
    });
    restoreFetch = stub.restore;

    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-1"),
    );
    const command: GoogleDocsEditorCommand = {
      command: "str_replace",
      path: "doc-basic",
      old_str: "Alpha",
      new_str: "Omega",
    };

    await expect(
      editor.execute("token", command, context("edit-stale")),
    ).resolves.toBe("STALE_DOCUMENT: view again");
    await expect(
      editor.execute("token", command, context("edit-before-re-view")),
    ).resolves.toMatch(/^READ_REQUIRED:/);

    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-2"),
    );
    await expect(
      editor.execute("token", command, context("edit-recovered")),
    ).resolves.toContain("Revision: rev-final");
    expect(stub.calls).toHaveLength(5);
  });

  test("surfaces none, ambiguous, and mapper-typed refusals without writing", async () => {
    const stub = stubFetch((_call, index) => {
      if (index === 0) return json(basicDocument);
      throw new Error("A refused edit must not call batchUpdate");
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-1"),
    );

    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-basic",
          old_str: "missing",
          new_str: "replacement",
        },
        context("edit-none"),
      ),
    ).resolves.toBe(
      "NOT_FOUND: old_str does not occur in the last viewed document.",
    );
    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-basic",
          old_str: "target",
          new_str: "replacement",
        },
        context("edit-many"),
      ),
    ).resolves.toBe(
      "AMBIGUOUS_MATCH: old_str occurs 3 times in the last viewed document; provide a uniquely identifying string.",
    );
    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-basic",
          old_str: "",
          new_str: "replacement",
        },
        context("edit-empty"),
      ),
    ).resolves.toMatch(/^EDIT_REFUSED: empty_needle\./);
    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-basic",
          old_str: "Alpha",
          new_str: "bad\u0000text",
        },
        context("edit-control"),
      ),
    ).resolves.toMatch(/^EDIT_REFUSED: invalid_control_character\./);
    expect(stub.calls).toHaveLength(1);
  });

  test("refuses an edit without a prior view", async () => {
    const editor = new GoogleDocsEditor();
    await expect(
      editor.execute(
        "token",
        {
          command: "insert",
          path: "doc-basic",
          insert_line: 0,
          insert_text: "Opening",
        },
        context("insert-1"),
      ),
    ).resolves.toBe(
      "READ_REQUIRED: view this document in the current edit session before changing it.",
    );
  });

  test("returns the stored result when the same tool_use id is retried", async () => {
    const afterEdit = basicRevision("rev-2", { Alpha: "Omega" });
    const stub = stubFetch((_call, index) => {
      if (index === 0) return json(basicDocument);
      if (index === 1) return json({});
      if (index === 2) return json(afterEdit);
      throw new Error("The retried tool call must not reach Google Docs");
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-1"),
    );
    const command: GoogleDocsEditorCommand = {
      command: "str_replace",
      path: "doc-basic",
      old_str: "Alpha",
      new_str: "Omega",
    };

    const first = await editor.execute(
      "token",
      command,
      context("edit-same"),
    );
    const retry = await editor.execute(
      "token",
      command,
      context("edit-same"),
    );
    expect(retry).toBe(first);
    expect(stub.calls).toHaveLength(3);
  });

  test("returns EDIT_VERIFY_FAILED when the post-write refetch drops the edit", async () => {
    const stub = stubFetch((_call, index) => {
      if (index === 0) return json(basicDocument);
      if (index === 1) return json({});
      if (index === 2) return json(basicRevision("rev-2"));
      throw new Error(`Unexpected request ${index}`);
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-1"),
    );

    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-basic",
          old_str: "Alpha",
          new_str: "Omega",
        },
        context("edit-verify"),
      ),
    ).resolves.toBe(
      "EDIT_VERIFY_FAILED: Google Docs accepted the write, but the refetched document did not contain the expected edit. View again before another edit.",
    );
    await expect(
      editor.execute(
        "token",
        {
          command: "insert",
          path: "doc-basic",
          insert_line: 0,
          insert_text: "Opening",
        },
        context("edit-after-verify-failure"),
      ),
    ).resolves.toMatch(/^READ_REQUIRED:/);
  });

  test("returns WRITE_APPLIED_REFRESH_FAILED and requires another view", async () => {
    const stub = stubFetch((_call, index) => {
      if (index === 0) return json(basicDocument);
      if (index === 1) return json({});
      if (index === 2) {
        return json(
          {
            error: {
              code: 503,
              status: "UNAVAILABLE",
              message: "Temporary read failure",
            },
          },
          503,
        );
      }
      throw new Error(`Unexpected request ${index}`);
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-1"),
    );

    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-basic",
          old_str: "Alpha",
          new_str: "Omega",
        },
        context("edit-refresh-failure"),
      ),
    ).resolves.toMatch(
      /^WRITE_APPLIED_REFRESH_FAILED: the edit was accepted, but the updated document could not be read/,
    );
  });

  test("refuses a reused tool_use id with different input", async () => {
    const stub = stubFetch((_call, index) => {
      if (index === 0) return json(basicDocument);
      throw new Error("An idempotency conflict must not reach Google Docs");
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("same-id"),
    );

    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-basic",
          old_str: "Alpha",
          new_str: "Omega",
        },
        context("same-id"),
      ),
    ).resolves.toBe(
      "IDEMPOTENCY_CONFLICT: this tool_use id was already used for a different command.",
    );
    expect(stub.calls).toHaveLength(1);
  });

  test("refuses edits when the prior view was truncated", async () => {
    const large = tabDocument("rev-large", `${"a".repeat(100_001)}\n`);
    const stub = stubFetch((_call, index) => {
      if (index === 0) return json(large);
      throw new Error("A truncated document must not be written");
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    const view = await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-large"),
    );
    expect(view).toContain("Truncated: true");

    for (const command of [
      {
        command: "str_replace" as const,
        path: "doc-basic",
        old_str: "a",
        new_str: "b",
      },
      {
        command: "insert" as const,
        path: "doc-basic",
        insert_line: 0,
        insert_text: "Opening",
      },
    ]) {
      await expect(
        editor.execute(
          "token",
          command,
          context(`large-${command.command}`),
        ),
      ).resolves.toBe(
        "DOCUMENT_TOO_LARGE: the prior view was truncated, so this document cannot be edited safely.",
      );
    }
    expect(stub.calls).toHaveLength(1);
  });

  test("surfaces a structural-boundary refusal end to end", async () => {
    const stub = stubFetch((_call, index) => {
      if (index === 0) return json(structureDocument);
      throw new Error("A structural refusal must not call batchUpdate");
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-structure" },
      context("view-structure"),
    );

    await expect(
      editor.execute(
        "token",
        {
          command: "insert",
          path: "doc-structure",
          insert_line: 2,
          insert_text: "Unsafe",
        },
        context("insert-structure"),
      ),
    ).resolves.toMatch(/^EDIT_REFUSED: structural_boundary\./);
    expect(stub.calls).toHaveLength(1);
  });

  test("omits tabId from legacy document requests", async () => {
    const stub = stubFetch(({ url, init }, index) => {
      if (index === 0) return json(legacyDocument);
      if (index === 1) {
        expect(requestBody({ url, init })).toEqual({
          requests: [
            {
              deleteContentRange: {
                range: { startIndex: 8, endIndex: 14 },
              },
            },
            {
              insertText: {
                location: { index: 8 },
                text: "planet",
              },
            },
          ],
          writeControl: { requiredRevisionId: "rev-legacy" },
        });
        return json({});
      }
      if (index === 2) {
        return json(legacyRevision("rev-legacy-2", "Legacy planet\n"));
      }
      throw new Error(`Unexpected request ${index}: ${url}`);
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    const view = await editor.execute(
      "token",
      { command: "view", path: "doc-legacy" },
      context("view-legacy"),
    );
    expect(view).toContain("Tab: legacy body");

    await expect(
      editor.execute(
        "token",
        {
          command: "str_replace",
          path: "doc-legacy",
          old_str: "target",
          new_str: "planet",
        },
        context("edit-legacy"),
      ),
    ).resolves.toContain("Revision: rev-legacy-2");
  });

  test.each([
    {
      label: "before the first line",
      insertLine: 0,
      insertText: "Opening\r\nDetails",
      expected: {
        insertText: {
          location: { tabId: "tab-basic", index: 1 },
          text: "Opening\nDetails\n",
        },
      },
      expectedText:
        "Opening\nDetails\nAlpha target omega\nSecond target line\nEmoji 😀 target 🎯\n",
    },
    {
      label: "after a middle line",
      insertLine: 1,
      insertText: "Between",
      expected: {
        insertText: {
          location: { tabId: "tab-basic", index: 19 },
          text: "\nBetween",
        },
      },
      expectedText:
        "Alpha target omega\nBetween\nSecond target line\nEmoji 😀 target 🎯\n",
    },
    {
      label: "after the final line",
      insertLine: 3,
      insertText: "Closing",
      expected: {
        insertText: {
          location: { tabId: "tab-basic", index: 57 },
          text: "\nClosing",
        },
      },
      expectedText:
        "Alpha target omega\nSecond target line\nEmoji 😀 target 🎯\nClosing\n",
    },
  ])("inserts $label with revision control", async ({
    insertLine,
    insertText,
    expected,
    expectedText,
  }) => {
    const stub = stubFetch(({ url, init }, index) => {
      if (index === 0) return json(basicDocument);
      if (index === 1) {
        expect(requestBody({ url, init })).toEqual({
          requests: [expected],
          writeControl: { requiredRevisionId: "rev-basic" },
        });
        return json({});
      }
      if (index === 2) {
        return json(tabDocument("rev-inserted", expectedText));
      }
      throw new Error(`Unexpected request ${index}: ${url}`);
    });
    restoreFetch = stub.restore;
    const editor = new GoogleDocsEditor();
    await editor.execute(
      "token",
      { command: "view", path: "doc-basic" },
      context("view-1"),
    );

    await expect(
      editor.execute(
        "token",
        {
          command: "insert",
          path: "doc-basic",
          insert_line: insertLine,
          insert_text: insertText,
        },
        context("insert-1"),
      ),
    ).resolves.toContain("Revision: rev-inserted");
    expect(stub.calls).toHaveLength(3);
  });

  test("delegates create and de-duplicates a retried create tool call", async () => {
    const create = vi.fn(async () => '{"documentId":"doc-created"}');
    const editor = new GoogleDocsEditor({ create });
    const command: GoogleDocsEditorCommand = {
      command: "create",
      path: "Unit brief",
      file_text: "Opening draft",
    };

    const first = await editor.execute(
      "token",
      command,
      context("create-1"),
    );
    const retry = await editor.execute(
      "token",
      command,
      context("create-1"),
    );
    expect(first).toBe('{"documentId":"doc-created"}');
    expect(retry).toBe(first);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      token: "token",
      title: "Unit brief",
      fileText: "Opening draft",
      toolUseId: "create-1",
    });
  });
});
