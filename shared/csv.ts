export type CsvValue = string | number | boolean | null | undefined;

export function csvField(value: CsvValue): string {
  const text = value == null ? "" : String(value);
  const safe = /^[\t ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildCsv(rows: readonly (readonly CsvValue[])[]): string {
  return rows
    .map((row) => row.map((value) => csvField(value)).join(","))
    .join("\r\n");
}
