"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Button, Flex, HStack, VStack, Text, Spinner } from "@chakra-ui/react";
import { ArrowRight, Check, Plant } from "@phosphor-icons/react";
import { Surface } from "@/components/ui/Surface";
import { ObservationCard, type ObservationCardRow } from "@/components/ObservationCard";
import { useAideDockOptional } from "@/components/aide/AideDockProvider";
import { formatTimeAgo } from "@/lib/relativeTime";
import { bloomLabel } from "@/lib/bloom";
import { MasteryMarker, type MasteryStop } from "@/components/MasteryMarker";
import { PulseSparkline, pct, fmtDelta, attentionFor, endColorFor } from "@/components/PulseSparkline";
import { BloomLadder } from "@/components/BloomLadder";
import { Automaticity } from "@/components/Automaticity";
import type { ScholarTabKey } from "@/components/ScholarProfile";
import { readingTileCaption } from "@/components/readingTileCaption";
import { useNow } from "@/hooks/useNow";
import { roundsWeekLabel } from "@/lib/roundsCadence";
import {
  systemAttentionCopy,
  systemAttentionHeadline,
  systemAttentionNeedsDecision,
} from "@/lib/systemAttention";

// ── Scholar Feed ──────────────────────────────────────────────────────────
// The default tab: a social-profile read of "what's this kid been up to?".
// A header of stat tiles (engagement · reading · needs-you · sessions)
// sits above a reverse-chronological activity feed assembled from the real
// signals already in the app — sessions, demonstrated concepts, surfaced
// misconceptions, portfolio adds, teacher notes, AI catches, sparks, and
// reading level-ups. Welfare/connection flags pin to the top. Each tile/card
// links into the tab that owns the detail. No new data — everything here is
// already queried elsewhere; Convex dedupes the subscriptions.

const READING_NUM = (level: string): number =>
  level === "K" ? 0.5 : level === "college" ? 13 : parseFloat(level) || 0;

const fmtLevel = (level: string | null | undefined): string =>
  !level ? "—" : level === "K" ? "K" : level === "college" ? "College" : `Gr ${level}`;

/**
 * How each record-eligible alert kind renders as a feed row. The allowlist that
 * decides which kinds reach the client lives server-side in
 * `convex/alerts.ts → SCHOLAR_RECORD_ALERT_KINDS`; a kind missing here is
 * simply skipped, so adding one there degrades to silence rather than a crash.
 */
const ALERT_PRESENTATION: Record<
  string,
  { emoji: string; iconBg: string; label: string; meta: string }
> = {
  chat_overwhelm: { emoji: "😫", iconBg: "amber.100", label: "Asked to stop", meta: "Tutoring session" },
  chat_stuck: { emoji: "🌀", iconBg: "amber.50", label: "Going in circles", meta: "Tutoring session" },
  scholar_feedback: { emoji: "👎", iconBg: "yellow.100", label: "Flagged a tutor reply", meta: "Scholar feedback" },
  practice_stuck: { emoji: "🧗", iconBg: "cyan.100", label: "Stuck in practice", meta: "Math practice" },
  practice_not_yet_taught: { emoji: "🌤️", iconBg: "cyan.50", label: "Hasn't been taught yet", meta: "Math practice" },
  seed_spawn: { emoji: "🌱", iconBg: "violet.100", label: "New spark from practice", meta: "Exploration" },
};
const EMPTY_COHERENCE_FINDINGS: {
  rule: string;
  disposition: string;
  observedAt: number;
}[] = [];

/**
 * The one informative sentence from an alert body.
 *
 * Producers compose bodies for SLACK, so they carry scaffolding a feed row must
 * not repeat: a `On *<session>*:` preamble, a `Session: "…"` footer, `> ` quote
 * markers and Slack `*bold*`. Dropping the scaffold but KEEPING quoted lines
 * matters — for `scholar_feedback` the quote is the substance (the tutor text
 * the scholar objected to), while for `chat_stuck` the quote merely follows a
 * summary that already came first.
 */
function alertLead(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw
      .replace(/^>\s*/, "")
      .replace(/^On \*.*\*:$/, "")
      .replace(/\*(.+?)\*/g, "$1")
      .trim();
    if (!line) continue;
    if (/^Session:\s/.test(line)) continue;
    return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }
  return "";
}

type FeedItem = {
  id: string;
  ts: number;
  /** When this evidence became visible to the feed; may be later than `ts`. */
  freshnessTs?: number;
  lead: React.ReactNode;
  meta: string;
  chip?: string;
  href?: string;
  // A right-aligned "Add Seed" CTA: promotes a pending exploration seed to
  // active (status "active"). `added` reflects the seed already being active.
  seedAction?: { seedId: Id<"seeds">; added: boolean };
  // A learning-record item carries a Tree-coloured square MARKER (mastery /
  // misconception); an event carries a soft emoji ORB. Exactly one is set.
  marker?: { kind: "mastery" | "misconception"; stop: MasteryStop | null };
  emoji?: string;
  iconBg?: string;
  // Extra learning-record glyphs in the meta line (neutral, never colour).
  bloomLevel?: number;
  fluencyLevel?: number | null;
  fluencySource?: string;
  // When set (+ an onOpenObservation handler), the row opens this observation's
  // evidence record (a ?obs= deep link).
  observationId?: string;
};

// One reverse-chron list, two card shapes. A teacher observation renders as the
// shared <ObservationCard> (the same card the dossier draws) instead of the
// generic Post, so it keeps its place in the ordering without forcing the
// generic card to grow author/clamp/action plumbing only it used.
type FeedEntry =
  | ({ observation?: undefined } & FeedItem)
  | {
      id: string;
      ts: number;
      freshnessTs?: number;
      observation: ObservationCardRow;
    };

/**
 * What the team has actually been shown, as opposed to when they clicked.
 *
 * `watermark` is the timestamp of the NEWEST event in the snapshot currently on
 * screen, taken from the evidence itself. Rounds acknowledges that number, so
 * anything that lands after this render stays new — a wall-clock acknowledgement
 * would silently swallow it.
 */
export type ScholarEvidenceSnapshot = {
  scholarId: string;
  watermark: number;
  newCount: number;
  total: number;
};

export function ScholarFeed({
  scholarId,
  onOpenTab,
  onOpenReading,
  onOpenObservation,
  canCurate = false,
  canRounds = true,
  showAllNewEvidence = false,
  evidenceSeenThrough,
  onEvidenceSnapshot,
}: {
  scholarId: string;
  onOpenTab?: (tab: ScholarTabKey) => void;
  /** Open the Map → Reading subtab. */
  onOpenReading?: () => void;
  /** Open one observation's evidence record (a ?obs= deep link). */
  onOpenObservation?: (observationId: string) => void;
  /** Teacher/admin only: enables the "Add Seed" action (seeds.review). */
  canCurate?: boolean;
  /** Rounds is a teaching-team surface, not an operations view. Also `false`
   *  when the feed is composed INTO Rounds, so the surface never links to
   *  itself. */
  canRounds?: boolean;
  /** Rounds must render every row newer than its acknowledged watermark before
   *  it can truthfully mark the snapshot reviewed. */
  showAllNewEvidence?: boolean;
  /** Supplied by a host that already knows the acknowledged watermark (Rounds),
   *  so the feed does not run a second `statusForScholar` subscription. */
  evidenceSeenThrough?: number | null;
  /** Fires whenever the rendered evidence snapshot changes. */
  onEvidenceSnapshot?: (snapshot: ScholarEvidenceSnapshot) => void;
}) {
  const sid = scholarId as Id<"users">;
  const profile = useQuery(api.scholars.getProfile, { scholarId: sid });
  const frontier = useQuery(api.knowledgeTree.frontierForScholar, { scholarId: sid });
  const masteryObs = useQuery(api.masteryObservations.listForScholar, { scholarId: sid });
  const seeds = useQuery(api.seeds.listByScholar, { scholarId: sid });
  const portfolio = useQuery(api.portfolio.listForScholar, { scholarId: sid });
  const physical = useQuery(api.physicalTasks.listForScholar, { scholarId: sid });
  const sessions = useQuery(api.sessions.list, { userId: sid });
  const observations = useQuery(api.observations.listByScholar, { scholarId: sid });
  const aiCatches = useQuery(api.messageFlags.listForScholar, { scholarId: sid });
  const reliance = useQuery(api.alerts.recentByScholar, {
    scholarId: sid,
    kind: "parasocial_reliance",
    limit: 1,
  });
  // The rest of what the system noticed about this scholar. Record-eligible
  // kinds are allowlisted server-side (welfare stays Slack-only, health kinds
  // stay capability-gated, and parasocial is excluded because it already has
  // the pinned Connection note above — one rendering per signal).
  const alertRecord = useQuery(api.alerts.recordForScholar, { scholarId: sid });
  const readingHistoryRaw = useQuery(api.scholars.getReadingLevelHistory, { scholarId: sid });
  const readingHistory = useMemo(() => readingHistoryRaw ?? [], [readingHistoryRaw]);
  const pulseResult = useQuery(api.scholars.scholarPulse, { scholarId: sid });
  const pulse = pulseResult?.pulse ?? undefined;
  const pulseWindowDays = pulseResult?.windowDays ?? 21;
  const roundsStatus = useQuery(
    api.rounds.statusForScholar,
    canRounds ? { scholarId: sid } : "skip",
  );
  // A host that already knows the watermark wins. `statusForScholar` is
  // note-based and carries no watermark of its own, so without a host there is
  // nothing to compare against.
  const seenThrough = evidenceSeenThrough ?? null;

  // What the coherence sweep noticed about our OWN representation of this
  // scholar. Staff-only (the query is teacher-gated), and it returns controlled
  // metadata only — no learner text, so nothing here can quote a child.
  // The improvement-loop coherence sweep is first-party-only tooling; without
  // it, "System attention" simply never has anything to show.
  let coherenceFindings:
    | { rule: string; disposition: string; observedAt: number }[]
    | undefined = EMPTY_COHERENCE_FINDINGS;
  const systemAttention = useMemo(() => {
    const seen = new Set<string>();
    return (coherenceFindings ?? []).flatMap((finding) => {
      const copy = systemAttentionCopy(finding.rule);
      const answeredInRounds =
        copy?.rule === "frustration_without_disposition" &&
        roundsStatus?.discussedAt !== null &&
        roundsStatus?.discussedAt !== undefined &&
        roundsStatus.discussedAt >= finding.observedAt;
      // An unrecognised rule is dropped rather than rendered raw: a rule id is
      // not teacher-readable and must never reach the screen.
      if (!copy || answeredInRounds || seen.has(copy.rule)) return [];
      seen.add(copy.rule);
      return [{
        copy,
        needsDecision: systemAttentionNeedsDecision(finding.disposition),
        observedAt: finding.observedAt,
      }];
    });
  }, [coherenceFindings, roundsStatus]);

  const scholar = profile?.scholar ?? null;
  // ── Tiles ────────────────────────────────────────────────────────────
  const mastery = useMemo(() => {
    const nodes = frontier?.nodes ?? [];
    const by = (s: string) => nodes.filter((n) => n.status === s).length;
    const demonstrated = by("demonstrated");
    const inProgress = by("frontier") + by("probed");
    const gaps = by("gap");
    const scored = demonstrated + inProgress + gaps; // skip "locked" (unexplored)
    return { demonstrated, inProgress, gaps, scored, total: nodes.length };
  }, [frontier]);

  const openMisconceptions = useMemo(
    () => (masteryObs ?? []).filter((o) => o.misconceptionStatus === "open").length,
    [masteryObs],
  );

  // One clock for both weekly readings below, so they can never disagree about
  // where the rolling cutoff falls. Memoizing on `sessions` alone pinned the
  // window to the last query update: a session ageing past seven days did not
  // drop out until something unrelated re-rendered the feed.
  const nowMs = useNow(60_000);

  const sessionsThisWeek = useMemo(() => {
    const wk = nowMs - 7 * 864e5;
    return (sessions ?? []).filter((s) => (s.lastMessageAt ?? s._creationTime) >= wk).length;
  }, [sessions, nowMs]);

  // Sessions per day for the last 7 days → tiny bar chart.
  const weekBars = useMemo(() => {
    const days = Array.from({ length: 7 }, () => 0);
    const start = nowMs - 7 * 864e5;
    for (const s of sessions ?? []) {
      const t = s.lastMessageAt ?? s._creationTime;
      if (t >= start) {
        const idx = Math.min(6, Math.floor((t - start) / 864e5));
        days[idx]++;
      }
    }
    const max = Math.max(1, ...days);
    return days.map((d) => d / max);
  }, [sessions, nowMs]);

  const needsYou = mastery.gaps + openMisconceptions;

  // Latest session for the "Now" strip.
  const latest = useMemo(() => {
    const list = [...(sessions ?? [])].sort(
      (a, b) => (b.lastMessageAt ?? b._creationTime) - (a.lastMessageAt ?? a._creationTime),
    );
    return list[0] ?? null;
  }, [sessions]);

  // ── Activity feed — merge every real signal, reverse-chron ─────────────
  const items = useMemo<FeedEntry[]>(() => {
    const out: FeedEntry[] = [];
    const href = (sessionId?: string) =>
      sessionId ? `/scholar/${sessionId}?remote=${scholarId}` : undefined;

    for (const o of masteryObs ?? []) {
      if (o.misconceptionStatus === "open") {
        out.push({
          id: `mis-${o._id}`,
          ts: o.observedAt,
          freshnessTs: Math.max(o.observedAt, o._creationTime),
          marker: { kind: "misconception", stop: null },
          lead: (<><b>Misconception</b> surfaced — “{o.conceptLabel}”</>),
          meta: o.domain,
          chip: "un-teach",
          observationId: o._id,
        });
      } else if (o.masteryLevel >= 2.5) {
        out.push({
          id: `dem-${o._id}`,
          ts: o.observedAt,
          freshnessTs: Math.max(o.observedAt, o._creationTime),
          marker: { kind: "mastery", stop: (o.stop ?? null) as MasteryStop | null },
          lead: (<>Demonstrated <b>{o.conceptLabel}</b></>),
          meta: o.domain,
          bloomLevel: o.masteryLevel,
          fluencyLevel: o.fluencyLevel ?? null,
          fluencySource: o.fluencySource,
          observationId: o._id,
        });
      }
    }
    for (const p of portfolio ?? []) {
      const srcLabel: Record<string, string> = {
        photo: "Photo", upload: "Upload", manual: "Added", google_drive: "Drive",
      };
      out.push({
        id: `port-${p._id}`,
        ts: p._creationTime,
        emoji: "🖼️",
        iconBg: "cyan.100",
        lead: (<>Added <b>{p.title || "a piece"}</b> to the portfolio</>),
        meta: srcLabel[p.source] ?? "Work",
      });
    }
    for (const ob of observations ?? []) {
      out.push({ id: `obs-${ob._id}`, ts: ob._creationTime, observation: ob });
    }
    for (const f of aiCatches?.recent ?? []) {
      out.push({
        id: `ai-${f._id}`,
        ts: f.flaggedAt,
        emoji: "🎯",
        iconBg: "yellow.100",
        lead: (<><b>Caught the AI</b> — “{f.snippet.slice(0, 70)}{f.snippet.length > 70 ? "…" : ""}”</>),
        meta: "Healthy skepticism",
        href: href(f.sessionId),
      });
    }
    for (const s of seeds ?? []) {
      if (s.status === "dismissed") continue;
      if (s.status === "completed") continue;
      out.push({
        id: `seed-${s._id}`,
        ts: s._creationTime,
        emoji: "🌱",
        iconBg: "violet.100",
        lead: (<>New spark — <b>{s.topic}</b></>),
        meta: s.suggestionType.replace(/_/g, " "),
        seedAction: { seedId: s._id, added: s.status === "active" },
      });
    }
    // Reading level-ups: each history entry that rose above the previous.
    const hist = [...readingHistory].sort((a, b) => a._creationTime - b._creationTime);
    for (let i = 1; i < hist.length; i++) {
      if (READING_NUM(hist[i].level) > READING_NUM(hist[i - 1].level)) {
        out.push({
          id: `lvl-${hist[i]._id}`,
          ts: hist[i]._creationTime,
          emoji: "📈",
          iconBg: "violet.100",
          lead: (<>Reading level rose to <b>{fmtLevel(hist[i].level).replace("Gr", "Grade")}</b></>),
          meta: `up from ${fmtLevel(hist[i - 1].level)}`,
        });
      }
    }
    for (const s of sessions ?? []) {
      out.push({
        id: `sess-${s._id}`,
        ts: s.lastMessageAt ?? s._creationTime,
        emoji: "💬",
        iconBg: "violet.50",
        lead: (<><b>{s.title}</b></>),
        meta: `Tutoring session · ${s.messageCount} message${s.messageCount === 1 ? "" : "s"}`,
        href: href(String(s._id)),
      });
    }

    for (const t of physical ?? []) {
      out.push({
        id: `phys-${t.id}`,
        ts: t.completedAt,
        emoji: "🧭",
        iconBg: "teal.100",
        lead: (
          <>
            Explored <b>{t.equipmentName}</b> hands-on
          </>
        ),
        meta: t.spaceName ? `Hands-on · ${t.spaceName}` : "Hands-on exploration",
        href: href(String(t.sessionId)),
      });
    }

    // What the system itself noticed — the same signals that page a teacher in
    // Slack, kept in the scholar's record so the web UI is a complete account
    // rather than one that only exists in Slack scrollback. Glyphs match the
    // Slack ones where a kind has its own (🧗 practice, 😫 overwhelm) so the two
    // surfaces read as one vocabulary.
    for (const a of alertRecord ?? []) {
      const p = ALERT_PRESENTATION[a.kind];
      if (!p) continue;
      // Producer bodies are Slack-shaped; take the one informative sentence.
      const summary = alertLead(a.body);
      out.push({
        id: `alert-${a._id}`,
        ts: a.createdAt,
        emoji: p.emoji,
        iconBg: p.iconBg,
        lead: (<><b>{p.label}</b>{summary ? <> — {summary}</> : null}</>),
        meta: p.meta,
        href: a.sessionId ? href(String(a.sessionId)) : undefined,
      });
    }

    return out.sort((a, b) => b.ts - a.ts);
  }, [masteryObs, portfolio, physical, observations, aiCatches, seeds, readingHistory, sessions, alertRecord, scholarId]);
  const loading = profile === undefined || frontier === undefined || sessions === undefined;

  // ── Evidence snapshot ────────────────────────────────────────────────
  // The watermark comes from the evidence itself, never from a click-time
  // clock. Backdated observations use their insertion time for freshness while
  // retaining their real observed time for feed ordering.
  const evidenceWatermark = useMemo(
    () =>
      items.reduce(
        (max, item) => Math.max(max, item.freshnessTs ?? item.ts),
        0,
      ),
    [items],
  );
  const newCount = useMemo(
    () =>
      items.filter(
        (item) => (item.freshnessTs ?? item.ts) > (seenThrough ?? 0),
      ).length,
    [items, seenThrough],
  );
  const renderedItems = showAllNewEvidence
    ? items.filter(
        (item, index) =>
          index < 16 || (item.freshnessTs ?? item.ts) > (seenThrough ?? 0),
      )
    : items.slice(0, 16);
  const emitEvidenceSnapshot = useEffectEvent((snapshot: ScholarEvidenceSnapshot) => {
    onEvidenceSnapshot?.(snapshot);
  });
  useEffect(() => {
    if (loading) return;
    emitEvidenceSnapshot({
      scholarId,
      watermark: evidenceWatermark,
      newCount,
      total: items.length,
    });
  }, [loading, scholarId, evidenceWatermark, newCount, items.length]);

  // The staff aide is mounted globally in the teacher shell; when present, a
  // note's "Discuss" seeds its composer (no new chat surface).
  const aide = useAideDockOptional();
  const scholarFirstName = scholar?.name?.split(" ")[0] ?? null;

  const connection = reliance && reliance.length > 0 ? reliance[0] : null;

  return (
    <VStack gap={4} align="stretch" maxW="1100px">
      {/* Now strip — what's happening right now */}
      {latest && (
        <Surface px={4} py={3}>
          <HStack gap={3}>
            <Text fontSize="md" aria-hidden>📌</Text>
            <Text fontWeight="700" fontFamily="heading" fontSize="sm" color="navy.500" flexShrink={0}>
              Now
            </Text>
            <Text fontSize="sm" color="charcoal.500" fontFamily="body" lineClamp={1} flex={1} minW={0}>
              {latest.title}
              {latest.unitTitle ? ` · ${latest.unitEmoji ? latest.unitEmoji + " " : ""}${latest.unitTitle}` : ""}
              {" · "}
              {formatTimeAgo(latest.lastMessageAt ?? latest._creationTime)}
            </Text>
            <TileLink label="Portfolio" onClick={onOpenTab ? () => onOpenTab("portfolio") : undefined} />
          </HStack>
        </Surface>
      )}

      {/* Stat tiles — the profile "header" */}
      <Box
        display="grid"
        gridTemplateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }}
        gap={3}
      >
        {/* Engagement carries no destination of its own — the observer's read
            lives here and nowhere else, so the tile informs without pretending
            to be a door. */}
        <Tile label="Engagement">
          {pulse && pulse.sparkline.length > 0 ? (
            <>
              <HStack gap={1.5} align="baseline">
                <Text fontSize="xl" fontWeight="800" fontFamily="heading" color={endColorFor(attentionFor(pulse).level)} lineHeight="1">
                  {pulse.latestEngagement != null ? pct(pulse.latestEngagement) : "—"}
                </Text>
                {pulse.trend && pulse.trend !== "flat" && pulse.trendDelta != null && (
                  <Text
                    fontSize="2xs"
                    fontWeight="700"
                    fontFamily="heading"
                    color={pulse.trend === "down" ? "#c56a4d" : "green.600"}
                  >
                    {fmtDelta(pulse.trendDelta)} pts
                  </Text>
                )}
              </HStack>
              <Box my="5px">
                <PulseSparkline
                  pulse={pulse}
                  scholarName={scholar?.name}
                  showValue={false}
                  width={150}
                  height={24}
                />
              </Box>
              <Text fontSize="2xs" color="charcoal.500" fontFamily="heading" lineHeight="1.35">
                How absorbed in each session
              </Text>
              <Text fontSize="2xs" color="charcoal.300" fontFamily="body" lineHeight="1.3">
                observer&rsquo;s read · {pulse.analyzedSessions} session
                {pulse.analyzedSessions === 1 ? "" : "s"}, {Math.round(pulseWindowDays / 7)} wks
              </Text>
            </>
          ) : (
            <>
              <Text fontSize="xl" fontWeight="800" fontFamily="heading" color="charcoal.300" lineHeight="1">
                —
              </Text>
              <Box h="24px" my="5px" />
              <Text fontSize="2xs" color="charcoal.500" fontFamily="heading" lineHeight="1.35">
                No observer readings yet
              </Text>
              <Text fontSize="2xs" color="charcoal.300" fontFamily="body" lineHeight="1.3">
                fills in as {scholar?.name?.split(" ")[0] ?? "they"} works with the tutor
              </Text>
            </>
          )}
        </Tile>

        <Tile label="Reading" onClick={onOpenReading ?? (onOpenTab ? () => onOpenTab("map") : undefined)}>
          <Text fontSize="xl" fontWeight="800" fontFamily="heading" color="navy.500" lineHeight="1">
            {fmtLevel(scholar?.readingLevel)}
          </Text>
          <ReadingSpark history={readingHistory} />
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
            {readingTileCaption({ readingLevel: scholar?.readingLevel, historyLength: readingHistory.length })}
          </Text>
        </Tile>

        <Tile
          label="To re-teach"
          onClick={onOpenTab ? () => onOpenTab("map") : undefined}
        >
          <Text fontSize="xl" fontWeight="800" fontFamily="heading" color={needsYou > 0 ? endColorFor("concern") : "navy.500"} lineHeight="1">
            {needsYou}
          </Text>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" mt={2}>
            {mastery.gaps} gap{mastery.gaps === 1 ? "" : "s"} · {openMisconceptions} to un-teach
          </Text>
        </Tile>

        <Tile label="Sessions" onClick={onOpenTab ? () => onOpenTab("portfolio") : undefined}>
          <Text fontSize="xl" fontWeight="800" fontFamily="heading" color="navy.500" lineHeight="1">
            {sessionsThisWeek}
          </Text>
          <HStack gap="3px" align="flex-end" h="16px" my="3px">
            {weekBars.map((h, i) => (
              <Box
                key={i}
                flex={1}
                bg={i === weekBars.length - 1 ? "violet.500" : "violet.100"}
                borderRadius="2px"
                h={`${Math.max(8, h * 100)}%`}
              />
            ))}
          </HStack>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">this week</Text>
        </Tile>

      </Box>

      {/* A citation, not a door: where this scholar was last talked about, so a
          reader knows the record exists. One date only — the Rounds week the
          discussion belongs to. The note's write timestamp is a different fact
          and rendering both put two dates of different meaning side by side,
          in disagreeing formats, with the later one last. */}
      {canRounds && roundsStatus && (
        <Text fontSize="xs" color="charcoal.400" fontFamily="body">
          Last discussed in Rounds · {roundsWeekLabel(roundsStatus.weekKey)}
        </Text>
      )}

      {/* System attention — what the coherence sweep found about our own
          representation of this scholar. One compact group in the canonical
          feed, deliberately NOT a second dashboard: Rounds picks it up by
          composing this component. Controlled metadata only — fixed copy per
          rule, no ids, no source refs, no learner text. */}
      {systemAttention.length > 0 && (
        <Surface px={4} py={3}>
          <Text
            fontSize="2xs"
            color="charcoal.300"
            fontFamily="heading"
            fontWeight="700"
            textTransform="uppercase"
            letterSpacing="wider"
          >
            {systemAttentionHeadline(systemAttention.length)}
          </Text>
          <VStack align="stretch" gap={2} mt={2}>
            {systemAttention.map(({ copy, needsDecision, observedAt }) => (
              <Flex key={copy.rule} gap={2.5} align="flex-start">
                <Box
                  mt="6px"
                  w="6px"
                  h="6px"
                  borderRadius="full"
                  flexShrink={0}
                  bg={copy.colorPalette === "amber" ? "amber.400" : "violet.400"}
                />
                <Box>
                  <Text fontSize="sm" fontWeight="600" fontFamily="heading" color="navy.500">
                    {copy.label}
                    {needsDecision && (
                      <Text as="span" fontSize="2xs" color="charcoal.300" fontFamily="heading" ml={1.5}>
                        · waiting on us
                      </Text>
                    )}
                  </Text>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                    {copy.help} Noticed {formatTimeAgo(observedAt)}.
                  </Text>
                </Box>
              </Flex>
            ))}
          </VStack>
        </Surface>
      )}

      {/* Activity feed */}
      <Box>
        <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" fontWeight="700" textTransform="uppercase" letterSpacing="wider" mb={2}>
          Activity
        </Text>

        {loading ? (
          <Flex justify="center" py={8}><Spinner size="sm" color="violet.500" /></Flex>
        ) : (
          <VStack gap="7px" align="stretch">
            {/* Pinned connection flag. Same Post shell as every other row —
                pinning is the only difference, so it must not also look like a
                different KIND of thing (one canonical rendering per signal). */}
            {connection && (
              <Post
                item={{
                  id: `connection-${connection._id}`,
                  ts: connection.createdAt,
                  emoji: "🫂",
                  iconBg: "amber.100",
                  lead: (
                    <>
                      <b>Connection note</b> — leaning on the tutor for company; a human check-in may help.
                    </>
                  ),
                  meta: "Noticed by the observer",
                }}
                canCurate={canCurate}
              />
            )}

            {renderedItems.length === 0 && !connection ? (
              <Surface px={4} py={6}>
                <Text fontSize="sm" color="charcoal.300" fontFamily="heading" textAlign="center">
                  No activity yet — this fills in as {scholar?.name?.split(" ")[0] ?? "the scholar"} works with the tutor.
                </Text>
              </Surface>
            ) : (
              renderedItems.map((it) =>
                it.observation ? (
                  <ObservationCard
                    key={it.id}
                    observation={it.observation}
                    scholarFirstName={scholarFirstName}
                    clamp={2}
                    onOpen={onOpenTab ? () => onOpenTab("dossier") : undefined}
                    onDiscuss={aide ? (prompt) => aide.seedComposer(prompt) : undefined}
                  />
                ) : (
                  <Post key={it.id} item={it} onOpenObservation={onOpenObservation} canCurate={canCurate} />
                ),
              )
            )}

            {items.length > renderedItems.length && (
              <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" textAlign="center" pt={1}>
                Showing the {renderedItems.length} most recent of {items.length} events.
              </Text>
            )}
          </VStack>
        )}
      </Box>
    </VStack>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

function Tile({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      shadow="xs"
      px={4}
      py={3}
      cursor={onClick ? "pointer" : undefined}
      _hover={onClick ? { borderColor: "violet.200" } : undefined}
      onClick={onClick}
    >
      <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" fontWeight="700" textTransform="uppercase" letterSpacing="wide" mb={1}>
        {label}
      </Text>
      {children}
    </Box>
  );
}

function ReadingSpark({ history }: { history: { level: string; _creationTime: number }[] }) {
  if (history.length < 2) {
    return <Box h="16px" my="3px" />;
  }
  const pts = [...history].reverse().map((h) => READING_NUM(h.level));
  const minY = Math.min(...pts);
  const maxY = Math.max(...pts);
  const range = maxY - minY || 1;
  const W = 80;
  const H = 18;
  const xStep = pts.length > 1 ? W / (pts.length - 1) : 0;
  const poly = pts
    .map((v, i) => `${(i * xStep).toFixed(1)},${(H - ((v - minY) / range) * H).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "16px", margin: "3px 0" }}>
      <polyline points={poly} fill="none" stroke="#a960bc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SeedItButton({
  seedId,
  added,
  canCurate,
}: {
  seedId: Id<"seeds">;
  added: boolean;
  canCurate: boolean;
}) {
  const review = useMutation(api.seeds.review);
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    setBusy(true);
    try {
      await review({ id: seedId, action: "accept" });
    } catch (err) {
      console.error("Error adding seed:", err);
    } finally {
      setBusy(false);
    }
  };

  // Already in the scholar's sky — a settled, read-only "Added" state.
  if (added) {
    return (
      <HStack gap={1} flexShrink={0} alignSelf="center" color="green.600">
        <Check weight="bold" size={12} />
        <Text fontSize="xs" fontWeight="700" fontFamily="heading">Added</Text>
      </HStack>
    );
  }

  // Registrars see the feed but can't curate seeds — show a neutral spark chip.
  if (!canCurate) {
    return (
      <Text
        flexShrink={0}
        alignSelf="center"
        fontSize="2xs"
        fontWeight="700"
        color="violet.700"
        bg="violet.50"
        borderWidth="1px"
        borderColor="violet.100"
        borderRadius="md"
        px="6px"
        py="1px"
        fontFamily="heading"
      >
        spark
      </Text>
    );
  }

  return (
    <Button
      size="xs"
      variant="ghost"
      color="violet.500"
      fontFamily="heading"
      fontSize="xs"
      flexShrink={0}
      alignSelf="center"
      _hover={{ bg: "violet.50" }}
      onClick={handleAdd}
      loading={busy}
      disabled={busy}
    >
      <Plant weight="duotone" style={{ marginRight: "3px" }} /> Add Seed
    </Button>
  );
}

function Post({
  item,
  onOpenObservation,
  canCurate,
}: {
  item: FeedItem;
  onOpenObservation?: (observationId: string) => void;
  canCurate?: boolean;
}) {
  const clickable = !!(item.observationId && onOpenObservation);
  const bloom = item.bloomLevel != null ? bloomLabel(item.bloomLevel) : null;
  const inner = (
    <Flex
      gap={3}
      align="flex-start"
      bg="white"
      borderWidth="1px"
      borderColor="charcoal.100"
      borderRadius="xl"
      px={3}
      py={2.5}
      boxShadow="0 1px 2px rgba(34,38,86,.05)"
      _hover={item.href || clickable ? { borderColor: "violet.200" } : undefined}
      cursor={item.href || clickable ? "pointer" : undefined}
    >
      {item.marker ? (
        <MasteryMarker kind={item.marker.kind} stop={item.marker.stop} size={34} />
      ) : (
        <Flex
          w="34px"
          h="34px"
          borderRadius="full"
          bg={item.iconBg}
          align="center"
          justify="center"
          flexShrink={0}
          fontSize="14px"
        >
          <span aria-hidden>{item.emoji}</span>
        </Flex>
      )}
      <Box flex={1} minW={0}>
        <Text fontSize="sm" color="charcoal.600" fontFamily="body" lineHeight="1.3">
          {item.lead}
        </Text>
        <HStack gap={2} mt="1px" flexWrap="wrap">
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
            {item.meta} · {formatTimeAgo(item.ts)}
          </Text>
          {/* Neutral depth + automaticity glyphs (colour stays on the marker). */}
          {bloom && (
            <HStack gap={1} title={`Depth: ${bloom}`}>
              <BloomLadder level={item.bloomLevel} size={10} title={`Depth: ${bloom}`} />
              <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" textTransform="lowercase">
                {bloom}
              </Text>
            </HStack>
          )}
          {item.fluencyLevel ? (
            <Automaticity level={item.fluencyLevel} source={item.fluencySource} size={11} />
          ) : null}
          {item.chip && (
            <Text fontSize="2xs" fontWeight="700" color="violet.700" bg="violet.50" borderWidth="1px" borderColor="violet.100" borderRadius="md" px="6px" py="1px" fontFamily="heading">
              {item.chip}
            </Text>
          )}
        </HStack>
      </Box>
      {item.seedAction && (
        <SeedItButton
          seedId={item.seedAction.seedId}
          added={item.seedAction.added}
          canCurate={!!canCurate}
        />
      )}
    </Flex>
  );
  if (item.href) {
    return (
      <a href={item.href} target="_blank" rel="noopener" style={{ textDecoration: "none", color: "inherit" }}>
        {inner}
      </a>
    );
  }
  if (clickable) {
    return (
      <Box
        as="button"
        w="full"
        textAlign="left"
        data-testid="feed-observation-row"
        data-observation-id={item.observationId}
        onClick={() => onOpenObservation!(item.observationId!)}
      >
        {inner}
      </Box>
    );
  }
  return inner;
}

function TileLink({ label, onClick, color = "violet.700" }: { label: string; onClick?: () => void; color?: string }) {
  // A pure affordance: with no handler there is nothing behind it, so it must
  // not render at all rather than look like a door that opens nowhere.
  if (!onClick) return null;
  return (
    <HStack
      as="button"
      gap={1}
      onClick={onClick}
      flexShrink={0}
      color={color}
      _hover={{ textDecoration: "underline" }}
    >
      <Text fontSize="xs" fontWeight="600" fontFamily="heading">{label}</Text>
      <ArrowRight size={13} />
    </HStack>
  );
}
