import { describe, expect, test } from "vitest";
import { remarkHardBreaks } from "../remarkHardBreaks";

type MdNode = { type: string; value?: string; children?: MdNode[] };

function run(tree: MdNode): MdNode {
  remarkHardBreaks()(tree);
  return tree;
}

describe("remarkHardBreaks", () => {
  test("splits a single newline in a paragraph into a break node", () => {
    const tree = run({
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "Line A\nLine B" }] },
      ],
    });
    expect(tree.children![0].children).toEqual([
      { type: "text", value: "Line A" },
      { type: "break" },
      { type: "text", value: "Line B" },
    ]);
  });

  test("handles multiple newlines (Unit / Lesson / Activity recap)", () => {
    const tree = run({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Unit\nLesson\nActivity" }],
        },
      ],
    });
    expect(tree.children![0].children).toEqual([
      { type: "text", value: "Unit" },
      { type: "break" },
      { type: "text", value: "Lesson" },
      { type: "break" },
      { type: "text", value: "Activity" },
    ]);
  });

  test("leaves text without newlines untouched", () => {
    const tree = run({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "no breaks here" }] }],
    });
    expect(tree.children![0].children).toEqual([
      { type: "text", value: "no breaks here" },
    ]);
  });

  test("never touches embedded newlines in code / inlineCode", () => {
    const tree = run({
      type: "root",
      children: [
        { type: "code", value: "const a = 1\nconst b = 2" },
        { type: "paragraph", children: [{ type: "inlineCode", value: "a\nb" }] },
      ],
    });
    expect(tree.children![0].value).toBe("const a = 1\nconst b = 2");
    expect(tree.children![1].children).toEqual([{ type: "inlineCode", value: "a\nb" }]);
  });
});
