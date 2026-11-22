"use client";

/**
 * BEDTIME GATE — Rabbithole sleeps 8 pm–6 am for primary-institution scholars,
 * or earlier where a parent set a stricter bedtime (window + copy:
 * shared/bedtime.ts; who: convex/lib/bedtime.ts; the child's window:
 * convex/scholarBedtimes.ts, read through currentUser).
 *
 * Five minutes before bedtime a banner says when the app goes to sleep; at
 * bedtime a full-screen night sky covers everything until morning. Like the
 * teacher's rest cue (RestOverlay), it covers rather than replaces: the page
 * underneath stays mounted, so nothing a scholar was in the middle of is lost,
 * and the takeover lifts by itself at 6 am. Nothing on it is tappable — there
 * is no "five more minutes".
 *
 * "Covers" has to beat every other layer a scholar can have open at 8 pm: it
 * portals to <body> at the top z-index and makes everything else `inert`
 * (Ark dialogs lock the body with `pointer-events: none` and trap focus, so a
 * plain overlay would let clicks and typing through to an open dialog), and
 * leaves fullscreen present mode, whose top layer nothing else can cover.
 * The app tree goes inert through a React-managed wrapper — setting the
 * attribute by hand on server-rendered nodes breaks their hydration — and
 * only the client-only portals (dialogs, toasts) are marked directly.
 *
 * Native twin: native/src/components/BedtimeGate.tsx.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Flex, Text } from "@chakra-ui/react";
import { MoonStars } from "@phosphor-icons/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useBedtime } from "@/hooks/useBedtime";
import {
  BEDTIME_HEADLINE,
  bedtimeSubline,
  bedtimeWarningText,
  SCHOOL_BEDTIME,
} from "@/shared/bedtime";
import { BedtimeScene } from "@/components/BedtimeScene";
import { exitFullscreen, fullscreenElementOf } from "@/lib/fullscreen";

const BedtimeContext = createContext(false);

/** currentUser's bedtime fields (convex/users.ts). */
type BedtimeFields = {
  bedtimeTimeZone?: string | null;
  bedtimeStartMinutes?: number | null;
  bedtimeEndMinutes?: number | null;
};

/**
 * Whether Rabbithole is asleep right now — for what keeps running under the
 * sky because the page stays mounted (the session's voice loop, wake lock).
 */
export function useIsBedtime(): boolean {
  return useContext(BedtimeContext);
}

export function BedtimeGate({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const fields = user as BedtimeFields | null;
  const timeZone = fields?.bedtimeTimeZone ?? null;
  // The child's own window (a parent may set a stricter one), else the
  // school's.
  const bedtime = useBedtime(timeZone, {
    startMinutes: fields?.bedtimeStartMinutes ?? SCHOOL_BEDTIME.startMinutes,
    endMinutes: fields?.bedtimeEndMinutes ?? SCHOOL_BEDTIME.endMinutes,
  });

  const asleep = bedtime?.phase === "asleep";

  return (
    <BedtimeContext.Provider value={asleep}>
      <div
        data-bedtime-app=""
        inert={asleep || undefined}
        style={{ display: "contents" }}
      >
        {children}
      </div>
      {bedtime?.phase === "warning" && timeZone && (
        <BedtimeWarningBanner
          text={bedtimeWarningText(bedtime.sleepsAt, timeZone)}
        />
      )}
      {bedtime?.phase === "asleep" && timeZone && (
        <BedtimeOverlay subline={bedtimeSubline(bedtime.wakesAt, timeZone)} />
      )}
    </BedtimeContext.Provider>
  );
}

/**
 * A notice, not a control: it lets every click through to the page under it
 * (and has no close button, which an open dialog's body lock would swallow
 * anyway — and whose outside-click would dismiss the scholar's dialog).
 */
function BedtimeWarningBanner({ text }: { text: string }) {
  // Fullscreen present mode puts its element in the browser's top layer,
  // where nothing outside it can show; the banner rides inside it instead.
  const [fullscreenEl, setFullscreenEl] = useState<Element | null>(
    () => fullscreenElementOf(document) as Element | null,
  );
  useEffect(() => {
    const sync = () =>
      setFullscreenEl(fullscreenElementOf(document) as Element | null);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);
  return createPortal(
    <Flex
      role="status"
      position="fixed"
      top={3}
      left="50%"
      transform="translateX(-50%)"
      zIndex={1800}
      pointerEvents="none"
      w="calc(100% - 32px)"
      maxW="lg"
      align="center"
      gap={3}
      bg="#221A4D"
      color="white"
      borderRadius="xl"
      shadow="lg"
      px={4}
      py={3}
    >
      <MoonStars size={22} weight="duotone" color="#FCE9A8" aria-hidden />
      <Text flex="1" fontSize="sm" fontWeight="500">
        {text}
      </Text>
    </Flex>,
    fullscreenEl ?? document.body,
  );
}

function BedtimeOverlay({ subline }: { subline: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    void exitFullscreen(document); // no-op outside fullscreen; covers webkit
    const inerted = new Set<Element>();
    const inertSiblings = () => {
      for (const child of Array.from(document.body.children)) {
        if (
          child === el ||
          child.hasAttribute("inert") ||
          // Server-rendered: the app wrapper (inert via React) and its kin.
          child.matches("[data-bedtime-app], script, style, link, next-route-announcer")
        ) {
          continue;
        }
        child.setAttribute("inert", "");
        inerted.add(child);
      }
    };
    inertSiblings();
    // Dialogs and toasts portal in later; they get the same treatment.
    const observer = new MutationObserver(inertSiblings);
    observer.observe(document.body, { childList: true });
    // `inert` stops events from TARGETING the page, but an open Ark dialog
    // also listens on the document — Escape, or a pointerdown or focus
    // outside it (the overlay counts) closes it and loses its draft. So
    // nothing reaches the page's listeners while asleep, and the overlay
    // deliberately never takes focus.
    const swallow = (event: Event) => {
      event.stopPropagation();
      if (event.type === "keydown") event.preventDefault();
    };
    const swallowed = [
      "keydown",
      "keyup",
      "pointerdown",
      "mousedown",
      "touchstart",
      "focusin",
      "click",
    ];
    for (const type of swallowed) window.addEventListener(type, swallow, true);
    return () => {
      for (const type of swallowed) window.removeEventListener(type, swallow, true);
      observer.disconnect();
      for (const child of inerted) child.removeAttribute("inert");
    };
  }, []);

  return createPortal(
    <Flex
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`${BEDTIME_HEADLINE}. ${subline}`}
      position="fixed"
      inset={0}
      // Above every scholar-reachable layer (camera, lightbox, profile
      // photo); only the admin ImpersonationBanner sits higher.
      zIndex={2147483600}
      pointerEvents="auto"
      bg="#0C0A18"
      direction="column"
      align="center"
      justify="center"
      gap={2}
      px={6}
      outline="none"
      overflow="hidden"
    >
      <BedtimeScene />
      <Box position="relative" textAlign="center" maxW="md" mt={-4}>
        <Text
          fontSize={{ base: "2xl", md: "3xl" }}
          fontFamily="heading"
          fontWeight="700"
          color="white"
          letterSpacing="-0.01em"
        >
          {BEDTIME_HEADLINE}
        </Text>
        <Text mt={2} fontSize={{ base: "md", md: "lg" }} color="whiteAlpha.800">
          {subline}
        </Text>
      </Box>
    </Flex>,
    document.body,
  );
}
