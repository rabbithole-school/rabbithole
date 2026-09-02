"use client";

/**
 * The kind="game" section of the activity editor.
 *
 * A game activity references a game by id from `GAME_CATALOG`. The catalog is
 * CODE, not a table — a fleet iPad only runs the games its build contains, so a
 * database row would immediately drift from the binary. That means this picker
 * lists exactly what the current build ships, which is the honest list.
 *
 * The platform line here is rendered from the SAME `platform` declaration the
 * scholar's capability notice reads (`platformNotice()`), so the requirement is
 * visible at authoring and assign time rather than at discovery time.
 *
 * There is deliberately no score, credit, unlock or threshold field: a game
 * emits evidence and the server draws conclusions. Nothing a teacher types here
 * can grade a scholar.
 */

import { Box, Stack, Text } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import { GAME_CATALOG, getGame, type GameCatalogEntry } from "@/lib/games/catalog";
import { platformNotice } from "@/lib/games/contract";
import { Field } from "./shared";

const selectStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "13px",
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  fontFamily: "var(--chakra-fonts-heading)",
  background: "white",
};

export function GameActivityFields({
  activityId,
  gameId,
  missingGame,
  update,
}: {
  activityId: Id<"activities">;
  gameId: string | null;
  missingGame: boolean;
  update: (args: {
    id: Id<"activities">;
    game?: { gameId: string; configJson?: string } | null;
  }) => void;
}) {
  const entries: GameCatalogEntry[] = Object.values(GAME_CATALOG);
  const selected = gameId ? getGame(gameId) : null;

  return (
    <Stack gap={3}>
      <Field
        label="Game"
        hint="Games ship with the app, so this list is exactly what the iPads are running."
      >
        <select
          style={{
            ...selectStyle,
            borderColor: missingGame ? "#e53e3e" : "#e2e8f0",
          }}
          value={gameId ?? ""}
          onChange={(e) => {
            const next = e.target.value;
            update({
              id: activityId,
              game: next ? { gameId: next } : null,
            });
          }}
        >
          <option value="">Pick a game…</option>
          {entries.map((g) => (
            <option key={g.gameId} value={g.gameId}>
              {g.title}
            </option>
          ))}
        </select>
      </Field>
      {selected && (
        <Box
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="md"
          bg="gray.50"
          px={3}
          py={2}
        >
          <Text fontSize="xs" color="charcoal.500" fontFamily="body">
            {selected.blurb}
          </Text>
          <Text
            fontSize="2xs"
            color="charcoal.400"
            fontFamily="heading"
            mt={1.5}
          >
            {platformNotice(selected.title, selected.platform)} Scholars on a
            laptop see that notice instead of the game.
          </Text>
        </Box>
      )}
    </Stack>
  );
}
