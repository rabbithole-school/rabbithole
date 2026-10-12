"use client";

// A staff-only row in a session transcript for one in-app AI turn
// (`appAiTurns`, read through `api.appAi.listForSession`): the scholar's line
// to the app's character and the character's reply, a judge's ruling, a line
// the tutor spoke through the character, or the tutor's standing direction.
// Rendered inline in time order beside the chat, visibly NOT a chat bubble:
// the character's words are tagged "in character" so a reader never takes
// them for the scholar's or the tutor's. The owning scholar never sees these
// rows (the app already shows them the scene).

import { Box, Flex, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

import type { AppAiTurnView } from "@/convex/appAi";
import { normalizeAppAiContext } from "@/shared/appAiPolicy";

/** The character's name for a turn, by the artifact that hosts it. */
export type AppCharacterNames = Readonly<Record<string, string>>;

function Label({ children }: { children: ReactNode }) {
  return (
    <Text
      as="span"
      fontSize="xs"
      fontFamily="heading"
      fontWeight="600"
      color="charcoal.400"
    >
      {children}
    </Text>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <Text
      as="span"
      fontSize="xs"
      fontFamily="heading"
      color="charcoal.400"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="full"
      px={1.5}
    >
      {children}
    </Text>
  );
}

function Line({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="sm" fontFamily="body" color="charcoal.600" whiteSpace="pre-wrap">
      {children}
    </Text>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="xs" fontFamily="body" color="charcoal.400">
      {children}
    </Text>
  );
}

/** "verdict: pass", with the tutor's overrule when there is one. */
function verdictText(turn: AppAiTurnView): string | null {
  if (!turn.verdict && !turn.verdictOverride) return null;
  if (turn.verdictOverride) {
    return `verdict: ${turn.verdict ?? "none"} — overruled by the tutor: ${turn.verdictOverride.verdict}`;
  }
  return `verdict: ${turn.verdict}`;
}

/**
 * The app's context for a turn (stored as JSON) as quiet meta text — values
 * in key order, `rule · wiring · stage 2`. A number or boolean says nothing
 * alone, so it keeps its key. Null when it does not parse to a flat object.
 */
export function appContextText(raw: string | undefined): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const context = normalizeAppAiContext(parsed);
  if (!context) return null;
  return Object.entries(context)
    .map(([key, value]) =>
      typeof value === "string" ? value : `${key} ${String(value)}`,
    )
    .join(" · ");
}

function replyState(turn: AppAiTurnView): string | null {
  if (turn.status === "pending") return "Waiting for a reply…";
  if (turn.status === "failed") return "No reply (the call failed)";
  return null;
}

export function AppAiTurnRow({
  turn,
  characterNames,
}: {
  turn: AppAiTurnView;
  characterNames: AppCharacterNames;
}) {
  const name = characterNames[turn.artifactId] ?? "Character";
  const verdict = verdictText(turn);
  const state = replyState(turn);
  const mood = turn.mood ? `mood: ${turn.mood}` : null;
  const context = appContextText(turn.appContext);
  const facts = [mood, verdict, context].filter(Boolean).join(" · ");

  let body: ReactNode;
  switch (turn.kind) {
    case "exchange":
      body = (
        <>
          <Label>Scholar → {name}</Label>
          <Line>{turn.scholarLine}</Line>
          <Flex align="center" gap={1.5} mt={1.5}>
            <Label>{name}</Label>
            <Tag>in character</Tag>
          </Flex>
          {state ? <Muted>{state}</Muted> : <Line>{turn.line}</Line>}
          {facts && <Muted>{facts}</Muted>}
        </>
      );
      break;
    case "aside":
      body = (
        <>
          <Flex align="center" gap={1.5}>
            <Label>{name}</Label>
            <Tag>in character</Tag>
            <Label>· spoken by the tutor</Label>
          </Flex>
          <Line>{turn.line}</Line>
          {facts && <Muted>{facts}</Muted>}
        </>
      );
      break;
    case "judgment":
      body = (
        <>
          <Label>Scholar&apos;s answer → judge &ldquo;{turn.judgeId}&rdquo;</Label>
          <Line>{turn.scholarLine}</Line>
          <Box mt={1.5}>
            <Label>
              {`judge "${turn.judgeId}": ${state ?? turn.verdict ?? "no verdict"}`}
            </Label>
          </Box>
          {turn.feedback && <Line>{turn.feedback}</Line>}
          {turn.verdictOverride && (
            <Muted>{`Overruled by the tutor: ${turn.verdictOverride.verdict}`}</Muted>
          )}
          {context && <Muted>{context}</Muted>}
        </>
      );
      break;
    case "direction":
      body = (
        <>
          <Label>Teachers only · tutor direction to {name}</Label>
          <Line>
            {turn.direction?.trim() ? turn.direction : "(direction cleared)"}
          </Line>
        </>
      );
      break;
  }

  return (
    <Box
      alignSelf="stretch"
      mx={{ base: 0, md: 6 }}
      px={3}
      py={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      bg="white"
    >
      {body}
    </Box>
  );
}

export type ThreadItem<T> =
  | { kind: "message"; item: T }
  | { kind: "appAi"; turn: AppAiTurnView };

/**
 * Merge in-app AI turns into a rendered message list by time without
 * reordering the messages themselves (their order is the transcript's,
 * optimistic rows included): each turn goes before the first message that
 * is newer than it, and turns newer than every message go last.
 */
export function interleaveAppAiTurns<T>(
  items: readonly T[],
  turns: readonly AppAiTurnView[],
  timeOf: (item: T) => number,
): ThreadItem<T>[] {
  const merged: ThreadItem<T>[] = [];
  let next = 0;
  for (const item of items) {
    const time = timeOf(item);
    while (next < turns.length && turns[next].createdAt < time) {
      merged.push({ kind: "appAi", turn: turns[next++] });
    }
    merged.push({ kind: "message", item });
  }
  while (next < turns.length) merged.push({ kind: "appAi", turn: turns[next++] });
  return merged;
}

/** artifactId → character name, from the session's code artifacts. */
export function appCharacterNamesFrom(
  artifacts: readonly {
    _id: string;
    type?: string;
    appAi?: { character?: { name: string } } | null;
  }[],
): AppCharacterNames {
  const names: Record<string, string> = {};
  for (const artifact of artifacts) {
    const name = artifact.appAi?.character?.name;
    if (artifact.type === "code" && name) names[artifact._id] = name;
  }
  return names;
}
