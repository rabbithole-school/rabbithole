"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Flex,
  Grid,
  HStack,
  Heading,
  Image,
  Link,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowDown,
  ArrowRight,
  ArrowsLeftRight,
  ImageSquare,
  Medal,
  Plant,
  ShootingStar,
  Sparkle,
  Target,
  TrendUp,
} from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import { BadgeDetailDialog } from "@/components/BadgeDetailDialog";
import MyGoalsCard from "@/components/MyGoalsCard";
import MyWeeklyGoalsCard from "@/components/MyWeeklyGoalsCard";
import { toaster } from "@/lib/toaster";
import { formatRelative } from "@/lib/relativeTime";
import { strongestSignalHeadline } from "@/convex/lib/practice/calibration";
import { sessionSignalMeta } from "@/shared/learningSignals";

type EarnedBadge = NonNullable<
  ReturnType<typeof useQuery<typeof api.scholarUnitBadges.myEarnedBadges>>
>[number];

type CalibrationMirrorData = NonNullable<
  ReturnType<typeof useQuery<typeof api.practiceCalibration.calibrationForSelf>>
>;

type Leap = NonNullable<
  ReturnType<typeof useQuery<typeof api.crossDomainConnections.listByScholar>>
>[number];

/**
 * The scholar's own "My Learning" page — a Total Talent Portfolio, not a
 * report card (review/learner-parent-pedagogy.md). Purpose-built for the
 * learner (second person, no levels/percentages/grades) instead of a
 * trimmed teacher view: a mode flag on the teacher mega-component fails
 * open; a separate component fails closed.
 *
 * Sections: identity + badges · how you work (sessionSignals) · how you've
 * grown (server-derived growth stories, no numbers) · next adventures (the
 * full active-seeds map; home shows the top 3) · things you've made
 * (badges + the kid's own portfolio).
 */

// Second-person framings of the observer's signal types. Static copy by
// design: the per-observation descriptions are observer-voiced (third
// person), which never renders on a kid surface — see the pedagogy note's
// "known gaps". Process language, never trait praise.
const MAX_STRENGTHS = 4;

export function MyLearningView({ scholarId }: { scholarId: Id<"users"> }) {
  const profile = useQuery(api.scholars.getProfile, { scholarId });
  const signalProfile = useQuery(api.sessionSignals.signalProfile, { scholarId });
  const growth = useQuery(api.masteryObservations.growthForScholar, { scholarId });
  const growthPairs = useQuery(api.granuleEvidence.growthPairsForScholar, { scholarId });
  const allSeeds = useQuery(api.seeds.listByScholar, { scholarId });
  const badges = useQuery(api.scholarUnitBadges.myEarnedBadges, {});
  const portfolio = useQuery(api.portfolio.listForSelf, {});
  const calibration = useQuery(api.practiceCalibration.calibrationForSelf, { scholarId });
  const connections = useQuery(api.crossDomainConnections.listByScholar, { scholarId });
  // Track the OPEN badge by id, not a captured snapshot, so the dialog stays
  // live: when a remix flips the badge to artStatus "generating" and the new
  // art lands, myEarnedBadges updates reactively and the dialog re-renders
  // (spinner overlay → fresh art) instead of freezing on the old image.
  const [selectedBadgeId, setSelectedBadgeId] =
    useState<Id<"scholarUnitBadges"> | null>(null);
  const selectedBadge =
    badges?.find((b) => b._id === selectedBadgeId) ?? null;

  const scholar = profile?.scholar;

  if (profile === undefined) {
    return (
      <Flex justify="center" py={16}>
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  const activeSeeds = (allSeeds ?? []).filter((s) => s.status === "active");
  // The kid's OWN authored leaps only (never observer-inferred connections),
  // newest first — listByScholar's index already orders desc.
  const leaps = (connections ?? []).filter((c) => c.studentInitiated);

  return (
    <Box maxW="760px" mx="auto" w="full" px={{ base: 4, md: 6 }} py={6}>
      <VStack align="stretch" gap={8}>
        {/* ── Identity ─────────────────────────────────────────────── */}
        <Box bg="white" borderRadius="xl" borderWidth="1px" borderColor="gray.200" p={6} shadow="xs">
          <HStack gap={5} align="center">
            <Avatar size="xl" name={scholar?.name ?? "Scholar"} src={scholar?.image ?? undefined} colorKey={scholarId} />
            <Stack gap={1} flex={1} minW={0}>
              <Heading size="xl" color="navy.500" fontFamily="heading">
                {scholar?.name}
              </Heading>
              {scholar?.username && (
                <Text fontFamily="heading" color="charcoal.400" fontSize="sm">
                  @{scholar.username}
                </Text>
              )}
            </Stack>
            {badges && badges.length > 0 && (
              <Link
                href="#badges"
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById("badges")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                display="flex"
                alignItems="center"
                gap={1.5}
                bg="violet.50"
                color="violet.700"
                px={3}
                py={1.5}
                borderRadius="full"
                flexShrink={0}
                _hover={{ bg: "violet.100", textDecoration: "none" }}
                transition="background .12s"
                aria-label={`Jump to your ${badges.length === 1 ? "badge" : "badges"}`}
              >
                <Medal size={16} />
                <Text fontFamily="heading" fontSize="sm" fontWeight="600">
                  {badges.length} {badges.length === 1 ? "badge" : "badges"}
                </Text>
              </Link>
            )}
          </HStack>
        </Box>

        {/* ── How you work ─────────────────────────────────────────── */}
        <Section icon={<Sparkle color="#AD60BF" size={18} />} title="How you work">
          {signalProfile === undefined ? (
            <SectionSpinner />
          ) : Object.keys(signalProfile).length === 0 ? (
            <EmptyNote>
              Nothing here yet — this fills in as you work with your tutor.
            </EmptyNote>
          ) : (
            <SimpleGrid columns={{ base: 1, md: 2 }} gap={3}>
              {Object.entries(signalProfile)
                .sort(([, a], [, b]) => b.count - a.count)
                .slice(0, MAX_STRENGTHS)
                .map(([type, data]) => {
                  const framing = sessionSignalMeta(type);
                  if (!framing) return null;
                  return (
                    <Box
                      key={type}
                      bg="white"
                      borderRadius="lg"
                      borderWidth="1px"
                      borderColor="gray.200"
                      p={4}
                      shadow="xs"
                    >
                      <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500">
                        {framing.scholarTitle}
                      </Text>
                      <Text fontFamily="body" fontSize="xs" color="charcoal.500" mt={1} lineHeight="1.5">
                        {framing.scholarBlurb}
                      </Text>
                      <Text fontFamily="heading" fontSize="2xs" color="charcoal.300" mt={2}>
                        Spotted {data.count} {data.count === 1 ? "time" : "times"}
                      </Text>
                    </Box>
                  );
                })}
            </SimpleGrid>
          )}
        </Section>

        {/* ── Getting to know what you know (calibration mirror) ───────── */}
        {calibration && (
          <Section
            icon={<Target color="#AD60BF" size={18} />}
            title="Getting to know what you know"
          >
            <CalibrationMirror calibration={calibration} />
          </Section>
        )}

        {/* ── My goals this week (learner-owned SRL loop) ──────────────── */}
        <MyWeeklyGoalsCard />

        {/* ── My goals (assessment-and-goals §9) ───────────────────────── */}
        <MyGoalsCard scholarId={scholarId} />

        {/* ── Look how far you've come (baseline → exit, kid's own words) ─ */}
        {growthPairs && growthPairs.length > 0 && (
          <Section
            icon={<Plant color="#AD60BF" size={18} weight="fill" />}
            title="Look how far you've come"
          >
            <VStack align="stretch" gap={3}>
              {growthPairs.map((pair, i) => (
                <GrowthPairCard key={`${pair.unitTitle}-${pair.prompt}-${i}`} pair={pair} />
              ))}
            </VStack>
          </Section>
        )}

        {/* ── How you've grown ─────────────────────────────────────── */}
        <Section icon={<TrendUp color="#AD60BF" size={18} />} title="How you've grown">
          {growth === undefined ? (
            <SectionSpinner />
          ) : growth.length === 0 ? (
            <EmptyNote>
              Growth stories show up once you&apos;ve worked on an idea across a
              few weeks — keep exploring.
            </EmptyNote>
          ) : (
            <VStack align="stretch" gap={3}>
              {growth.map((g) => (
                <Box
                  key={`${g.conceptLabel}-${g.latestAt}`}
                  bg="white"
                  borderRadius="lg"
                  borderWidth="1px"
                  borderColor="gray.200"
                  p={4}
                  shadow="xs"
                >
                  <HStack justify="space-between" align="baseline" gap={3}>
                    <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500">
                      {g.conceptLabel}
                    </Text>
                    <Text fontFamily="heading" fontSize="2xs" color="charcoal.300" flexShrink={0}>
                      {g.domain}
                    </Text>
                  </HStack>
                  <Text fontFamily="body" fontSize="xs" color="charcoal.500" mt={1}>
                    You&apos;ve been building this since {formatRelative(g.startedAt)}
                    {g.studentInitiated ? " — and you found it yourself" : ""}.
                  </Text>
                  {g.excerpt && (
                    <Text
                      fontFamily="body"
                      fontSize="xs"
                      color="charcoal.400"
                      fontStyle="italic"
                      mt={2}
                      lineHeight="1.5"
                    >
                      A moment from your work: &ldquo;{g.excerpt}&rdquo;
                    </Text>
                  )}
                </Box>
              ))}
            </VStack>
          )}
        </Section>

        {/* ── Leaps you made (the kid's own cross-domain connections) ──── */}
        {leaps.length > 0 && (
          <Section
            icon={<ArrowsLeftRight color="#AD60BF" size={18} />}
            title="Leaps you made"
          >
            <LeapsStrip leaps={leaps} />
          </Section>
        )}

        {/* ── Next adventures ──────────────────────────────────────── */}
        <Section icon={<Sparkle color="#AD60BF" size={18} weight="duotone" />} title="Next adventures">
          {allSeeds === undefined ? (
            <SectionSpinner />
          ) : activeSeeds.length === 0 ? (
            <EmptyNote>No suggestions waiting right now.</EmptyNote>
          ) : (
            <SeedMap seeds={activeSeeds} />
          )}
        </Section>

        {/* ── Things you've made ───────────────────────────────────── */}
        <Section id="badges" icon={<Medal color="#AD60BF" size={18} />} title="Things you've made">
          <VStack align="stretch" gap={5}>
            {badges === undefined ? (
              <SectionSpinner />
            ) : badges.length === 0 ? (
              <EmptyNote>
                No badges yet — they&apos;re earned by completing every activity
                in a unit.
              </EmptyNote>
            ) : (
              <SimpleGrid columns={{ base: 2, md: 3, lg: 4 }} gap={3}>
                {badges.map((row) => (
                  <BadgeCard
                    key={row._id}
                    badge={row}
                    onSelect={() => setSelectedBadgeId(row._id)}
                  />
                ))}
              </SimpleGrid>
            )}
            <PortfolioStrip items={portfolio} />
          </VStack>
        </Section>
      </VStack>

      <BadgeDetailDialog badge={selectedBadge} onClose={() => setSelectedBadgeId(null)} />
    </Box>
  );
}

// ── Look how far you've come: baseline → exit in the kid's own words ──

type GrowthPair = NonNullable<
  ReturnType<typeof useQuery<typeof api.granuleEvidence.growthPairsForScholar>>
>[number];

function GrowthPairCard({ pair }: { pair: GrowthPair }) {
  return (
    <Box
      bg="white"
      borderRadius="lg"
      borderWidth="1px"
      borderColor="gray.200"
      p={4}
      shadow="xs"
    >
      <HStack gap={2} align="baseline" mb={1}>
        {pair.unitEmoji && (
          <Text fontSize="sm" flexShrink={0}>
            {pair.unitEmoji}
          </Text>
        )}
        <Text
          fontFamily="heading"
          fontSize="2xs"
          color="charcoal.300"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          {pair.unitTitle}
        </Text>
      </HStack>
      <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500" mb={3}>
        {pair.prompt}
      </Text>

      <VStack align="stretch" gap={2}>
        <GrowthQuote label="At first you said" quote={pair.before} muted />
        <Flex justify="center" color="violet.300">
          <ArrowDown size={16} weight="bold" />
        </Flex>
        <GrowthQuote label="Now you say" quote={pair.after} />
      </VStack>
    </Box>
  );
}

function GrowthQuote({
  label,
  quote,
  muted = false,
}: {
  label: string;
  quote: string;
  muted?: boolean;
}) {
  // Strip any quote marks the excerpt already carries so we don't double them
  // up against the curly quotes this card adds.
  const clean = quote.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "");
  return (
    <Box
      bg={muted ? "gray.50" : "violet.50"}
      borderRadius="md"
      px={3}
      py={2}
      borderLeftWidth="3px"
      borderColor={muted ? "gray.200" : "violet.300"}
    >
      <Text
        fontFamily="heading"
        fontSize="2xs"
        color={muted ? "charcoal.300" : "violet.600"}
        textTransform="uppercase"
        letterSpacing="0.05em"
        mb={0.5}
      >
        {label}
      </Text>
      <Text
        fontFamily="body"
        fontSize="sm"
        color={muted ? "charcoal.400" : "charcoal.600"}
        fontStyle="italic"
        lineHeight="1.5"
      >
        &ldquo;{clean}&rdquo;
      </Text>
    </Box>
  );
}

// ── Getting to know what you know: the calibration mirror ───────────

function CalibrationMirror({ calibration }: { calibration: CalibrationMirrorData }) {
  const headline = strongestSignalHeadline(calibration.byLevel);
  return (
    <Box
      bg="white"
      borderRadius="lg"
      borderWidth="1px"
      borderColor="gray.200"
      p={4}
      shadow="xs"
    >
      {headline && (
        <Text
          fontFamily="heading"
          fontWeight="600"
          fontSize="sm"
          color="navy.500"
          mb={4}
        >
          {headline}
        </Text>
      )}
      <VStack align="stretch" gap={2.5}>
        {calibration.byLevel.map((row) => (
          <HStack key={row.level} gap={3}>
            <Text
              fontFamily="heading"
              fontSize="xs"
              color="charcoal.500"
              w="88px"
              flexShrink={0}
            >
              {row.label}
            </Text>
            <ConfidenceMeter correct={row.correct} total={row.total} />
            <Text
              fontFamily="body"
              fontSize="xs"
              color="charcoal.400"
              fontVariantNumeric="tabular-nums"
              flexShrink={0}
              minW="36px"
              textAlign="right"
            >
              {row.total > 0 ? `${row.correct}/${row.total}` : "—"}
            </Text>
          </HStack>
        ))}
      </VStack>
      <Text
        fontFamily="body"
        fontSize="xs"
        color="charcoal.500"
        mt={4}
        fontStyle="italic"
      >
        {calibration.growthLine}
      </Text>
    </Box>
  );
}

function ConfidenceMeter({ correct, total }: { correct: number; total: number }) {
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  return (
    <Box flex={1} h="7px" bg="gray.100" borderRadius="full" overflow="hidden">
      <Box h="full" w={`${pct}%`} bg="violet.400" borderRadius="full" />
    </Box>
  );
}

// ── Leaps you made: the kid's OWN cross-domain connections ──────────

const MAX_LEAPS_SHOWN = 6;

function LeapsStrip({ leaps }: { leaps: Leap[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? leaps : leaps.slice(0, MAX_LEAPS_SHOWN);
  return (
    <VStack align="stretch" gap={3}>
      {visible.map((leap) => (
        <LeapCard key={leap._id} leap={leap} />
      ))}
      {!expanded && leaps.length > MAX_LEAPS_SHOWN && (
        <Button
          variant="ghost"
          size="sm"
          alignSelf="flex-start"
          color="violet.600"
          fontFamily="heading"
          onClick={() => setExpanded(true)}
        >
          + {leaps.length - MAX_LEAPS_SHOWN} more
        </Button>
      )}
    </VStack>
  );
}

function LeapCard({ leap }: { leap: Leap }) {
  const pair = leapPair(leap);
  return (
    <Box
      bg="white"
      borderRadius="lg"
      borderWidth="1px"
      borderColor="gray.200"
      p={4}
      shadow="xs"
    >
      {pair && (
        <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500">
          You connected {pair[0]} ↔ {pair[1]}
        </Text>
      )}
      <Text
        fontFamily="body"
        fontSize="xs"
        color="charcoal.500"
        mt={pair ? 1 : 0}
        lineHeight="1.5"
      >
        {leap.description}
      </Text>
    </Box>
  );
}

/** The two things a leap joined, for "You connected A ↔ B" — prefers the
 * concept labels (more specific than the domain names) and falls back to
 * domains if there aren't at least two concept labels. Extra labels beyond
 * the first two fold into the second slot. */
function leapPair(leap: Leap): [string, string] | null {
  const source = leap.conceptLabels.length >= 2 ? leap.conceptLabels : leap.domains;
  if (source.length < 2) return null;
  return [source[0], source.slice(1).join(" & ")];
}

// ── Next adventures: the full seed map, grouped by domain ────────────

type SeedDoc = NonNullable<
  ReturnType<typeof useQuery<typeof api.seeds.listByScholar>>
>[number];

function SeedMap({ seeds }: { seeds: SeedDoc[] }) {
  const router = useRouter();
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const [exploringId, setExploringId] = useState<string | null>(null);

  const handleExplore = async (seedId: Id<"seeds">) => {
    setExploringId(seedId);
    try {
      const result = await createFromSeed({ seedId });
      if (result) router.push(`/scholar/${result.id}`);
    } catch (err) {
      console.error("Error creating session from seed:", err);
      toaster.error({ title: "Couldn't start that exploration", description: "Please try again." });
      setExploringId(null);
    }
  };

  // Group by domain so the list reads as a map of territories, not a queue.
  const groups = new Map<string, SeedDoc[]>();
  for (const seed of seeds) {
    const key = seed.domain ?? "Exploring";
    const list = groups.get(key);
    if (list) list.push(seed);
    else groups.set(key, [seed]);
  }
  const showHeaders = groups.size > 1;

  return (
    <VStack align="stretch" gap={4}>
      {[...groups.entries()].map(([domain, list]) => (
        <Box key={domain}>
          {showHeaders && (
            <Text
              fontFamily="heading"
              fontWeight="600"
              fontSize="xs"
              color="charcoal.400"
              textTransform="uppercase"
              letterSpacing="0.05em"
              mb={2}
            >
              {domain}
            </Text>
          )}
          <VStack align="stretch" gap={2}>
            {list.map((seed) => {
              const isExploring = exploringId === seed._id;
              const disabled = exploringId !== null && !isExploring;
              return (
                <Flex
                  key={seed._id}
                  align="center"
                  gap={3}
                  bg="white"
                  borderRadius="lg"
                  borderWidth="1px"
                  borderColor="gray.200"
                  shadow="xs"
                  px={4}
                  py={3}
                  opacity={disabled ? 0.5 : 1}
                >
                  <Box color={seed.unitId ? "#caa23a" : "violet.400"} flexShrink={0}>
                    {seed.unitId ? (
                      <ShootingStar size={16} weight="fill" />
                    ) : (
                      <Sparkle size={16} weight="fill" />
                    )}
                  </Box>
                  <Text
                    fontFamily="heading"
                    fontWeight="600"
                    color="navy.500"
                    fontSize="sm"
                    flex={1}
                    minW={0}
                  >
                    {seed.topic}
                  </Text>
                  <Button
                    size="xs"
                    variant="ghost"
                    color="violet.700"
                    fontFamily="heading"
                    fontWeight="600"
                    _hover={{ bg: "violet.50" }}
                    flexShrink={0}
                    disabled={disabled || isExploring}
                    onClick={() => handleExplore(seed._id)}
                  >
                    {isExploring ? "Starting…" : "Start exploring"}
                    {!isExploring && <ArrowRight style={{ marginLeft: 4 }} />}
                  </Button>
                </Flex>
              );
            })}
          </VStack>
        </Box>
      ))}
    </VStack>
  );
}

// ── Things you've made: the kid's own portfolio ──────────────────────

type PortfolioItem = NonNullable<
  ReturnType<typeof useQuery<typeof api.portfolio.listForSelf>>
>[number];

function PortfolioStrip({ items }: { items: PortfolioItem[] | undefined }) {
  const [openItem, setOpenItem] = useState<Id<"portfolioItems"> | null>(null);
  const fileUrl = useQuery(
    api.portfolio.getFileUrlForSelf,
    openItem ? { itemId: openItem } : "skip",
  );

  useEffect(() => {
    if (!openItem) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenItem(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openItem]);

  if (items === undefined) return <SectionSpinner />;
  const visible = items.filter((i) => i.hasFile);
  if (visible.length === 0) return null;
  const closeItem = () => {
    setOpenItem(null);
  };

  return (
    <Box>
      <Text
        fontFamily="heading"
        fontWeight="600"
        fontSize="xs"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.05em"
        mb={2}
      >
        From your portfolio
      </Text>

      {openItem && (
        <Box
          position="fixed"
          inset={0}
          bg="blackAlpha.700"
          zIndex={1000}
          display="flex"
          alignItems="center"
          justifyContent="center"
          p={6}
          onClick={closeItem}
        >
          <Box bg="white" borderRadius="lg" maxW="90vw" maxH="90vh" overflow="auto" onClick={(e) => e.stopPropagation()}>
            <Flex justify="flex-end" px={3} py={2} borderBottomWidth="1px" borderColor="gray.100">
              <Button size="xs" variant="ghost" fontFamily="heading" color="charcoal.500" onClick={closeItem}>
                Close ✕
              </Button>
            </Flex>
            {fileUrl === undefined ? (
              <Box p={10}>
                <Spinner color="violet.400" />
              </Box>
            ) : fileUrl === null ? (
              <Box p={10}>
                <Text fontFamily="body" fontSize="sm" color="charcoal.300">
                  This file is no longer available.
                </Text>
              </Box>
            ) : (
              <iframe src={fileUrl} title="Your work" style={{ width: "80vw", height: "60vh", border: 0 }} />
            )}
          </Box>
        </Box>
      )}

      <Grid templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(3, 1fr)" }} gap={3}>
        {visible.map((item) => (
          <Box
            as="button"
            key={item._id}
            bg="white"
            borderRadius="lg"
            borderWidth="1px"
            borderColor="gray.200"
            overflow="hidden"
            cursor="pointer"
            textAlign="left"
            w="full"
            _hover={{ borderColor: "violet.300", shadow: "sm" }}
            transition="all 0.15s"
            onClick={() => {
              setOpenItem(item._id);
            }}
          >
            {item.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed Convex storage URL, not a static asset
              <img
                src={item.thumbUrl}
                alt={item.title ?? "Work sample"}
                style={{ width: "100%", height: "110px", objectFit: "cover", display: "block" }}
              />
            ) : (
              <Flex h="110px" align="center" justify="center" bg="gray.50" color="charcoal.300">
                <ImageSquare size={28} />
              </Flex>
            )}
            <Box px={3} py={2}>
              <Text fontFamily="heading" fontWeight="600" fontSize="xs" color="navy.500" lineClamp={1}>
                {item.title}
              </Text>
              <Text fontFamily="body" fontSize="2xs" color="charcoal.300" mt={0.5}>
                {formatRelative(item._creationTime)}
              </Text>
            </Box>
          </Box>
        ))}
      </Grid>
    </Box>
  );
}

// ── Badge card (carried over from the old /scholar/profile page) ─────

function BadgeCard({
  badge,
  onSelect,
}: {
  badge: EarnedBadge;
  onSelect: () => void;
}) {
  const icon = badge.badge?.icon ?? "🏅";
  const title = badge.badge?.title ?? "(badge)";
  const { unitTitle, unitEmoji, earnedAt, imageUrl, artStatus } = badge;
  return (
    <VStack
      as="button"
      onClick={onSelect}
      aria-label={`View ${title} badge`}
      bg="white"
      borderWidth="1px"
      borderColor="violet.200"
      borderRadius="lg"
      p={4}
      gap={2}
      align="center"
      textAlign="center"
      shadow="xs"
      cursor="pointer"
      transition="all .12s"
      _hover={{ borderColor: "violet.400", shadow: "sm", transform: "translateY(-2px)" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "2px" }}
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={`${unitTitle} badge`}
          boxSize="72px"
          borderRadius="xl"
          objectFit="cover"
        />
      ) : (
        <Box
          position="relative"
          w="56px"
          h="56px"
          borderRadius="full"
          bg="violet.50"
          borderWidth="2px"
          borderColor="violet.400"
          display="flex"
          alignItems="center"
          justifyContent="center"
          fontSize="2xl"
          title={title}
        >
          {icon}
          {artStatus === "generating" && (
            <Box position="absolute" bottom="-2px" right="-2px">
              <Spinner size="xs" color="violet.500" borderWidth="2px" />
            </Box>
          )}
        </Box>
      )}
      <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
        {title}
      </Text>
      <Text fontSize="2xs" color="violet.600" fontFamily="heading" fontWeight="600">
        {unitEmoji ? `${unitEmoji} ` : ""}
        {unitTitle}
      </Text>
      <Text fontSize="2xs" color="charcoal.300" fontFamily="heading">
        {formatRelative(earnedAt)}
      </Text>
    </VStack>
  );
}

// ── Small shared bits ────────────────────────────────────────────────

function Section({
  icon,
  title,
  children,
  id,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <Box id={id} scrollMarginTop="16px">
      <HStack gap={2} mb={3}>
        {icon}
        <Heading size="sm" color="navy.500" fontFamily="heading">
          {title}
        </Heading>
      </HStack>
      {children}
    </Box>
  );
}

function SectionSpinner() {
  return (
    <Flex justify="center" py={6}>
      <Spinner size="sm" color="violet.500" />
    </Flex>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <Text fontFamily="body" fontSize="sm" color="charcoal.300" py={2}>
      {children}
    </Text>
  );
}
