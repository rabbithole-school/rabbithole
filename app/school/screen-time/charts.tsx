"use client";

// The charts on School › Screen time. Each is drawn by a pure SVG builder in
// shared/screenTimeCharts.ts (the same drawing the Friday Slack roundup
// rasterizes to a PNG); this file measures the width, puts the SVG on screen
// and lays a hover over the builder's hit boxes.
//
// Everything shown is timing and titles; no conversation content.

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  LIGHT_CHART_THEME,
  renderDayStripSvg,
  renderInSchoolAveragesSvg,
  renderStackedDaysSvg,
  type HitBox,
  type StripHit,
} from "@/shared/screenTimeCharts";
import {
  STRETCH_KINDS,
  STRETCH_KIND_LABELS,
  type StretchKind,
} from "@/shared/screenTimeStretches";
import { formatScreenMinutes } from "@/shared/screenTimeWeek";
import { minuteOfDayForTimezone } from "@/shared/institutionDay";
import type { BellSide, PeriodSummary } from "@/shared/screenTimePeriod";

type DayTimelineResult = FunctionReturnType<typeof api.deviceActivity.dayTimeline>;

/** The web app is light-only; DARK_CHART_THEME is there for a dark surface. */
const THEME = LIGHT_CHART_THEME;

/**
 * The theme with the page's own font, so on screen the SVG text matches the
 * page (next/font gives Hanken Grotesk a generated family name).
 */
function usePageTheme() {
  // The SVG draws only after the width is measured on the client, so reading
  // the body's font here never reaches a server render.
  const [fontFamily] = useState(() =>
    typeof document === "undefined"
      ? THEME.fontFamily
      : getComputedStyle(document.body).fontFamily.replace(/"/g, "'") || THEME.fontFamily,
  );
  return useMemo(() => ({ ...THEME, fontFamily }), [fontFamily]);
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** An SVG string from a shared builder, with a tooltip over its hit boxes. */
function SvgWithHover<H extends HitBox>({
  svg,
  hits,
  tooltip,
}: {
  svg: string;
  hits: readonly H[];
  tooltip: (hit: H) => ReactNode;
}) {
  const [hover, setHover] = useState<H | null>(null);
  return (
    <Box position="relative" onMouseLeave={() => setHover(null)}>
      {/* The SVG is built from escaped text by shared/screenTimeCharts.ts. */}
      <Box lineHeight={0} dangerouslySetInnerHTML={{ __html: svg }} />
      {hits.map((hit, index) => (
        <Box
          key={index}
          position="absolute"
          left={`${hit.x}px`}
          top={`${hit.y}px`}
          width={`${hit.width}px`}
          height={`${hit.height}px`}
          onMouseEnter={() => setHover(hit)}
        />
      ))}
      {hover ? (
        <Box
          position="absolute"
          left={`${hover.x + hover.width / 2}px`}
          top={`${hover.y}px`}
          transform="translate(-50%, calc(-100% - 8px))"
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="6px"
          boxShadow="md"
          px={3}
          py={2}
          zIndex={2}
          pointerEvents="none"
          whiteSpace="nowrap"
          fontFamily="body"
          fontSize="sm"
          lineHeight="1.45"
          color="charcoal.500"
        >
          {tooltip(hover)}
        </Box>
      ) : null}
    </Box>
  );
}

function Swatch({ color, hatch = false }: { color: string; hatch?: boolean }) {
  return (
    <Box
      as="span"
      display="inline-block"
      w="10px"
      h="10px"
      borderRadius="2px"
      bg={color}
      backgroundImage={
        hatch
          ? "repeating-linear-gradient(135deg, transparent 0 2px, white 2px 4px)"
          : undefined
      }
    />
  );
}

function Legend({ items }: { items: { label: string; swatch: ReactNode }[] }) {
  return (
    <HStack gap={4} wrap="wrap" fontFamily="body" fontSize="sm" color="charcoal.500">
      {items.map((item) => (
        <HStack key={item.label} gap={1.5}>
          {item.swatch}
          <Text>{item.label}</Text>
        </HStack>
      ))}
    </HStack>
  );
}

// ── Day strip ───────────────────────────────────────────────────────────

const DEFAULT_START_MINUTE = 5 * 60;
const DEFAULT_END_MINUTE = 22 * 60;

export function DayStrip({
  data,
  emphasizeScholarId,
}: {
  data: DayTimelineResult;
  emphasizeScholarId: string | null;
}) {
  const [ref, width] = useWidth();
  const theme = usePageTheme();
  const { dayKey, timeZone, scholars } = data;

  const clock = useMemo(() => {
    const format = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    return { format: (at: number) => format.format(at).replace("AM", "a.m.").replace("PM", "p.m.") };
  }, [timeZone]);

  const drawing = useMemo(() => {
    if (width < 100) return null;
    // Widen the 5 a.m.–10 p.m. axis to whole hours if anyone was on outside it.
    let startMinute = DEFAULT_START_MINUTE;
    let endMinute = DEFAULT_END_MINUTE;
    for (const scholar of scholars) {
      for (const stretch of [
        ...(scholar.timeline?.stretches ?? []),
        ...(scholar.timeline?.leftOpen ?? []),
      ]) {
        startMinute = Math.min(startMinute, Math.floor(minuteOfDayForTimezone(stretch.start, timeZone) / 60) * 60);
        const endOfStretch = minuteOfDayForTimezone(stretch.end, timeZone);
        if (endOfStretch > 0) endMinute = Math.max(endMinute, Math.ceil(endOfStretch / 60) * 60);
      }
    }
    return renderDayStripSvg({
      width,
      timeZone,
      theme,
      axisStartMinute: startMinute,
      axisEndMinute: Math.min(24 * 60, endMinute),
      emphasizeRowId: emphasizeScholarId,
      panels: [
        {
          dayKey,
          schoolHours: scholars.find((s) => (s.timeline?.schoolHours.length ?? 0) > 0)?.timeline?.schoolHours ?? [],
          rows: scholars.map((scholar) => ({
            id: scholar.scholarId,
            label: scholar.scholarName,
            totalMinutes: scholar.timeline?.totalMinutes ?? 0,
            stretches: scholar.timeline?.stretches ?? [],
            leftOpen: scholar.timeline?.leftOpen ?? [],
          })),
        },
      ],
    });
  }, [width, scholars, timeZone, dayKey, emphasizeScholarId, theme]);

  const tooltip = (hit: StripHit) => {
    const scholar = scholars[hit.rowIndex];
    const range = hit.stretch ?? hit.leftOpen!;
    const minutes = (range.end - range.start) / 60_000;
    return (
      <>
        <Text fontWeight="600" color="navy.500">{scholar?.scholarName}</Text>
        <Text>
          <Text as="span" fontWeight="600">
            {hit.stretch ? STRETCH_KIND_LABELS[hit.stretch.kind] : "Own app left open, no touches"}
          </Text>
          {hit.stretch?.detail && hit.stretch.kind !== "rabbithole" ? ` (${hit.stretch.detail})` : ""}
          {hit.stretch?.kind === "rabbithole" ? ", no activity open" : ""}
        </Text>
        <Text>
          {clock.format(range.start)} – {clock.format(range.end)} ·{" "}
          {minutes < 1 ? "under a minute" : formatScreenMinutes(minutes)}
          {hit.stretch ? "" : " (not counted)"}
        </Text>
      </>
    );
  };

  return (
    <Stack gap={4}>
      <Legend
        items={[
          ...STRETCH_KINDS.map((kind) => ({
            label: STRETCH_KIND_LABELS[kind],
            swatch: <Swatch color={THEME.kinds[kind]} />,
          })),
          { label: "Own app left open, no touches (not counted)", swatch: <Swatch color={THEME.leftOpen} hatch /> },
          { label: "Idle (not on Rabbithole)", swatch: <Swatch color={THEME.idle} /> },
        ]}
      />
      <Box ref={ref} w="100%">
        {drawing ? <SvgWithHover svg={drawing.svg} hits={drawing.hits} tooltip={tooltip} /> : null}
      </Box>
    </Stack>
  );
}

// ── Averages and activity bars (week and month) ─────────────────────────────────

export function AveragesChart({
  summary,
  scopeName,
  emphasizeScholarId,
}: {
  summary: PeriodSummary;
  /** The scope's name for its average line ("All scholars", "Seals"). */
  scopeName: string;
  emphasizeScholarId: string | null;
}) {
  const [ref, width] = useWidth();
  const theme = usePageTheme();
  const { people, average, schoolDays } = summary;
  const drawing = useMemo(() => {
    if (width < 100) return null;
    return renderInSchoolAveragesSvg({
      width,
      theme,
      emphasizeRowId: emphasizeScholarId,
      average: { label: scopeName, value: average.average },
      rows: people.map((p) => ({ id: p.id, label: p.name, value: p.inSchoolAvg })),
    });
  }, [width, people, average, scopeName, emphasizeScholarId, theme]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  return (
    <Box ref={ref} w="100%">
      {drawing ? (
        <SvgWithHover
          svg={drawing.svg}
          hits={drawing.hits}
          tooltip={(hit) => {
            const person = byId.get(hit.row.id);
            if (!person) return null;
            return (
              <>
                <Text fontWeight="600" color="navy.500">{person.name}</Text>
                <Text>{Math.round(person.inSchoolAvg)} min per school day in school</Text>
                <Text>{Math.round(person.outsideAvg)} min per day outside school</Text>
                <Text>
                  {person.schoolDaysOn} of {schoolDays.length} school days on it
                </Text>
              </>
            );
          }}
        />
      ) : null}
    </Box>
  );
}

/** What happened on one day, for the activity bars' hover. */
export type ActivityDay = {
  dayKey: string;
  /** An open school day; null when nobody's row says (no time that day). */
  schoolDay: boolean | null;
  /** Minutes per kind for the scope's average scholar or the selected scholar. */
  minutes: Record<StretchKind, number>;
};

const SIDE_PHRASE: Record<BellSide, string> = {
  inSchool: "at school",
  outside: "outside school",
  both: "in and outside school",
};

/**
 * One bar per day, stacked by activity in the day strip's colours. `side`
 * picks which side of the bell counts: the same bell rule as the table's
 * "Outside school" column, so Extended Ed (after the last bell) is outside.
 */
export function ActivityBarsChart({
  days,
  side,
  who,
}: {
  days: readonly ActivityDay[];
  side: BellSide;
  /** "Average scholar, All scholars" or the selected scholar's name. */
  who: string;
}) {
  const [ref, width] = useWidth();
  const theme = usePageTheme();
  const drawing = useMemo(() => {
    if (width < 100 || days.length === 0) return null;
    return renderStackedDaysSvg({
      width,
      theme,
      days: days.map((day) => day.dayKey),
      values: days.map((day) => day.minutes),
      ariaLabel: `${who}: minutes by activity ${SIDE_PHRASE[side]}, day by day`,
    });
  }, [width, days, side, who, theme]);

  const bellNote = (day: ActivityDay): string | null => {
    if (day.schoolDay === false) {
      return side === "inSchool"
        ? "No school this day."
        : "No school this day, so all of it is outside school.";
    }
    if (day.schoolDay === null || side === "inSchool") return null;
    return "Outside school includes Extended Ed after the last bell.";
  };

  return (
    <Stack gap={3}>
      <Legend
        items={STRETCH_KINDS.map((kind) => ({
          label: STRETCH_KIND_LABELS[kind],
          swatch: <Swatch color={THEME.kinds[kind]} />,
        }))}
      />
      <Box ref={ref} w="100%">
        {drawing ? (
          <SvgWithHover
            svg={drawing.svg}
            hits={drawing.hits}
            tooltip={(hit) => {
              const day = days[hit.dayIndex];
              if (!day) return null;
              const total = STRETCH_KINDS.reduce((sum, kind) => sum + day.minutes[kind], 0);
              const note = bellNote(day);
              return (
                <>
                  <Text fontWeight="600" color="navy.500">{dayLabel(day.dayKey)}</Text>
                  <Text>
                    {who}: {formatScreenMinutes(total)} {SIDE_PHRASE[side]}
                  </Text>
                  {STRETCH_KINDS.filter((kind) => day.minutes[kind] >= 1).map((kind) => (
                    <HStack key={kind} gap={1.5}>
                      <Swatch color={THEME.kinds[kind]} />
                      <Text>
                        {STRETCH_KIND_LABELS[kind]} {formatScreenMinutes(day.minutes[kind])}
                      </Text>
                    </HStack>
                  ))}
                  {note ? <Text color="charcoal.400">{note}</Text> : null}
                </>
              );
            }}
          />
        ) : null}
      </Box>
    </Stack>
  );
}

function dayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
