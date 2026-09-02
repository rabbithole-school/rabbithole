import { beforeEach, describe, expect, test } from "vitest";
import {
  clearAllArtifactDrafts,
  clearArtifactDraft,
  createArtifactDraftController,
  getArtifactDraft,
  hasArtifactDraftConflict,
  hasIncomingArtifactConflict,
  setArtifactDraft,
} from "../artifactDraftStore";

const snapshot = {
  content: "my draft",
  serverContent: "server draft",
  revision: 2,
  conflict: true,
};

describe("artifact draft store", () => {
  beforeEach(clearAllArtifactDrafts);

  test("preserves a conflict draft across editor remounts", () => {
    setArtifactDraft("artifact-1", snapshot);
    expect(getArtifactDraft("artifact-1")).toEqual(snapshot);
  });

  test("clears one draft or the whole session cache", () => {
    setArtifactDraft("artifact-1", snapshot);
    setArtifactDraft("artifact-2", snapshot);
    clearArtifactDraft("artifact-1");
    expect(getArtifactDraft("artifact-1")).toBeUndefined();
    expect(getArtifactDraft("artifact-2")).toEqual(snapshot);
    clearAllArtifactDrafts();
    expect(getArtifactDraft("artifact-2")).toBeUndefined();
  });

  test("conflicts only when the server changed underneath a dirty draft", () => {
    expect(
      hasArtifactDraftConflict({ ...snapshot, conflict: false }, { content: "third draft" }),
    ).toBe(true);
    expect(
      hasArtifactDraftConflict({ ...snapshot, conflict: false }, { content: "my draft" }),
    ).toBe(false);
    expect(
      hasArtifactDraftConflict({ ...snapshot, conflict: false }, { content: "server draft" }),
    ).toBe(false);
  });

  test("a stale editor cannot overwrite the latest mounted editor", () => {
    setArtifactDraft("artifact-1", snapshot);
    const oldEditor = createArtifactDraftController("artifact-1");
    oldEditor.claim();
    const newEditor = createArtifactDraftController("artifact-1");
    newEditor.claim();
    expect(
      newEditor.write({ ...snapshot, content: "newest draft" }),
    ).toBe(true);
    expect(
      oldEditor.write({ ...snapshot, content: "stale draft" }),
    ).toBe(false);
    expect(getArtifactDraft("artifact-1")?.content).toBe("newest draft");
  });

  test("an editor's own delayed save is not an external conflict", () => {
    expect(hasIncomingArtifactConflict("my draft", "old", "my draft")).toBe(false);
    expect(hasIncomingArtifactConflict("my draft", "old", "other edit")).toBe(true);
  });
});
