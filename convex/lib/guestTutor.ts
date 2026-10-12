/**
 * Guest mode — the unauthenticated "try it" exchange a prospective parent can
 * have with the tutor, embedded by iframe from the school marketing site.
 *
 * This file is the PURE half: the flag, the three fixed topics, the origin
 * allowlist, the turn cap, the IP-bucket hashing, and the closing line. No
 * Convex imports, so `convex/__tests__/guestTutor.test.ts` can drive all of it
 * directly.
 *
 * What guest mode deliberately is NOT:
 *  - It is not an account. Nothing is created, nothing is linked, nothing is
 *    remembered after the tab closes.
 *  - It does not touch a single scholar row. The stream handler reads no
 *    `users`/`sessions`/mastery data and writes to exactly one table
 *    (`guestTutorRateLimits`), whose only content is a salted IP hash, a topic
 *    slug, and counters. See `.claude/rules/rabbithole-multi-tenancy.md`: an
 *    unauthenticated surface still has a tenant, and guest mode's is "none" —
 *    it never resolves an institution because it never reads school data.
 *  - It is not a companion. The turn cap is the point, not a cost control: the
 *    closing card exists to say out loud that the thing stopped.
 *
 * The tutor's own system prompt is the PUBLISHED one, unchanged — guest mode
 * calls `buildTutorSystemPrompt` with an all-null context, so what a parent
 * talks to is byte-identical to the base + soul sections a scholar gets (minus
 * every per-scholar section, which has no data to fill it). The guest framing
 * (which topic, how many turns are left) rides in an ephemeral user-role
 * instruction, exactly like `kickoffInstruction()` does for a real activity.
 */

// ─── Flag ────────────────────────────────────────────────────────────────

/**
 * The guest-mode kill switch. Absent/garbage → OFF, so the feature ships dark
 * and stays dark on every deployment (including prod) until someone turns it
 * on deliberately:
 *
 *   npx convex env set GUEST_TUTOR_ENABLED true --prod      # on
 *   npx convex env remove GUEST_TUTOR_ENABLED --prod        # off
 *
 * Truthy spellings match the Code Explorer / idea-conversations flags so the
 * three read the same way in the dashboard.
 *
 * ONE flag governs BOTH halves. The Next page asks this Convex deployment
 * whether guest mode is on (GET /guest-tutor/config) and 404s when it is not,
 * so flipping the env var takes effect without a web redeploy and there is no
 * second Vercel flag to drift out of sync with this one.
 *
 * Two companion variables, both optional and both consequential:
 *
 *   GUEST_TUTOR_IP_SALT        Random secret. Set this wherever guest mode is
 *                              ON — without it the stored IP hashes are
 *                              reversible and stop being anonymous. See
 *                              `hashGuestIp`.
 *   GUEST_TUTOR_ALLOW_LOCALHOST  Dev/preview only. Never set on prod.
 */
export function isGuestTutorEnabled(): boolean {
  const raw = (process.env.GUEST_TUTOR_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "on" || raw === "1";
}

/**
 * Dev/preview escape hatch for the origin allowlist: when set, `http://
 * localhost:*` and `http://127.0.0.1:*` are accepted as embedders. Never set
 * this on prod — the production allowlist is the literal school domains plus
 * the website repo's Vercel preview pattern.
 */
export function guestTutorAllowsLocalhost(): boolean {
  const raw = (process.env.GUEST_TUTOR_ALLOW_LOCALHOST ?? "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "on" || raw === "1";
}

// ─── Topics ──────────────────────────────────────────────────────────────

export type GuestTopicId = "virus" | "divide-by-zero" | "council";

export type GuestTopic = {
  id: GuestTopicId;
  /** The question a visitor picks, shown verbatim on the card. */
  title: string;
  /**
   * The situation handed to the tutor as context on every request.
   * Empty for the two topics whose title is already the whole prompt.
   */
  seed: string;
  /**
   * A verbatim first tutor turn. When present the tutor must say exactly this
   * and nothing else to open — the point of the council topic is to show
   * Rabbithole picking up a lesson a teacher just taught, and a paraphrase of
   * that opening would land the visitor mid-argument instead of in the room
   * they were actually in. Absent for the two topics that open cold, where the
   * tutor writes its own opening question.
   */
  opening?: string;
  /**
   * Where the exchange should travel after the opening, in the tutor's own
   * terms. Rides alongside the seed on EVERY request (see
   * `guestKickoffInstruction`), so it shapes the whole exchange rather than
   * only its first turn. It names the destination, never a script: the tutor
   * still follows whatever the visitor actually says, and still never hands
   * over the verdict.
   */
  guidance?: string;
};

/**
 * The three fixed topics. There is no free-text topic entry on purpose: a
 * guest cannot steer an unauthenticated, unmoderated tutor anywhere it has not
 * been rehearsed, and three good questions demonstrate the product better than
 * an empty box does.
 *
 * These are ordered as they render. Keep the wording exactly as published on
 * the school site — the marketing copy and this list are one thing.
 */
export const GUEST_TOPICS: readonly GuestTopic[] = [
  {
    id: "virus",
    title: "Is a virus alive?",
    seed: "",
  },
  {
    id: "divide-by-zero",
    title: "Why can't you divide by zero?",
    seed: "",
  },
  {
    id: "council",
    title: "Was the council broken, or working as intended?",
    seed:
      "This morning, in Ms. Spahn's class, the group made its decisions three " +
      "different ways: first with one ruler who decided alone, then with a " +
      "small council, then by majority vote. During the council round one " +
      "member blocked a change that everyone else wanted.",
    // Verbatim, and deliberately so: the exchange opens where the teacher's
    // lesson ended that morning, not in the middle of an argument the visitor
    // never had.
    opening:
      "You just spent the morning trying three different ways to make " +
      "decisions as a group in Ms. Spahn's class. Did any of them feel " +
      "especially effective, or especially difficult?",
    guidance:
      "Let this unfold from what they actually say. If they name a method — " +
      "the council or any other — as difficult or as effective, ask what made " +
      "it so, and follow their reasons before adding any of your own. Work " +
      "toward the moment one member blocked the change everyone else wanted: " +
      "if they raise it, take it up; if they do not, bring it in as something " +
      "that happened, not as a verdict about it. From there the question " +
      "worth reaching is what a council is actually FOR — getting things done " +
      "fast, or making sure no single group can steam ahead over everyone " +
      "else. Reach it as a question you ask them, never as an answer you " +
      "supply. You do not tell them whether the council was broken or working " +
      "as intended; that is theirs to decide, and you may leave it undecided. " +
      "This is a destination, not a schedule: if the exchange ends before you " +
      "reach that question, leave it unasked rather than forcing it or " +
      "breaking the rule about how the turn you are on must end.",
  },
] as const;

export function guestTopicById(id: string): GuestTopic | null {
  return GUEST_TOPICS.find((topic) => topic.id === id) ?? null;
}

// ─── Turn cap ────────────────────────────────────────────────────────────

/**
 * How many times a guest may speak. The tutor's opening question is free (it
 * is the demo), so a full exchange is 8 guest turns and 9 tutor turns.
 *
 * Enforced SERVER-SIDE from the transcript the client posts — a client that
 * lies about its turn count gets a 429, and the per-IP session cap bounds how
 * often anyone can try.
 */
export const GUEST_MAX_TURNS = 8;

/** The card shown once the cap is reached. Deliberately flat, not warm. */
export const GUEST_CLOSING_LINE =
  "That is what it does. It asked, it did not answer, and it stopped.";

/** The caption under the composer, for the whole life of the exchange. */
export const GUEST_CAPTION =
  "Rabbithole has no feelings. It won't miss you and can't be your friend.";

/**
 * Both guest instructions end with this.
 *
 * The embed renders the reply as PLAIN TEXT — no markdown, no KaTeX. The app's
 * own thread has both, but pulling that renderer into a marketing iframe is
 * weight for one surface, so the honest fix is to tell the model what it is
 * writing into. Without it the divide-by-zero topic reliably emits `$10 \div
 * 2 = 5$`, and a prospective parent reads dollar signs and a backslash.
 */
const GUEST_PLAIN_TEXT_CLAUSE =
  " Write plain sentences only: no markdown, no LaTeX or dollar-sign math, no" +
  " bullet lists, no headings — this surface shows your words exactly as you" +
  " type them.";

/**
 * The ephemeral user-role instruction that opens a guest exchange. Same device
 * as `kickoffInstruction()`: a bracketed SYSTEM note in the user turn, so the
 * published system prompt itself stays untouched.
 */
export function guestKickoffInstruction(topic: GuestTopic): string {
  const situation = topic.seed
    ? ` The situation to think about: ${topic.seed}`
    : "";
  // A topic may either dictate its opening word for word or leave the tutor to
  // write one. Everything after the opening is identical either way.
  const opening = topic.opening
    ? ` Your FIRST message in this conversation is fixed. Say exactly this, ` +
      `word for word, and nothing else: "${topic.opening}" If that opening ` +
      `already appears below as something you said, then it has been said: ` +
      `carry on from where the conversation actually is and never repeat or ` +
      `quote it.`
    : ` Open the conversation: ask ONE genuine question that gets them ` +
      `thinking about it. Two or three sentences at most, ending in that one ` +
      `question.`;
  const guidance = topic.guidance ? ` ${topic.guidance}` : "";
  return (
    `[SYSTEM — this is NOT a message a person typed. Someone visiting the ` +
    `school's website chose the question "${topic.title}" and has not said ` +
    `anything yet.${situation}${opening}${guidance} Do not greet them by ` +
    `name — you do not know who they are and must not ask. Do not explain ` +
    `what you are or that this is a demonstration. Keep every turn short.` +
    `${GUEST_PLAIN_TEXT_CLAUSE}]`
  );
}

/**
 * The per-turn instruction that keeps guest mode Socratic and finite.
 * `turnsLeft` counts the guest's REMAINING turns after the one being answered.
 */
export function guestTurnInstruction(turnsLeft: number): string {
  const ending =
    turnsLeft <= 0
      ? `This is the LAST thing you will say. Do not ask a new question and ` +
        `do not offer to continue — leave them with the thought they have ` +
        `just had, in two sentences or fewer.`
      : `End with exactly ONE question. Never more than one.`;
  return (
    `[SYSTEM — not typed by the person. Stay Socratic: do not answer the ` +
    `question for them, do not lecture, do not list. Keep it under a hundred ` +
    `words. You are not a companion and must not offer to be one: no ` +
    `check-ins, no "I'm here for you", no memory of them, no invitation to ` +
    `come back. ${ending}${GUEST_PLAIN_TEXT_CLAUSE}]`
  );
}

// ─── Origin allowlist ────────────────────────────────────────────────────

/**
 * Who may EMBED this: `frame-ancestors` (next.config.js), and only that.
 *
 * The allowlist below does something narrower, and an earlier version of this
 * comment claimed otherwise — worth spelling out so nobody re-derives the
 * wrong model. The stream request is issued by the iframe DOCUMENT, which is
 * served from Rabbithole's own origin, so its `Origin` header says
 * `https://rabbithole.school` no matter who framed it. This check therefore
 * CANNOT see, and cannot police, the embedder. `frame-ancestors` is the whole
 * of that control, which is why it ships tight in production (the school
 * domains only — previews and localhost are added by the non-production
 * branch of next.config.js, never on prod).
 *
 * What this list still does, and why it stays: it refuses a request from some
 * OTHER site's page calling the endpoint directly with `fetch`. That is a real
 * class of caller and cheap to turn away. It is NOT authentication — a script
 * sets `Origin:` with one flag — so it must never be the reason a cost gate is
 * considered unnecessary. The per-request rate limits are that reason.
 *
 * The first-party school entries are for a future in which the marketing site
 * calls the endpoint itself rather than framing a page; they are inert today.
 */
const GUEST_ORIGIN_PATTERNS: readonly RegExp[] = [
  // Rabbithole's own origins — the iframe document's origin in production,
  // and the same page opened directly for verification.
  /^https:\/\/(www\.)?rabbithole\.school$/,
];

/**
 * Vercel preview origins, accepted ONLY under the same dev/preview flag as
 * localhost. Vercel project names are user-chosen, so matching project-name
 * prefixes is a convenience for previews, never a trust boundary, and the
 * patterns are off on prod.
 */
const GUEST_PREVIEW_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https:\/\/rabbithole-[a-z0-9-]+\.vercel\.app$/,
];

const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * True when `origin` may call guest mode. A missing Origin header is NOT
 * allowed: a browser always sends one on a POST, so an absent one means a
 * non-browser caller.
 */
export function isGuestOriginAllowed(
  origin: string | null | undefined,
  opts: { allowLocalhost?: boolean } = {},
): boolean {
  if (!origin) return false;
  const trimmed = origin.trim();
  if (opts.allowLocalhost) {
    if (LOCAL_ORIGIN_PATTERN.test(trimmed)) return true;
    if (GUEST_PREVIEW_ORIGIN_PATTERNS.some((p) => p.test(trimmed))) return true;
  }
  return GUEST_ORIGIN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ─── Rate limits ─────────────────────────────────────────────────────────

/**
 * EVERY request is counted, not just the first one of an exchange.
 *
 * The first version of this file claimed a rate-limit slot only on the opening
 * turn, on the reasoning that "the unit being limited is a conversation".
 * That was wrong in the way that matters: the conversation lives in the
 * client, so a caller who simply never sends an empty transcript never takes
 * the opening branch, and every cap is skipped. Verified against a live
 * deployment: five consecutive off-topic requests from an IP whose exchange
 * quota was already exhausted all returned 200. It was a free LLM proxy.
 *
 * So there are two counters per window, and both gate:
 *  - `exchanges` — openings, which is the number a human recognises ("three
 *    tries an hour");
 *  - `turns` — REQUESTS, which is the one that actually bounds cost, because
 *    it cannot be dodged by lying about what kind of turn this is.
 */

/** Openings per IP per hour: enough to try all three topics back to back. */
export const GUEST_SESSIONS_PER_IP_PER_HOUR = 3;
/**
 * Requests per IP per hour. Three full exchanges are 3 × (1 opening + 8
 * replies) = 27; the slack absorbs a retry after a dropped stream without
 * cutting a real visitor off mid-thought.
 */
export const GUEST_TURNS_PER_IP_PER_HOUR = 32;
export const GUEST_IP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Global: 300 openings and 3000 requests a rolling day across everyone.
 *
 * Chosen, not measured — this is a marketing surface with no traffic history.
 * At ~150 output tokens a turn, 3000 turns is a few dollars, which is a cost
 * we can discover we were wrong about cheaply. It is a BLAST-RADIUS cap, not a
 * capacity plan: it exists so a bad night costs a few dollars and an
 * apologetic card rather than an unbounded bill. Raise it once real numbers
 * exist; the numbers live here so raising them is a one-line PR rather than an
 * archaeology expedition.
 */
export const GUEST_SESSIONS_PER_DAY_GLOBAL = 300;
export const GUEST_TURNS_PER_DAY_GLOBAL = 3000;
export const GUEST_GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The scope key the single global counter row uses. Not a valid IP hash. */
export const GUEST_GLOBAL_SCOPE = "global";

/**
 * How long a counter row outlives its window before the daily purge takes it.
 * Anything older can no longer influence a decision, so it is deleted — the
 * whole retention story for guest mode is "the counters, for a day".
 */
export const GUEST_ROW_TTL_MS = 25 * 60 * 60 * 1000;

/** What the visitor sees when any limit bites. Never blames them. */
export const GUEST_RATE_LIMITED_MESSAGE =
  "Rabbithole is taking a break. Try again a little later.";

/**
 * The counting identity of a guest: a salted SHA-256 of the caller IP,
 * truncated to 16 hex chars. The raw IP never lands in a row.
 *
 * ⚠️ The privacy claim depends on the SALT. An IPv4 space is 2^32, so an
 * unsalted (or publicly-salted) hash is reversible in GPU-minutes. Set
 * `GUEST_TUTOR_IP_SALT` to a random secret on any deployment that turns guest
 * mode on — it is documented next to `GUEST_TUTOR_ENABLED` at the top of this
 * file for exactly that reason. Without it the fallback still COUNTS
 * correctly; it just stops being anonymous, so treat the rows as IPs.
 */
export async function hashGuestIp(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The caller's IP as the Convex HTTP router sees it.
 *
 * Takes the LAST entry of `x-forwarded-for`, not the first. A proxy APPENDS
 * the address it saw, so the last hop is the one our infrastructure vouches
 * for while every earlier entry is whatever the client chose to send. Reading
 * the first entry — which this did originally — lets a caller mint a fresh
 * bucket per request by rotating a fake header, which is the per-IP cap
 * deleting itself.
 *
 * Falls back to a constant so a missing header degrades to "everyone shares
 * one bucket" (over-limiting) rather than "everyone is unlimited".
 */
export function guestClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const hops = forwarded?.split(",").map((hop) => hop.trim()).filter(Boolean);
  const last = hops && hops.length > 0 ? hops[hops.length - 1] : undefined;
  return last || headers.get("x-real-ip")?.trim() || "unknown";
}

// ─── Transcript validation ───────────────────────────────────────────────

export type GuestTurn = { role: "user" | "assistant"; content: string };

/** Longest single guest message accepted, in characters. */
export const GUEST_MAX_MESSAGE_CHARS = 2000;

export type GuestTranscriptCheck =
  | { ok: true; turns: GuestTurn[]; guestTurnsUsed: number }
  | { ok: false; error: string };

/**
 * Validate the transcript a client posts. The client is the only place the
 * conversation lives (nothing is persisted), so it is also the only place that
 * can lie about it — hence a real check rather than a cast:
 *  - shape and roles,
 *  - per-message length,
 *  - the turn cap, counted from the transcript itself.
 */
export function checkGuestTranscript(raw: unknown): GuestTranscriptCheck {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Bad request." };
  }
  // A maxed exchange is one opening tutor turn plus GUEST_MAX_TURNS pairs.
  // The slack lets a slightly-over transcript reach the turn-count check below,
  // so an over-cap client hears the closing line rather than "Bad request" —
  // while an absurd flood still stops here without being walked.
  if (raw.length > GUEST_MAX_TURNS * 2 + 8) {
    return { ok: false, error: "Bad request." };
  }
  const turns: GuestTurn[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "Bad request." };
    }
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      return { ok: false, error: "Bad request." };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "Bad request." };
    }
    const trimmed = content.trim();
    if (trimmed === "") continue;
    if (trimmed.length > GUEST_MAX_MESSAGE_CHARS) {
      return { ok: false, error: "That message is too long for a demo." };
    }
    turns.push({ role, content: trimmed });
  }
  const guestTurnsUsed = turns.filter((turn) => turn.role === "user").length;
  if (guestTurnsUsed > GUEST_MAX_TURNS) {
    return { ok: false, error: GUEST_CLOSING_LINE };
  }
  return { ok: true, turns, guestTurnsUsed };
}

// ─── Minimal logging ─────────────────────────────────────────────────────

/**
 * The ONLY thing guest mode records about an exchange, and it goes to the
 * Convex log stream, not a table: which of the three topics, how far in, and
 * how long the turn took.
 *
 * Never the text. Not the guest's, not the tutor's, not a summary of either —
 * a prospective parent typing into a marketing page has not consented to being
 * read, and there is no product reason to read them. If you ever want to know
 * "what do people ask it", the answer is to ask people, not to log them.
 */
export function logGuestTurn(entry: {
  topic: GuestTopicId;
  turnIndex: number;
  ms: number;
  outcome: "ok" | "error";
}): void {
  console.log(
    `[guest-tutor] topic=${entry.topic} turn=${entry.turnIndex} ` +
      `ms=${Math.round(entry.ms)} outcome=${entry.outcome}`,
  );
}
