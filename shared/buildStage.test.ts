import { describe, expect, test } from "vitest";

import {
  buildStageIndex,
  deriveBuildPreview,
  deriveBuildStage,
  type BuildSignal,
} from "./buildStage";

describe("deriveBuildStage", () => {
  test("starts in planning before any code tool runs", () => {
    expect(deriveBuildStage([]).stage).toBe("planning");
    expect(deriveBuildStage([{ type: "streamStart" }]).stage).toBe("planning");
  });

  test("moves to writing while create_code is in flight", () => {
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
    ];
    expect(deriveBuildStage(events).stage).toBe("writing");
  });

  test("stays in writing after create_code completes but before a render check", () => {
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
      { type: "codeToolComplete", name: "create_code" },
    ];
    expect(deriveBuildStage(events).stage).toBe("writing");
  });

  test("moves to looking when a render check is requested and holds until answered", () => {
    const requested: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
      { type: "codeToolComplete", name: "create_code" },
      { type: "renderCheck" },
    ];
    expect(deriveBuildStage(requested).stage).toBe("looking");
    expect(
      deriveBuildStage([...requested, { type: "renderCheckAnswered" }]).stage,
    ).toBe("looking");
  });

  test("moves to fixing when edit_document runs after a render check", () => {
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
      { type: "codeToolComplete", name: "create_code" },
      { type: "renderCheck" },
      { type: "renderCheckAnswered" },
      { type: "codeToolStart", name: "edit_document" },
    ];
    expect(deriveBuildStage(events).stage).toBe("fixing");
  });

  test("walks the full planning → writing → looking → fixing sequence and ends", () => {
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
      { type: "codeToolComplete", name: "create_code" },
      { type: "renderCheck" },
      { type: "renderCheckAnswered" },
      { type: "codeToolStart", name: "edit_document" },
      { type: "codeToolComplete", name: "edit_document" },
      { type: "done" },
    ];
    const result = deriveBuildStage(events);
    expect(result.stage).toBe("fixing");
    expect(result.ended).toBe(true);
  });

  test("a build with NO render check stops at writing and never reaches fixing", () => {
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
      { type: "codeToolComplete", name: "create_code" },
      { type: "done" },
    ];
    const result = deriveBuildStage(events);
    expect(result.stage).toBe("writing");
    expect(result.ended).toBe(true);
  });

  test("an edit_document before any render check is treated as writing, not fixing", () => {
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "edit_document" },
    ];
    expect(deriveBuildStage(events).stage).toBe("writing");
  });

  test("a second create_code restarts the render-check cycle, so a later edit reads writing", () => {
    // create → render-check → create (start over) → edit before the new app is
    // inspected must be "writing", not a stale "fixing".
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
      { type: "codeToolComplete", name: "create_code" },
      { type: "renderCheck" },
      { type: "renderCheckAnswered" },
      { type: "codeToolStart", name: "create_code" },
      { type: "codeToolComplete", name: "create_code" },
      { type: "codeToolStart", name: "edit_document" },
    ];
    expect(deriveBuildStage(events).stage).toBe("writing");
  });

  test("error ends the build", () => {
    const events: BuildSignal[] = [
      { type: "streamStart" },
      { type: "codeToolStart", name: "create_code" },
      { type: "error" },
    ];
    expect(deriveBuildStage(events).ended).toBe(true);
  });

  test("buildStageIndex orders the stages", () => {
    expect(buildStageIndex("planning")).toBe(0);
    expect(buildStageIndex("writing")).toBe(1);
    expect(buildStageIndex("looking")).toBe(2);
    expect(buildStageIndex("fixing")).toBe(3);
  });
});

describe("deriveBuildPreview", () => {
  const base = {
    hasArtifact: false,
    isStreaming: false,
    launching: false,
    hasBuildRequest: false,
    buildStarted: false,
    ended: false,
  };

  test("a rendered artifact always shows the app, even mid-stream", () => {
    expect(deriveBuildPreview({ ...base, hasArtifact: true })).toBe("app");
    expect(
      deriveBuildPreview({ ...base, hasArtifact: true, isStreaming: true }),
    ).toBe("app");
  });

  test("an active stream shows the live card", () => {
    expect(deriveBuildPreview({ ...base, isStreaming: true })).toBe("live");
  });

  test("a launching / retrying kickoff shows the live card", () => {
    expect(deriveBuildPreview({ ...base, launching: true, hasBuildRequest: true })).toBe(
      "live",
    );
  });

  test("a freshly opened teacher build (nothing started yet) shows the live card", () => {
    expect(deriveBuildPreview({ ...base, hasBuildRequest: true })).toBe("live");
  });

  test("a teacher build that ran and stopped with no artifact settles to stopped", () => {
    // Stop / rejected fetch: no terminal SSE signal, but a stream did start.
    expect(
      deriveBuildPreview({ ...base, hasBuildRequest: true, buildStarted: true }),
    ).toBe("stopped");
    // SSE error / done with no code: a terminal signal, still no artifact.
    expect(
      deriveBuildPreview({ ...base, hasBuildRequest: true, ended: true }),
    ).toBe("stopped");
  });

  test("the stopped state is never keyed on hasBuildRequest alone", () => {
    // Opened, but nothing ran and nothing ended → still live, not stopped.
    expect(deriveBuildPreview({ ...base, hasBuildRequest: true })).toBe("live");
  });

  test("a scholar session with nothing in flight shows the empty prompt", () => {
    expect(deriveBuildPreview(base)).toBe("empty");
    // A scholar's stopped build (no kickoff) falls back to the empty prompt.
    expect(deriveBuildPreview({ ...base, buildStarted: true })).toBe("empty");
  });
});
