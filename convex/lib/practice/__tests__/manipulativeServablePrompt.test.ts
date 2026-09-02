import { describe, expect, it } from "vitest";

import { buildStoredServable, type StoredPracticeItem } from "../servable";
import { MANIPULATIVE_VERIFIER_KIND } from "../../../../lib/manipulative/practiceContract";
import type { Id } from "../../../_generated/dataModel";

// A manipulative stage renders MECHANICS only — a number line's own caption is
// "Start at 3. Drag the dot left or right." The QUESTION lives in the spec's
// `prompt` (and the row's `stem`). A row carrying neither is unanswerable, and
// because a placement probe's answer is recorded as evidence of what a scholar
// knows, serving one writes noise into the learning record. So the serve path
// fails CLOSED, the same call the bare-dots branch makes.
// Observed 2026-08-19 on the iPad canary: an integers check-in served a bare
// number line with no question. That was a RENDERER drop (NativePlacement), not
// bad data — these rows all carry a prompt — but nothing stopped a promptless
// row from being served either.

function row(over: Partial<StoredPracticeItem> = {}): StoredPracticeItem {
  return {
    _id: "item1" as Id<"practiceItems">,
    skillKey: "opposite_numbers",
    stem: "Place -1.5 on the number line.",
    answerType: "manipulative",
    answerCanonical: "",
    verifierKind: MANIPULATIVE_VERIFIER_KIND,
    manipulativeSpec: JSON.stringify({
      kind: "numberline",
      id: "ic-place-neg-1point5",
      concept: "Signed decimals on a line",
      prompt: "Place -1.5 on the number line.",
      min: -3,
      max: 3,
      tickStep: 1,
      snap: 0.5,
      start: 2,
      goal: { type: "placeAt", value: -1.5 },
    }),
    ...over,
  };
}

const node = { label: "Opposite numbers", domain: "integers-coordinates" };

describe("buildStoredServable — a manipulative must carry its question", () => {
  it("serves a well-formed manipulative with its stem and client spec", () => {
    const item = buildStoredServable("gen#item1", row(), node, "integers-coordinates");
    expect(item).not.toBeNull();
    expect(item!.prompt.stem).toBe("Place -1.5 on the number line.");
    expect(item!.prompt.manipulativeSpec).toBeTruthy();
    // The client copy keeps the prompt — it is the only place the question is
    // shown once a surface hides the stem card for a manipulative.
    expect(JSON.parse(item!.prompt.manipulativeSpec!).prompt).toBe(
      "Place -1.5 on the number line.",
    );
  });

  it("EXCLUDES a manipulative whose spec has an empty prompt", () => {
    const spec = JSON.parse(row().manipulativeSpec!);
    spec.prompt = "   ";
    expect(
      buildStoredServable(
        "gen#item1",
        row({ manipulativeSpec: JSON.stringify(spec) }),
        node,
        "integers-coordinates",
      ),
    ).toBeNull();
  });

  it("EXCLUDES a manipulative whose spec omits the prompt entirely", () => {
    const spec = JSON.parse(row().manipulativeSpec!);
    delete spec.prompt;
    expect(
      buildStoredServable(
        "gen#item1",
        row({ manipulativeSpec: JSON.stringify(spec) }),
        node,
        "integers-coordinates",
      ),
    ).toBeNull();
  });

  it("EXCLUDES a manipulative whose spec is unparseable AND whose stem is blank", () => {
    expect(
      buildStoredServable(
        "gen#item1",
        row({ manipulativeSpec: "{not json", stem: "" }),
        node,
        "integers-coordinates",
      ),
    ).toBeNull();
  });

  it("still serves an unparseable spec that has a real stem (degrades to text)", () => {
    const item = buildStoredServable(
      "gen#item1",
      row({ manipulativeSpec: "{not json" }),
      node,
      "integers-coordinates",
    );
    expect(item).not.toBeNull();
    expect(item!.prompt.stem).toBe("Place -1.5 on the number line.");
  });
});
