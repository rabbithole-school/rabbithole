"use client";

/**
 * GraphemeInventoryEditor — the teacher's control for a pre-reader's reading-ramp
 * grapheme teams (young-learners-plan.html §10).
 *
 * A pre-reader sees the tutor's on-screen text with grapheme teams ("sh", "th",
 * "ea", …) color-coded as training wheels that FADE per-team as her decoding
 * confidence grows (see components/GraphemeText.tsx). This editor is where a
 * teacher curates that per-team fade state: add the teams the scholar is
 * currently working, cycle each through training → fading → graduated, and
 * remove one. It writes the whole list through `graphemeInventory.upsert`
 * (teacher-gated), which also records every stage transition to the durable
 * `graphemeHistory` arc (a portfolio milestone, §10).
 *
 * It renders ONLY in the Reading Level neighborhood for a `pre-reader` scholar
 * (the caller gates on `isPreReader`); no other tier uses the ramp.
 *
 * Team chips render in the SAME palette + fade the child sees (via GraphemeText),
 * so the teacher's editor and the scholar's screen can never drift.
 */

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import {
  Box,
  Flex,
  HStack,
  VStack,
  Text,
  Input,
  Button,
  IconButton,
  Spinner,
} from "@chakra-ui/react";
import { TextAa, Trash, Plus } from "@phosphor-icons/react";
import { GraphemeText } from "@/components/GraphemeText";
import { FieldSelect } from "@/components/ui/FieldSelect";
import type { GraphemeInventoryTeam } from "@/convex/lib/graphemeAnnotate";
import type { GraphemeStage } from "@/shared/graphemeSegments";

// Curated common early grapheme teams (young-learners-plan.html §10), offered as
// one-tap "add" suggestions. Free-text entry is also allowed (2–4 letters).
//
// "silent-e" is the magic-e split pattern (e.g. cak·e, rid·e) — a real early
// scaffold named in §10 — BUT the v1 annotator (convex/lib/graphemeAnnotate.ts)
// can only mark a CONTIGUOUS [start,end) run, and magic-e is discontinuous
// (vowel … consonant … silent e), so it cannot be colored yet (documented +
// deferred there). It's kept in this list for completeness but offered as a
// DISABLED suggestion, so a teacher is never led to add a team the ramp can't
// yet render. (Drop the disable when the annotator grows a split-span shape.)
const COMMON_EARLY_TEAMS = [
  "sh",
  "ch",
  "th",
  "wh",
  "ck",
  "ng",
  "ai",
  "ay",
  "ea",
  "ee",
  "oa",
  "oo",
  "silent-e",
] as const;

// A team a teacher may add: lowercase letters only, 2–4 of them. Slightly
// stricter than the server's normalizeInventoryTeams (≥2 letters) — a UI guard
// that keeps the annotator's real-team assumption honest and rejects silent-e's
// hyphen. The server re-normalizes on save regardless.
function isAddableTeam(raw: string): boolean {
  return /^[a-z]{2,4}$/.test(raw.trim().toLowerCase());
}

// Exposure count at or above which we nudge "consider fading". A deliberately
// coarse heuristic on a bounded, approximate count — a HINT for the teacher, not
// automation. The real promotion signal (observer-suggested fades from decoding
// behavior) is a §10 follow-up; a phonics-strand node dial may replace this
// count entirely once the Practice engine (#400) lands.
const FADE_HINT_THRESHOLD = 12;

const STAGE_OPTIONS: { value: GraphemeStage; label: string }[] = [
  { value: "training", label: "Training" },
  { value: "fading", label: "Fading" },
  { value: "graduated", label: "Graduated" },
];

/** "Jun 12" — the compact absolute date used in the history line. */
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function TeamGlyph({ team, stage }: { team: string; stage: GraphemeStage }) {
  // Render the team through the SAME path the scholar sees: a single span
  // covering the whole team, at its current stage. A graduated team renders as
  // plain ink (scaffold gone) — exactly what's on the child's screen.
  return (
    <Box fontSize="lg" fontFamily="heading" fontWeight="600" lineHeight="1">
      <GraphemeText
        text={team}
        spans={[{ start: 0, end: team.length, team }]}
        stages={{ [team]: stage }}
      />
    </Box>
  );
}

export function GraphemeInventoryEditor({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const inventory = useQuery(api.graphemeInventory.getForScholar, { scholarId });
  const history = useQuery(api.graphemeInventory.getGraphemeHistory, {
    scholarId,
  });
  const exposure = useQuery(api.graphemeInventory.teamExposureCounts, {
    scholarId,
  });
  const upsert = useMutation(api.graphemeInventory.upsert);

  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");

  const teams: GraphemeInventoryTeam[] = inventory?.teams ?? [];
  const present = new Set(teams.map((t) => t.team));

  const saveTeams = async (
    next: GraphemeInventoryTeam[],
    successTitle: string,
  ) => {
    setSaving(true);
    try {
      await upsert({ scholarId, teams: next });
      toaster.success({ title: successTitle });
    } catch (error) {
      console.error("Error saving grapheme teams:", error);
      toaster.error({ title: "Couldn't save grapheme teams" });
    } finally {
      setSaving(false);
    }
  };

  const handleStageChange = (team: string, stage: GraphemeStage) => {
    void saveTeams(
      teams.map((t) => (t.team === team ? { ...t, stage } : t)),
      stage === "graduated" ? `${team} graduated 🎉` : `${team} → ${stage}`,
    );
  };

  const handleRemove = (team: string) => {
    void saveTeams(
      teams.filter((t) => t.team !== team),
      `Removed "${team}"`,
    );
  };

  const handleAdd = (raw: string) => {
    const team = raw.trim().toLowerCase();
    if (!isAddableTeam(team) || present.has(team)) return;
    void saveTeams([...teams, { team, stage: "training" }], `Added "${team}"`);
    setDraft("");
  };

  const draftValid = isAddableTeam(draft) && !present.has(draft.trim().toLowerCase());

  // Suggestion chips: curated teams not already in the inventory.
  const suggestions = COMMON_EARLY_TEAMS.filter((t) => !present.has(t));

  // Most-recent transitions, compact. history is newest-first from the query.
  const recentHistory = (history ?? []).slice(0, 5);
  const earlierCount = Math.max(0, (history?.length ?? 0) - recentHistory.length);

  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      shadow="xs"
      p={5}
      mt={4}
    >
      <Flex justify="space-between" align="center" gap={2} mb={1}>
        <HStack gap={2} minW={0}>
          <Box color="violet.500" lineHeight="0" display="flex" flexShrink={0}>
            <TextAa />
          </Box>
          <Text
            fontWeight="600"
            fontFamily="heading"
            color="navy.500"
            fontSize="sm"
            whiteSpace="nowrap"
          >
            Reading ramp — grapheme teams
          </Text>
        </HStack>
        {saving && <Spinner size="xs" color="violet.500" />}
      </Flex>
      <Text fontSize="2xs" color="charcoal.400" fontFamily="body" mb={3}>
        Color-coded teams the tutor’s on-screen text trains, and how far each has
        faded. Fade is per team — “sh” can graduate while “ea” is still full color.
      </Text>

      {inventory === undefined ? (
        <Flex justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      ) : teams.length === 0 ? (
        <Text
          fontSize="sm"
          color="charcoal.300"
          fontFamily="heading"
          py={2}
        >
          No teams yet — add the grapheme teams this scholar is working below.
        </Text>
      ) : (
        <VStack align="stretch" gap={0}>
          {teams.map((t, i) => {
            const count = exposure?.counts[t.team] ?? 0;
            const showExposure = t.stage !== "graduated";
            const nudgeFade = t.stage === "training" && count >= FADE_HINT_THRESHOLD;
            return (
              <Flex
                key={t.team}
                align="center"
                gap={3}
                py={2}
                borderTop={i === 0 ? undefined : "1px solid"}
                borderColor="gray.100"
              >
                <Box minW="52px">
                  <TeamGlyph team={t.team} stage={t.stage} />
                </Box>

                <Box w="120px" flexShrink={0}>
                  <FieldSelect
                    size="xs"
                    w="full"
                    value={t.stage}
                    onChange={(v) => handleStageChange(t.team, v as GraphemeStage)}
                    disabled={saving}
                    fieldProps={{ "aria-label": `${t.team} stage` }}
                  >
                    {STAGE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </FieldSelect>
                </Box>

                <Box flex={1} minW={0}>
                  {showExposure &&
                    (exposure === undefined ? (
                      <Text fontSize="2xs" color="charcoal.300" fontFamily="body">
                        counting exposure…
                      </Text>
                    ) : count > 0 ? (
                      <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
                        seen {count}×{exposure.capped ? "+" : ""} recently
                        {nudgeFade && (
                          <Text as="span" color="violet.600" fontWeight="600">
                            {" "}
                            · consider fading
                          </Text>
                        )}
                      </Text>
                    ) : (
                      <Text fontSize="2xs" color="charcoal.300" fontFamily="body">
                        not seen recently
                      </Text>
                    ))}
                </Box>

                <IconButton
                  aria-label={`Remove ${t.team}`}
                  variant="ghost"
                  size="2xs"
                  color="charcoal.300"
                  _hover={{ color: "red.500" }}
                  disabled={saving}
                  onClick={() => handleRemove(t.team)}
                >
                  <Trash />
                </IconButton>
              </Flex>
            );
          })}
        </VStack>
      )}

      {/* Add a team ─────────────────────────────────────────────── */}
      <Box mt={4} pt={3} borderTop="1px solid" borderColor="gray.100">
        <Text
          fontSize="2xs"
          color="charcoal.300"
          fontFamily="heading"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="wider"
          mb={2}
        >
          Add a team
        </Text>

        <HStack gap={2} mb={3}>
          <Input
            size="xs"
            maxW="140px"
            placeholder="e.g. igh"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draftValid) handleAdd(draft);
            }}
            fontFamily="heading"
            borderColor="gray.200"
            _focus={{ borderColor: "violet.400", boxShadow: "none" }}
          />
          <Button
            size="xs"
            variant="solid"
            colorPalette="violet"
            disabled={!draftValid || saving}
            onClick={() => handleAdd(draft)}
          >
            <Plus /> Add
          </Button>
        </HStack>

        <Flex wrap="wrap" gap={2}>
          {suggestions.map((team) => {
            const addable = isAddableTeam(team);
            return (
              <Button
                key={team}
                size="2xs"
                variant="outline"
                borderColor="gray.200"
                color="charcoal.500"
                fontFamily="heading"
                disabled={!addable || saving}
                title={
                  addable
                    ? `Add "${team}"`
                    : "magic-e — not colorable by the ramp yet"
                }
                onClick={() => addable && handleAdd(team)}
              >
                <Plus />
                {team}
                {!addable && (
                  <Text as="span" fontSize="3xs" color="charcoal.300">
                    {" "}
                    soon
                  </Text>
                )}
              </Button>
            );
          })}
        </Flex>
      </Box>

      {/* History line — the durable fade-stage arc (§10 portfolio milestones) */}
      {recentHistory.length > 0 && (
        <Box mt={4} pt={3} borderTop="1px solid" borderColor="gray.100">
          <Text
            fontSize="2xs"
            color="charcoal.300"
            fontFamily="heading"
            fontWeight="600"
            textTransform="uppercase"
            letterSpacing="wider"
            mb={1}
          >
            History
          </Text>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="body" lineHeight="1.7">
            {recentHistory.map((h, i) => (
              <Text as="span" key={h._id}>
                {i > 0 && " · "}
                <Text as="span" fontWeight="600" color="charcoal.500">
                  {h.team}
                </Text>{" "}
                {h.stage} {shortDate(h.recordedAt)}
              </Text>
            ))}
            {earlierCount > 0 && (
              <Text as="span" color="charcoal.300">
                {" "}
                · +{earlierCount} earlier
              </Text>
            )}
          </Text>
        </Box>
      )}
    </Box>
  );
}
