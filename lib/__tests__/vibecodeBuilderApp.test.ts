// TRA-519 one app surface: an app card's Open names its app, so the builder
// shows (edits, checks, restores) THAT app — not the session's newest — and
// History lists only that app's versions.

import { describe, expect, test } from "vitest";
import {
  builderAppChoices,
  builderHtmlArtifact,
  htmlAppIds,
  newlyAddedHtmlApp,
  revisionsForApp,
} from "../vibecode/helpers";

const older = {
  _id: "older",
  _creationTime: 1,
  type: "code",
  content: "<html><body>old</body></html>",
};
const newer = {
  _id: "newer",
  _creationTime: 2,
  type: "code",
  content: "<html><body>new</body></html>",
};
const notAnApp = {
  _id: "doc",
  _creationTime: 3,
  type: "text",
  content: "Just words",
};

describe("builderHtmlArtifact", () => {
  test("the app the card named, even when a newer one exists", () => {
    expect(builderHtmlArtifact([older, newer], "older")).toBe(older);
  });

  test("no request, an unknown id, or a non-app id → the newest app", () => {
    expect(builderHtmlArtifact([older, newer], null)).toBe(newer);
    expect(builderHtmlArtifact([older, newer], "gone")).toBe(newer);
    expect(builderHtmlArtifact([older, newer, notAnApp], "doc")).toBe(newer);
  });

  test("no artifacts → none", () => {
    expect(builderHtmlArtifact(undefined, "older")).toBeNull();
  });
});

describe("newlyAddedHtmlApp", () => {
  test("the first look sets the baseline and follows nothing", () => {
    expect(newlyAddedHtmlApp(null, [older, newer])).toBeNull();
  });

  test("an app the AI just created is followed; nothing new → nothing", () => {
    const known = htmlAppIds([older]);
    expect(newlyAddedHtmlApp(known, [older, newer, notAnApp])).toBe(newer);
    expect(newlyAddedHtmlApp(htmlAppIds([older, newer]), [older, newer])).toBeNull();
  });
});

describe("revisionsForApp", () => {
  const revisions = [
    { id: "r3", artifactId: "newer", version: 3 },
    { id: "r2", artifactId: "older", version: 2 },
    { id: "r1", artifactId: "older", version: 1 },
  ];

  test("only the shown app's versions, order kept", () => {
    expect(revisionsForApp(revisions, "older")?.map((r) => r.id)).toEqual([
      "r2",
      "r1",
    ]);
  });

  test("loading stays undefined; no app lists nothing", () => {
    expect(revisionsForApp(undefined, "older")).toBeUndefined();
    expect(revisionsForApp(revisions, null)).toEqual([]);
  });
});

describe("builderAppChoices", () => {
  const starter = { ...older, title: "Cart on a ramp" };
  const later = { ...newer, title: "Race track" };

  test("one app (or none) → no switcher", () => {
    expect(builderAppChoices([starter, notAnApp])).toEqual([]);
    expect(builderAppChoices(undefined)).toEqual([]);
  });

  test("every app, oldest first, by title — so a starter app stays reachable", () => {
    expect(builderAppChoices([later, notAnApp, starter])).toEqual([
      { id: "older", label: "Cart on a ramp" },
      { id: "newer", label: "Race track" },
    ]);
  });

  test("repeated or blank titles still read apart", () => {
    const third = { ...newer, _id: "third", _creationTime: 4, title: "Cart on a ramp" };
    const blank = { ...newer, _id: "blank", _creationTime: 5, title: "  " };
    expect(builderAppChoices([starter, third, blank]).map((c) => c.label)).toEqual([
      "Cart on a ramp",
      "Cart on a ramp (2)",
      "Untitled app",
    ]);
  });
});
