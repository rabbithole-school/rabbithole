import { describe, expect, test } from "vitest";
import { buildSystemPrompt, type ArtifactData } from "../sessionHelpers";

// Why this file: a tutor that could not tell a scholar's plain-text writing box
// from a live app told a scholar to style the writing box with <p style>, and
// could not say where "the code" was. Each listed document must carry the
// surface it is on the scholar's screen.

const doc = (overrides: Partial<ArtifactData>): ArtifactData => ({
  id: "doc-1",
  title: "Game design",
  content: "Rise: 6 Run: 3 Slope: 2",
  lastEditedBy: "scholar",
  revision: 1,
  ...overrides,
});

function promptWith(artifacts: ArtifactData[]): string {
  return buildSystemPrompt(
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    artifacts,
  );
}

describe("tutor DOCUMENTS section names each document's surface", () => {
  test("a text document is a writing box, a code document is a live app", () => {
    const prompt = promptWith([
      doc({}),
      doc({ id: "app-1", title: "Slope game", type: "code", content: "<p>hi</p>" }),
    ]);
    expect(prompt).toMatch(/\[Document ID: doc-1\] "Game design" — WRITING BOX/);
    expect(prompt).toMatch(/\[Document ID: app-1\] "Slope game" — LIVE APP/);
  });

  test("a legacy untyped document is a writing box", () => {
    expect(promptWith([doc({ type: undefined })])).toMatch(
      /"Game design" — WRITING BOX/,
    );
  });
});
