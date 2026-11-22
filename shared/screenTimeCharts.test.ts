import { describe, expect, test } from "vitest";

import { instantForLocalMinutes } from "./institutionDay";
import {
  DARK_CHART_THEME,
  LIGHT_CHART_THEME,
  renderDayStripSvg,
  renderInSchoolAveragesSvg,
  renderStackedDaysSvg,
} from "./screenTimeCharts";

const TZ = "Pacific/Honolulu";
const DAY = "2026-11-17";
const local = (minute: number) => instantForLocalMinutes(DAY, minute, TZ);

/** resvg renders none of these; the PNG path depends on their absence. */
function expectResvgSafe(svg: string) {
  expect(svg).not.toContain("var(");
  expect(svg).not.toContain("foreignObject");
  expect(svg).not.toContain("<style");
  expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
}

describe("renderDayStripSvg", () => {
  const panel = {
    dayKey: DAY,
    schoolHours: [{ start: local(8 * 60), end: local(15 * 60) }],
    rows: [
      {
        id: "a",
        label: "Avery <Stone>",
        totalMinutes: 75,
        stretches: [
          { kind: "chat" as const, start: local(9 * 60), end: local(9 * 60 + 45), detail: "Volcanoes · Seals · with Ms. Torres" },
          { kind: "launched_app" as const, start: local(10 * 60), end: local(10 * 60 + 30), detail: "LEGO SPIKE" },
        ],
        leftOpen: [{ start: local(13 * 60), end: local(13 * 60 + 20) }],
      },
      { id: "b", label: "Hoku Makani", totalMinutes: 0, stretches: [] },
    ],
  };

  test("draws each stretch to scale, escaped, with a hit box per stretch", () => {
    const { svg, hits, height } = renderDayStripSvg({
      width: 800,
      timeZone: TZ,
      panels: [panel],
      theme: LIGHT_CHART_THEME,
    });
    expectResvgSafe(svg);
    expect(svg).toContain("Avery &lt;Stone&gt;");
    expect(svg).toContain(LIGHT_CHART_THEME.kinds.chat);
    expect(svg).toContain("url(#rh-left-open)");
    expect(svg).toContain(">1h 15m<");
    expect(hits.map((hit) => hit.stretch?.kind ?? "left-open")).toEqual([
      "left-open",
      "chat",
      "launched_app",
    ]);
    // To scale: 45 minutes is 1.5 times the width of 30.
    const [, chat, app] = hits;
    expect(chat.width / app.width).toBeCloseTo(1.5, 5);
    expect(height).toBeGreaterThan(0);
  });

  test("a multi-day image stacks one titled panel per day", () => {
    const single = renderDayStripSvg({ width: 800, timeZone: TZ, panels: [panel], theme: DARK_CHART_THEME });
    const double = renderDayStripSvg({
      width: 800,
      timeZone: TZ,
      panels: [
        { ...panel, title: "Mon, Nov 17 (first copy)" },
        { ...panel, title: "Tue, Nov 17" },
      ],
      theme: DARK_CHART_THEME,
    });
    expectResvgSafe(double.svg);
    expect(double.svg).toContain("first copy");
    expect(double.height).toBeGreaterThan(single.height * 2 - 1);
    expect(new Set(double.hits.map((hit) => hit.panelIndex))).toEqual(new Set([0, 1]));
  });
});

describe("renderInSchoolAveragesSvg", () => {
  test("sorts bars by name in one colour, highlights the selected scholar, and draws one average line", () => {
    const { svg, hits } = renderInSchoolAveragesSvg({
      width: 600,
      rows: [
        { id: "b", label: "Hoku", value: 90 },
        { id: "a", label: "Avery", value: 40 },
        { id: "c", label: "Lehua", value: 65 },
      ],
      average: { label: "Seals", value: 65 },
      emphasizeRowId: "c",
      theme: LIGHT_CHART_THEME,
    });
    expectResvgSafe(svg);
    expect(hits.map((hit) => hit.row.id)).toEqual(["a", "b", "c"]);
    expect(svg).toContain("Seals average 65");
    expect(svg.match(/stroke-dasharray/g)).toHaveLength(1);
    expect(svg.match(new RegExp(`fill="${LIGHT_CHART_THEME.bar}"`, "g"))).toHaveLength(2);
    expect(svg.match(new RegExp(`fill="${LIGHT_CHART_THEME.highlight}"`, "g"))).toHaveLength(1);
  });
});

describe("renderStackedDaysSvg", () => {
  const zero = {
    launched_app: 0, web: 0, building: 0, playing: 0, practice: 0, chat: 0, rabbithole: 0,
  };
  test("stacks each day's kinds in the strip's colours, one hit per day", () => {
    const { svg, hits } = renderStackedDaysSvg({
      width: 600,
      days: ["2026-11-16", "2026-11-17", "2026-11-18"],
      values: [
        { ...zero, building: 20, chat: 10 },
        zero,
        { ...zero, launched_app: 5, rabbithole: 15 },
      ],
      theme: LIGHT_CHART_THEME,
      ariaLabel: "Minutes by activity, day by day",
    });
    expectResvgSafe(svg);
    expect(hits.map((hit) => hit.dayIndex)).toEqual([0, 1, 2]);
    for (const kind of ["building", "chat", "launched_app", "rabbithole"] as const) {
      expect(svg.match(new RegExp(`fill="${LIGHT_CHART_THEME.kinds[kind]}"`, "g"))).toHaveLength(1);
    }
    // A day with no minutes draws no bar.
    expect(svg.match(new RegExp(`fill="${LIGHT_CHART_THEME.kinds.web}"`, "g"))).toBeNull();
    // Legend order bottom up: the other app sits below the rest of Rabbithole.
    const yOf = (color: string) =>
      Number(svg.match(new RegExp(`<rect x="[^"]+" y="([^"]+)"[^>]*fill="${color}"`))?.[1]);
    expect(yOf(LIGHT_CHART_THEME.kinds.launched_app)).toBeGreaterThan(
      yOf(LIGHT_CHART_THEME.kinds.rabbithole),
    );
  });
});
