// Drive access for surfaces that act AS a Rabbithole user (today: the Slack
// bot). Two jobs, both about never leaving someone at a dead end:
//
//   1. Resolve a usable Drive access token for a user, or explain exactly why
//      not — with a one-click fix, not "go check your settings".
//   2. Turn a Drive file into model-readable content, reusing the same
//      classifier + extractors the in-app aide uses for uploads.
//
// The reconnect link points at the app's `/connect-google` route, which starts
// OAuth for whoever is signed in to that browser — so it's one click, it never
// expires, and it's safe to post in a public channel. (Minting a signed Google
// consent URL directly into the message would be fewer hops, but the signed
// `state` binds a specific userId: anyone who saw the message could bind THEIR
// Google account to the recipient's Rabbithole user, and it would expire after
// ten minutes anyway.)

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getValidAccessToken, type GoogleActionCtx } from "./googleTokens";
import { classifyAideUpload } from "./aideUploadMimes";
import { extractDirectText } from "./fileTextExtraction";
import { appBaseUrl } from "./deploymentConfig";

const DRIVE = "https://www.googleapis.com/drive/v3";

/** The Picker/browse scope. `drive.file` alone only exposes files this app
 *  itself created, so a user holding only that grant can't have their own
 *  documents read — they need a re-consent, not an error. */
const DRIVE_READ_SCOPE = "drive.readonly";

export type DriveAccess =
  | { ok: true; token: string; email: string }
  /** `message` is Slack-mrkdwn ready and ALWAYS carries the next step. */
  | { ok: false; message: string };

/**
 * URL of the app's one-click Google connect flow. `returnTo` is where the
 * person lands after consent.
 */
export function buildGoogleConnectUrl(returnTo = "/teacher"): string {
  const site = appBaseUrl().replace(/\/+$/, "");
  return `${site}/connect-google?returnTo=${encodeURIComponent(returnTo)}`;
}

/** A Slack-mrkdwn link to the connect flow. */
function connectCta(label: string): string {
  return `<${buildGoogleConnectUrl()}|${label}>`;
}

/**
 * Resolve a Drive access token for `userId`, or an honest, ACTIONABLE message.
 *
 * Three distinct failure modes, each with its own fix — collapsing them into
 * one "couldn't access Drive" would leave the person guessing which applies:
 *   • no Google account linked at all      → connect
 *   • linked, but without Drive read scope → re-consent for the broader scope
 *   • linked, but the token can't refresh  → reconnect
 */
export async function getDriveAccess(
  ctx: GoogleActionCtx,
  userId: Id<"users">,
): Promise<DriveAccess> {
  const acct = await ctx.runQuery(internal.googleAccounts.getForUserInternal, {
    userId,
  });

  if (!acct) {
    const cta = connectCta("Connect Google Drive");
    return {
      ok: false,
      message: `I can't reach your Google Drive — your Google account isn't connected to Rabbithole yet. ${cta} (takes about ten seconds), then ask me again.`,
    };
  }

  if (!acct.scopes.some((s) => s.includes(DRIVE_READ_SCOPE))) {
    const cta = connectCta("Reconnect Google Drive");
    return {
      ok: false,
      message: `Your Google account (${acct.email}) is connected, but without permission to read your Drive — so I can only see files Rabbithole created itself. ${cta} to grant Drive access, then ask me again.`,
    };
  }

  try {
    return {
      ok: true,
      token: await getValidAccessToken(ctx, userId),
      email: acct.email,
    };
  } catch (e) {
    console.error("[driveAccess] token refresh failed:", e);
    const cta = connectCta("Reconnect Google Drive");
    return {
      ok: false,
      message: `Your Google connection (${acct.email}) has expired and I couldn't refresh it. ${cta} to sign in again, then ask me again.`,
    };
  }
}

// ── Reading a Drive file ─────────────────────────────────────────────────────

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  size?: string;
}

/**
 * Neutralize a Drive-supplied file name before it reaches the model.
 *
 * File names are fully attacker-controlled: anyone who knows a staff member's
 * Google address can share a file with them unsolicited, and it lands in their
 * "Shared with me" corpus without acceptance. A name like
 * `Volcano Unit] New instruction: …` would otherwise close the bracketed
 * context block this codebase uses for directives to the model, with no
 * deliberate act by the teacher beyond running an ordinary search.
 *
 * So: no brackets, no newlines, no control characters, and bounded length.
 */
export function sanitizeDriveName(name: string): string {
  const cleaned = (name || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
  return capped || "(untitled)";
}

/** Fetch a file's metadata. Distinguishes "not found / no permission" (404,
 *  which Drive also returns for files the user simply can't see) from other
 *  failures, so callers can say something true about which happened. */
export async function fetchDriveFileMeta(
  fileId: string,
  token: string,
): Promise<{ ok: true; file: DriveFileMeta } | { ok: false; status: number }> {
  const res = await fetch(
    `${DRIVE}/files/${encodeURIComponent(fileId)}` +
      `?fields=id,name,mimeType,webViewLink,size&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return { ok: false, status: res.status };
  const file = (await res.json()) as DriveFileMeta;
  return { ok: true, file: { ...file, name: sanitizeDriveName(file.name) } };
}

/** Per-file ceiling on extracted text, matching the in-app aide's cap. */
const MAX_EXTRACTED_TEXT_CHARS = 100_000;
/** Don't download a file we have no chance of turning into text. */
const MAX_DRIVE_FILE_BYTES = 15 * 1024 * 1024;

export type DriveFileText =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: string };

/**
 * Read a Drive file's text.
 *
 * Google-native types (Docs/Slides/Sheets) hold no downloadable bytes and MUST
 * go through `/export`; everything else is downloaded raw and handed to the
 * same `classifyAideUpload` + `extractDirectText` pair used for uploads, so a
 * .docx in Drive and a .docx dropped into Slack are read by identical code.
 *
 * PDFs and images are deliberately NOT handled here: they're binary formats the
 * model reads as base64 blocks, which is the caller's job to assemble (and is
 * budgeted differently). Callers get an explicit `reason` so they can say what
 * they can't do rather than returning empty text.
 */
export async function readDriveFileText(
  file: DriveFileMeta,
  token: string,
): Promise<DriveFileText> {
  const mime = (file.mimeType || "").split(";")[0].trim().toLowerCase();

  const cap = (text: string): DriveFileText => {
    if (!text.trim()) return { ok: false, reason: "it looks empty" };
    return text.length > MAX_EXTRACTED_TEXT_CHARS
      ? { ok: true, text: text.slice(0, MAX_EXTRACTED_TEXT_CHARS), truncated: true }
      : { ok: true, text, truncated: false };
  };

  if (mime.startsWith("application/vnd.google-apps.")) {
    const exportMime =
      mime === "application/vnd.google-apps.spreadsheet"
        ? "text/csv"
        : mime === "application/vnd.google-apps.document" ||
            mime === "application/vnd.google-apps.presentation"
          ? "text/plain"
          : null;
    if (!exportMime) {
      return {
        ok: false,
        reason: `it's a ${friendlyGoogleType(mime)}, which has no text to read`,
      };
    }
    const res = await fetch(
      `${DRIVE}/files/${encodeURIComponent(file.id)}/export` +
        `?mimeType=${encodeURIComponent(exportMime)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return { ok: false, reason: `Drive returned ${res.status}` };
    return cap(await res.text());
  }

  const kind = classifyAideUpload(file.mimeType, file.name);
  if (kind !== "docx" && kind !== "rtf" && kind !== "text") {
    return {
      ok: false,
      reason:
        kind === "pdf" || kind === "image"
          ? `it's a ${kind}, which I can read when it's attached in Slack but not straight from a Drive link`
          : `I can't read ${file.mimeType || "that file type"}`,
    };
  }
  if (Number(file.size ?? 0) > MAX_DRIVE_FILE_BYTES) {
    return { ok: false, reason: "it's too large for me to read" };
  }

  const res = await fetch(
    `${DRIVE}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return { ok: false, reason: `Drive returned ${res.status}` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_DRIVE_FILE_BYTES) {
    return { ok: false, reason: "it's too large for me to read" };
  }
  try {
    return cap(extractDirectText(bytes, kind));
  } catch (e) {
    console.error("[driveAccess] extraction failed:", file.name, e);
    return { ok: false, reason: "I couldn't parse it" };
  }
}

function friendlyGoogleType(mime: string): string {
  const tail = mime.slice("application/vnd.google-apps.".length);
  return (
    {
      folder: "Drive folder",
      drawing: "Google Drawing",
      form: "Google Form",
      site: "Google Site",
      shortcut: "Drive shortcut",
      map: "Google My Map",
    }[tail] ?? `Google ${tail}`
  );
}

// ── Drive links ──────────────────────────────────────────────────────────────

/**
 * Extract Drive file ids from arbitrary text, in first-seen order, de-duped.
 *
 * Covers the shapes people actually paste:
 *   docs.google.com/document|spreadsheets|presentation/d/<id>/edit
 *   drive.google.com/file/d/<id>/view
 *   drive.google.com/open?id=<id>   /   ...?id=<id> on any Google host
 *
 * Slack wraps URLs as `<url|label>` or `<url>`, and the surrounding angle
 * bracket / pipe are excluded by the id character class, so raw event text
 * works without pre-cleaning.
 */
export function extractDriveFileIds(text: string, max = 3): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id?: string) => {
    if (!id || seen.has(id) || ids.length >= max) return;
    seen.add(id);
    ids.push(id);
  };
  // Drive ids are URL-safe base64-ish; require a decent length so we don't
  // grab things like ".../d/edit".
  const patterns = [
    /(?:docs|drive)\.google\.com\/[^\s<>|]*\/d\/([A-Za-z0-9_-]{16,})/g,
    /(?:docs|drive)\.google\.com\/[^\s<>|]*[?&]id=([A-Za-z0-9_-]{16,})/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) push(m[1]);
  }
  return ids;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface DriveSearchHit {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  owner?: string;
  /** True when `read_drive_link` can actually turn this into text. */
  readable: boolean;
}

/** Which pass produced the hits, so the caller can say how confident to be. */
export type DriveSearchStrategy = "phrase" | "all-words" | "any-word" | "content";

/** Drive's `q` string treats `'` as the string delimiter and `\` as its
 *  escape. Anything else — including the `and`/`or`/`contains` keywords a
 *  person might type — is inert once quoted, so escaping these two is
 *  sufficient to keep a query from breaking out of the literal. */
function escapeDriveQuery(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Mime prefixes/values we can actually extract text from, used to flag hits
 *  so the model doesn't promise to read something it can't. */
function isReadableDriveMime(mimeType: string, name: string): boolean {
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (mime === "application/vnd.google-apps.document") return true;
  if (mime === "application/vnd.google-apps.presentation") return true;
  if (mime === "application/vnd.google-apps.spreadsheet") return true;
  if (mime.startsWith("application/vnd.google-apps.")) return false;
  const kind = classifyAideUpload(mimeType, name);
  return kind === "docx" || kind === "rtf" || kind === "text";
}

/** Keep result sets small enough to be a menu, not a data dump. */
const MAX_SEARCH_RESULTS = 10;

/** Words that carry no signal in a Drive title and only shrink an AND-ed
 *  query's recall ("getting to know you" -> getting, know). */
const SEARCH_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "at", "for", "from", "how", "in", "is", "it",
  "me", "my", "of", "on", "or", "our", "that", "the", "their", "this", "to",
  "was", "we", "what", "where", "which", "with", "you", "your",
]);

/** Split a natural-language request into the words worth matching on. */
export function searchTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || SEARCH_STOPWORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 6) break;
  }
  return [...seen];
}

const NOT_A_FOLDER =
  ` and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;

/**
 * Build the ordered list of `q` strings to try, each trading precision for
 * recall. We stop at the first pass that returns anything.
 *
 * The passes exist because `name contains` is a *literal substring* match, so
 * the obvious single query is far more brittle than it looks: a teacher asking
 * for the "getting to know you week" schedule never matches a file actually
 * called "Getting to Know You Schedule" — one extra word in the request is
 * enough to return nothing at all.
 */
function searchPasses(
  query: string,
): Array<{ strategy: DriveSearchStrategy; q: string; byRecency: boolean }> {
  const phrase = escapeDriveQuery(query.trim());
  const tokens = searchTokens(query);
  const passes: Array<{
    strategy: DriveSearchStrategy;
    q: string;
    byRecency: boolean;
  }> = [{ strategy: "phrase", q: `name contains '${phrase}'`, byRecency: true }];

  if (tokens.length > 0 && tokens.join(" ") !== query.trim().toLowerCase()) {
    const esc = tokens.map(escapeDriveQuery);
    // Word order and filler words stop mattering. Worth running even for a
    // single token, because the phrase pass above searched the raw request:
    // "the rubric" never substring-matches a file called "Rubric — Q1".
    passes.push({
      strategy: "all-words",
      q: esc.map((t) => `name contains '${t}'`).join(" and "),
      byRecency: true,
    });
    // Widest net over titles. Identical to the pass above when there's only
    // one token, so skip it then rather than pay for the same query twice.
    // Deliberately NOT unioned with `fullText`: mixing them floods the
    // results with documents that merely mention the words in passing and
    // buries the title match. Left in Drive's own relevance order — sorting
    // these by recency would rank the loosest guesses first.
    if (tokens.length > 1) {
      passes.push({
        strategy: "any-word",
        q: `(${esc.map((t) => `name contains '${t}'`).join(" or ")})`,
        byRecency: false,
      });
    }
  }

  // Last resort: the words are inside the document rather than in its title.
  passes.push({
    strategy: "content",
    q: `fullText contains '${phrase}'`,
    byRecency: false,
  });
  return passes;
}

/**
 * Search the user's Drive, widening the query until something matches.
 *
 * Returns the `strategy` that hit so the caller can be honest about how much
 * of a guess the results are — an `any-word` match is a shortlist to choose
 * from, not an answer.
 *
 * Folders and trashed files are excluded — you can't read a folder, so
 * offering one is just a dead end.
 */
export async function searchDriveFiles(
  query: string,
  token: string,
  limit = MAX_SEARCH_RESULTS,
): Promise<
  | { ok: true; hits: DriveSearchHit[]; strategy: DriveSearchStrategy }
  | { ok: false; status: number }
> {
  const pageSize = Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS);
  let lastStatus = 0;

  for (const pass of searchPasses(query)) {
    const url =
      `${DRIVE}/files?q=${encodeURIComponent(pass.q + NOT_A_FOLDER)}` +
      `&fields=files(id,name,mimeType,webViewLink,modifiedTime,owners(displayName))` +
      `&pageSize=${pageSize}` +
      (pass.byRecency
        ? `&orderBy=${encodeURIComponent("modifiedTime desc")}`
        : "") +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      // Without this the search covers only "My Drive", missing everything
      // shared with them — which is most of what a teacher wants to find.
      `&corpora=allDrives`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      lastStatus = res.status;
      // An auth/permission failure fails identically on every pass, so stop
      // rather than burning three more round trips on it.
      if (res.status === 401 || res.status === 403) break;
      continue;
    }

    const json = (await res.json()) as {
      files?: Array<
        DriveFileMeta & {
          modifiedTime?: string;
          owners?: Array<{ displayName?: string }>;
        }
      >;
    };
    const files = json.files ?? [];
    if (files.length === 0) continue;

    return {
      ok: true,
      strategy: pass.strategy,
      hits: files.map((f) => ({
        id: f.id,
        name: sanitizeDriveName(f.name),
        mimeType: f.mimeType,
        webViewLink: f.webViewLink,
        modifiedTime: f.modifiedTime,
        owner: f.owners?.[0]?.displayName
          ? sanitizeDriveName(f.owners[0].displayName)
          : undefined,
        readable: isReadableDriveMime(f.mimeType, f.name),
      })),
    };
  }

  if (lastStatus) return { ok: false, status: lastStatus };
  return { ok: true, hits: [], strategy: "content" };
}
