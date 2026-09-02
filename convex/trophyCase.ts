// The Trophy Case — the classroom "entrance screen".
//
// A celebratory, kiosk-style roster display for the big screen by the
// door. ONE unified grid: every card celebrates a different scholar's
// earned **mission badge**, framed as a peer-discussion prompt —
// "Ask <Scholar> about <their Quest>" — and carries a ✨ curiosity hook
// drawn from THAT scholar's own boldest star (the Interpretive lens'
// `leap` seeds), so the room learns what each kid is chasing next.
//
// Roster-wide by design (role-based, not ACL — every teacher sees every
// scholar). Read-only.

import { v } from "convex/values";
import { authedQuery, teacherQuery } from "./lib/customFunctions";
import { collectInterpretiveStars } from "./lib/leapSeeds";
import { resolveInstitutionLens, scholarIdsInLens } from "./lib/institutionLens";
import type { Doc, Id } from "./_generated/dataModel";

const CARD_LIMIT = 18;

export const forRoster = teacherQuery({
  args: {
    groupId: v.optional(v.id("scholarGroups")),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let allowedScholarIds: Set<Id<"users">> | null = null;
    if (args.scope !== undefined) {
      const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
      allowedScholarIds = await scholarIdsInLens(ctx, lens);
    }

    // Optional group scope: restrict to the group's members (the Scholars-tab
    // group picker). When set, only that group's badges + curiosity hooks show.
    let group: { name: string; emoji: string | null } | null = null;
    let memberSet: Set<string> | null = null;
    if (args.groupId) {
      const g = await ctx.db.get(args.groupId);
      if (g) {
        group = { name: g.name, emoji: g.emoji ?? null };
        memberSet = new Set(g.scholarIds.map((id) => String(id)));
      }
    }

    let badgeRows = await ctx.db.query("scholarUnitBadges").collect();
    if (allowedScholarIds) {
      // Active institution lens: the kiosk only celebrates badges for scholars
      // visible in the resolved institution scope.
      badgeRows = badgeRows.filter((b) => allowedScholarIds!.has(b.scholarId));
    }
    if (memberSet) {
      badgeRows = badgeRows.filter((b) => memberSet!.has(String(b.scholarId)));
    }
    badgeRows.sort((a, b) => b.earnedAt - a.earnedAt);

    // Each scholar's leap stars, boldest first — the curiosity hooks.
    let leaps = await collectInterpretiveStars(ctx);
    if (allowedScholarIds) {
      // Active institution lens: curiosity hooks come from the same visible
      // scholar set as the badge rows.
      leaps = leaps.filter((s) => allowedScholarIds!.has(s.scholarId));
    }
    if (memberSet) {
      leaps = leaps.filter((s) => memberSet!.has(String(s.scholarId)));
    }
    leaps.sort(
      (a, b) => (b.reach ?? 0) - (a.reach ?? 0) || b._creationTime - a._creationTime,
    );
    const leapsByScholar = new Map<string, typeof leaps>();
    for (const s of leaps) {
      const k = String(s.scholarId);
      if (!leapsByScholar.has(k)) leapsByScholar.set(k, []);
      leapsByScholar.get(k)!.push(s);
    }

    type Card = {
      _id: string;
      scholarId: string;
      scholarName: string;
      scholarFirstName: string;
      scholarImage: string | null;
      unitTitle: string;
      unitEmoji: string | null;
      badgeIcon: string;
      imageUrl: string | null;
      earnedAt: number;
      hook: { topic: string; domain: string } | null;
    };

    // Round-robin SELECT badge rows (newest-per-scholar first) up to the
    // display cap BEFORE hydrating, so adjacent cards feature different
    // scholars AND we only `db.get` the ≤ CARD_LIMIT badges we'll show
    // (not 2 reads for every badge ever earned).
    const rowsByScholar = new Map<string, typeof badgeRows>();
    for (const r of badgeRows) {
      const k = String(r.scholarId);
      if (!rowsByScholar.has(k)) rowsByScholar.set(k, []);
      rowsByScholar.get(k)!.push(r);
    }
    const queues = [...rowsByScholar.values()];
    const selected: typeof badgeRows = [];
    let progressed = true;
    while (progressed && selected.length < CARD_LIMIT) {
      progressed = false;
      for (const q of queues) {
        const r = q.shift();
        if (r) {
          selected.push(r);
          progressed = true;
          if (selected.length >= CARD_LIMIT) break;
        }
      }
    }

    // Hydrate only the selected badges, caching repeated scholars/units. A
    // rotating index per scholar means a scholar's multiple badges each
    // pick up a DIFFERENT curiosity hook.
    const scholarCache = new Map<string, Doc<"users"> | null>();
    const unitCache = new Map<string, Doc<"units"> | null>();
    const hookIdx = new Map<string, number>();
    const cards: Card[] = [];
    for (const r of selected) {
      // Custom (unit-less) badges aren't part of the unit-organized wall.
      const unitId = r.unitId;
      if (!unitId) continue;
      const k = String(r.scholarId);
      const uk = String(unitId);
      let scholar = scholarCache.get(k);
      if (scholar === undefined) {
        scholar = await ctx.db.get(r.scholarId);
        scholarCache.set(k, scholar);
      }
      let unit = unitCache.get(uk);
      if (unit === undefined) {
        unit = await ctx.db.get(unitId);
        unitCache.set(uk, unit);
      }
      const name = scholar?.name ?? "A scholar";
      const myLeaps = leapsByScholar.get(k) ?? [];
      let hook: { topic: string; domain: string } | null = null;
      if (myLeaps.length > 0) {
        const i = hookIdx.get(k) ?? 0;
        const s = myLeaps[i % myLeaps.length];
        hook = { topic: s.topic, domain: s.domain ?? "general" };
        hookIdx.set(k, i + 1);
      }
      cards.push({
        _id: r._id,
        scholarId: k,
        scholarName: name,
        scholarFirstName: name.split(/\s+/)[0],
        scholarImage: scholar?.image ?? null,
        unitTitle: unit?.title ?? "(unit)",
        unitEmoji: unit?.emoji ?? null,
        badgeIcon: r.badgeSnapshot.icon ?? unit?.emoji ?? "🏅",
        imageUrl: r.imageStorageId
          ? await ctx.storage.getUrl(r.imageStorageId)
          : null,
        earnedAt: r.earnedAt,
        hook,
      });
    }

    return { cards, group };
  },
});

// ── Scholar-facing social proof: more quests from the scholar's group ──────
//
// The virality engine. For the viewing scholar, surface the COMPLETION
// badges their groupmates have earned that the scholar hasn't done yet — a
// derived "peer offer" (no new table): computed from scholarUnitBadges +
// group membership (shared scholarGroups), minus the units the scholar has
// already earned or started. Each trail carries its social-proof roster
// ("Kai & Lani earned this") so the scholar can choose to chase it. Tone:
// celebrate spread, never rank (no counts-as-leaderboard, no percentages).
export const trailsForScholar = authedQuery({
  args: {},
  handler: async (ctx) => {
    const me = ctx.user._id;
    const meKey = String(me);

    // Pick one named cohort group so the recommendations and their heading
    // always describe the same set. A scholar normally has exactly one group;
    // if they're in several, prefer a named/emoji-bearing one for the heading.
    const groups = await ctx.db.query("scholarGroups").collect();
    const myGroups = groups.filter((group) =>
      group.scholarIds.some((id) => String(id) === meKey),
    );
    const peerGroup =
      myGroups.find((group) => Boolean(group.emoji?.trim())) ??
      myGroups[0] ??
      null;
    const group = peerGroup
      ? { name: peerGroup.name, emoji: peerGroup.emoji ?? null }
      : null;
    const peers = new Set<string>();
    const peerIds: Id<"users">[] = [];
    if (peerGroup) {
      for (const id of peerGroup.scholarIds) {
        const k = String(id);
        if (k !== meKey && !peers.has(k)) {
          peers.add(k);
          peerIds.push(id);
        }
      }
    }
    if (peerIds.length === 0) return { trails: [], group };

    // Units I've already earned or started — nothing to chase there.
    const myBadges = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar", (q) => q.eq("scholarId", me))
      .collect();
    const mine = new Set(myBadges.map((b) => String(b.unitId)));
    const mySessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", me))
      .collect();
    for (const s of mySessions) {
      if (s.unitId) mine.add(String(s.unitId));
    }

    // Aggregate groupmates' badges per unit (the trail), collecting earners.
    type Agg = {
      unitId: Id<"units">;
      latestAt: number;
      icon: string | undefined;
      earnerIds: Id<"users">[];
    };
    // Read each groupmate's badges via the by_scholar index rather than scanning
    // every badge in the school. This scopes BOTH the read and the reactive
    // invalidation to the group, so a scholar's home only re-renders when one of
    // THEIR groupmates earns a badge — not on any school-wide badge award.
    const peerBadges = (
      await Promise.all(
        peerIds.map((id) =>
          ctx.db
            .query("scholarUnitBadges")
            .withIndex("by_scholar", (q) => q.eq("scholarId", id))
            .collect(),
        ),
      )
    ).flat();
    const byUnit = new Map<string, Agg>();
    for (const b of peerBadges) {
      // Custom (unit-less) badges aren't unit-aggregated on the group wall.
      const unitId = b.unitId;
      if (!unitId) continue;
      const uk = String(unitId);
      if (mine.has(uk)) continue;
      const agg = byUnit.get(uk);
      if (agg) {
        agg.earnerIds.push(b.scholarId);
        if (b.earnedAt > agg.latestAt) {
          agg.latestAt = b.earnedAt;
          agg.icon = b.badgeSnapshot.icon ?? agg.icon;
        }
      } else {
        byUnit.set(uk, {
          unitId,
          latestAt: b.earnedAt,
          icon: b.badgeSnapshot.icon,
          earnerIds: [b.scholarId],
        });
      }
    }
    if (byUnit.size === 0) return { trails: [], group };

    // Most-followed + freshest trails first.
    const aggs = [...byUnit.values()].sort(
      (a, b) => b.earnerIds.length - a.earnerIds.length || b.latestAt - a.latestAt,
    );

    const userCache = new Map<string, Doc<"users"> | null>();
    const getUser = async (id: Id<"users">) => {
      const k = String(id);
      let u = userCache.get(k);
      if (u === undefined) {
        u = await ctx.db.get(id);
        userCache.set(k, u);
      }
      return u;
    };

    const trails = [];
    for (const agg of aggs.slice(0, 12)) {
      const unit = await ctx.db.get(agg.unitId);
      if (!unit) continue;
      // Up to 3 earner names/avatars for the social-proof line; keep the
      // full count for "+N more".
      const earners = [];
      for (const id of agg.earnerIds.slice(0, 3)) {
        const u = await getUser(id);
        if (!u) continue;
        const name = u.name ?? "A scholar";
        earners.push({
          firstName: name.split(/\s+/)[0],
          name,
          image: u.image ?? null,
        });
      }
      trails.push({
        unitId: agg.unitId,
        unitTitle: unit.title,
        unitEmoji: unit.emoji ?? null,
        // A trail is a pod-mate's unit, so keep the teacher-facing
        // (neutral / 3rd-person) blurb — a 2nd-person "your…" would be wrong
        // for someone else's quest.
        unitDescription: unit.description ?? null,
        badgeIcon: agg.icon ?? unit.emoji ?? "🏅",
        domain: unit.subject ?? null,
        earners,
        earnerCount: agg.earnerIds.length,
        latestAt: agg.latestAt,
      });
    }

    return { trails, group };
  },
});
