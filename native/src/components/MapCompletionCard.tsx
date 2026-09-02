/**
 * MapCompletionCard (native) — the RN twin of web
 * components/practice/MapCompletionCard.tsx (finish-the-check-in SURFACES,
 * PR2, Surface 4): the ONCE-EVER "your map is ready" / "a new domain
 * appeared" reveal.
 *
 * Reuses the EXISTING one-time reveal mechanism — the `mapReveals` table
 * (convex/mapGates.ts's pattern) — under the new "mapComplete" map kind:
 * `mapCompletionForScholar` (convex/practiceSkills.ts) reads/derives the
 * state, `acknowledgeMapCompletion` stamps the row so it never replays.
 * UNLIKE the sky/tree reveals (consumed on ARRIVAL — see native's
 * MapHomeCard.tsx), this reveal is acknowledged on the CTA PRESS: the growth
 * variant's CTA routes to the check-in, not the map, so an arrival-based ack
 * would never fire for it. Self-only by construction (the query reads
 * `ctx.user._id`) — native's Home has no remote/teacher view to guard against.
 *
 * Two variants, same card:
 *   - "complete" — first time EVERY eligible domain has converged.
 *   - "growth"   — a later grade unlock adds a newly-eligible domain (M grew)
 *                  after a prior completion. Framed as expansion, never as
 *                  "your check-in is incomplete again" (rule 5).
 *
 * Visual: the SAME night InvitationCard milestone surface as native
 * MapHomeCard's "unlock" rung — one definition of "the loud once-ever card".
 */

import { Pressable, StyleSheet, Text } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { router } from "expo-router";

import { api } from "@/lib/convex";
import { fonts, palette, useColors } from "@/theme";
import { InvitationCard } from "@/components/InvitationCard";
import {
  MAP_COMPLETE_CTA,
  MAP_COMPLETE_TITLE,
  MAP_GROWTH_CTA,
  MAP_GROWTH_TITLE,
  mapCompleteBody,
  mapGrowthBody,
} from "../../vendor/shared/checkInMapCopy";

export function MapCompletionCard() {
  const colors = useColors();
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
  const openTarget = () => {
    // Ack on the PRESS, not on arrival (see file doc) — fire and forget; the
    // press already navigates away, so a resulting reactive refresh cannot
    // flicker this card.
    void acknowledge({});
    router.push(
      isGrowth ? "/practice?checkin=all" : { pathname: "/sky", params: { view: "tree" } },
    );
  };

  return (
    <InvitationCard
      surface="night"
      align="center"
      emoji={isGrowth ? "🌱" : "✨"}
      title={title}
      body={body}
      nestedContent={
        <Pressable
          onPress={openTarget}
          accessibilityRole="button"
          accessibilityLabel={cta}
          hitSlop={8}
          style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
        >
          <Text style={[styles.ctaText, { color: colors.white }]}>{cta}  →</Text>
        </Pressable>
      }
    />
  );
}

const styles = StyleSheet.create({
  cta: {
    marginTop: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: palette.navy[800],
    borderWidth: 1,
    borderColor: palette.navy[700],
  },
  ctaText: { fontFamily: fonts.semibold, fontSize: 15 },
});
