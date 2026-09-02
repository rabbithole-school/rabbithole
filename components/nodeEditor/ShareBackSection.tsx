"use client";

/**
 * Share Back section in the Unit Designer's activity editor. Mounted
 * only when activity.kind === "shareBack". Owns:
 *  - the recipe picker (reflection / galleryWalk / exitTicket /
 *    debateDebrief / custom)
 *  - source wiring (pick one or more earlier online activities)
 *  - the AI digest generate / preview / facilitation-launch panel
 *
 * Facilitation focus (free text) lives in ActivityFields as the
 * Description-equivalent for Share Back activities — it feeds the
 * digest prompt alongside the recipe.
 *
 * See review/shareback-offline-activity.md.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { X, Plus, MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { Field } from "./shared";

type RecipeValue =
  | "reflection"
  | "galleryWalk"
  | "exitTicket"
  | "debateDebrief"
  | "custom";

const SHAREBACK_RECIPES: Array<{
  value: RecipeValue;
  label: string;
  emoji: string;
  hint: string;
}> = [
  {
    value: "reflection",
    label: "Reflection",
    emoji: "🪞",
    hint: "Synthesize what the class produced — themes + highlights celebrating variety in approach and craft.",
  },
  {
    value: "galleryWalk",
    label: "Gallery walk",
    emoji: "🖼️",
    hint: "Every scholar gets a slide. Lighter themes; prompts prime good circulation and pairing.",
  },
  {
    value: "exitTicket",
    label: "Exit ticket",
    emoji: "🎟️",
    hint: "Surface confusions and gaps, not celebrations. Themes name misconceptions; prompts are diagnostic.",
  },
  {
    value: "debateDebrief",
    label: "Debate debrief",
    emoji: "⚖️",
    hint: "Group positions taken, contrast them, surface strongest articulations of each side.",
  },
  {
    value: "custom",
    label: "Custom",
    emoji: "✏️",
    hint: "No recipe scaffolding — the AI shapes the digest entirely around your facilitation focus below.",
  },
];

export function ShareBackSection({
  activityId,
  highlightMissingSources,
}: {
  activityId: Id<"activities">;
  /** When true, the source picker button gets a red border + tint so
   *  the field matches the up-top warning telling the teacher to add
   *  a source. */
  highlightMissingSources?: boolean;
}) {
  const activity = useQuery(api.activities.get, { id: activityId });
  const sources = useQuery(api.shareBack.getSources, { activityId });
  const setSources = useMutation(api.shareBack.setSources);
  const updateActivity = useMutation(api.activities.update);
  const [pickerOpen, setPickerOpen] = useState(false);

  const currentRecipe = activity?.shareBackRecipe ?? "reflection";
  const isCustom = currentRecipe === "custom";

  // Local draft for the custom-focus textarea, synced from server.
  const [focusDraft, setFocusDraft] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusDraft(activity?.facilitationFocus ?? "");
  }, [activity?.facilitationFocus]);

  const sourceIds = (sources ?? []).map((s) => s._id);
  const isShareBack = sourceIds.length > 0;

  const addSource = async (id: Id<"activities">) => {
    if (sourceIds.includes(id)) return;
    await setSources({
      activityId,
      sourceActivityIds: [...sourceIds, id],
    });
  };
  const removeSource = async (id: Id<"activities">) => {
    await setSources({
      activityId,
      sourceActivityIds: sourceIds.filter((s) => s !== id),
    });
  };

  // ── Sources section content (rendered inside the SubField below) ─
  const sourcesBlock = (
    <Stack gap={2}>
      {sources === undefined ? (
        <Flex justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      ) : (
        <>
          {isShareBack && (
            <Stack gap={1.5}>
              {sources.map((s) => (
                <Flex
                  key={String(s._id)}
                  align="center"
                  gap={2}
                  p={2.5}
                  bg="white"
                  borderWidth="1px"
                  borderColor={s.exists ? "gray.200" : "red.200"}
                  borderRadius="md"
                >
                  <Stack gap={0} flex={1} minW={0}>
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      color={s.exists ? "navy.500" : "red.600"}
                      fontSize="sm"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {s.title}
                    </Text>
                    <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                      {s.exists
                        ? `${s.deliverableCount} submission${s.deliverableCount === 1 ? "" : "s"}${s.hasScholarAngles ? " · per-scholar angles" : ""}`
                        : "deleted — remove this source"}
                    </Text>
                  </Stack>
                  <Button
                    size="xs"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ color: "red.500", bg: "red.50" }}
                    onClick={() => removeSource(s._id)}
                  >
                    <X />
                  </Button>
                </Flex>
              ))}
            </Stack>
          )}
          <Button
            size="sm"
            variant="outline"
            colorPalette={highlightMissingSources ? "red" : "violet"}
            fontFamily="heading"
            alignSelf="flex-start"
            borderColor={highlightMissingSources ? "red.400" : undefined}
            bg={highlightMissingSources ? "red.50" : undefined}
            onClick={() => setPickerOpen(true)}
          >
            <Plus size={12} style={{ marginRight: 4 }} />
            {isShareBack ? "Add another source" : "Pick a source activity"}
          </Button>
        </>
      )}
    </Stack>
  );

  // ── Recipe section content (chips + hint + optional custom focus) ─
  const recipeBlock = (
    <Stack gap={2}>
      <Flex gap={1.5} flexWrap="wrap">
        {SHAREBACK_RECIPES.map((r) => {
          const selected = currentRecipe === r.value;
          return (
            <Button
              key={r.value}
              size="xs"
              variant={selected ? "solid" : "outline"}
              bg={selected ? "violet.500" : "white"}
              color={selected ? "white" : "charcoal.500"}
              borderColor={selected ? "violet.500" : "gray.300"}
              _hover={
                selected
                  ? { bg: "violet.600" }
                  : { borderColor: "violet.400", color: "violet.500" }
              }
              fontFamily="heading"
              onClick={() =>
                updateActivity({ id: activityId, shareBackRecipe: r.value })
              }
            >
              <span style={{ marginRight: 6 }}>{r.emoji}</span>
              {r.label}
            </Button>
          );
        })}
      </Flex>
      <Text fontSize="2xs" color="charcoal.400" lineHeight="1.5">
        {SHAREBACK_RECIPES.find((r) => r.value === currentRecipe)?.hint}
      </Text>
      {/* Custom focus tucks INSIDE the Recipe sub-section when Custom
          is selected — left border + indent so it visually belongs
          to the recipe row instead of looking like a peer. */}
      {isCustom && (
        <Box
          pl={3}
          ml={1}
          borderLeftWidth="2px"
          borderLeftColor="violet.200"
        >
          <Text
            fontSize="2xs"
            color="charcoal.400"
            fontFamily="heading"
            letterSpacing="wider"
            textTransform="uppercase"
            mb={1}
          >
            Custom focus
          </Text>
          <Textarea
            value={focusDraft}
            onChange={(e) => setFocusDraft(e.target.value)}
            onBlur={() =>
              updateActivity({
                id: activityId,
                facilitationFocus: focusDraft || null,
              })
            }
            rows={3}
            fontSize="sm"
            fontFamily="body"
            borderColor="gray.200"
            placeholder="What angle do you want? Example: 'find pieces that took emotional risks', 'surface confusions about denominators'."
            _focus={{ borderColor: "violet.400", boxShadow: "none" }}
          />
        </Box>
      )}
    </Stack>
  );

  return (
    <>
      <Field
        label="Share Back"
        hint="Collates scholars' submitted work from earlier online activities into an AI digest you facilitate in class."
      >
        {/* Sub-sections live inside the SHARE BACK field — indented +
            with a soft left border so they read as children of it.
            Order: Sources (the sine qua non) → Recipe → Digest. */}
        <Stack
          gap={4}
          mt={2}
          pl={3}
          borderLeftWidth="2px"
          borderLeftColor="gray.100"
        >
          <SubField label="Sources">{sourcesBlock}</SubField>
          <SubField label="Recipe">{recipeBlock}</SubField>
          {/* The digest generate / preview / facilitation block used
              to live here. Post the Assignments split it lives on the
              per-Assignment Run page (/teacher/schedule/<id>) so
              each cohort gets its own digest — see
              review/design-vs-execution-split.md. */}
        </Stack>
      </Field>

      {pickerOpen && (
        <SourcePickerDialog
          shareBackActivityId={activityId}
          alreadyPicked={sourceIds}
          onClose={() => setPickerOpen(false)}
          onPick={async (id) => {
            await addSource(id);
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}

// ── Digest generate + preview ────────────────────────────────────────

/**
 * Smaller sub-field label, used inside the SHARE BACK Field for
 * SOURCES / RECIPE / DIGEST so they read as children of it rather
 * than as peers. Visually lighter than the page-level Field eyebrow.
 */
function SubField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text
        fontSize="2xs"
        color="charcoal.400"
        fontFamily="heading"
        letterSpacing="wider"
        textTransform="uppercase"
        mb={1}
      >
        {label}
      </Text>
      {children}
    </Box>
  );
}


// ── Source picker dialog ─────────────────────────────────────────────

function SourcePickerDialog({
  shareBackActivityId,
  alreadyPicked,
  onClose,
  onPick,
}: {
  shareBackActivityId: Id<"activities">;
  alreadyPicked: Id<"activities">[];
  onClose: () => void;
  onPick: (id: Id<"activities">) => void;
}) {
  const candidates = useQuery(api.shareBack.listSourceCandidates, {
    shareBackActivityId,
  });
  const [query, setQuery] = useState("");
  // Defaults to "This unit" — the common case is sharing back work
  // from the unit the teacher's currently editing. "All" widens the
  // pool for cross-unit share-backs (much rarer).
  const [scope, setScope] = useState<"unit" | "all">("unit");

  const pickedSet = new Set(alreadyPicked.map(String));
  const filtered = (candidates ?? []).filter((c) => {
    if (pickedSet.has(String(c._id))) return false;
    if (scope === "unit" && !c.sameUnit) return false;
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return (
      c.title.toLowerCase().includes(needle) ||
      c.unitTitle.toLowerCase().includes(needle)
    );
  });
  // Counts for the scope chips so the teacher knows whether widening
  // would surface more — e.g. "This unit · 3" / "All · 47".
  const thisUnitCount = (candidates ?? []).filter(
    (c) => c.sameUnit && !pickedSet.has(String(c._id)),
  ).length;
  const allCount = (candidates ?? []).filter(
    (c) => !pickedSet.has(String(c._id)),
  ).length;

  return (
    <Dialog.Root open={true} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="560px">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Dialog.Title asChild>
                <Text
                  fontFamily="heading"
                  fontWeight="700"
                  fontSize="lg"
                  color="navy.500"
                >
                  Share back which activity?
                </Text>
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} pb={4}>
              <Stack gap={3}>
                {/* Scope filter — defaults to "This unit" because that's
                    where the share-back almost always sources from. */}
                <HStack gap={1.5}>
                  {(
                    [
                      { value: "unit", label: "This unit", count: thisUnitCount },
                      { value: "all", label: "All", count: allCount },
                    ] as const
                  ).map((opt) => {
                    const active = scope === opt.value;
                    return (
                      <Button
                        key={opt.value}
                        size="xs"
                        variant={active ? "solid" : "outline"}
                        bg={active ? "violet.500" : "white"}
                        color={active ? "white" : "charcoal.500"}
                        borderColor={active ? "violet.500" : "gray.300"}
                        _hover={
                          active
                            ? { bg: "violet.600" }
                            : { borderColor: "violet.400", color: "violet.500" }
                        }
                        fontFamily="heading"
                        onClick={() => setScope(opt.value)}
                      >
                        {opt.label}
                        <Box
                          as="span"
                          ml={1.5}
                          fontSize="2xs"
                          opacity={0.7}
                        >
                          {opt.count}
                        </Box>
                      </Button>
                    );
                  })}
                </HStack>
                <Box position="relative">
                  <Box
                    position="absolute"
                    left={3}
                    top="50%"
                    transform="translateY(-50%)"
                    color="charcoal.300"
                    pointerEvents="none"
                  >
                    <MagnifyingGlass size={14} />
                  </Box>
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search activities or units…"
                    size="sm"
                    pl={8}
                    autoFocus
                  />
                </Box>
                <Box maxH="380px" overflowY="auto">
                  {candidates === undefined ? (
                    <Flex justify="center" py={6}>
                      <Spinner size="sm" color="violet.500" />
                    </Flex>
                  ) : filtered.length === 0 ? (
                    <Text
                      fontSize="sm"
                      color="charcoal.400"
                      py={4}
                      textAlign="center"
                      fontStyle="italic"
                    >
                      {query.trim()
                        ? "No matches."
                        : scope === "unit"
                          ? "No other online activities in this unit yet — switch to All to look across units."
                          : "No online activities available to share back."}
                    </Text>
                  ) : (
                    <Stack gap={1}>
                      {filtered.map((c) => (
                        <Flex
                          key={String(c._id)}
                          as="button"
                          align="center"
                          gap={3}
                          p={2.5}
                          borderRadius="md"
                          cursor="pointer"
                          textAlign="left"
                          _hover={{ bg: "violet.50" }}
                          onClick={() => onPick(c._id)}
                        >
                          {c.unitEmoji && (
                            <Text fontSize="md" lineHeight="1">
                              {c.unitEmoji}
                            </Text>
                          )}
                          <Stack gap={0} flex={1} minW={0}>
                            <Text
                              fontFamily="heading"
                              fontWeight="600"
                              color="navy.500"
                              fontSize="sm"
                            >
                              {c.title}
                            </Text>
                            <Text
                              fontSize="2xs"
                              color="charcoal.400"
                              fontFamily="heading"
                            >
                              {c.unitTitle} · {c.lessonTitle}
                              {c.sameUnit ? " · this unit" : ""}
                            </Text>
                          </Stack>
                          <Text
                            fontSize="2xs"
                            color={
                              c.deliverableCount > 0
                                ? "violet.600"
                                : "charcoal.300"
                            }
                            fontFamily="heading"
                            fontWeight="600"
                            whiteSpace="nowrap"
                          >
                            {c.deliverableCount} submitted
                          </Text>
                        </Flex>
                      ))}
                    </Stack>
                  )}
                </Box>
              </Stack>
            </Dialog.Body>
            <Box px={6} pb={6}>
              <Flex justify="flex-end">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </Flex>
            </Box>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
