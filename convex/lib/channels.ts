// The "channel" abstraction: everything about an aide reply that differs
// by WHERE it's delivered. Today two channels — the in-app Rabbithole UI
// ("web") and Slack ("slack") — built to grow (parent SMS / WhatsApp /
// email are on the roadmap). Two things vary by channel:
//
//   1. Link form. The web UI resolves a bare path against its own origin,
//      so its links stay RELATIVE ("/teacher/…"). Slack — and any external
//      channel — can't resolve a bare path, so links must be ABSOLUTE
//      (siteUrl() + path). `linkBaseFor(channel)` picks the prefix; the
//      aide tools then stamp a ready-to-use `url` onto every entity they
//      surface, so the model links by copying a field, never by hand-
//      assembling a URL from an id.
//
//   2. Markdown support. The web UI renders GitHub-flavored markdown
//      (react-markdown + remark-gfm), TABLES included. Slack's
//      markdown_text renders bold / italics / links / lists but NOT
//      tables — a `| col | col |` table comes out as raw pipes.
//      `formattingGuidance(channel)` tells the model what its channel can
//      actually render.
//
// Path builders are RELATIVE and mirror the app/ routes. Prefix one with a
// link base (via `withBase`) to get the channel's form.

import { appBaseUrl } from "./deploymentConfig";

export type AideChannel = "web" | "slack";

/** Absolute app origin for this deployment (per-deployment via SITE_URL). */
export const siteUrl = appBaseUrl;

// ── HST time labels ──────────────────────────────────────────────────────
// The primary school runs on Hawaii time (HST = UTC-10, no DST ever), so a fixed
// -10h offset formatted off UTC parts is always correct — and avoids
// depending on ICU/`timeZone` support in the Convex runtime. The aide
// reasons in epoch-ms; these labels make timestamps legible to the model
// (and let it sanity-check that a computed time is right). Lives here (a
// pure, Convex-free module) so every surface — the aide tool layer, the
// MCP queries, the Next route — can format the same way.
const HST_OFFSET_MS = 10 * 60 * 60 * 1000;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export function hstLabel(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const d = new Date(ms - HST_OFFSET_MS);
  let h = d.getUTCHours();
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3)}, ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${h}:${mm} ${ap} HST`;
}

/** HST calendar date in the teacher-facing "Monday, July 27" form. */
export function hstDateLabel(ms: number): string {
  const d = new Date(ms - HST_OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Prefix for deep links on a channel. "" = relative (the web UI, which
 * resolves a bare path against its own origin); siteUrl() = absolute
 * (Slack + future external channels). Pass the result to the aide tools as
 * `linkBase`.
 */
export function linkBaseFor(channel: AideChannel): string {
  return channel === "web" ? "" : siteUrl();
}

/** Join a link base to a relative path. An empty base returns the path unchanged. */
export function withBase(base: string, path: string): string {
  return base ? `${base.replace(/\/+$/, "")}${path}` : path;
}

/**
 * A labeled markdown link — the ONLY way outbound copy should render a URL.
 * Two wins over a bare URL: non-technical staff see a clickable *word*, and
 * the `(url)` is structurally bound to the label, so Slack's autolinker can't
 * fuse following punctuation into the destination (a bare render URL once
 * swallowed a trailing `(That…` in prod and 404'd).
 */
export function markdownLink(label: string, url: string): string {
  return `[${label}](${url})`;
}

// ── Relative path builders (mirror app/ routes) ─────────────────────────
// ids are interpolated as plain strings — they arrive as Id<…> or string
// from various callers, and a URL only ever needs the string form.

/**
 * A scholar's route slug: their `username` when they have one, else their id
 * as a string. The Scholars route resolves BOTH forms (see the scholars
 * layout: "a username, or a raw id as a fallback"), so the id fallback keeps
 * links working for scholars who haven't picked a username yet. Every
 * scholar-link builder should slug through here so that rule lives in one
 * place. `??` (not `||`) mirrors the callers this replaced: a genuine
 * username is always kept, and only a missing one falls back to the id.
 */
export function scholarSlug(
  username: string | null | undefined,
  id: string,
): string {
  return username ?? String(id);
}

/** The Scholars tab, focused on one scholar by their username slug. */
export function scholarPath(username: string): string {
  return username ? `/teacher/scholars/${username}` : `/teacher/scholars`;
}

/** A scholar's project/session. `remote` opens it as that scholar for staff. */
export function sessionPath(sessionId: string, scholarId?: string): string {
  return scholarId
    ? `/scholar/${sessionId}?remote=${scholarId}`
    : `/scholar/${sessionId}`;
}

/** The Curriculum column-view, optionally focused on a lesson / activity. */
export function unitPath(
  unitId: string,
  opts?: { lessonId?: string; activityId?: string },
): string {
  const qs = new URLSearchParams();
  if (opts?.lessonId) qs.set("lesson", opts.lessonId);
  if (opts?.activityId) qs.set("activity", opts.activityId);
  const q = qs.toString();
  // A node-targeted link opens the editor (matching an in-app node click); a
  // bare unit link opens its summary (the bare curriculum path). Links go
  // straight to the column-view — never the old /teacher/unit/<id> redirect.
  const paneSeg = opts?.lessonId || opts?.activityId ? "/edit" : "";
  return `/teacher/curriculum/${unitId}${paneSeg}${q ? `?${q}` : ""}`;
}

/** The assignment Run page (Schedule tab, that assignment selected). */
export function assignmentPath(assignmentId: string): string {
  return `/teacher/schedule/${assignmentId}`;
}

// ── Per-channel link + formatting guidance for the aide system prompt ────
// Static per channel (byte-stable), so it lives in the prompt-cache prefix.

export function formattingGuidance(channel: AideChannel): string {
  if (channel === "slack") {
    return [
      "## Links & formatting (Slack)",
      "",
      "Many tools return a `url` field on the entities they surface — already absolute (https://…). The FIRST time you name a scholar, session/project, unit, or assignment that has a page, wrap its name in a markdown link `[Name](url)` using that field verbatim. Link the first mention only; don't repeat the same link.",
      "That same rule applies to EVERY other URL you mention too — proposal links, pull requests, dispatched-task pages, posted comments, anything. Never paste a bare URL into a Slack reply. If a tool gives you a preformatted markdown link field such as `taskLink`, `proposalLink`, `prLink`, or `commentLink`, paste that field VERBATIM instead of echoing the raw `...Url` field. Never put a raw URL directly next to trailing punctuation.",
      "- Scholar: `get_scholar_sessions` → `scholarUrl`; `list_scholars` → a `url` per scholar.",
      "- Session/project: `get_scholar_sessions` → a `url` per project.",
      "- Unit / lesson / activity: `list_units` / `get_unit_details` / `create_unit` / `create_scholar_quest` / `create_scholar_lesson` / `create_scholar_activity` / `create_simulator_activity` / `update_simulator_spec` / `create_problem_set` → `url`. ALWAYS link what you just created. When you built a unit → lesson → activity, the ACTIVITY link is the most useful one (it opens exactly what the teacher will run) — never leave the activity as plain text.",
      "- Assignment: `list_assignments` / `get_assignment` → `url`.",
      "",
      "Slack CANNOT render markdown tables — never use a `| col | col |` table; the pipes come out as raw text. Give tabular data as short labeled lines or a bullet list instead (e.g. \"Scholar A — 3 days ago\"). Bold (`**bold**`), italics, bullets, and `[text](url)` links all render; keep formatting light, no big section headers.",
    ].join("\n");
  }
  // web: the in-app UI renders relative links and GFM tables.
  return [
    "## Links — link entities you name",
    "",
    "Many tools return a `url` field (a relative path) on the entities they surface. The FIRST time you name a scholar, session/project, unit, or assignment that has a page, wrap its name in a markdown link `[Name](url)` using that field verbatim. Link the first mention only; don't repeat the same link.",
    "Apply that rule to EVERY URL you mention, not just entity pages. Never paste a bare URL when you can label it; if a tool gives you a preformatted markdown link field such as `taskLink`, `proposalLink`, `prLink`, or `commentLink`, use that verbatim instead of the raw `...Url` field.",
    "- Scholar: `get_scholar_sessions` → `scholarUrl`; `list_scholars` → a `url` per scholar.",
    '- Session/project: `get_scholar_sessions` → a `url` per project. When you name a specific session (e.g. "the Number Line Fractions session"), link the title.',
    "- Unit / lesson / activity: `list_units` / `get_unit_details` / `create_unit` / `create_scholar_quest` / `create_scholar_lesson` / `create_scholar_activity` / `create_simulator_activity` / `update_simulator_spec` / `create_problem_set` → `url`. ALWAYS link what you just created; when you built a unit → lesson → activity, the ACTIVITY link is the most useful (it opens exactly what the teacher will run) — never leave the activity name as plain text.",
    "- Assignment: `list_assignments` / `get_assignment` → `url`.",
    "",
    "Markdown tables render in the app, so use one when a comparison is genuinely tabular.",
  ].join("\n");
}
