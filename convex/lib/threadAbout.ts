// What an `about` conversation is about, and which one a teacher's Slack reply
// is for. Pure: schema.ts imports the validator, so this file imports nothing
// from the server side.
//
// An `about` thread (parentThreads.kind "about") is ONE scholar ↔ their
// school's teachers, about ONE of the scholar's Quests (a unit) or ONE of
// their wonders (a seed). There is one per (scholar, about) at the scholar's
// school; scholarMessages.ensureAboutThread is the only place that makes one.

import { v, type Infer } from "convex/values";

export const threadAboutValidator = v.union(
  v.object({ type: v.literal("quest"), unitId: v.id("units") }),
  v.object({ type: v.literal("wonder"), seedId: v.id("seeds") }),
);

export type ThreadAbout = Infer<typeof threadAboutValidator>;

export function sameAbout(a: ThreadAbout | undefined, b: ThreadAbout): boolean {
  if (!a) return false;
  if (a.type === "quest") return b.type === "quest" && a.unitId === b.unitId;
  return b.type === "wonder" && a.seedId === b.seedId;
}

/** A scholar by the name they go by (a mapped line, or a schoolmate). */
export type NamedScholar<Id extends string = string> = {
  scholarId: Id;
  scholarName: string;
};

export type AboutSlackPick<T> =
  | { ok: true; target: T }
  /** A root with several scholars, and the reply addresses none of them. */
  | { ok: false; reason: "no_address" }
  /** The leading name fits more than one scholar (a shared name). */
  | { ok: false; reason: "several_names" }
  /** The reply addresses a scholar who isn't on this root. */
  | { ok: false; reason: "names_someone_else" }
  /** The addressed scholar has more than one line under this root. */
  | { ok: false; reason: "several_lines" };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Name," / "Name:" / "Name -" at the very start, any case and spacing. */
function addressPattern(name: string): RegExp | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(`^\\s*${words.map(escapeRegExp).join("\\s+")}\\s*[,:\\-–—]`, "iu");
}

/**
 * The reply as the address check reads it. Emphasis marks (* _ ~ `) are
 * dropped everywhere, so "*Remy*," reads "Remy,"; then everything before the
 * first letter goes: whitespace, quote marks (">" or Slack's "&gt;"), <@…>
 * mentions and <…> links, :emoji: shortcodes, emoji and other symbols. So
 * "> :wave: <@U123> *Remy*, …" reads "Remy, …". For matching only: the reply
 * is delivered exactly as the teacher wrote it.
 */
export function addressText(text: string): string {
  let rest = text.replace(/[*_~`]/g, "");
  for (;;) {
    const next = rest
      .replace(/^\s+/u, "")
      .replace(/^&(?:gt|lt|amp);/i, "")
      .replace(/^<[^>]*>/, "")
      .replace(/^:[a-z0-9+'-]+:/i, "")
      .replace(/^[^\p{L}]/u, "");
    if (next === rest) return rest;
    rest = next;
  }
}

/**
 * The scholars a reply ADDRESSES: its first words are a scholar's full name
 * or first name followed by a comma, colon or dash ("Quinn, …", "Quinn Test:
 * …", "quinn - …"). That is how a teacher writes to one kid in a shared
 * thread. A name anywhere else is ignored ("Will you look?", "we will see"),
 * and so is a leading word that is nobody's name ("Great question, …").
 * Returns everyone the leading name fits, so a shared name returns several.
 * Leading Slack markup is read past first (`addressText`).
 */
export function scholarsAddressedBy(
  people: readonly NamedScholar[],
  reply: string,
): Set<string> {
  const text = addressText(reply);
  const addressed = new Set<string>();
  for (const person of people) {
    const full = addressPattern(person.scholarName);
    const first = addressPattern(person.scholarName.trim().split(/\s+/)[0] ?? "");
    if (full?.test(text) || first?.test(text)) addressed.add(person.scholarId);
  }
  return addressed;
}

/**
 * Which conversation a teacher's plain reply under a mapped Slack root is for.
 * `roster` is every scholar at the mapped scholars' schools, so a name shared
 * with a schoolmate, or a schoolmate's name, is caught before choosing.
 *
 *   - A root about several scholars (a day's note): the reply must address
 *     exactly one scholar, on this root, who has one line here.
 *   - A root about one scholar (a proposal's thread): a reply that addresses
 *     nobody, or addresses only that scholar, goes to them. One addressing
 *     any other scholar is refused.
 *
 * Anything else is refused, never guessed: "Remy, …" under Quinn's line must
 * not reach Quinn.
 */
export function pickAboutSlackTarget<T extends NamedScholar>(
  targets: readonly T[],
  roster: readonly NamedScholar[],
  replyText: string,
): AboutSlackPick<T> {
  const byScholar = new Map<string, T[]>();
  for (const target of targets) {
    const list = byScholar.get(target.scholarId);
    if (list) list.push(target);
    else byScholar.set(target.scholarId, [target]);
  }
  const people = new Map<string, NamedScholar>();
  for (const person of [...roster, ...targets]) {
    if (person.scholarName.trim()) people.set(person.scholarId, person);
  }
  const addressed = scholarsAddressedBy([...people.values()], replyText);
  let scholarId: string;
  if (byScholar.size === 1) {
    scholarId = [...byScholar.keys()][0];
    const others = [...addressed].filter((id) => id !== scholarId);
    if (others.length > 0) {
      return {
        ok: false,
        reason: addressed.has(scholarId) ? "several_names" : "names_someone_else",
      };
    }
  } else {
    if (addressed.size === 0) return { ok: false, reason: "no_address" };
    if (addressed.size > 1) return { ok: false, reason: "several_names" };
    scholarId = [...addressed][0];
  }
  const lines = byScholar.get(scholarId);
  if (!lines) return { ok: false, reason: "names_someone_else" };
  if (lines.length > 1) return { ok: false, reason: "several_lines" };
  return { ok: true, target: lines[0] };
}
