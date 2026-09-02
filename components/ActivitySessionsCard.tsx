"use client";

/**
 * Teacher view of a scholar's recent **non-chat activity sessions** — the work
 * that doesn't live in a `sessions` row because it isn't a conversation.
 *
 * Two sources feed one time-ordered list:
 *  - **Web assignments** (kind="web") — a locked webview on an external site;
 *    the capture pipeline extracts XP/tasks and screenshots.
 *  - **Games** (kind="game") — an iPad-only game; the server-built digest is
 *    what's shown, never raw game state.
 *
 * One list, not two cards. A teacher scanning "what did this kid do that wasn't
 * a chat?" is asking one question; the source icon answers "which kind" without
 * making them read two separately-sorted panels. Adding a third source later
 * costs a row renderer, not a card.
 *
 * Reviewing is not playing: games are iPad-only, but their evidence is fully
 * readable here on a laptop. That asymmetry is deliberate.
 *
 * Mounted on the teacher's ScholarProfile overview tab (teacher mode only —
 * both backing queries are teacher-gated). Renders nothing when there's
 * nothing to show, same convention as the other per-scholar panels.
 */

import { useQuery } from "convex/react";
import { Badge, Box, HStack, Stack, Text } from "@chakra-ui/react";
import { GameController, GlobeSimple, Warning } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h}h ${minutes % 60}m`;
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type WebRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.webActivitySessions.listRecentForScholar>>
>[number];
type GameRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.games.listRecentForScholar>>
>[number];

type Row =
  | { source: "web"; startedAt: number; key: string; web: WebRow }
  | { source: "game"; startedAt: number; key: string; game: GameRow };

const CARD_PROPS = {
  bg: "white",
  borderRadius: "lg",
  borderWidth: "1px",
  borderColor: "gray.200",
  shadow: "xs",
  p: 3,
} as const;

export function ActivitySessionsCard({
  scholarId,
  limit = 5,
}: {
  scholarId: Id<"users">;
  limit?: number;
}) {
  const webSessions = useQuery(api.webActivitySessions.listRecentForScholar, {
    scholarId,
    limit,
  });
  const gameSessions = useQuery(api.games.listRecentForScholar, {
    scholarId,
    limit,
  });

  const rows: Row[] = [
    ...(webSessions ?? []).map(
      (s): Row => ({
        source: "web",
        startedAt: s.startedAt,
        key: `web:${s._id}`,
        web: s,
      }),
    ),
    ...(gameSessions ?? []).map(
      (s): Row => ({
        source: "game",
        startedAt: s.startedAt,
        key: `game:${s._id}`,
        game: s,
      }),
    ),
  ]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);

  if (rows.length === 0) return null;

  return (
    <Box>
      <HStack mb={3}>
        <GlobeSimple color="#AD60BF" />
        <Text
          fontWeight="600"
          fontFamily="heading"
          color="navy.500"
          fontSize="sm"
        >
          Activity sessions
        </Text>
      </HStack>
      <Stack gap={3}>
        {rows.map((row) =>
          row.source === "web" ? (
            <WebSessionRow key={row.key} s={row.web} />
          ) : (
            <GameSessionRow key={row.key} s={row.game} />
          ),
        )}
      </Stack>
    </Box>
  );
}

function SourceIcon({ source }: { source: "web" | "game" }) {
  return source === "web" ? (
    <GlobeSimple size={13} color="var(--chakra-colors-charcoal-400)" />
  ) : (
    <GameController size={13} color="var(--chakra-colors-charcoal-400)" />
  );
}

function WebSessionRow({ s }: { s: WebRow }) {
  const xp =
    s.extracted?.xpToday !== undefined && s.extracted?.xpGoal !== undefined
      ? `${s.extracted.xpToday}/${s.extracted.xpGoal} XP`
      : null;
  const goalMet =
    !!xp &&
    (s.extracted!.xpGoal ?? 0) > 0 &&
    (s.extracted!.xpToday ?? 0) >= (s.extracted!.xpGoal ?? 0);
  const course = s.extracted?.courseName?.trim() || null;

  return (
    <Box {...CARD_PROPS}>
      <HStack justify="space-between" flexWrap="wrap" gap={2}>
        <Stack gap={0} minW={0}>
          <HStack gap={1.5} minW={0}>
            <SourceIcon source="web" />
            <Text
              fontFamily="heading"
              fontSize="sm"
              fontWeight="600"
              color="navy.500"
              lineClamp={1}
            >
              {s.activityTitle}
            </Text>
          </HStack>
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
            {course ? `${course} · ` : ""}
            {formatWhen(s.startedAt)} · {formatDuration(s.durationMs)}
            {s.endedAt === null ? " · in session" : ""}
          </Text>
        </Stack>
        <HStack gap={1.5} flexShrink={0}>
          {xp && (
            <Badge
              bg={goalMet ? "green.100" : "violet.100"}
              color={goalMet ? "green.700" : "violet.700"}
              fontSize="2xs"
              fontFamily="heading"
            >
              {xp}
            </Badge>
          )}
          {s.extracted?.tasksCompletedToday !== undefined && (
            <Badge
              bg="gray.100"
              color="charcoal.600"
              fontSize="2xs"
              fontFamily="heading"
            >
              {s.extracted.tasksCompletedToday}{" "}
              {s.extracted.tasksCompletedToday === 1 ? "task" : "tasks"}
            </Badge>
          )}
          {s.offDomainBlocks > 0 && (
            <Badge
              bg="orange.100"
              color="orange.700"
              fontSize="2xs"
              fontFamily="heading"
            >
              <Warning size={10} style={{ marginRight: 2 }} />
              {s.offDomainBlocks} blocked
            </Badge>
          )}
        </HStack>
      </HStack>
      {s.summary ? (
        <Text
          fontSize="xs"
          color="charcoal.600"
          fontFamily="body"
          fontStyle="italic"
          mt={1.5}
          lineClamp={3}
        >
          {s.summary}
        </Text>
      ) : (
        s.extracted?.taskSummaries &&
        s.extracted.taskSummaries.length > 0 && (
          <Text
            fontSize="xs"
            color="charcoal.500"
            fontFamily="body"
            mt={1.5}
            lineClamp={2}
          >
            {s.extracted.taskSummaries.slice(0, 4).join(" · ")}
          </Text>
        )
      )}
      {s.screenshotUrls.length > 0 && (
        <HStack gap={2} mt={2} overflowX="auto" pb={1}>
          {s.screenshotUrls.map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noopener">
              {/* eslint-disable-next-line @next/next/no-img-element -- Convex storage URLs are ephemeral signed URLs; next/image adds nothing here */}
              <img
                src={u}
                alt={`Session screenshot ${i + 1}`}
                style={{
                  height: 72,
                  borderRadius: 6,
                  border: "1px solid var(--chakra-colors-gray-200)",
                  display: "block",
                  maxWidth: "none",
                }}
              />
            </a>
          ))}
        </HStack>
      )}
    </Box>
  );
}

/**
 * A game session reads as: how long, what they predicted, what happened, and
 * where they changed their mind. Deliberately NOT "how they scored" — the
 * digest carries no verdict, and this surface must not invent one. The claimed
 * outcome is labelled as the game's word, not a grade.
 */
function GameSessionRow({ s }: { s: GameRow }) {
  const d = s.digest;
  const revisions = d?.revisions ?? [];
  const predictions = d?.predictions ?? [];
  const helps = d?.helpRequests ?? [];
  const explanations = d?.scholarExplanations ?? [];
  const localRuleResults = d?.localRuleResults ?? [];
  const resolved = predictions.filter((p) => p.outcome);

  return (
    <Box {...CARD_PROPS}>
      <HStack justify="space-between" flexWrap="wrap" gap={2}>
        <Stack gap={0} minW={0}>
          <HStack gap={1.5} minW={0}>
            <SourceIcon source="game" />
            <Text
              fontFamily="heading"
              fontSize="sm"
              fontWeight="600"
              color="navy.500"
              lineClamp={1}
            >
              {s.activityTitle}
            </Text>
          </HStack>
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
            {s.gameTitle} · {formatWhen(s.startedAt)} ·{" "}
            {formatDuration(s.activeMs)} playing
            {s.status === "active" ? " · in session" : ""}
            {s.status === "crashed" ? " · ended early" : ""}
          </Text>
        </Stack>
        <HStack gap={1.5} flexShrink={0}>
          {resolved.length > 0 && (
            <Badge
              bg="violet.100"
              color="violet.700"
              fontSize="2xs"
              fontFamily="heading"
            >
              {resolved.length}{" "}
              {resolved.length === 1 ? "prediction" : "predictions"}
            </Badge>
          )}
          {revisions.length > 0 && (
            <Badge
              bg="green.100"
              color="green.700"
              fontSize="2xs"
              fontFamily="heading"
            >
              {revisions.length}{" "}
              {revisions.length === 1 ? "rethink" : "rethinks"}
            </Badge>
          )}
          {helps.length > 0 && (
            <Badge
              bg="orange.100"
              color="orange.700"
              fontSize="2xs"
              fontFamily="heading"
            >
              {helps.length} stuck
            </Badge>
          )}
        </HStack>
      </HStack>

      {revisions.length > 0 && (
        <Stack gap={0.5} mt={1.5}>
          {revisions.slice(0, 3).map((r) => (
            <Text
              key={r.seq}
              fontSize="xs"
              color="charcoal.600"
              fontFamily="body"
              lineClamp={2}
            >
              <b>{r.label}:</b> {r.before} → {r.after}
              {r.triggeredBy ? ` (after ${r.triggeredBy.summary})` : ""}
            </Text>
          ))}
        </Stack>
      )}
      {explanations.length > 0 && (
        <Text
          fontSize="xs"
          color="charcoal.600"
          fontFamily="body"
          fontStyle="italic"
          mt={1.5}
          lineClamp={3}
        >
          “{explanations[explanations.length - 1]!.detail}”
        </Text>
      )}
      {localRuleResults.length > 0 && (
        <Stack gap={0.5} mt={1.5}>
          {localRuleResults.slice(-3).map((result) => (
            <Text
              key={result.seq}
              fontSize="xs"
              color="charcoal.600"
              fontFamily="body"
              lineClamp={2}
            >
              <b>{result.label}:</b> {result.detail}
            </Text>
          ))}
        </Stack>
      )}
      {d?.outcomeClaim && (
        <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" mt={1.5}>
          Game reported: {d.outcomeClaim.outcomeKey}
        </Text>
      )}
    </Box>
  );
}
