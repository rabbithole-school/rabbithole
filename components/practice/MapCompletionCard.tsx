"use client";

/**
 * MapCompletionCard — the ONCE-EVER "your map is ready" / "a new domain
 * appeared" reveal (finish-the-check-in SURFACES, PR2, Surface 4).
 *
 * Reuses the EXISTING one-time reveal mechanism — the `mapReveals` table
 * (convex/mapGates.ts's pattern) — under a new "mapComplete" map kind rather
 * than inventing a second one: `mapCompletionForScholar` (convex/
 * practiceSkills.ts) reads/derives the state, `acknowledgeMapCompletion`
 * stamps the row so it never replays. UNLIKE the sky/tree reveals (consumed
 * on ARRIVAL at /scholar/map — see app/scholar/map/page.tsx), this reveal is
 * acknowledged on the CTA press: the growth variant's CTA routes to the
 * check-in, not the map, so an arrival-based ack would never fire for it.
 * Self-only by construction (the query reads `ctx.user._id`) — mount this
 * ONLY on the scholar's own Home, never in a teacher's remote view.
 *
 * Two variants, same card:
 *   - "complete" — first time EVERY eligible domain has converged.
 *   - "growth"   — a later grade unlock adds a newly-eligible domain (M grew)
 *                  after a prior completion. Framed as expansion, never as
 *                  "your check-in is incomplete again" (rule 5).
 *
 * Visual: the SAME night InvitationCard milestone surface as MapHomeCard's
 * "unlock" rung — one definition of "the loud once-ever card", not a second
 * vocabulary for the same kind of moment.
 */

import NextLink from "next/link";
import { Link as ChakraLink, Stack } from "@chakra-ui/react";
import { ArrowRight } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { InvitationCard } from "@/components/ui/InvitationCard";
import {
  MAP_COMPLETE_CTA,
  MAP_COMPLETE_TITLE,
  MAP_GROWTH_CTA,
  MAP_GROWTH_TITLE,
  mapCompleteBody,
  mapGrowthBody,
} from "@/shared/checkInMapCopy";

export function MapCompletionCard({
  mapHref,
  checkInHref,
}: {
  /** Where the "complete" variant's CTA lands. */
  mapHref: string;
  /** Where the "growth" variant's CTA lands — a newly-eligible domain is
   *  unmapped, so it routes to the check-in, not the (already-seen) map. */
  checkInHref: string;
}) {
  const completion = useQuery(api.practiceSkills.mapCompletionForScholar, {});
  const acknowledge = useMutation(api.practiceSkills.acknowledgeMapCompletion);

  if (!completion || completion.state === "none") return null;

  const isGrowth = completion.state === "growth";
  const title = isGrowth ? MAP_GROWTH_TITLE : MAP_COMPLETE_TITLE;
  const body = isGrowth
    ? mapGrowthBody(
        completion.newDomainLabels[0] ?? "A new domain",
        completion.mapped,
        completion.eligible,
      )
    : mapCompleteBody(completion.eligible);
  const cta = isGrowth ? MAP_GROWTH_CTA : MAP_COMPLETE_CTA;
  const href = isGrowth ? checkInHref : mapHref;

  return (
    <Stack gap={3}>
      <InvitationCard
        surface="night"
        align="center"
        emoji={isGrowth ? "🌱" : "✨"}
        title={title}
        body={body}
        nestedContent={
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
            onClick={() => {
              // Ack on the PRESS, not on arrival (see file doc) — fire and
              // forget; a resulting reactive refresh cannot flicker this
              // card since the click already navigates away.
              void acknowledge({});
            }}
          >
            <NextLink href={href}>
              {cta}
              <ArrowRight size={16} weight="bold" />
            </NextLink>
          </ChakraLink>
        }
      />
    </Stack>
  );
}
