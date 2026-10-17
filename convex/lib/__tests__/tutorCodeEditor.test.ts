import { describe, expect, test } from "vitest";

import {
  clientToolName,
  codeArtifactPath,
  editExcerpt,
  parseCodeArtifactPath,
  parseCodeEditorInput,
  requestedArtifactIdFromToolInput,
  SeenRevisions,
} from "../tutorCodeEditor";
import { runBuildToolWithTruncationGuard } from "../../sessionStreamHelpers";

describe("app paths", () => {
  test("an app's path is derived from its id and parses back to it", () => {
    const path = codeArtifactPath("k57abc123");
    expect(path).toBe("/apps/k57abc123.html");
    expect(parseCodeArtifactPath(path)).toEqual({ kind: "file", artifactId: "k57abc123" });
    // A missing leading slash and surrounding whitespace are forgiven.
    expect(parseCodeArtifactPath(" apps/k57abc123.html ")).toEqual({
      kind: "file",
      artifactId: "k57abc123",
    });
    expect(parseCodeArtifactPath("/apps")).toEqual({ kind: "directory" });
    expect(parseCodeArtifactPath("/apps/")).toEqual({ kind: "directory" });
    for (const bad of [
      "",
      "/apps/k57.js",
      "/apps/../x.html",
      "/docs/k57.html",
      "k57abc123",
      "/apps/a/b.html",
    ]) {
      expect(parseCodeArtifactPath(bad).kind).toBe("invalid");
    }
  });

  test("the render check finds the target from either tool's input", () => {
    expect(requestedArtifactIdFromToolInput({ path: "/apps/abc.html" })).toBe("abc");
    expect(requestedArtifactIdFromToolInput({ document_id: "abc" })).toBe("abc");
    expect(requestedArtifactIdFromToolInput({ path: "/apps" })).toBeNull();
    expect(requestedArtifactIdFromToolInput(null)).toBeNull();
  });

  test("clients keep seeing edit_document for the app editor", () => {
    expect(clientToolName("str_replace_based_edit_tool")).toBe("edit_document");
    expect(clientToolName("create_code")).toBe("create_code");
  });
});

describe("editor input", () => {
  test("parses the commands and rejects malformed input", () => {
    expect(
      parseCodeEditorInput({ command: "view", path: "/apps/a.html", view_range: [1, -1] }),
    ).toEqual({ command: "view", path: "/apps/a.html", view_range: [1, -1] });
    // Omitting new_str deletes old_str, as in the reference editor.
    expect(
      parseCodeEditorInput({ command: "str_replace", path: "/apps/a.html", old_str: "x" }),
    ).toEqual({ command: "str_replace", path: "/apps/a.html", old_str: "x", new_str: "" });
    expect(
      parseCodeEditorInput({
        command: "insert",
        path: "/apps/a.html",
        insert_line: 3,
        insert_text: "y",
      }),
    ).toMatchObject({ insert_line: 3, insert_text: "y" });
    expect(() =>
      parseCodeEditorInput({ command: "view", path: "/apps/a.html", view_range: [1] }),
    ).toThrow();
    expect(() =>
      parseCodeEditorInput({ command: "insert", path: "/apps/a.html", insert_text: "y" }),
    ).toThrow();
    expect(() => parseCodeEditorInput({ command: "undo_edit", path: "/apps/a.html" })).toThrow();
    expect(() => parseCodeEditorInput({ command: "view" })).toThrow("path");
  });
});

describe("seen revisions", () => {
  test("seeds from code artifacts only and tracks views, edits and conflicts", () => {
    const seen = new SeenRevisions([
      { id: "app", revision: 4, type: "code" },
      { id: "story", revision: 9, type: "text" },
    ]);
    expect(seen.get("app")).toBe(4);
    expect(seen.get("story")).toBeUndefined();
    seen.see("app", 5);
    expect(seen.get("app")).toBe(5);
    seen.forget("app");
    expect(seen.get("app")).toBeUndefined();
  });
});

describe("edit excerpt", () => {
  test("numbers the edited lines with context", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const lines = editExcerpt(content, 10, 11).split("\n");
    expect(lines[0]).toBe("6: line 6");
    expect(lines.at(-1)).toBe("15: line 15");
  });
});

describe("output-limit guard", () => {
  test("refuses a cut-off app edit before it runs, and lets a view through", async () => {
    let ran = 0;
    const run = () => {
      ran += 1;
      return "ok";
    };
    const cut = await runBuildToolWithTruncationGuard({
      toolName: "str_replace_based_edit_tool",
      input: { command: "str_replace", path: "/apps/a.html" },
      truncationsThisTurn: 0,
      run,
    });
    expect(cut.blocked).toBe(true);
    expect(cut.result).toContain("str_replace_based_edit_tool");
    const view = await runBuildToolWithTruncationGuard({
      toolName: "str_replace_based_edit_tool",
      input: { command: "view", path: "/apps/a.html" },
      stopReason: "max_tokens",
      truncationsThisTurn: 0,
      run,
    });
    expect(view.blocked).toBe(false);
    expect(ran).toBe(1);
  });
});
