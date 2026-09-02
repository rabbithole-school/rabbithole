import { describe, expect, test } from "vitest";
import {
  coalesceToolActivity,
  splitStreamSegments,
  shouldShowStreamingTail,
  toScholarSafeGroup,
  isFailureResult,
  isScholarHiddenToolResult,
  SCHOLAR_TOOL_FAILURE_MARKER,
  type ToolActivity,
  type ThinkingActivity,
  type ToolGroup,
  type StreamSegment,
} from "../toolActivityGroups";

const running = (name: string): ToolActivity => ({ name, status: "running" });
const done = (name: string, result?: string): ToolActivity => ({
  name,
  status: "complete",
  result,
});

describe("coalesceToolActivity", () => {
  test("empty log → no groups", () => {
    expect(coalesceToolActivity([])).toEqual([]);
  });

  test("single call → one group of count 1", () => {
    const groups = coalesceToolActivity([done("update_unit", "Unit updated")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: "update_unit",
      status: "complete",
      items: [{ result: "Unit updated" }],
    });
  });

  test("3 consecutive same-type → one group of count 3, results preserved in order", () => {
    const groups = coalesceToolActivity([
      done("create_activity", 'Added "A"'),
      done("create_activity", 'Added "B"'),
      done("create_activity", 'Added "C"'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("create_activity");
    expect(groups[0].status).toBe("complete");
    expect(groups[0].items.map((i) => i.result)).toEqual([
      'Added "A"',
      'Added "B"',
      'Added "C"',
    ]);
  });

  test("A,A,B,A → groups [A×2, B×1, A×1] (consecutive only — trailing A is its own group)", () => {
    const groups = coalesceToolActivity([
      done("create_lesson", "L1"),
      done("create_lesson", "L2"),
      done("update_unit", "Unit updated"),
      done("create_lesson", "L3"),
    ]);
    expect(groups.map((g) => g.name)).toEqual([
      "create_lesson",
      "update_unit",
      "create_lesson",
    ]);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 1]);
  });

  test("a running tail keeps the group's status running while count climbs", () => {
    const groups = coalesceToolActivity([
      done("create_activity", 'Added "A"'),
      done("create_activity", 'Added "B"'),
      running("create_activity"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("running");
    expect(groups[0].items).toHaveLength(3);
  });

  test("completed group followed by a fresh running tool → two groups", () => {
    const groups = coalesceToolActivity([
      done("create_lesson", "L1"),
      done("create_lesson", "L2"),
      running("create_activity"),
    ]);
    expect(groups.map((g) => g.name)).toEqual([
      "create_lesson",
      "create_activity",
    ]);
    expect(groups[0].status).toBe("complete");
    expect(groups[1].status).toBe("running");
  });
});

const at = (
  name: string,
  textOffset: number,
  result?: string,
): ToolActivity => ({ name, status: "complete", result, textOffset });

describe("splitStreamSegments", () => {
  test("no tools → single text segment", () => {
    expect(splitStreamSegments("hello world", [])).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  test("empty content + no tools → no segments", () => {
    expect(splitStreamSegments("", [])).toEqual([]);
  });

  test("text → tool → text places the tool inline at its offset", () => {
    const content = "Let me look that up.\n\nHere is what I found.";
    const offset = "Let me look that up.".length;
    const segs = splitStreamSegments(content, [at("search", offset, "ok")]);
    expect(segs).toEqual([
      { kind: "text", text: "Let me look that up." },
      {
        kind: "tools",
        group: { name: "search", status: "complete", items: [{ result: "ok" }] },
      },
      { kind: "text", text: "\n\nHere is what I found." },
    ]);
  });

  test("a tool before any text → tool group leads, then the text", () => {
    const segs = splitStreamSegments("done now", [at("update_unit", 0)]);
    expect(segs[0]).toMatchObject({ kind: "tools" });
    expect(segs[1]).toEqual({ kind: "text", text: "done now" });
  });

  test("consecutive same-name tools at one offset coalesce into one group", () => {
    const segs = splitStreamSegments("intro", [
      at("create_lesson", 5, "L1"),
      at("create_lesson", 5, "L2"),
      at("create_lesson", 5, "L3"),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ kind: "text", text: "intro" });
    expect(segs[1]).toMatchObject({ kind: "tools" });
    if (segs[1].kind === "tools") {
      expect(segs[1].group.items).toHaveLength(3);
    }
  });

  test("same-name tools separated by text do NOT coalesce (own groups, inline)", () => {
    const content = "aaaa\n\nbbbb";
    const segs = splitStreamSegments(content, [
      at("note", 4, "first"),
      at("note", content.length, "second"),
    ]);
    const tools = segs.filter((s) => s.kind === "tools");
    expect(tools).toHaveLength(2);
    // text before each tool is preserved in order
    expect(segs[0]).toEqual({ kind: "text", text: "aaaa" });
  });

  test("missing offset degrades to the end (tool after all text)", () => {
    const segs = splitStreamSegments("some text", [
      { name: "legacy", status: "complete" },
    ]);
    expect(segs[0]).toEqual({ kind: "text", text: "some text" });
    expect(segs[1]).toMatchObject({ kind: "tools" });
  });

  test("a trailing running tool with no following text ends the segments", () => {
    const segs = splitStreamSegments("working on it", [
      { name: "build", status: "running", textOffset: "working on it".length },
    ]);
    expect(segs[0]).toEqual({ kind: "text", text: "working on it" });
    expect(segs[1]).toMatchObject({ kind: "tools" });
    if (segs[1].kind === "tools") {
      expect(segs[1].group.status).toBe("running");
    }
  });

  test("offsets are clamped monotonic (out-of-order offset never slices backward)", () => {
    const content = "0123456789";
    const segs = splitStreamSegments(content, [
      at("a", 6),
      at("b", 2), // earlier than the cursor — must not emit negative/overlapping text
    ]);
    const texts = segs.filter((s) => s.kind === "text");
    // first text is the prefix up to offset 6, remainder after
    expect(texts[0]).toEqual({ kind: "text", text: "012345" });
    expect(segs.filter((s) => s.kind === "tools")).toHaveLength(2);
  });
});

describe("splitStreamSegments — thinking interleaving", () => {
  const think = (
    text: string,
    textOffset: number,
    done = true,
  ): ThinkingActivity => ({ text, textOffset, done });

  test("a thinking block before any text/tool leads the turn", () => {
    const segs = splitStreamSegments("the answer is 42", [], [
      think("let me reason about this", 0),
    ]);
    expect(segs[0]).toEqual({ kind: "thinking", text: "let me reason about this", done: true });
    expect(segs[1]).toEqual({ kind: "text", text: "the answer is 42" });
  });

  test("thinking → text → thinking is placed inline at each offset", () => {
    const content = "First point.\n\nSecond point.";
    const segs = splitStreamSegments(content, [], [
      think("plan the intro", 0),
      think("now the follow-up", "First point.".length),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["thinking", "text", "thinking", "text"]);
  });

  test("thinking blocks never coalesce (each stays its own segment)", () => {
    const segs = splitStreamSegments("", [], [
      think("a", 0),
      think("b", 0),
    ]);
    expect(segs).toEqual([
      { kind: "thinking", text: "a", done: true },
      { kind: "thinking", text: "b", done: true },
    ]);
  });

  test("thinking precedes a tool at the same offset (reasons, then acts)", () => {
    const segs = splitStreamSegments("", [{ name: "build", status: "complete", textOffset: 0, result: "ok" }], [
      think("decide to build", 0),
    ]);
    expect(segs[0]).toMatchObject({ kind: "thinking" });
    expect(segs[1]).toMatchObject({ kind: "tools" });
  });

  test("sequence preserves tool → thinking → tool chronology at one offset", () => {
    const segs = splitStreamSegments(
      "Hello",
      [
        {
          name: "first",
          status: "complete",
          textOffset: 5,
          sequence: 1,
        },
        {
          name: "second",
          status: "running",
          textOffset: 5,
          sequence: 3,
        },
      ],
      [
        {
          text: "Reason between actions.",
          textOffset: 5,
          sequence: 2,
          done: false,
        },
      ],
    );

    expect(segs.map((segment) => segment.kind)).toEqual([
      "text",
      "tools",
      "thinking",
      "tools",
    ]);
  });

  test("an in-progress thinking block preserves done:false", () => {
    const segs = splitStreamSegments("", [], [think("still thinking…", 0, false)]);
    expect(segs[0]).toEqual({ kind: "thinking", text: "still thinking…", done: false });
  });

  test("two-arg calls are byte-identical (no thinking arg → no thinking segments)", () => {
    const content = "intro\n\nbody";
    const activity: ToolActivity[] = [{ name: "note", status: "complete", textOffset: 5, result: "r" }];
    expect(splitStreamSegments(content, activity)).toEqual(
      splitStreamSegments(content, activity, []),
    );
  });
});

describe("shouldShowStreamingTail", () => {
  const textSeg = (text: string): StreamSegment => ({ kind: "text", text });
  const toolSeg = (status: "running" | "complete"): StreamSegment => ({
    kind: "tools",
    group: { name: "build", status, items: [{}] },
  });
  const thinkSeg = (done: boolean): StreamSegment => ({ kind: "thinking", text: "…", done });

  test("not streaming → never show the tail", () => {
    expect(shouldShowStreamingTail(false, [])).toBe(false);
    expect(shouldShowStreamingTail(false, [textSeg("hi")])).toBe(false);
  });

  test("streaming with empty segments → show (nothing else is animating)", () => {
    expect(shouldShowStreamingTail(true, [])).toBe(true);
  });

  test("trailing running tool already animates → suppress the tail", () => {
    expect(shouldShowStreamingTail(true, [textSeg("x"), toolSeg("running")])).toBe(false);
  });

  test("trailing in-progress thinking already animates → suppress the tail", () => {
    expect(shouldShowStreamingTail(true, [thinkSeg(false)])).toBe(false);
  });

  test("GAP: trailing COMPLETED tool → show the tail (post-tool pause)", () => {
    expect(shouldShowStreamingTail(true, [toolSeg("complete")])).toBe(true);
  });

  test("GAP: trailing text (paused mid-turn / pre-tool / awaiting done) → show", () => {
    expect(shouldShowStreamingTail(true, [textSeg("some text so far")])).toBe(true);
  });

  test("GAP: trailing finished thinking block → show (about to act/write)", () => {
    expect(shouldShowStreamingTail(true, [thinkSeg(true)])).toBe(true);
  });
});

describe("scholar-safe failure redaction", () => {
  const group = (
    name: string,
    items: { result?: string }[],
    status: "running" | "complete" = "complete",
  ): ToolGroup => ({ name, status, items });

  test("isFailureResult flags the 'Failed:' / 'Error:' convention", () => {
    expect(isFailureResult("Failed: Pass artifact_id to score the document rubric.")).toBe(true);
    expect(isFailureResult("Error: boom")).toBe(true);
    expect(isFailureResult("  failed: lowercased + padded")).toBe(true);
    // Non-failures are left alone.
    expect(isFailureResult("Awarded flair: Strong opening")).toBe(false);
    expect(isFailureResult("Recorded 3 verdicts · overall full")).toBe(false);
    expect(isFailureResult(undefined)).toBe(false);
    expect(isFailureResult("")).toBe(false);
  });

  test("a raw tool-failure result is swapped for the hidden marker", () => {
    const safe = toScholarSafeGroup(
      group("update_rubric_score", [
        { result: "Failed: Pass artifact_id to score the document rubric." },
      ]),
    );
    expect(safe.items).toEqual([{ result: SCHOLAR_TOOL_FAILURE_MARKER }]);
    expect(isScholarHiddenToolResult(safe.items[0].result)).toBe(true);
    expect(SCHOLAR_TOOL_FAILURE_MARKER).not.toMatch(/didn't work|try again|failed|error/i);
    // The raw developer string never survives into scholar-facing data.
    expect(JSON.stringify(safe)).not.toContain("artifact_id");
  });

  test("non-failure results are untouched (success still reads normally)", () => {
    const g = group("update_rubric_score", [
      { result: "Awarded flair: Strong opening" },
    ]);
    const safe = toScholarSafeGroup(g);
    expect(safe).toBe(g); // same reference — nothing needed redacting
  });

  test("mixed group only redacts the failing calls", () => {
    const safe = toScholarSafeGroup(
      group("edit_document", [
        { result: "Document created" },
        { result: "Failed: old_str not found" },
        { result: "Text inserted" },
      ]),
    );
    expect(safe.items).toEqual([
      { result: "Document created" },
      { result: SCHOLAR_TOOL_FAILURE_MARKER },
      { result: "Text inserted" },
    ]);
  });
});
