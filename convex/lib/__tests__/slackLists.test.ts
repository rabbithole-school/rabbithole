import { describe, expect, test } from "vitest";
import {
  parseListId,
  buildListCell,
  richTextValue,
  listSchemaColumns,
  formatCellValue,
  formatListForModel,
  formatRecordForModel,
} from "../slackLists";

// ── parseListId ──────────────────────────────────────────────────────────
describe("parseListId", () => {
  test("extracts F… from a full List link", () => {
    expect(
      parseListId("https://app.slack.com/client/T012ABCDE/lists/F09ABC123XYZ"),
    ).toBe("F09ABC123XYZ");
  });

  test("extracts from a permalink and ignores angle-bracket wrapping", () => {
    expect(parseListId("<https://example.slack.com/lists/F09ABC123XYZ>")).toBe(
      "F09ABC123XYZ",
    );
  });

  test("accepts a bare list id and upcases path matches", () => {
    expect(parseListId("F09ABC123XYZ")).toBe("F09ABC123XYZ");
    expect(
      parseListId("https://app.slack.com/client/T1/lists/f09abc123xyz"),
    ).toBe("F09ABC123XYZ");
  });

  test("returns null when there is no list id", () => {
    expect(parseListId("just some text")).toBeNull();
    expect(parseListId("")).toBeNull();
  });
});

// ── buildListCell — exact API payload shapes ─────────────────────────────
describe("buildListCell", () => {
  test("text → Block Kit rich_text block", () => {
    expect(buildListCell("Col1", "text", "Fix the pump")).toEqual({
      column_id: "Col1",
      rich_text: richTextValue("Fix the pump"),
    });
    // rich_text shape is what Slack requires (section > text element)
    expect(buildListCell("Col1", "text", "hi").rich_text).toEqual([
      {
        type: "rich_text",
        elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "hi" }] },
        ],
      },
    ]);
  });

  test("checkbox → BARE boolean, never an array (the critical gotcha)", () => {
    expect(buildListCell("Col2", "checkbox", true)).toEqual({
      column_id: "Col2",
      checkbox: true,
    });
    // loose truthy/falsey coercion
    expect(buildListCell("Col2", "checkbox", "false").checkbox).toBe(false);
    expect(buildListCell("Col2", "checkbox", "0").checkbox).toBe(false);
    expect(buildListCell("Col2", "checkbox", "").checkbox).toBe(false);
    expect(buildListCell("Col2", "checkbox", "yes").checkbox).toBe(true);
    expect(buildListCell("Col2", "checkbox", 1).checkbox).toBe(true);
  });

  test("date → array of YYYY-MM-DD strings", () => {
    expect(buildListCell("Col3", "date", "2026-07-01")).toEqual({
      column_id: "Col3",
      date: ["2026-07-01"],
    });
  });

  test("number → array of numbers (coerced)", () => {
    expect(buildListCell("Col4", "number", "42")).toEqual({
      column_id: "Col4",
      number: [42],
    });
    expect(buildListCell("Col4", "number", [1, 2])).toEqual({
      column_id: "Col4",
      number: [1, 2],
    });
  });

  test("select/user/channel → arrays of string ids (scalar wrapped)", () => {
    expect(buildListCell("Col5", "select", "Opt7")).toEqual({
      column_id: "Col5",
      select: ["Opt7"],
    });
    expect(buildListCell("Col6", "user", ["U1", "U2"])).toEqual({
      column_id: "Col6",
      user: ["U1", "U2"],
    });
    expect(buildListCell("Col7", "channel", "C9")).toEqual({
      column_id: "Col7",
      channel: ["C9"],
    });
  });

  test("email/phone → arrays", () => {
    expect(buildListCell("Col8", "email", "a@b.co").email).toEqual(["a@b.co"]);
    expect(buildListCell("Col9", "phone", "555").phone).toEqual(["555"]);
  });

  test("unknown type throws with a helpful message", () => {
    expect(() => buildListCell("Col1", "wormhole", "x")).toThrow(/Unsupported/);
  });
});

// ── listSchemaColumns ────────────────────────────────────────────────────
describe("listSchemaColumns", () => {
  test("reads columns from list.list_metadata.schema", () => {
    const info = {
      ok: true,
      list: {
        id: "F1",
        list_metadata: {
          schema: [
            { id: "Col1", key: "name", name: "Task", type: "text" },
            { id: "Col2", name: "Done", type: "checkbox" },
          ],
        },
      },
    };
    expect(listSchemaColumns(info)).toEqual([
      { id: "Col1", key: "name", name: "Task", type: "text", options: undefined },
      { id: "Col2", key: undefined, name: "Done", type: "checkbox", options: undefined },
    ]);
  });

  test("tolerates a missing/empty schema", () => {
    expect(listSchemaColumns({ ok: true })).toEqual([]);
    expect(listSchemaColumns({ ok: true, list: {} })).toEqual([]);
  });
});

// ── formatCellValue / formatListForModel ─────────────────────────────────
describe("formatting for the model", () => {
  test("formatCellValue handles text, rich_text, checkbox, and arrays", () => {
    expect(formatCellValue({ column_id: "C", text: "hello" })).toBe("hello");
    expect(
      formatCellValue({ column_id: "C", rich_text: richTextValue("world") }),
    ).toBe("world");
    expect(formatCellValue({ column_id: "C", checkbox: true })).toBe("☑ checked");
    expect(formatCellValue({ column_id: "C", checkbox: false })).toBe(
      "☐ unchecked",
    );
    expect(formatCellValue({ column_id: "C", select: ["Opt1", "Opt2"] })).toBe(
      "Opt1, Opt2",
    );
  });

  test("formatListForModel surfaces column ids + row record ids", () => {
    const columns = listSchemaColumns({
      list: {
        list_metadata: {
          schema: [
            { id: "Col1", name: "Task", type: "text" },
            { id: "Col2", name: "Done", type: "checkbox" },
          ],
        },
      },
    });
    const items = [
      {
        id: "Rec111",
        fields: [
          { column_id: "Col1", text: "Prep tank" },
          { column_id: "Col2", checkbox: false },
        ],
      },
    ];
    const out = formatListForModel("F1", columns, items);
    expect(out).toContain("Slack List F1");
    expect(out).toContain("Col1 · text · Task");
    expect(out).toContain("[Rec111]");
    expect(out).toContain("Task: Prep tank");
    expect(out).toContain("Done: ☐ unchecked");
  });

  test("formatListForModel falls back to column ids when schema is empty", () => {
    const out = formatListForModel("F1", [], [
      { id: "Rec1", fields: [{ column_id: "Col1", text: "x" }] },
    ]);
    expect(out).toContain("Col1: x");
    expect(out).toContain("Rows (1)");
  });

  test("formatRecordForModel renders one row's fields + the ids to edit it", () => {
    const columns = listSchemaColumns({
      list: {
        list_metadata: {
          schema: [
            { id: "Col0", key: "name", name: "Name", type: "text" },
            { id: "Col00", key: "todo_completed", name: "Completed", type: "checkbox" },
          ],
        },
      },
    });
    // The primary text field arrives keyed by `key` (no column_id on the row) —
    // the schema is what supplies its Col… id, which the writer needs.
    const record = {
      id: "Rec0BJFK630F9",
      fields: [
        { key: "name", text: "write me a poem about dogs" },
        { key: "todo_completed", checkbox: false, column_id: "Col00" },
      ],
    };
    const out = formatRecordForModel("F0BJFK5T9HD", columns, record);
    expect(out).toContain("list_id=F0BJFK5T9HD");
    expect(out).toContain("record_id=Rec0BJFK630F9");
    // Field value rendered by column NAME, with the Col… id resolved via key.
    expect(out).toContain("Name · write me a poem about dogs · Col0");
    expect(out).toContain("Completed · ☐ unchecked · Col00");
    // The full column list (for writes) is present too.
    expect(out).toContain("Col0 · text · Name");
  });

  test("formatRecordForModel works with no schema (ids fall back to raw)", () => {
    const out = formatRecordForModel("F1", [], {
      id: "Rec9",
      fields: [{ key: "name", text: "hello" }],
    });
    expect(out).toContain("record_id=Rec9");
    expect(out).toContain("hello");
  });
});
