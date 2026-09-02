import { afterEach, describe, expect, test } from "vitest";
import {
  GoogleSlidesEditor,
  parseGoogleSlidesEditorInput,
  type GoogleSlidesEditorCommand,
} from "../googleSlidesEditor";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const textElement = (
  text: string,
  options: { link?: boolean; bullet?: boolean; extraRun?: boolean } = {},
) =>
  text.split("\n").flatMap((paragraph, index, paragraphs) => [
    {
      paragraphMarker: {
        style: {},
        ...(options.bullet ? { bullet: {} } : {}),
      },
    },
    {
      textRun: {
        content: `${paragraph}${index < paragraphs.length - 1 ? "\n" : ""}`,
        style: options.link ? { link: {} } : {},
      },
    },
    ...(options.extraRun && index === 0
      ? [{ textRun: { content: "two", style: { bold: true } } }]
      : []),
  ]);

function deck(revisionId = "r1", options: { text?: string; notes?: string; mixed?: boolean; notesMixed?: boolean; added?: boolean } = {}) {
  const text = options.text ?? "Title";
  const notes = options.notes ?? "Notes";
  const elements = [
    {
      objectId: "title-box",
      shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE", index: 0 }, text: { textElements: textElement(text, { extraRun: options.mixed }) } },
    },
    {
      objectId: "image-1",
      size: { width: { magnitude: 100, unit: "PT" } },
      transform: { scaleX: 1, scaleY: 1 },
      image: {},
    },
  ];
  if (options.added) {
    elements.push({
      objectId: "rh_addedtitle",
      shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE", index: 0 }, text: { textElements: textElement("New title") } },
    });
  }
  return {
    presentationId: "deck-1", title: "Curriculum deck", revisionId,
    slides: [{
      objectId: "slide-1",
      pageElements: elements,
      slideProperties: {
        layoutObjectId: "layout-1",
        notesPage: {
          notesProperties: { speakerNotesObjectId: "notes-1" },
          pageElements: [{ objectId: "notes-1", shape: { text: { textElements: textElement(notes, { extraRun: options.notesMixed }) } } }],
        },
      },
    }],
    layouts: [{
      objectId: "layout-1",
      pageElements: [
        { objectId: "layout-title", shape: { placeholder: { type: "TITLE", index: 0 } } },
        { objectId: "layout-body", shape: { placeholder: { type: "BODY", index: 0 } } },
      ],
    }],
  };
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function stubFetch(handler: (url: string, init: RequestInit | undefined, index: number) => Response) {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init, calls.length - 1));
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = realFetch; };
  return calls;
}

const replace: GoogleSlidesEditorCommand = {
  command: "replace_text", base_revision: "r1", slide_object_id: "slide-1",
  object_id: "title-box", expected_text: "Title", new_text: "Revised",
};

describe("GoogleSlidesEditor", () => {
  test("projects editable targets, notes, layout and opaque counts", async () => {
    stubFetch(() => json(deck()));
    const editor = new GoogleSlidesEditor();
    const view = await editor.view("token", "deck-1", "principal-a");
    expect(view).toContain("slide_object_id=slide-1 layout_id=layout-1");
    expect(view).toContain("Title: Curriculum deck");
    expect(view).toContain('title: object_id=title-box text="Title"');
    expect(view).toContain('speaker_notes: "Notes"');
    expect(view).toContain("Unsupported/complex objects: image=1");
  });

  test("refuses mixed-style text and expected-text mismatch without posting", async () => {
    const calls = stubFetch((_url, _init, index) => json(deck("r1", { mixed: index === 0 })));
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "mixed" }))
      .resolves.toContain("MIXED_STYLE_TEXT");
    expect(calls).toHaveLength(1);

    restoreFetch?.();
    const mismatchCalls = stubFetch(() => json(deck()));
    const second = new GoogleSlidesEditor();
    await second.view("token", "deck-1", "principal-a");
    await expect(second.execute("token", "deck-1", "principal-a", {
      ...replace, expected_text: "Wrong",
    }, { toolUseId: "mismatch" })).resolves.toContain("TEXT_MISMATCH");
    expect(mismatchCalls).toHaveLength(1);
  });

  test("replaces notes using bounded delete and insert requests and verifies refresh", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) return json(deck());
      if (index === 1) {
        expect(JSON.parse(String(init?.body)).requests).toEqual([
          { deleteText: { objectId: "notes-1", textRange: { type: "ALL" } } },
          { insertText: { objectId: "notes-1", insertionIndex: 0, text: "New notes" } },
        ]);
        return json({});
      }
      return json(deck("r2", { notes: "New notes" }));
    });

    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "set_speaker_notes", base_revision: "r1", slide_object_id: "slide-1",
      expected_text: "Notes", new_text: "New notes",
    }, { toolUseId: "notes" })).resolves.toBe("EDIT_APPLIED\nRevision: r2");
    expect(calls).toHaveLength(3);
  });

  test("replaces plain text and verifies the refetched target", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) return json(deck());
      if (index === 1) {
        expect(JSON.parse(String(init?.body)).requests).toEqual([
          { deleteText: { objectId: "title-box", textRange: { type: "ALL" } } },
          { insertText: { objectId: "title-box", insertionIndex: 0, text: "Revised" } },
        ]);
        return json({});
      }
      return json(deck("r2", { text: "Revised" }));
    });
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "replace" }))
      .resolves.toBe("EDIT_APPLIED\nRevision: r2");
    expect(calls).toHaveLength(3);
  });

  test("round-trips uniformly styled multi-paragraph text", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) return json(deck());
      if (index === 1) {
        expect(JSON.parse(String(init?.body)).requests[1].insertText.text)
          .toBe("First\nSecond");
        return json({});
      }
      if (index === 2) {
        return json(deck("r2", { text: "First\nSecond" }));
      }
      if (index === 3) {
        expect(JSON.parse(String(init?.body)).requests[1].insertText.text)
          .toBe("Third\nFourth");
        return json({});
      }
      return json(deck("r3", { text: "Third\nFourth" }));
    });
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      ...replace,
      new_text: "First\nSecond",
    }, { toolUseId: "multiline-1" })).resolves.toBe(
      "EDIT_APPLIED\nRevision: r2",
    );
    await expect(editor.execute("token", "deck-1", "principal-a", {
      ...replace,
      base_revision: "r2",
      expected_text: "First\nSecond",
      new_text: "Third\nFourth",
    }, { toolUseId: "multiline-2" })).resolves.toBe(
      "EDIT_APPLIED\nRevision: r3",
    );
    expect(calls).toHaveLength(5);
  });

  test("round-trips uniformly styled multi-paragraph speaker notes", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) return json(deck());
      if (index === 1) {
        expect(JSON.parse(String(init?.body)).requests[1].insertText.text)
          .toBe("First note\nSecond note");
        return json({});
      }
      if (index === 2) {
        return json(deck("r2", { notes: "First note\nSecond note" }));
      }
      if (index === 3) {
        expect(JSON.parse(String(init?.body)).requests[1].insertText.text)
          .toBe("Third note\nFourth note");
        return json({});
      }
      return json(deck("r3", { notes: "Third note\nFourth note" }));
    });
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "set_speaker_notes",
      base_revision: "r1",
      slide_object_id: "slide-1",
      expected_text: "Notes",
      new_text: "First note\nSecond note",
    }, { toolUseId: "multiline-notes-1" })).resolves.toBe(
      "EDIT_APPLIED\nRevision: r2",
    );
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "set_speaker_notes",
      base_revision: "r2",
      slide_object_id: "slide-1",
      expected_text: "First note\nSecond note",
      new_text: "Third note\nFourth note",
    }, { toolUseId: "multiline-notes-2" })).resolves.toBe(
      "EDIT_APPLIED\nRevision: r3",
    );
    expect(calls).toHaveLength(5);
  });

  test("exposes and fills an empty ordinary placeholder", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) {
        const source = deck();
        Object.assign(source.slides[0]!.pageElements![0]!.shape!, { text: undefined });
        return json(source);
      }
      if (index === 1) {
        expect(JSON.parse(String(init?.body)).requests).toEqual([
          { insertText: { objectId: "title-box", insertionIndex: 0, text: "Filled" } },
        ]);
        return json({});
      }
      return json(deck("r2", { text: "Filled" }));
    });
    const editor = new GoogleSlidesEditor();
    await expect(editor.view("token", "deck-1", "principal-a"))
      .resolves.toContain('title: object_id=title-box text=""');
    await expect(editor.execute("token", "deck-1", "principal-a", {
      ...replace, expected_text: "", new_text: "Filled",
    }, { toolUseId: "empty-title" })).resolves.toBe("EDIT_APPLIED\nRevision: r2");
    expect(calls).toHaveLength(3);
  });

  test("fills empty speaker notes even when the notes shape is omitted", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) {
        const source = deck();
        source.slides[0]!.slideProperties.notesPage.pageElements = [];
        return json(source);
      }
      if (index === 1) {
        expect(JSON.parse(String(init?.body)).requests).toEqual([
          { insertText: { objectId: "notes-1", insertionIndex: 0, text: "Added note" } },
        ]);
        return json({});
      }
      return json(deck("r2", { notes: "Added note" }));
    });
    const editor = new GoogleSlidesEditor();
    await expect(editor.view("token", "deck-1", "principal-a")).resolves.toContain('speaker_notes: ""');
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "set_speaker_notes", base_revision: "r1", slide_object_id: "slide-1",
      expected_text: "", new_text: "Added note",
    }, { toolUseId: "empty-notes" })).resolves.toBe("EDIT_APPLIED\nRevision: r2");
    expect(calls).toHaveLength(3);
  });

  test("shows but refuses mixed-style speaker notes without posting", async () => {
    const calls = stubFetch(() => json(deck("r1", { notes: "Read only", notesMixed: true })));
    const editor = new GoogleSlidesEditor();
    await expect(editor.view("token", "deck-1", "principal-a")).resolves.toContain('speaker_notes: "Read onlytwo"');
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "set_speaker_notes", base_revision: "r1", slide_object_id: "slide-1",
      expected_text: "Read onlytwo", new_text: "No",
    }, { toolUseId: "complex-notes" })).resolves.toContain("MIXED_STYLE_TEXT");
    expect(calls).toHaveLength(1);
  });

  test("creates slides at requested insertion using only whitelisted request kinds", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) return json(deck());
      if (index === 1) {
        const requests = JSON.parse(String(init?.body)).requests as Array<Record<string, unknown>>;
        expect(requests.map((request) => Object.keys(request)[0])).toEqual([
          "createSlide", "insertText", "insertText",
        ]);
        const create = requests[0].createSlide as { objectId: string; insertionIndex: number; slideLayoutReference: { layoutId: string }; placeholderIdMappings: Array<{ objectId: string }> };
        expect(create.insertionIndex).toBe(1);
        expect(create.objectId).toMatch(/^rh_[A-Za-z0-9_-]+$/);
        expect(create.slideLayoutReference.layoutId).toBe("layout-1");
        expect(create.placeholderIdMappings).toHaveLength(2);
        expect(create.placeholderIdMappings.every((mapping) => /^rh_[A-Za-z0-9_-]+$/.test(mapping.objectId))).toBe(true);
        return json({});
      }
      const refreshed = deck("r2");
      refreshed.slides.push({
        objectId: "slide-2",
        pageElements: [
          { objectId: "placeholder-a", shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE", index: 0 }, text: { textElements: textElement("New title") } } },
          { objectId: "placeholder-b", shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY", index: 0 }, text: { textElements: textElement("New body") } } },
        ],
        slideProperties: {
          layoutObjectId: "layout-1",
          notesPage: {
            notesProperties: { speakerNotesObjectId: "notes-2" },
            pageElements: [{ objectId: "notes-2", shape: { text: { textElements: textElement("") } } }],
          },
        },
      });

      // The editor verifies the server-generated mapping ids, so preserve them
      // from the submitted requests in this deterministic fake.
      const request = JSON.parse(String(calls[1]!.init?.body)).requests[0].createSlide;
      refreshed.slides[1]!.objectId = request.objectId;
      refreshed.slides[1]!.pageElements![0]!.objectId = request.placeholderIdMappings[0].objectId;
      refreshed.slides[1]!.pageElements![1]!.objectId = request.placeholderIdMappings[1].objectId;
      return json(refreshed);
    });
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "append_slide", base_revision: "r1", layout_from_slide_object_id: "slide-1",
      placeholders: { title: "New title", body: "New body" },
    }, { toolUseId: "append" })).resolves.toBe("EDIT_APPLIED\nRevision: r2");
    expect(calls).toHaveLength(3);
  });

  test("uses index zero for layout placeholders that omit an index", async () => {
    const calls = stubFetch((_url, init, index) => {
      if (index === 0) {
        const source = deck();
        Object.assign(source.layouts[0]!.pageElements[0]!.shape!.placeholder!, { index: undefined });
        return json(source);
      }
      if (index === 1) {
        expect(JSON.parse(String(init?.body)).requests[0].createSlide.placeholderIdMappings[0].layoutPlaceholder.index).toBe(0);
        return json({});
      }
      const refreshed = deck("r2");
      const create = JSON.parse(String(calls[1]!.init?.body)).requests[0].createSlide;
      refreshed.slides.push({
        objectId: create.objectId,
        pageElements: [{ objectId: create.placeholderIdMappings[0].objectId, shape: {
          shapeType: "TEXT_BOX", placeholder: { type: "TITLE", index: 0 }, text: { textElements: textElement("Indexed title") },
        } }],
        slideProperties: { layoutObjectId: "layout-1", notesPage: { notesProperties: { speakerNotesObjectId: "n" }, pageElements: [] } },
      });
      return json(refreshed);
    });
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "append_slide", base_revision: "r1", layout_from_slide_object_id: "slide-1", placeholders: { title: "Indexed title" },
    }, { toolUseId: "zero-index" })).resolves.toBe("EDIT_APPLIED\nRevision: r2");
    expect(calls).toHaveLength(3);
  });

  test("verifies empty-placeholder append by new slide identity and layout", async () => {
    const calls = stubFetch((_url, _init, index) => {
      if (index === 0) return json(deck());
      if (index === 1) return json({});
      const refreshed = deck("r2");
      const create = JSON.parse(String(calls[1]!.init?.body)).requests[0].createSlide;
      refreshed.slides.push({
        objectId: create.objectId, pageElements: [],
        slideProperties: { layoutObjectId: "layout-1", notesPage: { notesProperties: { speakerNotesObjectId: "n" }, pageElements: [] } },
      });
      return json(refreshed);
    });
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      command: "append_slide", base_revision: "r1", layout_from_slide_object_id: "slide-1", placeholders: {},
    }, { toolUseId: "empty-append" })).resolves.toBe("EDIT_APPLIED\nRevision: r2");
    expect(calls).toHaveLength(3);
  });

  test("clears session on stale, refresh failure, and semantic verification failure", async () => {
    const stale = stubFetch((_url, _init, index) => index === 0 ? json(deck()) : json({
      error: { status: "FAILED_PRECONDITION", message: "stale" },
    }, 400));
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "stale" }))
      .resolves.toBe("STALE_DECK: view again");
    expect(stale).toHaveLength(2);

    restoreFetch?.();
    const refresh = stubFetch((_url, _init, index) => {
      if (index === 0) return json(deck());
      if (index === 1) return json({});
      throw new Error("offline");
    });
    const refreshEditor = new GoogleSlidesEditor();
    await refreshEditor.view("token", "deck-1", "principal-a");
    await expect(refreshEditor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "refresh" }))
      .resolves.toContain("WRITE_APPLIED_REFRESH_FAILED");
    expect(refresh).toHaveLength(3);

    restoreFetch?.();
    const verify = stubFetch((_url, _init, index) => index === 0 ? json(deck()) : index === 1 ? json({}) : json(deck("r2")));
    const verifyEditor = new GoogleSlidesEditor();
    await verifyEditor.view("token", "deck-1", "principal-a");
    await expect(verifyEditor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "verify" }))
      .resolves.toContain("EDIT_VERIFY_FAILED");
    expect(verify).toHaveLength(3);
  });

  test("requires same principal and handles idempotency without replaying pending work", async () => {
    const calls = stubFetch((_url, _init, index) => {
      if (index === 0) return json(deck());
      throw new Error("network broke after request began");
    });
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-b", replace, { toolUseId: "other" }))
      .resolves.toContain("READ_REQUIRED");
    await expect(editor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "retry" }))
      .rejects.toThrow("network broke");
    await expect(editor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "retry" }))
      .resolves.toContain("IDEMPOTENCY_UNCERTAIN");
    await expect(editor.execute("token", "deck-1", "principal-a", { ...replace, new_text: "Other" }, { toolUseId: "retry" }))
      .resolves.toContain("IDEMPOTENCY_CONFLICT");
    expect(calls).toHaveLength(2);
  });

  test("a fresh editor cannot replay an append from an older revision", async () => {
    const calls = stubFetch(() => json(deck("r2")));
    const editor = new GoogleSlidesEditor();
    const append: GoogleSlidesEditorCommand = {
      command: "append_slide",
      base_revision: "r1",
      layout_from_slide_object_id: "slide-1",
      placeholders: { title: "Possible duplicate" },
    };
    await expect(
      editor.execute(
        "token",
        "deck-1",
        "principal-a",
        append,
        { toolUseId: "cross-instance-retry" },
      ),
    ).resolves.toContain("READ_REQUIRED");
    expect(calls).toHaveLength(0);

    await editor.view("token", "deck-1", "principal-a");
    await expect(
      editor.execute(
        "token",
        "deck-1",
        "principal-a",
        append,
        { toolUseId: "cross-instance-retry-after-read" },
      ),
    ).resolves.toBe("STALE_DECK: view again");
    expect(calls).toHaveLength(1);
  });

  test("returns a completed idempotent result without a second write", async () => {
    const calls = stubFetch((_url, _init, index) =>
      index === 0 ? json(deck()) : index === 1 ? json({}) : json(deck("r2", { text: "Revised" })),
    );
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    const first = await editor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "done" });
    const retry = await editor.execute("token", "deck-1", "principal-a", replace, { toolUseId: "done" });
    expect(first).toBe("EDIT_APPLIED\nRevision: r2");
    expect(retry).toBe(first);
    expect(calls).toHaveLength(3);
  });

  test("refuses edits against a truncated view", async () => {
    const veryLong = "x".repeat(60_100);
    const calls = stubFetch(() => json(deck("r1", { text: veryLong })));
    const editor = new GoogleSlidesEditor();
    await expect(editor.view("token", "deck-1", "principal-a")).resolves.toContain("TRUNCATED");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      ...replace, expected_text: veryLong,
    }, { toolUseId: "truncated" })).resolves.toContain("READ_REQUIRED");
    expect(calls).toHaveLength(1);
  });

  test("returns NO_CHANGE without a write when replacement text is unchanged", async () => {
    const calls = stubFetch(() => json(deck()));
    const editor = new GoogleSlidesEditor();
    await editor.view("token", "deck-1", "principal-a");
    await expect(editor.execute("token", "deck-1", "principal-a", {
      ...replace, new_text: "Title",
    }, { toolUseId: "no-change" })).resolves.toBe("NO_CHANGE\nRevision: r1");
    expect(calls).toHaveLength(1);
  });

  test("parses only bounded commands", () => {
    expect(parseGoogleSlidesEditorInput({
      command: "append_slide", base_revision: "r1", layout_from_slide_object_id: "slide-1",
      placeholders: { title: "Title" },
    })).toMatchObject({ command: "append_slide" });
    expect(() => parseGoogleSlidesEditorInput({ command: "delete_slide", base_revision: "r1" })).toThrow("Unsupported");
  });
});
