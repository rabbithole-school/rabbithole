/**
 * Mixed-domain playlist merge — the PURE queue-level logic that blends several
 * practice domains into one interleaved session. The engine stays single-domain
 * per skill (each domain's graph, mastery, and frontier are computed
 * independently, in practiceSkills.computeDomainQueue); the blend happens ONLY
 * here, at the queue level, so spaced repetition stays honest:
 *
 *   1. Every DUE REVIEW wins ahead of any new work, ranked GLOBALLY by decay —
 *      a fading fact is urgent regardless of which domain it lives in.
 *   2. FRONTIER (new) work is round-robined across domains for balance.
 *   3. A "never 100% review" mix floor reserves ~a quarter of the session for
 *      frontier work whenever any exists (mirrors nextPractice's own mix floor).
 *
 * Kept free of Convex/ctx so it unit-tests standalone (mixedQueue.test.ts). The
 * submit path needs nothing special — submitAnswer resolves each item's domain
 * from its own skill (by_nodeKey), so a blended session records correctly.
 */

import { HINT_STRAND_WEIGHT } from "./scheduler";

/** One queued skill, tagged with the domain it belongs to. */
export type DomainQueueEntry = { domain: string; key: string };

/** The merge only needs each domain's slug + its ordered entries (the full
 *  per-domain queue in practiceSkills carries skills+mastery too, but this pure
 *  merge ignores those — structural typing lets the richer type flow in). */
export type MergeableDomainQueue = {
  domain: string;
  entries: { key: string; reason: "review" | "new"; retention: number }[];
};

/** Round-robin interleave a set of per-domain lists into one, preserving each
 *  list's internal order. */
export function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/** Merge per-domain queues into ONE ordered queue (capped at `limit`). A single
 *  domain passes through unchanged (identical to the pre-mixed behavior). For a
 *  mixed set: due reviews first, ranked globally most-decayed-first across all
 *  domains; then frontier work round-robined across domains; with the same
 *  "never 100% review" mix floor `nextPractice` applies within a domain. */
export function mergeDomainQueues(
  perDomain: MergeableDomainQueue[],
  limit: number,
  options: { preferredDomain?: string } = {},
): DomainQueueEntry[] {
  if (perDomain.length === 1) {
    const only = perDomain[0];
    return only.entries.map((e) => ({ domain: only.domain, key: e.key }));
  }
  const reviews = perDomain
    .flatMap((pd) =>
      pd.entries
        .filter((e) => e.reason === "review")
        .map((e) => ({ domain: pd.domain, key: e.key, retention: e.retention })),
    )
    .sort((a, b) => a.retention - b.retention);
  const frontierByDomain = perDomain.map((pd) => ({
    domain: pd.domain,
    entries: pd.entries
      .filter((e) => e.reason === "new")
      .map((e) => ({ domain: pd.domain, key: e.key })),
  }));
  const frontier: DomainQueueEntry[] = [];
  const cursor = new Map(frontierByDomain.map(({ domain }) => [domain, 0]));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const queue of frontierByDomain) {
      const weight =
        queue.domain === options.preferredDomain ? HINT_STRAND_WEIGHT : 1;
      for (let n = 0; n < weight; n += 1) {
        const index = cursor.get(queue.domain) ?? 0;
        const entry = queue.entries[index];
        if (!entry) break;
        frontier.push(entry);
        cursor.set(queue.domain, index + 1);
        progressed = true;
      }
    }
  }

  const floor = frontier.length > 0 ? Math.ceil(limit / 4) : 0;
  const reviewBudget = Math.max(0, limit - Math.min(floor, frontier.length));

  const out: DomainQueueEntry[] = [];
  const seen = new Set<string>();
  const push = (e: { domain: string; key: string }) => {
    const id = `${e.domain}\u0000${e.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ domain: e.domain, key: e.key });
  };
  for (const r of reviews) {
    if (out.length >= reviewBudget) break;
    push(r);
  }
  for (const f of frontier) {
    if (out.length >= limit) break;
    push(f);
  }
  // Backfill any unused floor slots with leftover reviews.
  if (out.length < limit) {
    for (const r of reviews) {
      if (out.length >= limit) break;
      push(r);
    }
  }
  return out;
}
