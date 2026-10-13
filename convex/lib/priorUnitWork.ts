/**
 * The scholar's own prior work in the current unit, for the App designer.
 *
 * A vibecode session is usually the last stop in a unit: the scholar has
 * already written the mechanism, answered questions, or generated questions of
 * their own in earlier sessions. Without this section the designer starts cold
 * ("I don't have your design in front of me") and re-asks what the scholar
 * already said. This module reads that work and renders one bounded prompt
 * section from it.
 *
 * What it reads, all keyed on ONE scholar (other scholars' work can never
 * enter — every read goes through that scholar's sessions):
 *   1. Deliverables the scholar submitted for OTHER activities in the unit,
 *      resolved through the same content resolver the class digest uses — but
 *      only the scholar's own words: a deliverable whose artifact the AI last
 *      edited, or whose content is code, is skipped, and a scanned portfolio
 *      item contributes its extracted text, never its AI-written caption.
 *      Writing the tutor partly transcribed is labelled as such.
 *   2. For each of the scholar's other sessions in the unit, the latest
 *      `analyses.learningIndicators` (connections, deeper questions, revised
 *      understanding), labelled "Noticed in that session". This is the one
 *      observer output read here.
 *   3. When a session left no usable submitted deliverable, its writing box:
 *      the most recently created plain-text document the scholar last edited
 *      (one a tutor last touched, even by a rename, is skipped). A scholar who designed something and moved on
 *      without pressing Send is the common case, and the builder starting
 *      cold on a finished design is the failure this section exists to stop.
 *   4. When a session left no writing at all, the scholar's own turns in it
 *      (role "user", never tool/system/notebook/instruction rows or app-button
 *      presses), most recent kept.
 *
 * Deliberately absent: the observer's engagement scores, concern flags,
 * dashboard summary and suggested interventions (teacher-facing), and teacher
 * directives and whispers. The section is the scholar's work, not a report on
 * them.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveDeliverableContent } from "../classDigests";

export const PRIOR_UNIT_WORK_HEADER =
  "SCHOLAR'S PRIOR WORK IN THIS UNIT (their own words — build on it, never re-ask what is already here; refer to it specifically when it bears on the build)";

/** Budget for the rendered items (the header is not counted). */
export const PRIOR_UNIT_WORK_CHAR_CAP = 2500;

/** At most this many prior sessions are read — the cap trims long before. */
const MAX_SESSIONS = 12;
const MAX_DELIVERABLE_CHARS = 900;
const MAX_MESSAGE_CHARS = 240;
const MAX_MESSAGES_PER_SESSION = 6;
/** Shorter turns ("ok", "idk", "next") carry no thinking worth replaying. */
const MIN_MESSAGE_CHARS = 12;

export type PriorUnitWorkLine =
  | {
      kind: "wrote";
      text: string;
      /** The tutor transcribed part of this writing (hasTutorTranscription). */
      transcribed?: boolean;
    }
  | { kind: "drafted"; text: string; transcribed?: boolean }
  | { kind: "said"; text: string }
  | { kind: "noticed"; text: string };

export type PriorUnitWorkItem = {
  /** Activity title, else the session title. */
  label: string;
  /** When the work happened (ms) — orders items and renders as a date. */
  at: number;
  lines: PriorUnitWorkLine[];
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Source code (JS/CSS) rather than writing. Deliberately structural — a
 * keyword alone is not enough, so a sentence that starts "let the fish…"
 * still reads as writing. HTML documents are not code here: they are reduced
 * to their text.
 */
const CODE_START = [
  /^(?:const|let|var)\s+[\w$]+\s*=/,
  /^(?:async\s+)?function\b[\s\w$]*\(/,
  /^(?:import|export)\s[^\n]*(?:\bfrom\b|[={])/,
  /^class\s+[\w$]+[^\n]*\{/,
  /^(?:\/\/|\/\*)/,
  /^@(?:media|import|keyframes)\b/,
  /^[\w.#:*\-\s,>[\]="']+\{[^}]*:[^}]*\}/,
];

function looksLikeCode(text: string): boolean {
  return CODE_START.some((re) => re.test(text));
}

/**
 * Deliverable content as prompt text. Structured artifacts (map/slides JSON)
 * and code are skipped; HTML documents are reduced to their text.
 */
function deliverableText(content: string | null): string | null {
  const trimmed = content?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  if (looksLikeCode(trimmed)) return null;
  const text = /<[a-z][\s\S]*>/i.test(trimmed)
    ? trimmed
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    : trimmed;
  const clipped = clip(text, MAX_DELIVERABLE_CHARS);
  return clipped.length > 0 ? clipped : null;
}

function isScholarSpeech(m: Doc<"messages">): boolean {
  return (
    m.role === "user" &&
    // An app-button press is not scholar speech — the same test the observer
    // uses (isScholarAuthoredTurn in lib/observerShared.ts).
    m.inputModality !== "app" &&
    !m.notebookEntry &&
    !m.instruction &&
    !m.toolAction &&
    m.content.trim().length >= MIN_MESSAGE_CHARS
  );
}

/**
 * The part of a deliverable the scholar wrote, or null when none of it is
 * theirs. Filters at the item level and otherwise defers to the shared
 * resolver: an artifact the AI last edited is skipped outright (its text may
 * be the tutor's), and a portfolio item contributes only its extracted text —
 * the resolver would prepend the AI-written caption.
 */
async function scholarAuthoredContent(
  ctx: Pick<QueryCtx, "db">,
  d: Doc<"deliverables">,
): Promise<{ content: string | null; transcribed: boolean } | null> {
  let transcribed = d.hasTutorTranscription === true;
  if (d.artifactId) {
    const artifact = await ctx.db.get(d.artifactId);
    if (artifact?.lastEditedBy === "ai") return null;
    // A code artifact in a non-HTML language (JS, CSS, Python) is not writing.
    if (
      artifact?.type === "code" &&
      artifact.language &&
      !/^(?:html|markdown|md|text|plain)$/i.test(artifact.language)
    ) {
      return null;
    }
    transcribed ||= artifact?.hasTutorTranscription === true;
  }
  if (!d.textContent && !d.artifactId && d.portfolioItemId) {
    const item = await ctx.db.get(d.portfolioItemId);
    return { content: item?.extractedText ?? null, transcribed };
  }
  const { content } = await resolveDeliverableContent(ctx as QueryCtx, d);
  return { content, transcribed };
}

/**
 * Read the scholar's prior work in `unitId`, newest first. Excludes the
 * current session, rehearsal (test-drive) sessions, and deliverables for the
 * current activity.
 */
export async function loadPriorUnitWork(
  ctx: Pick<QueryCtx, "db">,
  args: {
    scholarId: Id<"users">;
    unitId: Id<"units">;
    currentSessionId: Id<"sessions">;
    currentActivityId: Id<"activities"> | null;
  },
): Promise<PriorUnitWorkItem[]> {
  const sessions = (
    await ctx.db
      .query("sessions")
      .withIndex("by_user_unit", (q) =>
        q.eq("userId", args.scholarId).eq("unitId", args.unitId),
      )
      .collect()
  )
    .filter((s) => s._id !== args.currentSessionId && !s.isTestDrive)
    .sort(
      (a, b) =>
        (b.lastMessageAt ?? b._creationTime) -
        (a.lastMessageAt ?? a._creationTime),
    )
    .slice(0, MAX_SESSIONS);

  const items = await Promise.all(
    sessions.map(async (session): Promise<PriorUnitWorkItem | null> => {
      const [deliverables, latestAnalysis, activity] = await Promise.all([
        ctx.db
          .query("deliverables")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .collect(),
        ctx.db
          .query("analyses")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .order("desc")
          .first(),
        session.activityId ? ctx.db.get(session.activityId) : null,
      ]);

      const lines: PriorUnitWorkLine[] = [];
      let at = session.lastMessageAt ?? session._creationTime;

      const otherDeliverables = deliverables
        .filter(
          (d) =>
            d.scholarId === args.scholarId &&
            d.activityId !== args.currentActivityId,
        )
        .sort((a, b) => b.submittedAt - a.submittedAt);
      for (const d of otherDeliverables) {
        const authored = await scholarAuthoredContent(ctx, d);
        if (!authored) continue;
        const text = deliverableText(authored.content);
        if (!text) continue;
        lines.push({
          kind: "wrote",
          text,
          ...(authored.transcribed ? { transcribed: true } : {}),
        });
        at = Math.max(at, d.submittedAt);
      }

      const indicators = (latestAnalysis?.learningIndicators ?? [])
        .map((s) => s.trim())
        .filter(Boolean);
      if (indicators.length > 0) {
        lines.push({ kind: "noticed", text: clip(indicators.join("; "), 400) });
      }

      if (!lines.some((l) => l.kind === "wrote")) {
        const draft = (
          await ctx.db
            .query("artifacts")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .collect()
        )
          .filter(
            (a) =>
              (a.type === undefined || a.type === "text") &&
              a.lastEditedBy === "scholar",
          )
          .sort((a, b) => b._creationTime - a._creationTime)
          .map((a) => ({ a, text: deliverableText(a.content) }))
          .find((d) => d.text !== null);
        if (draft?.text) {
          lines.push({
            kind: "drafted",
            text: draft.text,
            ...(draft.a.hasTutorTranscription ? { transcribed: true } : {}),
          });
        }
      }

      if (!lines.some((l) => l.kind === "wrote" || l.kind === "drafted")) {
        const userTurns = (
          await ctx.db
            .query("messages")
            .withIndex("by_session_role", (q) =>
              q.eq("sessionId", session._id).eq("role", "user"),
            )
            .collect()
        ).filter(isScholarSpeech);
        for (const m of userTurns.slice(-MAX_MESSAGES_PER_SESSION)) {
          lines.push({ kind: "said", text: clip(m.content, MAX_MESSAGE_CHARS) });
        }
      }

      if (lines.length === 0) return null;
      return { label: activity?.title ?? session.title, at, lines };
    }),
  );

  return items
    .filter((i): i is PriorUnitWorkItem => i !== null)
    .sort((a, b) => b.at - a.at);
}

const LINE_PREFIX: Record<PriorUnitWorkLine["kind"], string> = {
  wrote: "They wrote",
  drafted: "In their writing box",
  said: "They said",
  noticed: "Noticed in that session",
};

const TRANSCRIBED_PREFIX = "They wrote (partly transcribed by the tutor)";

function formatDate(at: number, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
}

/**
 * Render the section, newest item first, within `cap` characters of items.
 * Returns null when there is no prior work — the section is then omitted.
 */
export function buildPriorUnitWorkSection(
  items: PriorUnitWorkItem[] | null,
  timeZone: string,
  cap: number = PRIOR_UNIT_WORK_CHAR_CAP,
): string | null {
  if (!items || items.length === 0) return null;
  let body = "";
  for (const item of items) {
    const rendered =
      `\n- ${item.label} (${formatDate(item.at, timeZone)})` +
      item.lines
        .map(
          (l) =>
            `\n  ${l.kind === "wrote" && l.transcribed ? TRANSCRIBED_PREFIX : LINE_PREFIX[l.kind]}${l.kind === "drafted" && l.transcribed ? " (partly transcribed by the tutor)" : ""}: ${l.text}`,
        )
        .join("");
    const remaining = cap - body.length;
    if (rendered.length <= remaining) {
      body += rendered;
      continue;
    }
    // Keep a partial item only when enough of it survives to be useful.
    if (remaining > 160) body += `${rendered.slice(0, remaining - 1)}…`;
    break;
  }
  if (!body) return null;
  return `\n\n${PRIOR_UNIT_WORK_HEADER}${body}`;
}
