import { describe, expect, it } from "vitest";
import type { MasteryState } from "@/components/KnowledgeNodeDial";
import { isDomainComplete } from "./serving";

// The old serving/access vocabulary (`resolveServingState`, primary/secondary/
// not-serving, domainFocus rows) was removed with the retired hard-serving
// control-plane cutover — see serving.tsx's top-of-file comment.
// `isDomainComplete` is the only surviving export and is a pure
// mastery-derived signal.

const reading = (mastery: MasteryState) => ({ mastery });

describe("isDomainComplete", () => {
  it("is false for an empty (unread) domain so partial coverage is never Complete", () => {
    expect(isDomainComplete([])).toBe(false);
  });

  it("is true only when every reading is placed-out or mastered", () => {
    expect(
      isDomainComplete([reading("placed"), reading("fluent"), reading("overlearned")]),
    ).toBe(true);
  });

  it("is false when any skill still sits at locked or frontier", () => {
    expect(isDomainComplete([reading("overlearned"), reading("frontier")])).toBe(
      false,
    );
    expect(isDomainComplete([reading("fluent"), reading("locked")])).toBe(false);
  });
});
