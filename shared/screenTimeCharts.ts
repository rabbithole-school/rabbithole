// Pure SVG builders for the School › Screen time charts: the minute-by-minute
// day strip, the in-school average per scholar, and the day-by-day trend. No
// DOM, React or Convex imports (see shared/screenTimeCharts.test.ts).
//
// ONE DRAWING, TWO RENDERERS. The staff page puts the returned SVG on screen
// and lays its hover on top using the returned hit boxes; the Friday Slack
// roundup rasterizes the same string to a PNG with @cf-wasm/resvg (the way
// convex/lib/inkRaster.ts does). So everything here stays inside what resvg
// draws: plain shapes, <pattern> hatching, <text> with an explicit font
// family. No foreignObject, no CSS variables, no stylesheet; every colour
// comes in through a `ChartTheme`, so light, dark and PNG each choose theirs.
//
// Text is measured by estimate (AVG_CHAR_EM), since there is no layout engine
// on the server. Labels are only drawn where the estimate says they fit.

import type { Interval } from "./screenTime";
import {
  STRETCH_KINDS,
  STRETCH_KIND_LABELS,
  type StretchKind,
} from "./screenTimeStretches";
import { instantForLocalMinutes } from "./institutionDay";

export type ChartTheme = {
  fontFamily: string;
  /** Names and values. */
  text: string;
  /** Axis labels and secondary text. */
  textMuted: string;
  /** The chart's own background; hatching lines are drawn in it. */
  surface: string;
  /** A scholar's track: idle, not on Rabbithole. */
  idle: string;
  /** School hours, laid over the tracks at `schoolBandOpacity`. */
  schoolBand: string;
  schoolBandOpacity: number;
  /** Hour and value gridlines. */
  grid: string;
  /** One solid colour per stretch kind. */
  kinds: Record<StretchKind, string>;
  /** Own app left open with no touches (hatched, never counted). */
  leftOpen: string;
  /** Every scholar's bar on the averages chart: one neutral colour. */
  bar: string;
  /** The current scope's average: a dashed line on both period charts. */
  average: string;
  /** The selected scholar: their bar, and their line on the trend chart. */
  highlight: string;
};

/**
 * Light theme. Kind colours follow the dataviz default categorical order;
 * the rest are Rabbithole's gray ramp (shared/brand.ts).
 */
export const LIGHT_CHART_THEME: ChartTheme = {
  fontFamily: "Hanken Grotesk, Helvetica, Arial, sans-serif",
  text: "#16202f",
  textMuted: "#6d7584",
  surface: "#ffffff",
  idle: "#e6e8ea",
  schoolBand: "#16202f",
  schoolBandOpacity: 0.07,
  grid: "#d0d4d9",
  kinds: {
    building: "#2a78d6",
    playing: "#e87ba4",
    chat: "#eb6834",
    practice: "#1baf7a",
    web: "#eda100",
    launched_app: "#008300",
    rabbithole: "#8a93a3",
  },
  leftOpen: "#c2b6e8",
  bar: "#b4bcc8",
  average: "#4d5767",
  highlight: "#6250d6",
};

/** Dark theme: the same hues, re-stepped for a dark surface. */
export const DARK_CHART_THEME: ChartTheme = {
  fontFamily: LIGHT_CHART_THEME.fontFamily,
  text: "#f0efec",
  textMuted: "#a6adb7",
  surface: "#16202f",
  idle: "#263750",
  schoolBand: "#f0efec",
  schoolBandOpacity: 0.08,
  grid: "#47556b",
  kinds: {
    building: "#3987e5",
    playing: "#d55181",
    chat: "#d95926",
    practice: "#199e70",
    web: "#c98500",
    launched_app: "#0ca30c",
    rabbithole: "#758090",
  },
  leftOpen: "#6e62a8",
  bar: "#56637a",
  average: "#c3c8d0",
  highlight: "#9085e9",
};

// ── Text helpers ────────────────────────────────────────────────────────

const FONT_SIZE = 13;
/** Average glyph advance of Hanken Grotesk, as a fraction of the font size. */
const AVG_CHAR_EM = 0.6;

export function estimateTextWidth(text: string, fontSize = FONT_SIZE): number {
  return text.length * fontSize * AVG_CHAR_EM;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Cut `text` with an ellipsis so its estimated width fits `maxWidth`. */
function fitText(text: string, maxWidth: number, fontSize = FONT_SIZE): string | null {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = Math.floor(maxWidth / (fontSize * AVG_CHAR_EM)) - 1;
  if (chars < 3) return null;
  return `${text.slice(0, chars)}…`;
}

const n = (value: number) => Math.round(value * 100) / 100;

function textEl(
  theme: ChartTheme,
  x: number,
  y: number,
  content: string,
  opts: {
    fill?: string;
    anchor?: "start" | "middle" | "end";
    weight?: number;
    size?: number;
    family?: string;
  } = {},
): string {
  // Inline style, not presentation attributes: a page's CSS reset (Chakra's
  // `font: inherit`) beats attributes, and resvg reads style too.
  const style = [
    `font-family:${opts.family ?? theme.fontFamily}`,
    `font-size:${opts.size ?? FONT_SIZE}px`,
    `font-weight:${opts.weight ?? 400}`,
    "letter-spacing:0",
  ].join(";");
  return `<text x="${n(x)}" y="${n(y)}" style="${escapeXml(style)}" fill="${opts.fill ?? theme.textMuted}"${opts.anchor && opts.anchor !== "start" ? ` text-anchor="${opts.anchor}"` : ""}>${escapeXml(content)}</text>`;
}

/** Black or white, whichever reads better on `hex`. */
function inkOn(hex: string): string {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.36 ? "#16202f" : "#ffffff";
}

function svgDocument(width: number, height: number, label: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-label="${escapeXml(label)}">${body}</svg>`;
}

/** Clock label for an hour tick: "6a", "noon", "3p". */
function hourTickLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  if (hour === 12) return "noon";
  if (hour === 0) return "12a";
  return `${((hour + 11) % 12) + 1}${hour < 12 ? "a" : "p"}`;
}

export type HitBox = { x: number; y: number; width: number; height: number };

// ── The day strip ───────────────────────────────────────────────────────

export type StripStretch = Interval & {
  kind: StretchKind;
  /** What it was, as specifically as the data allows ("Volcano app · Seals · with Ms. Torres"). */
  detail?: string;
};

export type StripRow = {
  id: string;
  label: string;
  /** Minutes on screen that day; drawn right-aligned beside the name. */
  totalMinutes: number;
  stretches: readonly StripStretch[];
  /** Own app on screen with no touches: drawn hatched, never counted. */
  leftOpen?: readonly Interval[];
};

export type StripPanel = {
  dayKey: string;
  /** A heading above the panel, for a multi-day image ("Mon, Nov 17"). */
  title?: string;
  schoolHours: readonly Interval[];
  rows: readonly StripRow[];
};

export type StripHit = HitBox & {
  panelIndex: number;
  rowIndex: number;
  /** The stretch under the box, or null for a left-open stretch. */
  stretch: StripStretch | null;
  leftOpen: Interval | null;
};

export type DayStripInput = {
  width: number;
  timeZone: string;
  panels: readonly StripPanel[];
  theme: ChartTheme;
  /** Clock range drawn, in minutes after local midnight. Default 5 a.m.–10 p.m. */
  axisStartMinute?: number;
  axisEndMinute?: number;
  /** Bold this row's name (the scholar the page was opened for). */
  emphasizeRowId?: string | null;
};

export const STRIP_ROW_HEIGHT = 20;
const STRIP_ROW_GAP = 6;
const STRIP_AXIS_HEIGHT = 20;
const STRIP_TITLE_HEIGHT = 26;

export function formatMinutesShort(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The minute-by-minute strip: per row a name, that day's minutes, and a
 * rounded idle track with each stretch drawn to scale over it. School hours
 * are a translucent band across the rows; thin gridlines mark the hours.
 * One panel per day, stacked, so a week renders as one image.
 */
export function renderDayStripSvg(input: DayStripInput): {
  svg: string;
  width: number;
  height: number;
  hits: StripHit[];
} {
  const { width, timeZone, panels, theme } = input;
  const axisStartMinute = input.axisStartMinute ?? 5 * 60;
  const axisEndMinute = input.axisEndMinute ?? 22 * 60;
  const nameWidth = Math.min(
    Math.max(
      60,
      ...panels.flatMap((panel) =>
        panel.rows.map((row) => estimateTextWidth(row.label) + 4),
      ),
    ),
    Math.max(80, width * 0.28),
  );
  const totalX = nameWidth + 8 + 40;
  const trackLeft = totalX + 10;
  const trackRight = width - 8;
  const trackWidth = Math.max(10, trackRight - trackLeft);
  const span = (axisEndMinute - axisStartMinute) * 60_000;

  const parts: string[] = [
    `<defs><pattern id="rh-left-open" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><rect width="4" height="4" fill="${theme.leftOpen}"/><line x1="0" y1="0" x2="0" y2="4" stroke="${theme.surface}" stroke-width="1.5"/></pattern></defs>`,
    `<rect width="${n(width)}" height="__H__" fill="${theme.surface}"/>`,
  ];
  const hits: StripHit[] = [];
  let y = 0;

  panels.forEach((panel, panelIndex) => {
    const axisStart = instantForLocalMinutes(panel.dayKey, axisStartMinute, timeZone);
    const xAt = (at: number) =>
      trackLeft + Math.min(1, Math.max(0, (at - axisStart) / span)) * trackWidth;

    if (panel.title) {
      y += STRIP_TITLE_HEIGHT;
      parts.push(textEl(theme, 0, y - 8, panel.title, { fill: theme.text, weight: 600, size: 14 }));
    }
    const top = y + 14;
    parts.push(textEl(theme, totalX, top - 4, "min", { anchor: "end", size: 12 }));
    const rowsHeight = panel.rows.length * (STRIP_ROW_HEIGHT + STRIP_ROW_GAP);
    const bottom = top + rowsHeight;

    panel.rows.forEach((row, rowIndex) => {
      const rowTop = top + rowIndex * (STRIP_ROW_HEIGHT + STRIP_ROW_GAP);
      const baseline = rowTop + STRIP_ROW_HEIGHT / 2 + 4;
      const name = fitText(row.label, nameWidth) ?? row.label.slice(0, 3);
      parts.push(
        textEl(theme, 0, baseline, name, {
          fill: theme.text,
          weight: row.id === input.emphasizeRowId ? 700 : undefined,
        }),
      );
      parts.push(
        textEl(theme, totalX, baseline, formatMinutesShort(row.totalMinutes), {
          anchor: "end",
          fill: theme.text,
        }),
      );
      parts.push(
        `<rect x="${n(trackLeft)}" y="${n(rowTop)}" width="${n(trackWidth)}" height="${STRIP_ROW_HEIGHT}" rx="3" fill="${theme.idle}"/>`,
      );
      for (const open of row.leftOpen ?? []) {
        const x0 = xAt(open.start);
        const x1 = xAt(open.end);
        if (x1 - x0 <= 0) continue;
        parts.push(
          `<rect x="${n(x0)}" y="${n(rowTop)}" width="${n(Math.max(0.8, x1 - x0))}" height="${STRIP_ROW_HEIGHT}" fill="url(#rh-left-open)"/>`,
        );
        hits.push({ x: x0, y: rowTop, width: Math.max(2, x1 - x0), height: STRIP_ROW_HEIGHT, panelIndex, rowIndex, stretch: null, leftOpen: open });
      }
      for (const stretch of row.stretches) {
        const x0 = xAt(stretch.start);
        const x1 = xAt(stretch.end);
        if (x1 - x0 <= 0) continue;
        const fill = theme.kinds[stretch.kind];
        const w = Math.max(0.8, x1 - x0);
        parts.push(
          `<rect x="${n(x0)}" y="${n(rowTop)}" width="${n(w)}" height="${STRIP_ROW_HEIGHT}" fill="${fill}"/>`,
        );
        const label = stretch.detail ? fitText(stretch.detail, w - 8, 12) : null;
        if (label) {
          parts.push(textEl(theme, x0 + 4, baseline - 0.5, label, { fill: inkOn(fill), size: 12 }));
        }
        hits.push({ x: x0, y: rowTop, width: Math.max(2, w), height: STRIP_ROW_HEIGHT, panelIndex, rowIndex, stretch, leftOpen: null });
      }
    });

    // School hours span the rows, over the tracks.
    for (const hours of panel.schoolHours) {
      const x0 = xAt(hours.start);
      const x1 = xAt(hours.end);
      if (x1 <= x0) continue;
      parts.push(
        `<rect x="${n(x0)}" y="${n(top - STRIP_ROW_GAP / 2)}" width="${n(x1 - x0)}" height="${n(rowsHeight)}" fill="${theme.schoolBand}" fill-opacity="${theme.schoolBandOpacity}"/>`,
      );
    }

    // Hour gridlines and the clock axis.
    const tickStep = width < 520 ? 240 : 120;
    const firstTick = Math.ceil(axisStartMinute / 60) * 60 + (Math.ceil(axisStartMinute / 60) % 2 === 1 ? 60 : 0);
    for (let minute = firstTick; minute <= axisEndMinute; minute += tickStep) {
      const x = trackLeft + ((minute - axisStartMinute) / (axisEndMinute - axisStartMinute)) * trackWidth;
      parts.push(
        `<line x1="${n(x)}" y1="${n(top - STRIP_ROW_GAP / 2)}" x2="${n(x)}" y2="${n(bottom)}" stroke="${theme.grid}" stroke-width="0.75"/>`,
      );
      const tickLabel = hourTickLabel(minute);
      // The last label right-aligns so it never runs off the edge.
      const atEdge = x + estimateTextWidth(tickLabel, 12) / 2 > width;
      parts.push(
        textEl(theme, atEdge ? width : x, bottom + 14, tickLabel, {
          anchor: atEdge ? "end" : "middle",
          size: 12,
        }),
      );
    }
    y = bottom + STRIP_AXIS_HEIGHT;
  });

  const height = Math.max(y, 1);
  parts[1] = parts[1].replace("__H__", String(n(height)));
  return {
    svg: svgDocument(width, height, "Minute-by-minute screen time for each scholar", parts.join("")),
    width,
    height,
    hits,
  };
}

/** The legend, in precedence order, for a page or a PNG caption. */
export function stripLegend(theme: ChartTheme): { label: string; color: string }[] {
  return STRETCH_KINDS.map((kind) => ({
    label: STRETCH_KIND_LABELS[kind],
    color: theme.kinds[kind],
  }));
}

// ── In-school average per scholar ───────────────────────────────────────

export type AverageRow = {
  id: string;
  label: string;
  /** Minutes in school per school day. */
  value: number;
};

export type AveragesInput = {
  width: number;
  rows: readonly AverageRow[];
  /** The scope's average scholar ("All scholars", a group), or null for none. */
  average: { label: string; value: number } | null;
  theme: ChartTheme;
  emphasizeRowId?: string | null;
};

const AVG_ROW_HEIGHT = 28;
const AVG_LABEL_LINE = 17;

/**
 * One horizontal bar per scholar, sorted by name like the page's table (a
 * column of minutes sorted high to low reads as a leaderboard; T9). Every bar
 * is the same neutral colour except the selected scholar's, with one dashed
 * line at the scope's average.
 */
export function renderInSchoolAveragesSvg(input: AveragesInput): {
  svg: string;
  width: number;
  height: number;
  hits: (HitBox & { row: AverageRow })[];
} {
  const { width, theme, average } = input;
  const rows = [...input.rows].sort((a, b) => a.label.localeCompare(b.label));
  const top = (average ? AVG_LABEL_LINE : 0) + 8;
  const height = top + rows.length * AVG_ROW_HEIGHT + 8;
  const left = Math.min(
    Math.max(60, ...rows.map((row) => estimateTextWidth(row.label))) + 12,
    width * 0.35,
  );
  const right = 44;
  const maxValue = Math.max(1, ...rows.map((row) => row.value), average?.value ?? 0);
  const xAt = (value: number) => left + (value / maxValue) * (width - right - left);

  const parts: string[] = [`<rect width="${n(width)}" height="${n(height)}" fill="${theme.surface}"/>`];
  const hits: (HitBox & { row: AverageRow })[] = [];
  rows.forEach((row, index) => {
    const rowTop = top + index * AVG_ROW_HEIGHT;
    const baseline = rowTop + AVG_ROW_HEIGHT / 2 + 4;
    const emphasized = row.id === input.emphasizeRowId;
    parts.push(
      textEl(theme, 0, baseline, fitText(row.label, left - 12) ?? row.label, {
        fill: theme.text,
        weight: emphasized ? 700 : undefined,
      }),
    );
    const barEnd = xAt(row.value);
    parts.push(
      `<rect x="${n(left)}" y="${n(rowTop + 5)}" width="${n(Math.max(1, barEnd - left))}" height="${AVG_ROW_HEIGHT - 10}" rx="2" fill="${emphasized ? theme.highlight : theme.bar}"/>`,
    );
    parts.push(textEl(theme, barEnd + 6, baseline, String(Math.round(row.value)), { fill: theme.text }));
    hits.push({ x: 0, y: rowTop, width, height: AVG_ROW_HEIGHT, row });
  });

  if (average) {
    const x = xAt(average.value);
    const labelY = AVG_LABEL_LINE - 4;
    parts.push(
      `<line x1="${n(x)}" y1="${n(labelY + 4)}" x2="${n(x)}" y2="${n(height - 4)}" stroke="${theme.average}" stroke-width="1.5" stroke-dasharray="4 3"/>`,
    );
    const label = `${average.label} average ${Math.round(average.value)}`;
    const w = estimateTextWidth(label);
    // Beside the line, on whichever side has room.
    const tx = x + 6 + w <= width ? x + 6 : Math.max(left, x - 6 - w);
    parts.push(textEl(theme, tx, labelY, label, { fill: theme.text }));
  }

  return {
    svg: svgDocument(width, height, "In-school minutes per school day for each scholar, with the average", parts.join("")),
    width,
    height,
    hits,
  };
}

// ── Day-by-day trend ────────────────────────────────────────────────────

export type StackedDaysInput = {
  width: number;
  height?: number;
  /** Day keys in order; one bar each. */
  days: readonly string[];
  /** One entry per day in `days`: minutes per kind, stacked in STRETCH_KINDS order. */
  values: readonly Record<StretchKind, number>[];
  theme: ChartTheme;
  ariaLabel: string;
};

function shortDayLabel(dayKey: string): string {
  const [, m, d] = dayKey.split("-").map(Number);
  return `${m}/${d}`;
}

/**
 * One bar per day, stacked by kind in the day strip's legend order (the first
 * kind at the bottom) and in its colours, so a minute is the same colour here
 * as on the strip.
 */
export function renderStackedDaysSvg(input: StackedDaysInput): {
  svg: string;
  width: number;
  height: number;
  /** One column per day, for the hover. */
  hits: (HitBox & { dayIndex: number })[];
} {
  const { width, theme, days, values } = input;
  const height = input.height ?? 240;
  const totals = values.map((byKind) =>
    STRETCH_KINDS.reduce((sum, kind) => sum + Math.max(0, byKind[kind] ?? 0), 0),
  );
  const maxValue = Math.max(1, ...totals);
  const tickStep = niceStep(maxValue / 4);
  const niceMax = Math.ceil(maxValue / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let tick = 0; tick <= niceMax; tick += tickStep) ticks.push(tick);
  const left = estimateTextWidth(String(Math.round(niceMax))) + 10;
  const plotTop = 10;
  const plotBottom = height - 28;
  const scale = (minutes: number) => (minutes / niceMax) * (plotBottom - plotTop);
  const xLeft = left + 6;
  const xRight = width - 6;
  const slot = days.length > 0 ? (xRight - xLeft) / days.length : 0;
  const barWidth = Math.max(2, Math.min(36, slot * 0.68));
  const xCenter = (index: number) => xLeft + slot * (index + 0.5);

  const parts: string[] = [`<rect width="${n(width)}" height="${n(height)}" fill="${theme.surface}"/>`];
  for (const tick of ticks) {
    const y = plotBottom - scale(tick);
    parts.push(
      `<line x1="${n(left)}" y1="${n(y)}" x2="${n(width)}" y2="${n(y)}" stroke="${theme.grid}" stroke-width="0.75"/>`,
    );
    parts.push(textEl(theme, left - 4, y + 4, String(Math.round(tick)), { anchor: "end", size: 12 }));
  }
  const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor((xRight - xLeft) / 44))));
  days.forEach((day, index) => {
    if (index % every !== 0) return;
    parts.push(textEl(theme, xCenter(index), height - 8, shortDayLabel(day), { anchor: "middle", size: 12 }));
  });
  values.forEach((byKind, index) => {
    const x = xCenter(index) - barWidth / 2;
    let y = plotBottom;
    for (const kind of STRETCH_KINDS) {
      const minutes = Math.max(0, byKind[kind] ?? 0);
      const h = scale(minutes);
      if (h < 0.25) continue;
      y -= h;
      parts.push(
        `<rect x="${n(x)}" y="${n(y)}" width="${n(barWidth)}" height="${n(h)}" fill="${theme.kinds[kind]}"/>`,
      );
    }
  });
  const hits = days.map((_, index) => ({
    x: xLeft + slot * index,
    y: 0,
    width: slot,
    height,
    dayIndex: index,
  }));
  return { svg: svgDocument(width, height, input.ariaLabel, parts.join("")), width, height, hits };
}

/** The smallest 1, 2 or 5 × 10^k at or above `value`. */
function niceStep(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  for (const factor of [1, 2, 5, 10]) {
    if (factor * magnitude >= value) return factor * magnitude;
  }
  return 10 * magnitude;
}
