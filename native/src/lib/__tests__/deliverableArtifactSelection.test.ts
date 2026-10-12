import { describe, expect, it } from "vitest";

import {
  artifactIdForDeliverableLookup,
  artifactMatchesDeliverableKind,
  dedicatedDeliverableArtifact,
  nextAutoSelect,
  pickDefaultArtifact,
  type SelectableArtifact,
  workSurfaceFor,
} from "../deliverableArtifactSelection";

// Small factory so tests read as (id, createdAt, type).
function artifact(
  id: string,
  creationTime: number,
  type?: string,
): SelectableArtifact {
  return { _id: id, _creationTime: creationTime, type };
}

describe("pickDefaultArtifact", () => {
  it("returns null when there are no artifacts", () => {
    expect(pickDefaultArtifact([], "text")).toBeNull();
  });

  it("returns the only artifact regardless of kind", () => {
    const only = artifact("a", 1, "code");
    expect(pickDefaultArtifact([only], "text")).toBe(only);
  });

  it("keeps the text doc when a later code artifact appears in a text deliverable", () => {
    const memoir = artifact("memoir", 100, "text");
    const counter = artifact("counter", 200, "code");
    // Order shuffled to prove the rule does not depend on input order.
    expect(pickDefaultArtifact([counter, memoir], "text")).toBe(memoir);
  });

  it("treats a legacy untyped artifact as matching a text deliverable", () => {
    const legacy = artifact("legacy", 100, undefined);
    const counter = artifact("counter", 200, "code");
    expect(pickDefaultArtifact([legacy, counter], "text")).toBe(legacy);
  });

  it("picks the code artifact for a code (artifact) deliverable", () => {
    const memoir = artifact("memoir", 100, "text");
    const counter = artifact("counter", 200, "code");
    expect(pickDefaultArtifact([memoir, counter], "artifact")).toBe(counter);
  });

  it("falls back to the newest artifact when nothing matches the kind", () => {
    const first = artifact("first", 100, "code");
    const second = artifact("second", 200, "code");
    // A text deliverable but only code artifacts exist → newest code artifact.
    expect(pickDefaultArtifact([first, second], "text")).toBe(second);
  });

  it("returns the earliest-created when two artifacts match the kind", () => {
    const early = artifact("early", 100, "text");
    const late = artifact("late", 200, "text");
    expect(pickDefaultArtifact([late, early], "text")).toBe(early);
  });
});

describe("artifactMatchesDeliverableKind", () => {
  it("matches text and untyped artifacts to a text deliverable", () => {
    expect(artifactMatchesDeliverableKind("text", "text")).toBe(true);
    expect(artifactMatchesDeliverableKind(undefined, "text")).toBe(true);
    expect(artifactMatchesDeliverableKind("code", "text")).toBe(false);
  });

  it("matches only code artifacts to an artifact (code) deliverable", () => {
    expect(artifactMatchesDeliverableKind("code", "artifact")).toBe(true);
    expect(artifactMatchesDeliverableKind("text", "artifact")).toBe(false);
    expect(artifactMatchesDeliverableKind(undefined, "artifact")).toBe(false);
  });

  it("matches nothing for kinds without a text-editable artifact", () => {
    expect(artifactMatchesDeliverableKind("text", "photo")).toBe(false);
    expect(artifactMatchesDeliverableKind("code", "map")).toBe(false);
    expect(artifactMatchesDeliverableKind(undefined, null)).toBe(false);
  });
});

describe("artifactIdForDeliverableLookup", () => {
  // The bug: a photo submits with no artifactId, so scoping its lookup to
  // whatever document happens to be open hides it entirely.
  it("does not scope a photo lookup to a document", () => {
    expect(artifactIdForDeliverableLookup("text-artifact", "photo")).toBeUndefined();
  });

  // `audio` has no capture surface, and the generic rubric path writes an
  // artifact-scoped row for it — so it must stay scoped despite the name
  // suggesting a file-backed kind.
  it("keeps every artifact-backed kind scoped to the artifact it is given", () => {
    for (const kind of ["text", "artifact", "map", "slides", "audio"] as const) {
      expect(artifactIdForDeliverableLookup("open-artifact", kind)).toBe(
        "open-artifact",
      );
    }
  });

  it("stays scoped while the activity (and so the kind) is still loading", () => {
    expect(artifactIdForDeliverableLookup("open-artifact", null)).toBe("open-artifact");
    expect(artifactIdForDeliverableLookup("open-artifact", undefined)).toBe(
      "open-artifact",
    );
  });

  it("returns undefined when there is no artifact to scope to", () => {
    expect(artifactIdForDeliverableLookup(null, "text")).toBeUndefined();
    expect(artifactIdForDeliverableLookup(undefined, "text")).toBeUndefined();
    expect(artifactIdForDeliverableLookup(null, "photo")).toBeUndefined();
  });
});

describe("dedicatedDeliverableArtifact", () => {
  it("scopes a slides deliverable to the deck, not a side text document (TRA-339 repro)", () => {
    const deck = artifact("deck", 100, "slides");
    const notes = artifact("notes", 200, "text");
    const deckOrNull = dedicatedDeliverableArtifact([notes, deck], "slides");
    expect(deckOrNull).toBe(deck);
    expect(artifactIdForDeliverableLookup(deckOrNull?._id, "slides")).toBe("deck");
  });

  it("picks the earliest deck, matching the server's resolveScorableArtifactId", () => {
    const first = artifact("first", 100, "slides");
    const second = artifact("second", 300, "slides");
    expect(dedicatedDeliverableArtifact([second, first], "slides")).toBe(first);
  });

  it("returns null (not a document) for a slides deliverable with no deck yet", () => {
    expect(
      dedicatedDeliverableArtifact([artifact("notes", 100, "text")], "slides"),
    ).toBeNull();
  });

  it("resolves the map for a map deliverable", () => {
    const map = artifact("map", 200, "map");
    expect(
      dedicatedDeliverableArtifact([artifact("notes", 100, "text"), map], "map"),
    ).toBe(map);
  });

  it("defers (undefined) for kinds without a dedicated artifact type", () => {
    const artifacts = [artifact("deck", 100, "slides")];
    for (const kind of ["text", "artifact", "photo", "audio", null, undefined] as const) {
      expect(dedicatedDeliverableArtifact(artifacts, kind)).toBeUndefined();
    }
  });
});

describe("nextAutoSelect", () => {
  // (1) An initial empty snapshot (undefined → [] while the query loads) must
  //     NOT establish the baseline — otherwise the first real artifact looks new.
  it("does not establish a baseline from an empty snapshot", () => {
    const result = nextAutoSelect({
      seenIds: [],
      ids: [],
      baselineEstablished: false,
    });
    expect(result.baselineEstablished).toBe(false);
    expect(result.select).toBeUndefined();
    expect(result.seenIds).toEqual([]);
  });

  it("establishes the baseline from the first non-empty snapshot without selecting", () => {
    const result = nextAutoSelect({
      seenIds: [],
      ids: ["a", "b"],
      baselineEstablished: false,
    });
    expect(result.baselineEstablished).toBe(true);
    expect(result.select).toBeUndefined();
    expect(result.seenIds).toEqual(["a", "b"]);
  });

  // (2) Seen ids are monotonic: a snapshot that drops an id keeps it seen, so it
  //     is never re-selected when it returns.
  it("keeps seen ids monotonic when a snapshot omits some", () => {
    const dropped = nextAutoSelect({
      seenIds: ["a", "b"],
      ids: ["a"],
      baselineEstablished: true,
    });
    expect(dropped.select).toBeUndefined();
    expect(dropped.seenIds).toEqual(["a", "b"]);

    const returned = nextAutoSelect({
      seenIds: dropped.seenIds,
      ids: ["a", "b"],
      baselineEstablished: true,
    });
    expect(returned.select).toBeUndefined();
    expect(returned.seenIds).toEqual(["a", "b"]);
  });

  // (3) A transient empty snapshot followed by the same ids selects nothing.
  it("selects nothing after a transient empty snapshot returns the same ids", () => {
    const emptied = nextAutoSelect({
      seenIds: ["a", "b"],
      ids: [],
      baselineEstablished: true,
    });
    expect(emptied.select).toBeUndefined();
    expect(emptied.seenIds).toEqual(["a", "b"]);

    const restored = nextAutoSelect({
      seenIds: emptied.seenIds,
      ids: ["a", "b"],
      baselineEstablished: true,
    });
    expect(restored.select).toBeUndefined();
  });

  // (4) One genuine addition selects that id (the last, if several arrive).
  it("selects a genuinely-new id", () => {
    const result = nextAutoSelect({
      seenIds: ["a"],
      ids: ["a", "c"],
      baselineEstablished: true,
    });
    expect(result.select).toBe("c");
    expect(result.seenIds).toEqual(["a", "c"]);
  });

  it("selects the last of several new ids arriving at once", () => {
    const result = nextAutoSelect({
      seenIds: ["a"],
      ids: ["a", "c", "d"],
      baselineEstablished: true,
    });
    expect(result.select).toBe("d");
    expect(result.seenIds).toEqual(["a", "c", "d"]);
  });

  // (5) A scholar-created artifact (whose id the caller already selected in
  //     handleCreateArtifact) is registered as seen but not re-selected on the
  //     next identical render — no double-handling.
  it("does not re-select an id it already recorded", () => {
    const created = nextAutoSelect({
      seenIds: ["a"],
      ids: ["a", "c"],
      baselineEstablished: true,
    });
    expect(created.select).toBe("c");

    const rerender = nextAutoSelect({
      seenIds: created.seenIds,
      ids: ["a", "c"],
      baselineEstablished: true,
    });
    expect(rerender.select).toBeUndefined();
    expect(rerender.seenIds).toEqual(["a", "c"]);
  });
});

describe("workSurfaceFor (TRA-463)", () => {
  const textDeliverable = { deliverable: { kind: "text" } };
  const noDeliverable = { deliverable: undefined };

  it("shows a tutor-made document in an open exploration with no activity", () => {
    expect(
      workSurfaceFor({ hasActivity: false, activity: undefined, textArtifactCount: 1 }),
    ).toBe("documents");
  });

  it("shows documents for an activity that asks for no deliverable", () => {
    expect(
      workSurfaceFor({ hasActivity: true, activity: noDeliverable, textArtifactCount: 2 }),
    ).toBe("documents");
  });

  it("renders nothing for a no-activity session with no documents (no empty panel)", () => {
    expect(
      workSurfaceFor({ hasActivity: false, activity: undefined, textArtifactCount: 0 }),
    ).toBe("none");
  });

  it("renders nothing, not a skeleton, while a no-activity session's artifacts load", () => {
    expect(
      workSurfaceFor({ hasActivity: false, activity: undefined, textArtifactCount: undefined }),
    ).toBe("none");
  });

  it("keeps the full deliverable surface even before any document exists", () => {
    expect(
      workSurfaceFor({ hasActivity: true, activity: textDeliverable, textArtifactCount: 0 }),
    ).toBe("deliverable");
  });

  it("waits on an unloaded activity rather than guessing documents mode", () => {
    // A deliverable activity must never flash the stripped-down documents view
    // (no prompt, no check) while its activity row is still in flight.
    expect(
      workSurfaceFor({ hasActivity: true, activity: undefined, textArtifactCount: 1 }),
    ).toBe("loading");
  });

  it("falls back to documents when the session's activity was deleted", () => {
    expect(
      workSurfaceFor({ hasActivity: true, activity: null, textArtifactCount: 1 }),
    ).toBe("documents");
  });
});
