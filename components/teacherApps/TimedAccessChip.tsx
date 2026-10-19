"use client";

/**
 * The timed-access chip on the teacher Apps page
 * (review/teacher-apps-v2-sketch.html §1): green "Live now · until 2:30 PM"
 * while a push or an "Open until…" grant has the app on scholars' launchers,
 * blue "Next · Thu 9:00–9:45 AM" for a planned push. Only the current or next
 * window reaches here (appAudiences.listAppsWithAudiences `timed`); the server
 * returns boundaries and this words them in the school's time zone.
 */

import { chakra } from "@chakra-ui/react";
import type { AppTimedWindow } from "@/convex/appAudiences";
import { fullWindow, SOURCE_LINE, timedAccessLabel } from "./timedAccessLabel";

export function TimedAccessChip({
  window: w,
  now,
  withAudience = true,
  onClick,
}: {
  window: AppTimedWindow;
  now: number;
  /** Rows name who it covers; a gallery card's chip sits on the image and
   *  leaves that to the card's reach line. */
  withAudience?: boolean;
  onClick?: () => void;
}) {
  const live = w.state === "live";
  const label = timedAccessLabel(w, now, withAudience);
  return (
    <chakra.button
      type="button"
      display="inline-flex"
      alignItems="center"
      gap={1.5}
      fontFamily="heading"
      fontSize="xs"
      fontWeight="600"
      whiteSpace="nowrap"
      borderRadius="full"
      px={2.5}
      py={0.5}
      bg={live ? "green.50" : "blue.50"}
      color={live ? "green.700" : "blue.700"}
      cursor={onClick ? "pointer" : "default"}
      _hover={onClick ? { bg: live ? "green.100" : "blue.100" } : undefined}
      _focusVisible={{
        outline: "2px solid",
        outlineColor: "violet.400",
        outlineOffset: "2px",
      }}
      title={`${fullWindow(w)} · ${w.audience} · ${SOURCE_LINE[w.source]}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {live && (
        <chakra.span
          w="7px"
          h="7px"
          borderRadius="full"
          bg="green.500"
          flexShrink={0}
          aria-hidden
        />
      )}
      {label}
    </chakra.button>
  );
}
