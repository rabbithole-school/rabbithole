"use client";

// The parent portal's Calendar tab: this child's school's upcoming no-school
// days, and the one thing a parent actually wants to do with them — put them in
// the calendar app they already live in.
//
// Every link here carries `?school=<slug>` for THIS child's school. The bare
// /calendar.ics resolves to the primary institution, so a second school's
// family would silently subscribe to the home school's year (CLAUDE.md →
// Multi-tenancy, the anonymous-surface case).

import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import {
  Box,
  Button,
  Heading,
  HStack,
  Input,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CalendarPlus, Check, Copy } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { convexSiteUrl } from "@/lib/convexUrls";

/** "2026-12-21" → "Mon, Dec 21". Parsed as UTC so the label never slips a day
 *  in a west-of-UTC browser — a day key is a calendar date, not an instant. */
function dayLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  return date.toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function rangeLabel(startDayKey: string, endDayKey: string): string {
  return startDayKey === endDayKey
    ? dayLabel(startDayKey)
    : `${dayLabel(startDayKey)} – ${dayLabel(endDayKey)}`;
}

export function ParentCalendarTab({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const calendar = useQuery(api.academicCalendar.upcomingForScholar, {
    scholarId,
  });
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (calendar === undefined) {
    return (
      <HStack py={6} justify="center">
        <Spinner size="sm" color="violet.400" />
      </HStack>
    );
  }

  if (calendar === null) {
    return (
      <Box
        p={4}
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        bg="gray.50"
      >
        <Text fontSize="sm" color="charcoal.600">
          Your child&rsquo;s school calendar isn&rsquo;t available yet. Ask the
          school office if you were expecting to see one here.
        </Text>
      </Box>
    );
  }

  const feedUrl = `${convexSiteUrl()}/calendar.ics?school=${encodeURIComponent(
    calendar.schoolSlug,
  )}`;
  // webcal:// is what makes a phone hand the feed to its calendar app instead
  // of downloading a one-off .ics that never updates again.
  const webcalUrl = feedUrl.replace(/^https?:\/\//, "webcal://");
  const googleUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(
    webcalUrl,
  )}`;

  return (
    <VStack align="stretch" gap={4}>
      <Box
        p={4}
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        bg="white"
      >
        <Heading as="h2" size="sm" fontFamily="heading" mb={1}>
          Subscribe to the school calendar
        </Heading>
        <Text fontSize="sm" color="charcoal.500" mb={3}>
          Closures and holidays for {calendar.schoolName}, kept up to date in
          your own calendar app. Subscribing follows changes — it isn&rsquo;t a
          one-time download.
        </Text>

        {/* Two equal siblings, each NAMING its destination. A single generic
            "Add to calendar" on the webcal:// link would be a dead end for the
            large share of families on Google — webcal:// is handled by the OS,
            which means Apple on Mac/iPhone/iPad and mostly nothing on Android.
            Outlook is deliberately NOT a button: outlook.com has no
            subscribe deep link at all (Add calendar → Subscribe from web is a
            paste-only form), so it lives in the copy path below where the
            instruction can be honest. */}
        <HStack gap={2} wrap="wrap" mb={4}>
          <Button asChild size="sm" variant="outline">
            <a href={webcalUrl}>
              <CalendarPlus weight="bold" />
              Apple Calendar
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={googleUrl} target="_blank" rel="noopener noreferrer">
              <CalendarPlus weight="bold" />
              Google Calendar
            </a>
          </Button>
        </HStack>

        <Text fontSize="xs" color="charcoal.500" mb={1}>
          Outlook and everything else: copy this address, then in your calendar
          app choose <Text as="span" fontWeight="600">Add calendar</Text> →{" "}
          <Text as="span" fontWeight="600">Subscribe from web</Text>.
        </Text>
        <HStack gap={2}>
          <Input
            ref={inputRef}
            value={feedUrl}
            readOnly
            size="sm"
            fontSize="xs"
            fontFamily="mono"
            onFocus={(event) => event.currentTarget.select()}
            aria-label="School calendar subscription address"
          />
          <Button
            size="sm"
            variant="outline"
            flexShrink={0}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(feedUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                // Insecure context or a denied permission: select the address
                // so the parent can copy it by hand rather than pressing a
                // button that silently does nothing.
                inputRef.current?.select();
              }
            }}
          >
            {copied ? <Check weight="bold" /> : <Copy weight="bold" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </HStack>
      </Box>

      <Box
        p={4}
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        bg="white"
      >
        <Heading as="h2" size="sm" fontFamily="heading" mb={3}>
          No school coming up
        </Heading>
        {calendar.upcoming.length === 0 ? (
          <Text fontSize="sm" color="charcoal.500">
            No closures on the calendar for the rest of the year.
          </Text>
        ) : (
          <VStack align="stretch" gap={0}>
            {calendar.upcoming.map((closure, index) => (
              <HStack
                key={closure.id}
                justify="space-between"
                gap={3}
                py={2}
                borderTopWidth={index === 0 ? 0 : "1px"}
                borderColor="gray.100"
              >
                <Text fontSize="sm" color="charcoal.700">
                  {closure.label}
                  {closure.kind === "staffOnly" && (
                    <Text as="span" fontSize="xs" color="charcoal.400">
                      {" "}
                      · no school for scholars
                    </Text>
                  )}
                </Text>
                <Text
                  fontSize="sm"
                  color="charcoal.500"
                  flexShrink={0}
                  textAlign="right"
                >
                  {rangeLabel(closure.startDayKey, closure.endDayKey)}
                </Text>
              </HStack>
            ))}
          </VStack>
        )}
      </Box>
    </VStack>
  );
}
