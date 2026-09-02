"use client";

/**
 * FocusStrip — the scholar-facing card strip for a live "class focus" push
 * (see convex/pushes.ts, convex/schema.ts `pushes`). Modeled on
 * RoomCueBanner's calm-chrome-around-teacher-content idiom, but rendered as
 * a row of cards rather than a single dismissible banner: a push isn't
 * locally dismissible (it's the teacher's standing instruction for the
 * window, not a courtesy note), so there is no dismiss affordance here.
 *
 * All wording comes from shared/pushCopy.ts so the words on this card can
 * never drift from native's twin (native/src/components/FocusStrip.tsx), and
 * an app card's mark comes from shared/appTileMark.ts (via AppTileIcon) so
 * its LOOK can't drift either. This file only supplies the layout + the
 * per-kind "how do I open this" mechanism, which is necessarily
 * platform-specific.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useExternalApp } from "@/hooks/useExternalApp";
import { useRemote } from "@/hooks/useRemote";
import { toaster } from "@/lib/toaster";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { AppTileIcon } from "@/components/ui/AppTileIcon";
import {
  FOCUS_STRIP_HEADING,
  pushActionLabel,
  pushGlyph,
  pushTimeLeftLabel,
  type PushForDisplay,
} from "@/shared/pushCopy";

/** How often the countdown re-renders. A push's own liveness is still
 * decided server-side (isPushLive) — this only keeps the label fresh. */
const TICK_MS = 15_000;

export function FocusStrip() {
  const pushes = useQuery(api.pushes.livePushesForMe, {});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Loading or empty: render nothing, matching AppLauncher's no-layout-shift
  // convention for a section that may legitimately be absent.
  if (!pushes || pushes.length === 0) return null;

  return (
    <Box display="flex" flexDirection="column" gap={3}>
      <ScholarHomeSectionHeader>{FOCUS_STRIP_HEADING}</ScholarHomeSectionHeader>
      <Flex direction="column" gap={2}>
        {pushes.map((push) => (
          <FocusCard
            key={push._id}
            push={{
              pushId: push._id,
              kind: push.kind,
              title: push.title,
              subtitle: push.subtitle ?? null,
              url: push.url ?? null,
              iconUrl: push.iconUrl ?? null,
              iconEmoji: push.iconEmoji ?? null,
              color: push.color ?? null,
              media: push.media ?? null,
              note: push.note ?? null,
              blocking: push.blocking,
              endsAt: push.endsAt,
            }}
            now={now}
            activityId={push.activityId}
            externalAppId={push.externalAppId}
          />
        ))}
      </Flex>
    </Box>
  );
}

function FocusCard({
  push,
  now,
  activityId,
  externalAppId,
}: {
  push: PushForDisplay;
  now: number;
  activityId?: Id<"activities">;
  externalAppId?: Id<"externalApps">;
}) {
  const router = useRouter();
  const { stamp } = useRemote();
  const { launch, launchingId } = useExternalApp();
  const createSession = useMutation(api.sessions.create);
  const [starting, setStarting] = useState(false);

  const timeLeft = pushTimeLeftLabel(push.endsAt, now);
  const actionLabel = pushActionLabel(push);
  const busy =
    starting || (push.kind === "app" && launchingId === externalAppId && launchingId !== null);

  const openLink = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleClick = async () => {
    if (busy) return;
    switch (push.kind) {
      case "app": {
        if (!push.url || !externalAppId) return;
        await launch({
          appId: externalAppId,
          name: push.title,
          webUrl: push.url,
        });
        return;
      }
      case "link": {
        if (push.url) openLink(push.url);
        return;
      }
      case "activity": {
        if (!activityId) return;
        setStarting(true);
        try {
          const result = await createSession({ activityId });
          if (result) router.push(stamp(`/scholar/${result.id}`));
        } catch (err) {
          console.error("FocusStrip: failed to start activity", err);
          toaster.error({ title: "Couldn't start that activity", description: "Please try again." });
        } finally {
          setStarting(false);
        }
        return;
      }
      case "resource": {
        // The resource's own URL isn't always resolvable client-side (a
        // file's URL is signed server-side, a Rabbit Slides deck has no
        // URL at all) — open it only when the query already resolved one.
        if (push.url) openLink(push.url);
        return;
      }
    }
  };

  const clickable =
    push.kind === "link"
      ? !!push.url
      : push.kind === "resource"
        ? !!push.url
        : push.kind === "activity"
          ? !!activityId
          : !!push.url;

  return (
    <Flex
      as={clickable ? "button" : "div"}
      onClick={clickable ? () => void handleClick() : undefined}
      align="center"
      gap={3}
      w="full"
      textAlign="left"
      px={4}
      py={3}
      bg="white"
      borderRadius="lg"
      borderWidth="1px"
      borderColor="violet.200"
      boxShadow="0 2px 6px rgba(20,24,50,0.06)"
      cursor={clickable ? "pointer" : "default"}
      opacity={busy ? 0.6 : 1}
      transition="transform 0.08s ease"
      _active={clickable ? { transform: "scale(0.99)" } : undefined}
    >
      {push.kind === "app" ? (
        // An app's identity already has ONE rendering (shared/appTileMark.ts:
        // logo → the staff-chosen emoji → the initial, on the app's own tint),
        // and the launcher tile for this very app is usually on screen right
        // below. The generic "▶" that used to sit here was a second vocabulary
        // for the same signal, so this substitutes the canonical mark into the
        // slot the glyph already occupied — same slot, no extra tile. Sized to
        // native's card (native/src/components/FocusStrip.tsx), which is what
        // makes the two surfaces the same card.
        <AppTileIcon
          name={push.title}
          iconUrl={push.iconUrl}
          iconEmoji={push.iconEmoji}
          color={push.color}
          boxSize="44px"
          radius="22%"
          markFontSize="16px"
          imagePadding="14%"
          // The card's own title names the app immediately to the right.
          decorative
        />
      ) : (
        // A video, link or activity has no catalog tile: the glyph names the
        // KIND of thing, and shared/pushCopy.ts owns that choice so web and
        // iPad can't drift.
        <Box fontSize="lg" color="violet.500" flexShrink={0} aria-hidden>
          {pushGlyph(push)}
        </Box>
      )}
      <Box flex={1} minW={0}>
        <Text
          fontFamily="heading"
          fontSize="sm"
          fontWeight="700"
          color="charcoal.500"
          lineClamp={1}
        >
          {push.title}
        </Text>
        {push.note && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={2}>
            {push.note}
          </Text>
        )}
      </Box>
      <HStack gap={2} flexShrink={0} align="center">
        {timeLeft && (
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" fontWeight="600">
            {timeLeft}
          </Text>
        )}
        {clickable && (
          <Text fontSize="xs" color="violet.500" fontFamily="heading" fontWeight="700">
            {actionLabel}
          </Text>
        )}
      </HStack>
    </Flex>
  );
}
