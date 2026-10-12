import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The tutor may no longer write words into a scholar's text document, so the
// scholar's writing box carries a dictation mic instead. DeliverablePanel has
// no render harness (importing it drags in react-native + expo), so — like
// composerSnapshotWiring.test.ts — this pins the wiring against the source:
//   • the mic reuses the chat composer's dictation stack (no fork);
//   • a transcript flows through the SAME debounced save path as typing;
//   • only one recorder runs at a time (the shared appStatusBus mic-owner);
//   • the recorder is mounted ONLY for the text editor (WritingToolbar), never
//     the code-source editor;
//   • an adopted remote update resets the caret so a transcript can't overwrite.
// ─────────────────────────────────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const source = readFileSync(
  resolve(repoRoot, "native/src/components/DeliverablePanel.tsx"),
  "utf8",
);

/** Body of the text editor's toolbar, where the dictation hook now lives. */
const writingToolbar = source.slice(
  source.indexOf("function WritingToolbar({"),
  source.indexOf("function ArtifactEditor({"),
);
/** Body of the shared editor itself (caret tracking + remote-update handling). */
const editor = source.slice(
  source.indexOf("function ArtifactEditor({"),
  source.indexOf("function PanelSkeleton("),
);

describe("DeliverablePanel writing-box dictation", () => {
  it("reuses the chat composer's dictation stack rather than a fork", () => {
    expect(source).toContain(
      'import { useStreamingDictation } from "@/hooks/useStreamingDictation";',
    );
    expect(writingToolbar).toContain(
      "useStreamingDictation(insertDictated, sessionId)",
    );
    expect(writingToolbar).toContain("<RecordingBar");
  });

  it("mounts the recorder ONLY for the text editor, never the code editor", () => {
    // The Expo recorder + its 80ms poll are constructed by the hook. Keeping the
    // hook out of ArtifactEditor's own body means the code-source editor (which
    // renders ArtifactEditor without a sessionId) never spins one up.
    expect(editor).not.toContain("useStreamingDictation(");
    // WritingToolbar is only rendered on the sessionId-defined branch.
    const guarded = editor.indexOf("sessionId !== undefined ? (");
    const mounts = editor.indexOf("<WritingToolbar");
    expect(guarded).toBeGreaterThan(-1);
    expect(mounts).toBeGreaterThan(guarded);
    // The code editor's fallback is the plain toolbar row — no mic.
    expect(editor).toContain(
      "<EditorToolbarRow title={artifact.title} saveState={saveState} />",
    );
  });

  it("routes a transcript through the same save path as typing", () => {
    const insert = writingToolbar.slice(
      writingToolbar.indexOf("const insertDictated = useCallback("),
      writingToolbar.indexOf("const dictation = useStreamingDictation("),
    );
    expect(insert).toContain("spliceDictation(");
    // Same debounced scholarUpdate path a keystroke takes: onInsert === handleChange.
    expect(insert).toContain("onInsert(next)");
    expect(insert).not.toContain("onSave");
    expect(insert).not.toContain("updateArtifact");
    expect(source).toContain("onInsert={handleChange}");
  });

  it("inserts at the tracked caret", () => {
    expect(editor).toContain("selectionRef.current = event.nativeEvent.selection");
    expect(writingToolbar).toContain("selectionRef.current,");
  });

  it("resets the caret to the end when a remote update is adopted", () => {
    // The no-conflict branch of the incoming-content effect replaces localContent
    // with the server's; the stale caret must not survive to overwrite text.
    // `setLocalContent(artifact.content ?? "")` is unique to that branch.
    const adoptStart = editor.indexOf('setLocalContent(artifact.content ?? "");');
    expect(adoptStart).toBeGreaterThan(-1);
    const adopt = editor.slice(adoptStart, adoptStart + 600);
    expect(adopt).toContain("selectionRef.current = {");
    expect(adopt).toContain('start: (artifact.content ?? "").length');
    expect(adopt).toContain('end: (artifact.content ?? "").length');
  });

  it("refuses to start a second recorder while another mic is live", () => {
    const start = writingToolbar.slice(
      writingToolbar.indexOf("const onDictateStart = useCallback("),
      writingToolbar.indexOf("const onDictateStop = useCallback("),
    );
    const guard = start.indexOf("appStatusBus.isMicOwned()");
    const record = start.indexOf("dictation.start()");
    expect(guard).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(guard);
  });

  it("labels the mic for the scholar's own writing", () => {
    expect(writingToolbar).toContain('accessibilityLabel="Dictate into your writing"');
  });

  it("wires the mic for text documents only, never the code source editor", () => {
    // The prose editor is handed a sessionId; the code source editor is not.
    const textRender = source.slice(
      source.indexOf("<ArtifactEditor\n                key={activeArtifact._id}"),
    );
    expect(textRender.slice(0, 400)).toContain("sessionId={sessionId}");
    const codeRender = source.slice(source.indexOf("`${artifact._id}:code`"));
    expect(codeRender.slice(0, 200)).not.toContain("sessionId=");
  });
});

describe("spliceDictation", () => {
  // The helper is pure but lives in a react-native module, so re-derive its
  // contract here as executable expectations of the source it is spliced from.
  const helper = source.slice(
    source.indexOf("export function spliceDictation("),
    source.indexOf("type SaveState ="),
  );

  it("trims speech and no-ops on empty input at the current caret", () => {
    expect(helper).toContain("const text = spoken.trim();");
    expect(helper).toContain("if (!text) return { next: content, caret: selection.end };");
  });

  it("clamps the selection into the document before splicing", () => {
    expect(helper).toContain("Math.min(selection.start, selection.end, content.length)");
    expect(helper).toContain(
      "Math.min(Math.max(selection.start, selection.end), content.length)",
    );
  });

  it("pads with a single space so speech never fuses onto a neighbour word", () => {
    expect(helper).toContain('!/\\s$/.test(before) ? " " : ""');
    expect(helper).toContain('!/^\\s/.test(after) ? " " : ""');
  });

  it("reports the caret just past the insertion for chained dictation", () => {
    expect(helper).toContain("caret: before.length + insertion.length");
  });
});
