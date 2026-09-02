/**
 * Native port of the web capture parser (lib/webAssignmentExtract.ts) and
 * the domain-lock helper (lib/webAssignmentHosts.ts).
 *
 * These are pure functions with zero browser/RN-specific deps — they can
 * live in the shared lib in theory, but the metro config does NOT include
 * watchFolders for the repo root, so we maintain a faithful copy here.
 *
 * When updating the web originals, mirror the logic here:
 *  - lib/webAssignmentExtract.ts  → parseWebCapture, parseXpFromText
 *  - lib/webAssignmentHosts.ts    → urlAllowedByAllowlist, hostMatchesAllowlist
 */

// ─── Types (mirror lib/webAssignmentExtract.ts) ──────────────────────────────

export type RawWebCapture = {
  /** document.body.innerText, truncated by the inject snippet. */
  text?: string;
  /** JSON array from the site's own API, when the fetch worked. */
  api?: unknown;
  /** Capture timestamp (device-local clock — the iPad is in HST). */
  now: number;
};

export type ParsedWebCapture = {
  extracted: {
    xpToday?: number;
    xpGoal?: number;
    courseName?: string;
    percentComplete?: number;
    tasksCompletedToday?: number;
    taskSummaries?: string[];
  };
  source: "api" | "dom";
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function firstString(item: Dict, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function firstNumber(item: Dict, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) {
      return Number(v.trim());
    }
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function completedAtOf(item: Dict): number | null {
  for (const k of [
    "completed",
    "completedAt",
    "completionDate",
    "datetime",
    "date",
  ]) {
    const ts = parseTimestamp(item[k]);
    if (ts !== null) return ts;
  }
  return null;
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Task name. Some providers nest it under topic.name (Lesson, Review, Quiz)
 * or test.name (diagnostic/placement). (Verified against live API 2026-06-16.)
 */
function taskNameOf(item: Dict): string | undefined {
  const topic = asDict(item.topic);
  if (topic) {
    const n = firstString(topic, ["name", "title"]);
    if (n) return n;
  }
  const test = asDict(item.test);
  if (test) {
    const n = firstString(test, ["name", "title"]);
    if (n) return n;
  }
  return firstString(item, [
    "name",
    "title",
    "lesson",
    "lessonName",
    "description",
  ]);
}

/** Course name. Some providers nest it at topic.course.name. */
function courseNameOf(item: Dict): string | undefined {
  const topic = asDict(item.topic);
  const course = topic ? asDict(topic.course) : null;
  if (course) {
    const n = firstString(course, ["name", "title"]);
    if (n) return n;
  }
  return firstString(item, ["courseName", "course"]);
}

function summarizeTask(item: Dict): string {
  const type = firstString(item, ["type", "taskType", "kind", "category"]);
  const name = taskNameOf(item);
  const xp = firstNumber(item, [
    "pointsAwarded",
    "points",
    "xp",
    "pointsEarned",
    "earned",
    "mpAwarded",
  ]);
  const label = [type, name].filter(Boolean).join(": ") || "Task";
  return xp !== undefined ? `${label} (+${xp} XP)` : label;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Pull the daily XP counter out of page text.
 * Some providers render "57/70 XP" or "XP 57/70"; both shapes are probed.
 */
export function parseXpFromText(
  text: string,
): { xpToday: number; xpGoal: number } | null {
  const m =
    text.match(/(\d+)\s*\/\s*(\d+)\s*XP\b/i) ??
    text.match(/\bXP\b[^\d%]{0,12}(\d+)\s*\/\s*(\d+)/i);
  if (!m) return null;
  const xpToday = Number(m[1]);
  const xpGoal = Number(m[2]);
  if (!Number.isFinite(xpToday) || !Number.isFinite(xpGoal) || xpGoal <= 0)
    return null;
  return { xpToday, xpGoal };
}

/**
 * Pull the active course name + % complete from page text. A typical provider's
 * LEARN header renders the course in caps immediately followed by its percent,
 * e.g. "4TH GRADE MATH\t45%". The course is the first all-caps phrase that's
 * directly trailed by a percent (skips "TOTAL EARNED", "THIS WEEK", etc).
 */
export function parseCourseFromText(
  text: string,
): { courseName?: string; percentComplete?: number } {
  const out: { courseName?: string; percentComplete?: number } = {};
  const m = text.match(/([0-9]*[A-Z][A-Z0-9 &.,'/-]{2,40}?)\s*[\n\t ]\s*(\d{1,3})\s*%/);
  if (m) {
    const name = m[1].trim();
    const pct = Number(m[2]);
    if (name && !/^(TOTAL EARNED|TODAY|THIS WEEK|LEARN|COURSES)$/.test(name))
      out.courseName = name;
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) out.percentComplete = pct;
  }
  return out;
}

/** Parse raw webview capture → structured extracted shape for recordProgress. */
export function parseWebCapture(raw: RawWebCapture): ParsedWebCapture {
  const extracted: ParsedWebCapture["extracted"] = {};
  let source: "api" | "dom" = "dom";

  const xp = parseXpFromText(raw.text ?? "");
  if (xp) {
    extracted.xpToday = xp.xpToday;
    extracted.xpGoal = xp.xpGoal;
  }
  const dom = parseCourseFromText(raw.text ?? "");
  if (dom.courseName) extracted.courseName = dom.courseName;
  if (dom.percentComplete !== undefined) extracted.percentComplete = dom.percentComplete;

  if (Array.isArray(raw.api)) {
    const items = raw.api.map(asDict).filter((d): d is Dict => d !== null);
    if (items.length > 0) source = "api";
    const dayStart = startOfLocalDay(raw.now);
    const today = items
      .map((item) => ({ item, at: completedAtOf(item) }))
      .filter((x): x is { item: Dict; at: number } => x.at !== null)
      .filter((x) => x.at >= dayStart && x.at <= raw.now + 60_000)
      .sort((a, b) => a.at - b.at);
    if (today.length > 0) {
      extracted.tasksCompletedToday = today.length;
      extracted.taskSummaries = today.map((x) => summarizeTask(x.item));
      // API course name is more precise than the DOM header — prefer it.
      const course = today.map((x) => courseNameOf(x.item)).find(Boolean);
      if (course) extracted.courseName = course;
    } else if (items.length > 0) {
      extracted.tasksCompletedToday = 0;
    }
  }

  return { extracted, source };
}

// ─── Domain-lock helpers (mirror lib/webAssignmentHosts.ts) ──────────────────

/**
 * Match a hostname against a list of patterns.
 *   "example.com"    → apex + any subdomain
 *   "*.example.com"  → subdomains only
 */
export function hostMatchesAllowlist(
  host: string,
  patterns: string[],
): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!p) return false;
    if (p.startsWith("*.")) {
      const apex = p.slice(2);
      return h !== apex && h.endsWith(`.${apex}`);
    }
    return h === p || h.endsWith(`.${p}`);
  });
}

/**
 * Full-URL gate for the domain-lock watchdog.
 * Non-http(s) schemes (about:blank, blob:, data:) are allowed — they can't
 * navigate the kid off-site. Unparseable URLs are blocked.
 */
export function urlAllowedByAllowlist(
  url: string,
  patterns: string[],
): boolean {
  // Non-http(s) schemes (about:, data:, blob:, …) are always allowed.
  if (!/^https?:\/\//i.test(url)) return true;
  // React Native's built-in URL doesn't reliably populate .hostname (no
  // react-native-url-polyfill), so derive the host robustly: try URL first,
  // then a regex. If we can't parse a host, don't block (fail open).
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if (!host) {
    const m = /^https?:\/\/([^/?#:]+)/i.exec(url);
    host = m ? m[1] : "";
  }
  if (!host) return true;
  return hostMatchesAllowlist(host, patterns);
}

/**
 * Public suffixes that are two labels long — mirrors
 * `convex/lib/externalAppsResolve.ts`. See `registrableHost` there for why the
 * list exists and why it is deliberately partial.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk", "ac.uk", "org.uk", "gov.uk", "sch.uk",
  "com.au", "edu.au", "co.nz", "co.jp", "co.za", "com.br",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app",
  "firebaseapp.com", "glitch.me", "wixsite.com", "blogspot.com",
]);

/**
 * Widen a host to the site it belongs to — mirrors `registrableHost` in
 * `convex/lib/externalAppsResolve.ts` (keep the two in step). Subdomains are
 * treated as interchangeable, so a deep link can't lock a scholar out of the
 * site's own sign-in hop.
 */
export function registrableHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return h;
  if (/^\d+(\.\d+){3}$/.test(h)) return h;
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * Derive the effective allowed-hosts list for an app: use the configured list
 * if present, else fall back to the webUrl's own SITE (not its exact host — see
 * `registrableHost`).
 */
export function effectiveAllowedHosts(app: {
  webUrl: string;
  webAllowedHosts?: string[] | null;
}): string[] {
  const configured = (app.webAllowedHosts ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  try {
    return [registrableHost(new URL(app.webUrl).hostname)];
  } catch {
    return [];
  }
}
