"use client";

/**
 * BakePathPicker — the live "choose your path" options for a quest.
 *
 * Asks the Curriculum Bot (`api.bakePaths.suggestBakePaths`) for 2-4 concrete,
 * kid-facing ways into THIS topic, and lets the scholar pick one. A fixed
 * "Endless chat" option sits at the top — the old ad-lib free exploration with
 * no curated path — and is always available, even while the bot is still
 * thinking (it doesn't need the call). Owns its own selection and reports the
 * chosen choice up via `onSelect` (called with `null` while nothing is selected
 * yet). Shared by every quest-start flow so they never drift apart: the inline
 * star-drawer + standalone dialog (a topic SEED) and the Custom Quest dialog (a
 * free-text TOPIC the scholar just typed) — driven by the `source` prop.
 *
 * The live call is ~10s, so the loading state is deliberately alive (rotating
 * reassurance + shimmer) and results are memoised per-source so reopening is
 * instant.
 */

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import {
  accentForIndex,
  type BakePathSource,
  ENDLESS_CHAT,
  FALLBACK_PATHS,
  type PathChoice,
  type SuggestedPath,
} from "@/lib/bakePaths";

// Reopening a star (or retyping the same Custom-Quest topic) within a session
// shouldn't re-pay the ~10s call. Keyed by a stable string per source.
const SUGGESTION_CACHE = new Map<string, SuggestedPath[]>();

function cacheKey(source: BakePathSource): string {
  return source.kind === "seed"
    ? `seed:${source.seedId}`
    : `topic:${source.topic}::${source.rationale ?? ""}`;
}

const LOADING_MESSAGES = [
  "✨ Finding a few ways into this…",
  "🧭 Weighing what's actually worth exploring…",
  "📚 Shaping real options just for you…",
  "🪄 Almost ready…",
];

function ShimmerCard() {
  return (
    <Box
      h="68px"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="gray.200"
      bg="gray.50"
      position="relative"
      overflow="hidden"
      css={{
        "&::after": {
          content: '""',
          position: "absolute",
          inset: 0,
          transform: "translateX(-100%)",
          background:
            "linear-gradient(90deg, transparent, rgba(255,255,255,0.65), transparent)",
          animation: "bp-shimmer 1.5s ease-in-out infinite",
        },
        "@keyframes bp-shimmer": { to: { transform: "translateX(100%)" } },
      }}
    >
      <Box position="absolute" top="15px" left="16px" w="46%" h="11px" borderRadius="full" bg="gray.200" />
      <Box position="absolute" top="35px" left="16px" w="78%" h="8px" borderRadius="full" bg="gray.100" />
      <Box position="absolute" top="49px" left="16px" w="56%" h="8px" borderRadius="full" bg="gray.100" />
    </Box>
  );
}

function SuggestedBadge() {
  return (
    <Text
      as="span"
      fontSize="2xs"
      fontWeight="800"
      color="violet.600"
      bg="violet.50"
      borderRadius="full"
      px={2}
      py="1px"
      textTransform="uppercase"
      letterSpacing="0.04em"
    >
      Suggested
    </Text>
  );
}

function OptionCard({
  emoji,
  title,
  blurb,
  tileBg,
  selected,
  badge,
  onClick,
}: {
  emoji: string;
  title: string;
  blurb: string;
  tileBg: string;
  selected: boolean;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <Box
      as="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      textAlign="left"
      position="relative"
      display="grid"
      gridTemplateColumns="auto 1fr auto"
      gap={3}
      alignItems="center"
      borderWidth="1px"
      borderColor={selected ? "violet.400" : "gray.200"}
      borderRadius="xl"
      bg="white"
      px={3}
      py={2.5}
      boxShadow={selected ? "0 0 0 3px var(--chakra-colors-violet-100)" : "none"}
      transition="all 0.12s"
      _hover={{
        borderColor: selected ? "violet.400" : "gray.300",
        bg: selected ? "white" : "gray.50",
      }}
    >
      <Box
        w="38px"
        h="38px"
        borderRadius="lg"
        display="grid"
        placeItems="center"
        fontSize="lg"
        bg={tileBg}
      >
        {emoji}
      </Box>
      <Box minW={0}>
        <Flex align="center" gap={2} wrap="wrap">
          <Text fontWeight="700" color="navy.600" fontSize="sm">
            {title}
          </Text>
          {badge}
        </Flex>
        <Text fontSize="xs" color="charcoal.500" mt="2px" lineHeight="1.4">
          {blurb}
        </Text>
      </Box>
      <Box
        w="22px"
        h="22px"
        borderRadius="full"
        borderWidth="2px"
        borderColor={selected ? "violet.500" : "gray.300"}
        bg={selected ? "violet.500" : "transparent"}
        color="white"
        display="grid"
        placeItems="center"
        flexShrink={0}
      >
        {selected && <Check size={13} weight="bold" />}
      </Box>
    </Box>
  );
}

// Selection is the bot-path index, the endless-chat sentinel, or null (none yet).
type Selection = number | typeof ENDLESS_CHAT | null;

type PickerProps = {
  source: BakePathSource;
  onSelect: (choice: PathChoice | null) => void;
};

/**
 * A new source is a new picker. Keying the stateful body by the source's cache
 * key means every initializer below re-derives — including reading the
 * suggestion cache — so a changed topic/seed can never display or accept the
 * PREVIOUS source's paths while the reset effect catches up.
 *
 * The key lives here rather than at the two call sites because `cacheKey` is
 * module-private and both callers render this inside a dialog; keying an inner
 * child is fine, keying the surrounding `Dialog.Root` would not be (see
 * `.claude/rules/engineering-principles.md` on the Ark body-lock leak).
 */
export function BakePathPicker(props: PickerProps) {
  return <PathPicker key={cacheKey(props.source)} {...props} />;
}

function PathPicker({ source, onSelect }: PickerProps) {
  const suggest = useAction(api.bakePaths.suggestBakePaths);
  const key = cacheKey(source);
  const cached = SUGGESTION_CACHE.get(key) ?? null;
  const [paths, setPaths] = useState<SuggestedPath[] | null>(cached);
  const [selected, setSelected] = useState<Selection>(cached ? 0 : null);
  const [msgIdx, setMsgIdx] = useState(0);
  // Keep `onSelect` fresh without making a new parent closure refire the ~10s
  // request.
  const notifySelection = useEffectEvent(onSelect);
  // Once the scholar picks anything (including endless chat), don't let the
  // arriving suggestions stomp their choice with the default.
  const touchedRef = useRef(false);

  // Mounts once per source (the caller keys on `cacheKey`), so the state this
  // effect used to reset is already correct from the initializers above — it is
  // left with only the two things a mount cannot do for itself: telling the
  // parent what is currently selected, and firing the fetch.
  useEffect(() => {
    let cancelled = false;
    if (cached) {
      notifySelection(cached[0] ?? null);
      return;
    }
    notifySelection(null);
    const params =
      source.kind === "seed"
        ? { seedId: source.seedId }
        : { topic: source.topic, ...(source.rationale ? { rationale: source.rationale } : {}) };
    suggest(params)
      .then((r) => {
        if (cancelled) return;
        const ps = r.paths?.length ? r.paths : FALLBACK_PATHS;
        SUGGESTION_CACHE.set(key, ps);
        setPaths(ps);
        if (!touchedRef.current) {
          setSelected(0);
          notifySelection(ps[0] ?? null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPaths(FALLBACK_PATHS);
        if (!touchedRef.current) {
          setSelected(0);
          notifySelection(FALLBACK_PATHS[0]);
        }
      });
    return () => {
      cancelled = true;
    };
    // `key` captures the meaningful source identity; the effect reads `source`
    // through it (a fresh topic string → new key → refetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, suggest]);

  // Cycle the reassurance line while the bot thinks.
  const loading = paths === null;
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(
      () => setMsgIdx((i) => (i + 1) % LOADING_MESSAGES.length),
      2200,
    );
    return () => clearInterval(t);
  }, [loading]);

  const pick = (choice: Selection, value: PathChoice) => {
    touchedRef.current = true;
    setSelected(choice);
    onSelect(value);
  };

  return (
    <Stack gap={3}>
      <Text fontSize="xs" color="charcoal.400" fontWeight="600">
        {loading ? LOADING_MESSAGES[msgIdx] : "How do you want to explore it?"}
      </Text>

      <Stack gap={2.5} role="radiogroup" aria-label="Choose your path">
        {/* Endless chat — the old ad-lib free exploration. Always available
            (it doesn't wait on the bot), no badge. */}
        <OptionCard
          emoji="💬"
          title="Endless chat"
          blurb="No plan — just start talking and follow your curiosity wherever it goes."
          tileBg="gray.100"
          selected={selected === ENDLESS_CHAT}
          onClick={() => pick(ENDLESS_CHAT, ENDLESS_CHAT)}
        />

        {loading ? (
          <>
            <ShimmerCard />
            <ShimmerCard />
            <ShimmerCard />
          </>
        ) : (
          paths!.map((p, i) => (
            <OptionCard
              key={`${p.title}-${i}`}
              emoji={p.emoji}
              title={p.title}
              blurb={p.blurb}
              tileBg={`${accentForIndex(i)}1a`}
              selected={selected === i}
              badge={i === 0 ? <SuggestedBadge /> : undefined}
              onClick={() => pick(i, p)}
            />
          ))
        )}
      </Stack>
    </Stack>
  );
}
