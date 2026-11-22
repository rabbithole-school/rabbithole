"use client";

/**
 * Pushed rows — the scholar-facing rows for a live "class focus" push
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
import { useMutation } from "convex/react";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useExternalApp } from "@/hooks/useExternalApp";
import { useRemote } from "@/hooks/useRemote";
import { toaster } from "@/lib/toaster";
import { AppTileIcon } from "@/components/ui/AppTileIcon";
import {
  pushActionLabel,
  pushGlyph,
  pushMetaLine,
  type PushForDisplay,
} from "@/shared/pushCopy";
import { openUntilPhrase } from "@/shared/openUntil";

/** The minute re-arm for the live read. A push's own liveness is decided
 * server-side (isPushLive); the row shows its end as a time, so nothing on
 * it ticks. */
const TICK_MS = 60_000;

export type LivePush = NonNullable<
  ReturnType<typeof useSmoothedQuery<typeof api.pushes.livePushesForMe>>
>[number];

/** The scholar's live pushes (an app, a resource, a link, an activity). The
 *  page reads them once, so the class section knows whether to show. */
export function useLivePushes(enabled: boolean): LivePush[] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const minuteNow = Math.floor(now / 60_000) * 60_000;
  // Smoothed so the minute re-arm doesn't blank the rows for a round-trip.
  const pushes = useSmoothedQuery(
    api.pushes.livePushesForMe,
    enabled ? { now: minuteNow } : "skip",
  );
  return pushes ?? [];
}

/**
 * The pushes as rows at the top of the class section ("In class now" /
 * "From class today"), above its activity rows: the same row grid and emoji
 * column, each with its own glyph or app tile, its note and "until …", and
 * its action on the right. There is no separate heading. An open-until give
 * (`openUntil` set) is drawn under "Open from class" instead and reads
 * "Open until Fri", worded against the page's `nowMs` like the rows there.
 */
export function PushRows({
  pushes,
  timeZone,
  nowMs,
}: {
  pushes: LivePush[];
  timeZone: string;
  nowMs: number;
}) {
  if (pushes.length === 0) return null;
  return (
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
          timeZone={timeZone}
          openUntilLabel={
            push.openUntil != null
              ? openUntilPhrase(push.openUntil, timeZone, nowMs)
              : null
          }
          activityId={push.activityId}
          externalAppId={push.externalAppId}
        />
      ))}
    </Flex>
  );
}

function FocusCard({
  push,
  timeZone,
  openUntilLabel,
  activityId,
  externalAppId,
}: {
  push: PushForDisplay;
  timeZone: string;
  openUntilLabel: string | null;
  activityId?: Id<"activities">;
  externalAppId?: Id<"externalApps">;
}) {
  const router = useRouter();
  const { stamp } = useRemote();
  const { launch, launchingId } = useExternalApp();
  const createSession = useMutation(api.sessions.create);
  const [starting, setStarting] = useState(false);

  const meta = pushMetaLine(push, timeZone, openUntilLabel);
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
      px="14px"
      py={3}
      bg="white"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="gray.200"
      cursor={clickable ? "pointer" : "default"}
      opacity={busy ? 0.6 : 1}
      transition="transform 0.08s ease"
      _hover={clickable ? { bg: "gray.50" } : undefined}
      _active={clickable ? { transform: "scale(0.99)" } : undefined}
    >
      {/* The class rows' emoji column (18px, 10px gap), so a push's glyph or
          app tile lines up with the activity rows' emoji below it. */}
      <HStack gap="10px" align="flex-start" flex={1} minW={0}>
        <Box w="18px" flexShrink={0} display="flex" justifyContent="center" pt="1px">
          {push.kind === "app" ? (
            // An app's identity has ONE rendering (shared/appTileMark.ts:
            // logo → the staff-chosen emoji → the initial, on the app's own
            // tint), the same mark as its launcher tile.
            <AppTileIcon
              name={push.title}
              iconUrl={push.iconUrl}
              iconEmoji={push.iconEmoji}
              color={push.color}
              boxSize="18px"
              radius="22%"
              markFontSize="10px"
              imagePadding="10%"
              // The row's own title names the app immediately to the right.
              decorative
            />
          ) : (
            // A video, link or activity has no catalog tile: the glyph names
            // the KIND of thing (shared/pushCopy.ts), so web and iPad agree.
            <Box fontSize="sm" lineHeight="1.43" color="violet.500" aria-hidden>
              {pushGlyph(push)}
            </Box>
          )}
        </Box>
      <Box flex={1} minW={0}>
        <Text
          fontFamily="heading"
          fontSize="sm"
          fontWeight="600"
          color="charcoal.600"
          lineClamp={1}
        >
          {push.title}
        </Text>
        {meta && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading" lineClamp={2}>
            {meta}
          </Text>
        )}
      </Box>
      </HStack>
      {clickable && (
        <Text
          flexShrink={0}
          fontSize="xs"
          color="violet.500"
          fontFamily="heading"
          fontWeight="700"
        >
          {actionLabel}
        </Text>
      )}
    </Flex>
  );
}
