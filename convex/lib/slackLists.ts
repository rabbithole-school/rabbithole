// Pure helpers for the Slack **Lists** API (slackLists.*) — the native
// task/table surface Slack shipped a public API for on 2025-09-02. Kept free
// of Convex/network deps so the fiddly bits (cell encoding, id parsing,
// schema extraction, display formatting) are unit-testable in isolation. The
// thin network wrappers live in slackApi.ts; the bot tools in slackTools.ts.
//
// Cell-encoding shapes are taken from the live API (verified by the reference
// justadityaraj/slack-lists-mcp against real workspaces), NOT the published
// docs, which are wrong in at least one place: **checkbox is a bare boolean,
// not an array** — the array form is rejected with `invalid_arguments`. Text
// cells must be Block Kit `rich_text` blocks (List text is always rich text);
// every other type is an array of primitives.

export type SlackListColumn = {
  /** Encoded column id (`Col…`) — this is what writes reference. */
  id: string;
  /** Legacy identifier; being deprecated in favour of the id. */
  key?: string;
  name: string;
  type: string;
  /** Present on select columns: the choosable options ({id,label}-ish). */
  options?: unknown;
};

/** The cell/field types the bot can WRITE (a subset of Slack's full set). */
export const WRITABLE_LIST_TYPES = [
  "text",
  "checkbox",
  "date",
  "number",
  "select",
  "user",
  "channel",
  "email",
  "phone",
] as const;

/**
 * Pull the `F…` List id out of a pasted List link or raw id. Slack List URLs
 * look like `https://app.slack.com/client/T…/lists/F…` (and permalinks like
 * `https://team.slack.com/lists/F…`); a List is a file, so its id starts `F`.
 * Slack often wraps URLs in `<…>` in message text — the regexes ignore that.
 */
export function parseListId(input: string): string | null {
  if (!input) return null;
  const inPath = input.match(/\/lists\/(F[A-Z0-9]+)/i);
  if (inPath) return inPath[1].toUpperCase();
  const bare = input.match(/\bF[A-Z0-9]{6,}\b/);
  return bare ? bare[0].toUpperCase() : null;
}

/** Coerce a loose truthy/falsey value to a real boolean for a checkbox cell. */
function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return !/^\s*(false|0|no|off|unchecked|)\s*$/i.test(v);
  return Boolean(v);
}

/** The Block Kit `rich_text` value a List text cell requires. */
export function richTextValue(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "rich_text",
      elements: [
        { type: "rich_text_section", elements: [{ type: "text", text }] },
      ],
    },
  ];
}

/**
 * Build ONE `slackLists.*` cell payload — `{ column_id, <type>: value }` —
 * shared by create (`initial_fields`) and update (`cells`, which then also
 * carry a `row_id`). Throws on an unsupported type so the caller surfaces a
 * clear error instead of silently dropping data.
 */
export function buildListCell(
  columnId: string,
  type: string,
  value: unknown,
): Record<string, unknown> {
  const ft = (type || "").toLowerCase();
  const arr = (v: unknown) => (Array.isArray(v) ? v : [v]);
  switch (ft) {
    case "text":
    case "rich_text": {
      const t = Array.isArray(value) ? value[0] : value;
      return { column_id: columnId, rich_text: richTextValue(String(t ?? "")) };
    }
    case "date": {
      const d = Array.isArray(value) ? value[0] : value;
      return { column_id: columnId, date: [String(d)] };
    }
    case "user":
      return { column_id: columnId, user: arr(value).map(String) };
    case "select":
      return { column_id: columnId, select: arr(value).map(String) };
    case "channel":
      return { column_id: columnId, channel: arr(value).map(String) };
    case "checkbox":
      return { column_id: columnId, checkbox: coerceBool(value) };
    case "number":
      return { column_id: columnId, number: arr(value).map((n) => Number(n)) };
    case "email":
      return { column_id: columnId, email: arr(value).map(String) };
    case "phone":
      return { column_id: columnId, phone: arr(value).map(String) };
    default:
      throw new Error(
        `Unsupported Slack List column type "${type}". Writable types: ${WRITABLE_LIST_TYPES.join(", ")}.`,
      );
  }
}

/** Extract the column schema from a `slackLists.info` response (best-effort). */
export function listSchemaColumns(info: Record<string, unknown>): SlackListColumn[] {
  const list = (info?.list ?? {}) as Record<string, unknown>;
  const meta = (list.list_metadata ?? {}) as Record<string, unknown>;
  const schema = (meta.schema ?? list.schema ?? []) as unknown[];
  if (!Array.isArray(schema)) return [];
  const cols: SlackListColumn[] = [];
  for (const raw of schema) {
    const col = raw as Record<string, unknown>;
    const id = (col.id ?? col.column_id ?? col.key) as string | undefined;
    if (!id) continue;
    cols.push({
      id: String(id),
      key: col.key != null ? String(col.key) : undefined,
      name: col.name != null ? String(col.name) : String(id),
      type: col.type != null ? String(col.type) : "unknown",
      options: col.options,
    });
  }
  return cols;
}

function richTextToPlain(blocks: unknown[]): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string") out.push(n.text);
    if (Array.isArray(n.elements)) n.elements.forEach(walk);
  };
  blocks.forEach(walk);
  return out.join("");
}

/** Render one item field cell as a short human/model-readable string. */
export function formatCellValue(field: Record<string, unknown>): string {
  if (typeof field.text === "string" && field.text) return field.text;
  if (Array.isArray(field.rich_text)) {
    const t = richTextToPlain(field.rich_text);
    if (t) return t;
  }
  if (typeof field.checkbox === "boolean") {
    return field.checkbox ? "☑ checked" : "☐ unchecked";
  }
  for (const key of [
    "select",
    "user",
    "number",
    "date",
    "email",
    "phone",
    "channel",
    "attachment",
    "timestamp",
    "rating",
  ]) {
    const v = field[key];
    if (Array.isArray(v) && v.length) return v.map(String).join(", ");
  }
  if (field.value !== undefined && field.value !== null) return String(field.value);
  return "";
}

function optionsToString(options: unknown): string {
  if (!Array.isArray(options) || options.length === 0) return "";
  const parts = options.map((o) => {
    const opt = o as Record<string, unknown>;
    const label = opt.value ?? opt.label ?? opt.name ?? "?";
    return `${String(label)}=${String(opt.id ?? "?")}`;
  });
  return `  [options: ${parts.join(", ")}]`;
}

/**
 * Format a List's columns + rows into the compact text the model reads before
 * writing. Deliberately surfaces the raw `column_id`s (writes need them) and
 * each row's record id. Resilient to an empty/absent schema (falls back to the
 * ids seen on the rows), since `slackLists.info` is known to omit some columns.
 */
export function formatListForModel(
  listId: string,
  columns: SlackListColumn[],
  items: Array<Record<string, unknown>>,
): string {
  const lines: string[] = [`Slack List ${listId}`];
  if (columns.length) {
    lines.push("Columns (column_id · type · name):");
    for (const c of columns) {
      lines.push(`- ${c.id} · ${c.type} · ${c.name}${optionsToString(c.options)}`);
    }
  }
  const colById = new Map(columns.map((c) => [c.id, c]));
  lines.push(`Rows (${items.length}):`);
  for (const item of items) {
    const id = String(item.id ?? "?");
    const fields = Array.isArray(item.fields)
      ? (item.fields as Array<Record<string, unknown>>)
      : [];
    const cells = fields
      .map((f) => {
        const colId = String(f.column_id ?? f.key ?? "?");
        const name = colById.get(colId)?.name ?? colId;
        const val = formatCellValue(f);
        return val ? `${name}: ${val}` : "";
      })
      .filter(Boolean);
    lines.push(`• [${id}] ${cells.join(" · ")}`);
  }
  return lines.join("\n");
}

/**
 * Format ONE List record (row) as model context — used when the bot is
 * @-mentioned inside a row's comment thread, where the human's comment only
 * points AT the row and the row's actual content has to be fetched separately.
 * Surfaces the row's field values by column NAME (readable) plus the raw
 * `list_id`/`record_id`/`column_id`s the write tools need, so the model can
 * both understand "this task" and act on it (tick it done, edit a cell) without
 * a second read_slack_list round-trip.
 */
export function formatRecordForModel(
  listId: string,
  columns: SlackListColumn[],
  record: Record<string, unknown>,
): string {
  const recordId = String(record.id ?? record.record_id ?? "?");
  const colById = new Map(columns.map((c) => [c.id, c]));
  const colByKey = new Map(
    columns.filter((c) => c.key).map((c) => [String(c.key), c]),
  );
  const lines: string[] = [
    `This thread is attached to a Slack List row. list_id=${listId} record_id=${recordId}`,
  ];
  const fields = Array.isArray(record.fields)
    ? (record.fields as Array<Record<string, unknown>>)
    : [];
  if (fields.length) {
    lines.push("Row fields (name · value · column_id):");
    for (const f of fields) {
      const rawId = f.column_id != null ? String(f.column_id) : undefined;
      const rawKey = f.key != null ? String(f.key) : undefined;
      const col =
        (rawId ? colById.get(rawId) : undefined) ??
        (rawKey ? colByKey.get(rawKey) : undefined);
      const colId = col?.id ?? rawId ?? rawKey ?? "?";
      const name = col?.name ?? rawKey ?? colId;
      const val = formatCellValue(f);
      lines.push(`- ${name} · ${val || "(empty)"} · ${colId}`);
    }
  }
  if (columns.length) {
    lines.push("List columns (column_id · type · name):");
    for (const c of columns) {
      lines.push(`- ${c.id} · ${c.type} · ${c.name}${optionsToString(c.options)}`);
    }
  }
  return lines.join("\n");
}
