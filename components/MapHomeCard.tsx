"use client";

/**
 * MapHomeCard — the scholar Home's ONE card for a map, web twin of
 * native/src/components/MapHomeCard.tsx.
 *
 * It replaces the standalone reveal card and the free-floating daily receipt,
 * which rendered the same object to the same destination on the same screen
 * (Andy, 2026-07-26: "feels like these are all 3 different flavors of the same
 * thing"). The state ladder — and every word of copy — lives in
 * shared/mapHomeCard.ts so web and native cannot drift; this file is only the
 * pixels. Design: review/tree-signal-reconciliation-plan.html.
 *
 * The web's THIRD state is deliberately empty. Native needs a standing Tree
 * doorway card because it has one pull-to-open gesture and it is spoken for;
 * the web already has a persistent doorway in the title bar ("Your Map"), so a
 * quiet card here would be a second rendering of access the scholar can already
 * see — exactly the duplication this card exists to remove.
 *
 * Home-only (f21 / Andy's ruling, 2026-07-15): the reveal state surfaces ONLY
 * on the scholar home screen — never in-session or on the Math Check-In result,
 * where it would compete with an in-flow "Up next →". Full-width (f21
 * addendum): w="100%" with no maxW cap, filling the same content column as
 * every other Home card.
 *
 * A render is never an acknowledgement, and neither is a CTA press: the reveal
 * is consumed on ARRIVAL at the map (app/scholar/map/page.tsx), which flips
 * `revealPending` false and drops this card to its next rung.
 */

import { useEffect, useState } from "react";
import NextLink from "next/link";
import {
  Box,
  Flex,
  HStack,
  Link as ChakraLink,
  Stack,
  Text,
} from "@chakra-ui/react";
import { KnowledgeNodeDial } from "@/components/KnowledgeNodeDial";
import type { MasteryState } from "@/shared/treeMapLayout";
import { InvitationCard } from "@/components/ui/InvitationCard";
import {
  RECEIPT_LEAD_W,
  RECEIPT_LEAD_GAP,
  RECEIPT_TAG_FONT_SIZE,
  RECEIPT_LABEL_FONT_SIZE,
} from "@/components/practice/receiptRowStyle";
import { ArrowRight, MapTrifold } from "@phosphor-icons/react";
import { useMapGates } from "@/hooks/useMapGates";
import { DailyRecapCard } from "@/components/DailyRecapCard";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import type { DailyRecap } from "@/convex/lib/dailyRecap";
import {
  MAP_HOME_MOVEMENT_HEADING,
  mapHomeAccess,
  mapHomeCopy,
  resolveMapHomeState,
  type MapKind,
} from "@/shared/mapHomeCard";
import {
  buildRecapLines,
  RECAP_DIAL_STATE,
  type RecapLine,
} from "@/shared/dailyRecapLines";

// The persistent nav control that opens the map, quoted verbatim so the card's
// instruction matches what the scholar actually sees in the title bar. If the
// label ever changes (app/scholar/page.tsx), change it here too. This sentence
// is web-only on purpose — native reaches the Sky by pulling down instead.
const MAP_NAV_LABEL = "Your Map";

// The reveal band has no dot state of its own — see RECAP_DIAL_STATE.
const DIAL_STATE: Record<RecapLine["mastery"], MasteryState> = RECAP_DIAL_STATE;

export function MapHomeCard({
  map,
  recap,
  mapHref,
  welcomeActive = false,
}: {
  map: MapKind;
  /** Lifted by app/scholar/page.tsx into its above-the-fold render gate so the
   *  whole home paints in one step. Only the Tree has a daily read model. */
  recap?: DailyRecap;
  /** Where the CTA lands — the page stamps it (remote-mode aware). */
  mapHref?: string;
  /** The scholar is still in the welcome sequence (onboarding pin non-null).
   *  Defers the once-ever reveal until welcome is done — see
   *  shared/mapHomeCard.ts resolveMapHomeState. */
  welcomeActive?: boolean;
}) {
  const gates = useMapGates();
  const state = resolveMapHomeState({
    map,
    unlocked: map === "sky" ? gates.sky : gates.tree,
    revealPending:
      map === "sky" ? gates.skyRevealPending : gates.treeRevealPending,
    hasMovement:
      // `undefined` means "still asking" (see resolveMapHomeState). The page
      // holds its skeleton until the recap resolves, so a Tree card that
      // renders at all already has its answer; the Sky is never asked, so it
      // reports a definite `false` instead of hiding forever.
      map === "tree" ? (recap === undefined ? undefined : recap.hasAny) : false,
    welcomeActive,
  });

  // Latch the pending unlock for this mount so a reactive refresh cannot make
  // the card flicker, and clear it once the reveal is recorded on arrival — so
  // browser Back cannot replay a moment the scholar already had.
  const pending = state === "unlock";
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (pending && !revealed) {
      // Syncing a "seen once" latch to the external (Convex) reveal state —
      // the accepted subscribe-to-external-system case for setState-in-effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRevealed(true);
    } else if (!pending && revealed) {
      setRevealed(false);
    }
  }, [pending, revealed]);

  const copy = mapHomeCopy(map, state);
  if (!copy) return null;

  // ── The once-ever unlock: the loudest rung, and the only filled surface.
  if (state === "unlock") {
    if (!revealed) return null;
    const lines = recap?.hasAny ? buildRecapLines(recap) : [];

    // A GESTURE-reached map (Sky) has no CTA — it teaches the access path. Its
    // milestone pixels now come from the InvitationCard family (surface="night"),
    // so a Sky-ready milestone reads as the same object as the other Home
    // invitations, one surface treatment across the family. Sky carries no daily
    // movement rows (only the Tree has a recap), so there is nothing to nest.
    if (mapHomeAccess(map) === "gesture") {
      return (
        <Stack gap={3}>
          {copy.eyebrow && (
            <ScholarHomeSectionHeader color="violet.600">
              {copy.eyebrow}
            </ScholarHomeSectionHeader>
          )}
          <InvitationCard
            surface="night"
            align="center"
            emoji={map === "sky" ? "🌌" : "🌳"}
            title={copy.title}
            body={copy.body}
            accessHint={
              <HStack
                gap={2}
                px={3.5}
                py={2}
                borderRadius="lg"
                bg="whiteAlpha.100"
                borderWidth="1px"
                borderColor="whiteAlpha.300"
                color="violet.100"
              >
                <MapTrifold size={18} weight="duotone" />
                <Text fontSize="sm" fontWeight="500">
                  Tap{" "}
                  <Text as="span" fontWeight="700" color="white">
                    {MAP_NAV_LABEL}
                  </Text>{" "}
                  in the top corner to open it.
                </Text>
              </HStack>
            }
          />
        </Stack>
      );
    }

    // A map whose standing Home access IS this card (Tree) keeps its ordinary
    // CTA in the unlock state. The reveal is still consumed on arrival, never by
    // this click. The dark milestone pixels come from the InvitationCard family
    // (surface="night"), the same one definition the Sky card uses — the CTA and
    // the day's-movement rows nest under the hero via the card's nested slot.
    return (
      <Stack gap={3}>
        {copy.eyebrow && (
          <ScholarHomeSectionHeader color="violet.600">
            {copy.eyebrow}
          </ScholarHomeSectionHeader>
        )}
        <InvitationCard
          surface="night"
          align="center"
          emoji={map === "sky" ? "🌌" : "🌳"}
          title={copy.title}
          body={copy.body}
          nestedContent={
            <>
              <ChakraLink
                asChild
                mt={1}
                display="inline-flex"
                alignItems="center"
                gap={1.5}
                px={3.5}
                py={2}
                borderRadius="lg"
                bg="whiteAlpha.100"
                borderWidth="1px"
                borderColor="whiteAlpha.300"
                color="white"
                fontFamily="heading"
                fontWeight="600"
                fontSize="sm"
                _hover={{ bg: "whiteAlpha.200", textDecoration: "none" }}
              >
                <NextLink href={mapHref ?? "/scholar/map?view=tree"}>
                  {copy.cta}
                  <ArrowRight size={16} weight="bold" />
                </NextLink>
              </ChakraLink>
              {/* Two clocks, one card: when the map ALSO moved today, the day's
                  rows nest under the milestone rather than becoming a second
                  card — so they say which clock they are on. Same row grammar as
                  the daily receipt (dial · name · tag), on the night surface. */}
              {lines.length > 0 && (
                <Stack
                  gap={2}
                  w="100%"
                  mt={1}
                  pt={4}
                  borderTopWidth="1px"
                  borderColor="whiteAlpha.300"
                  // The card centres its hero copy; these rows are a LIST, so
                  // they opt back out — otherwise every skill name floats to a
                  // different x and the leading dials read as orphaned.
                  textAlign="start"
                >
                  <Text
                    fontFamily="heading"
                    fontWeight="700"
                    fontSize="xs"
                    textTransform="uppercase"
                    letterSpacing="0.06em"
                    // navy.200, matching native — a nested sub-heading must stay
                    // quieter than the section eyebrow above the card, and violet
                    // is spoken for by the selected state.
                    color="navy.200"
                  >
                    {MAP_HOME_MOVEMENT_HEADING}
                  </Text>
                  {lines.map((line) => (
                    <Flex key={line.key} align="center" gap={RECEIPT_LEAD_GAP}>
                      <Box
                        aria-hidden="true"
                        flexShrink={0}
                        w={RECEIPT_LEAD_W}
                        display="flex"
                        justifyContent="center"
                      >
                        <KnowledgeNodeDial
                          mastery={DIAL_STATE[line.mastery]}
                          automaticity={0}
                          depth={0}
                          size={18}
                          flankWidth={0}
                          surface="night"
                        />
                      </Box>
                      <Text
                        flex="1"
                        minW={0}
                        lineClamp={1}
                        fontSize={RECEIPT_LABEL_FONT_SIZE}
                        fontWeight="700"
                        color="whiteAlpha.900"
                      >
                        {line.text}
                      </Text>
                      <Text
                        flexShrink={0}
                        textAlign="right"
                        lineClamp={1}
                        fontSize={RECEIPT_TAG_FONT_SIZE}
                        color="whiteAlpha.700"
                      >
                        {line.label}
                      </Text>
                    </Flex>
                  ))}
                </Stack>
              )}
            </>
          }
        />
      </Stack>
    );
  }

  // ── Today's movement: a receipt, not a celebration.
  if (state === "daily") {
    return (
      <Stack gap={3}>
        {copy.eyebrow && (
          <ScholarHomeSectionHeader>{copy.eyebrow}</ScholarHomeSectionHeader>
        )}
        <DailyRecapCard
          recap={recap}
          title={copy.title}
          ctaLabel={copy.cta ?? undefined}
          mapHref={mapHref ?? "/scholar/map?view=tree"}
        />
      </Stack>
    );
  }

  // ── The quiet doorway is the title bar's "Your Map" control on web. See the
  // component doc: a card here would duplicate access the scholar already has.
  return null;
}
