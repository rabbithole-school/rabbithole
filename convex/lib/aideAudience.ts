// The AUDIENCE axis: who else can read this reply.
//
// Sibling of lib/channels.ts, and deliberately NOT part of it. `channels.ts`
// owns everything that varies by WHERE a reply is delivered — link form and
// markdown support ("web" vs "slack"). This module owns everything that varies
// by WHO CAN SEE IT. They are orthogonal: a 1:1 Slack DM and the in-app dock
// share an audience and differ in rendering; a Slack channel and a (future)
// in-app group thread share an audience and differ in rendering.
//
// Why this exists as its own axis — a real incident. Until now the disclosure
// rules lived ONLY in the Slack system prompt, because Slack was the only
// surface that had ever held more than one human. That fused two unrelated
// ideas into the word "Slack" and produced two bugs:
//
//   1. FALSE REFUSAL. The Slack prompt carried five ad-hoc "sensitive category
//      + shared channel → withhold" rules (health, form answers, credentials,
//      …) and no statement that reading scholar records is legitimate staff
//      work. A school_admin asked in a channel for a roster of cognitive
//      assessment scores — a read his role is fully authorized for, and one
//      the in-app aide performed for him 21 minutes later on the same model
//      and the same tools. The Slack aide generalized the pattern to a
//      category nobody had written a rule for, and refused him six times.
//      The fix is `AUDIENCE_DISCLOSURE_DOCTRINE` below: ONE principle with a
//      CLOSED list, so the model cannot invent a sixth member.
//   2. A LATENT SAFETY BUG. The in-app prompt has no disclosure tiering at
//      all — correctly, because in-app has always been 1:1. The day in-app
//      group messaging ships, that surface would inherit zero discipline and
//      happily put a child's medical detail or a reset PIN into a group
//      thread. Stating audience per-surface would mean rediscovering all five
//      rules in fresh prose; stating it here means the rules arrive already
//      written.
//
// The tool layer already models this correctly and channel-agnostically:
// `writeSurfaceFor` collapses a surface to "private" | "channel" to gate
// credential/health/destructive tools, and `guardianFormAnswersSurface` takes
// its own boundary because a deliberately-composed group DM DOES count as
// private for that one case. Only the PROMPT layer was missing the axis.
// Nothing here changes a gate — the tools remain the security boundary; this
// module makes the model's PROSE agree with what the tools already enforce.

/**
 * Who can read this reply.
 *
 * - `private` — one human. A Slack 1:1 DM, the in-app aide dock, an MCP client.
 * - `group`   — a deliberately-composed set of humans. A Slack group DM.
 * - `open`    — anyone with access to the room. A Slack channel.
 *
 * `group` is NOT a synonym for private: the people in a group DM were chosen
 * for one conversation, not vetted for a child's medical record. Where a tool
 * needs a hard two-way gate it collapses `group` in with `open`
 * (`writeSurfaceFor`); where a group DM genuinely is the right place for an
 * answer, the caller says so explicitly (`guardianFormAnswersSurface`).
 */
export type AideAudience = "private" | "group" | "open";

/** The Slack transport's own surface names, mapped onto the shared axis. */
export function audienceFromSlackSurface(
  surface: "channel" | "dm" | "mpim",
): AideAudience {
  if (surface === "dm") return "private";
  if (surface === "mpim") return "group";
  return "open";
}

/** Human-readable, for the per-turn context line. */
export function audienceLabel(audience: AideAudience): string {
  if (audience === "private") return "a one-to-one conversation";
  if (audience === "group") return "a group conversation with several people";
  return "an open conversation anyone with access can read";
}

/** True only for a genuine one-to-one conversation. */
export function isPrivateAudience(audience: AideAudience): boolean {
  return audience === "private";
}

/**
 * The disclosure principle — byte-stable, so it belongs in the CACHED static
 * prefix of every staff-aide prompt. The per-conversation VALUE goes in the
 * uncached per-turn block via {@link audienceContextLine}, which keeps one
 * cached prefix per surface instead of one per audience.
 *
 * The list is deliberately CLOSED and deliberately stated twice (what is on
 * it, and that nothing else is). An open-ended "be careful with sensitive
 * things in public" is exactly the instruction that produced the false
 * refusal: the model extended it to cognitive assessment scores on its own.
 * Anything genuinely needing a sixth entry gets it added HERE, in one place,
 * for every surface at once — that is the point of the closed list, not an
 * obstacle to it.
 */
export const AUDIENCE_DISCLOSURE_DOCTRINE = [
  "Audience and disclosure:",
  "- Your per-turn context says whether this conversation is one-to-one, a group, or an open conversation. A few specific things are withheld outside a private conversation, because the people who can read an open conversation were not chosen for that conversation at all.",
  "- The CLOSED list of audience-restricted things: (1) health and emergency-record details; (2) the NAMES of families outstanding on a form, and any submitted form answers; (3) credentials — parent enrollment links, temporary PINs, password/passkey resets; (4) filing a document onto a scholar's record; (5) an individually identifying detail from a scholar's private record volunteered into an open channel when nobody asked for it. Where one of these is restricted, give what you can (counts, aggregates, the non-restricted part of the answer) and say plainly that the rest is available in a private conversation.",
  "- For (1)–(4) the boundary is the TOOL's to decide, not yours. Most treat only a 1:1 conversation as private, because a group's members were chosen for that conversation rather than vetted for a child's record — but not all: form names and answers deliberately count a composed private group DM as private too. So in a group conversation, call the tool and follow what it does. If it answers, that answer was authorized; relay it. If it withholds, relay its instruction.",
  "- (5) is different, and it is yours to hold: no tool can enforce it, because it is about what you VOLUNTEER rather than what you may read. The read tools do not know what room you are speaking into. So in an open channel, answer the question that was asked and don't garnish it with identifying detail from a scholar's record that nobody asked for.",
  "- That list is COMPLETE. Nothing else is audience-restricted. Do NOT extend it by analogy: if a request is not on that list, the audience is not a reason to refuse it, water it down, or add a caveat about who might see it.",
  "- Audience never changes WHETHER you may read something — only where you may say it. Read the record either way, then decide where the answer goes.",
].join("\n");

/**
 * Multi-party etiquette. Belongs to the AUDIENCE axis, not to Slack: it is
 * about whether a turn is yours, which is a question that only exists once a
 * conversation holds more than one human. Slack is merely the first surface
 * where that became true. The mechanics of HOW to stay quiet are transport-
 * specific (Slack has a `react_only` tool and emoji) and stay in the Slack
 * prompt; the judgement of WHEN lives here so the next multi-party surface
 * inherits it instead of reinventing it.
 */
export const MULTI_PARTY_ETIQUETTE = [
  "In a group or open conversation you are not obligated to reply to every message, and over-replying is its own failure. When a message is really between other people — directed human-to-human, merely name-dropping you, a passing remark or thanks, or asking SOMEONE ELSE to review or decide something (even about work you did) — the turn is not yours; acknowledge minimally or stay silent rather than composing a reply. A direct instruction or go-ahead TO you is yours: act on it. Don't insist on the last word. In a one-to-one conversation every turn is yours — always reply.",
].join("\n");

/**
 * The per-turn line naming THIS conversation's audience. Goes in the dynamic
 * (uncached) block — it is the one thing here that varies per thread.
 */
export function audienceContextLine(audience: AideAudience): string {
  return `Audience: this is ${audienceLabel(audience)}.`;
}
