"use client";

import { useEffect, useState } from "react";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { FlairMark } from "@/components/FlairChips";
import { flairNoticeDelayMs } from "@/shared/flairMotion";

import { FLAIR_MOTION_CSS } from "./flairMotionCss";

export type FlairAward = {
  criterionId: string;
  label: string;
};

export function FlairAwardNotice({
  awards,
  sessionId,
  animate = false,
  onAnimationClaim,
}: {
  awards: FlairAward[];
  sessionId: Id<"sessions">;
  /**
   * True only for a flair row this client has just seen arrive — the caller's
   * arrival baseline decides that, and a remote teacher view passes false so an
   * observer never sees the scholar's moment replayed as their own.
   *
   * Deliberately NOT gated on a live stream: Convex subscription catch-up can
   * land after the SSE connection closes, which would drop the entrance on a
   * genuinely new award. Read once, at mount, because the caller's `arriving`
   * list settles while the entrance may still be running and re-reading it
   * would pull the class mid-animation and snap the row.
   */
  animate?: boolean;
  /** Marks this arrival consumed while the mounted notice finishes locally. */
  onAnimationClaim?: () => void;
}) {
  const [entering] = useState(animate);
  useEffect(() => {
    if (entering) onAnimationClaim?.();
  }, [entering, onAnimationClaim]);
  const art = useQuery(api.flairArt.forSession, { sessionId });
  if (awards.length === 0) return null;
  const artByCriterionId = new Map(
    (art ?? []).map((item) => [item.criterionId, item]),
  );

  return (
    <Stack
      role="status"
      aria-label={`Earned flair. ${awards.map((award) => award.label).join(". ")}`}
      alignSelf="stretch"
      align="start"
      gap={2}
      py={1}
    >
      {entering ? (
        <style dangerouslySetInnerHTML={{ __html: FLAIR_MOTION_CSS }} />
      ) : null}
      {awards.map((award, index) => {
        const delay = entering
          ? { animationDelay: `${flairNoticeDelayMs(index)}ms` }
          : undefined;
        return (
          <Flex
            key={award.criterionId}
            align="center"
            gap={2}
            className={entering ? "rh-flair-notice" : undefined}
            style={delay}
          >
            {/* The mark settles inside the row that is already rising, so the
                wrapper — not FlairMark itself — carries the scale. Its art
                swaps in underneath whenever the generated image finishes. */}
            <Box
              display="inline-flex"
              flexShrink={0}
              className={entering ? "rh-flair-notice-emoji" : undefined}
              style={delay}
            >
              <FlairMark
                imageUrl={
                  artByCriterionId.get(award.criterionId)?.imageUrl ?? null
                }
                initial={
                  artByCriterionId.get(award.criterionId)?.initial ??
                  flairInitial(award.label)
                }
              />
            </Box>
            <Stack gap={0}>
              {/* Same muted token as every other line in the chat's system
                  vocabulary (the tool-activity line, the speaker labels) —
                  this notice must not read as a separate, fainter class. */}
              <Text fontSize="xs" color="fg.muted" fontFamily="heading">
                Earned flair
              </Text>
              <Text
                fontSize="xs"
                color="fg.muted"
                fontFamily="heading"
                fontWeight="600"
              >
                {award.label}
              </Text>
            </Stack>
          </Flex>
        );
      })}
    </Stack>
  );
}

function flairInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}
