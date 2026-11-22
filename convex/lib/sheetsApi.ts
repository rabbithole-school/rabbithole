// A small Google Sheets client for agent tools that act AS a Rabbithole user
// (lib/sheetsTools.ts). Convex-free, with injected fetch, so it tests without a
// network. Every call carries the asker's own Google access token, so Google
// enforces exactly what that person may see and edit.
//
// Scopes, as Google applies them: reading works with `drive.readonly` (which
// the personal link already holds); creating a spreadsheet works with
// `drive.file`, and so does writing to one this app created; writing to any
// other spreadsheet needs `spreadsheets`, which a person grants through the
// "sheets" consent purpose (lib/google.ts). A write without it comes back as
// `SheetsError` kind "scope", which the tool turns into a one-click fix.

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * "scope": the token lacks a permission the call needs. "not_found": Google
 * returns 404 for a sheet the person can't see, too. "disabled": the Sheets
 * API is off in Rabbithole's Google Cloud project, which only an admin can
 * fix. "other": anything else, with Google's message.
 */
export class SheetsError extends Error {
  constructor(
    readonly kind: "scope" | "not_found" | "disabled" | "other",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SheetsError";
  }
}

export type SheetTab = { title: string; sheetId: number; rows: number; columns: number };
export type SpreadsheetInfo = { id: string; title: string; url: string; tabs: SheetTab[] };

/** A spreadsheet id from a Sheets link, or a bare id. */
export function spreadsheetIdFrom(value: string): string | null {
  const text = value.trim();
  const fromLink = text.match(/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/);
  if (fromLink) return fromLink[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(text) ? text : null;
}

/** A tab name quoted for an A1 range: 'Q3 Budget'!A1. */
export function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** 1 → A, 27 → AA. */
export function columnLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export class SheetsApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch,
  ) {}

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; status?: string; details?: { reason?: string }[] };
    } | null;
    const message = body?.error?.message ?? `Google Sheets returned ${res.status}`;
    const reason = body?.error?.details?.map((d) => d.reason).join(" ") ?? "";
    if (res.status === 403 && /SERVICE_DISABLED|has not been used in project|API .* is disabled/i.test(`${message} ${reason}`)) {
      throw new SheetsError("disabled", res.status, message);
    }
    if (res.status === 403 && /scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(`${message} ${reason}`)) {
      throw new SheetsError("scope", res.status, message);
    }
    if (res.status === 404) throw new SheetsError("not_found", res.status, message);
    throw new SheetsError("other", res.status, message);
  }

  /** Whether the asker owns this file. A Drive read, so it works on the link people already have. */
  async ownedByMe(id: string): Promise<boolean> {
    const body = await this.call<{ ownedByMe?: boolean }>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=ownedByMe&supportsAllDrives=true`,
    );
    return body.ownedByMe === true;
  }

  async info(id: string): Promise<SpreadsheetInfo> {
    const fields = "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))";
    const body = await this.call<{
      spreadsheetId: string;
      spreadsheetUrl?: string;
      properties?: { title?: string };
      sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
    }>(`${SHEETS}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`);
    return {
      id: body.spreadsheetId,
      title: body.properties?.title ?? "(untitled)",
      url: body.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${body.spreadsheetId}/edit`,
      tabs: (body.sheets ?? []).map((s) => ({
        title: s.properties?.title ?? "",
        sheetId: s.properties?.sheetId ?? 0,
        rows: s.properties?.gridProperties?.rowCount ?? 0,
        columns: s.properties?.gridProperties?.columnCount ?? 0,
      })),
    };
  }

  /** Cells as people see them (formatted), row by row. `range` is A1 notation. */
  async values(id: string, range: string): Promise<{ range: string; rows: string[][] }> {
    const body = await this.call<{ range?: string; values?: unknown[][] }>(
      `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
    );
    return { range: body.range ?? range, rows: (body.values ?? []).map((row) => row.map((c) => String(c ?? ""))) };
  }

  /** A new spreadsheet in the asker's Drive, with these tabs (at least one). */
  async create(title: string, tabs: string[]): Promise<SpreadsheetInfo> {
    const body = await this.call<{ spreadsheetId: string; spreadsheetUrl?: string; sheets?: { properties?: { sheetId?: number; title?: string } }[] }>(
      SHEETS,
      {
        method: "POST",
        body: JSON.stringify({ properties: { title }, sheets: tabs.map((t) => ({ properties: { title: t } })) }),
      },
    );
    return {
      id: body.spreadsheetId,
      title,
      url: body.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${body.spreadsheetId}/edit`,
      tabs: (body.sheets ?? []).map((s) => ({ title: s.properties?.title ?? "", sheetId: s.properties?.sheetId ?? 0, rows: 0, columns: 0 })),
    };
  }

  async addTab(id: string, title: string): Promise<void> {
    await this.call(`${SHEETS}/${encodeURIComponent(id)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
  }

  /**
   * Write rows starting at a cell, as if typed (so "1,250.00" is a number and
   * "=SUM(B2:B9)" a formula). Returns the range Google reports it wrote.
   */
  async write(id: string, range: string, rows: string[][]): Promise<string> {
    const body = await this.call<{ updatedRange?: string }>(
      `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }) },
    );
    return body.updatedRange ?? range;
  }

  /** Add rows after the table that `range` sits in, inserting rows rather than overwriting. */
  async append(id: string, range: string, rows: string[][]): Promise<string> {
    const body = await this.call<{ updates?: { updatedRange?: string } }>(
      `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }) },
    );
    return body.updates?.updatedRange ?? range;
  }
}
