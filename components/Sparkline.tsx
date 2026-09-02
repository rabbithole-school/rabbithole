import { Box } from "@chakra-ui/react";

// A Tufte "word-sized" sparkline: a small, high-data-ink line chart meant to sit
// inline in a roster row — no axes, no gridlines, no legend. Just the shape of a
// scholar's recent engagement, a faint shared reference band so you can scan a
// column and see who's slipping below it, and a single colored end-dot marking
// the latest reading (optionally with its number). Values are 0–1 rates and the
// y-domain is fixed [0,1] so every scholar's line is on the SAME scale and the
// small multiples are honestly comparable.

export interface SparklineProps {
  /** Engagement 0–1, oldest → newest. */
  values: number[];
  width?: number;
  height?: number;
  /** Faint reference band (the "engaged" zone), in domain units. null hides it. */
  band?: [number, number] | null;
  /** Line ink color (CSS). Defaults to a quiet charcoal. */
  lineColor?: string;
  /** End-dot color (CSS) — the board passes a semantic attention color here. */
  endColor?: string;
  /**
   * Draw a soft translucent halo behind the end-dot in the end-dot color. The
   * roster uses this as its single attention marker: a warm-tinted end-dot with
   * a quiet halo is the one thing that says "look here" — no separate flag glyph.
   */
  endHalo?: boolean;
  /** Render the latest value as a small number to the right of the line. */
  showValue?: boolean;
  /** Color for the showValue number. Defaults to a neutral charcoal; the roster
   *  passes the same attention color as the end-dot so the number matches it. */
  valueColor?: string;
  ariaLabel?: string;
  /** Plain-language hover explanation (native SVG tooltip). */
  title?: string;
}

const DEFAULT_LINE = "var(--chakra-colors-charcoal-400)";
const BAND_FILL = "var(--chakra-colors-gray-200)";

export function Sparkline({
  values,
  width = 88,
  height = 22,
  band = [0.5, 1],
  lineColor = DEFAULT_LINE,
  endColor,
  endHalo = false,
  showValue = false,
  valueColor,
  ariaLabel,
  title,
}: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  const latest = clean.length > 0 ? clean[clean.length - 1] : null;

  // Fixed domain so lines are comparable across scholars.
  const domainMin = 0;
  const domainMax = 1;
  const padX = 2;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const clamp01 = (v: number) => Math.max(domainMin, Math.min(domainMax, v));
  const toY = (v: number) =>
    padY + (1 - (clamp01(v) - domainMin) / (domainMax - domainMin)) * innerH;
  const toX = (i: number, n: number) =>
    n <= 1 ? padX + innerW : padX + (i / (n - 1)) * innerW;

  const n = clean.length;
  const polyline =
    n > 1
      ? clean.map((v, i) => `${toX(i, n).toFixed(1)},${toY(v).toFixed(1)}`).join(" ")
      : "";

  const lastX = toX(n - 1, n);
  const lastY = latest != null ? toY(latest) : null;

  const bandTop = band ? toY(band[1]) : 0;
  const bandBottom = band ? toY(band[0]) : 0;

  const label =
    ariaLabel ??
    (latest != null
      ? `Engagement trend, latest ${Math.round(latest * 100)} percent over ${n} reading${n === 1 ? "" : "s"}`
      : "No engagement readings");

  return (
    <Box display="inline-flex" alignItems="center" gap={1.5}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        style={{ display: "block", overflow: "visible" }}
      >
        {title ? <title>{title}</title> : null}
        {band && (
          <rect
            x={0}
            y={bandTop}
            width={width}
            height={Math.max(0, bandBottom - bandTop)}
            fill={BAND_FILL}
            opacity={0.55}
          />
        )}
        {n > 1 && (
          <polyline
            points={polyline}
            fill="none"
            stroke={lineColor}
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {lastY != null && endHalo && (
          <circle cx={lastX} cy={lastY} r={6} fill={endColor ?? lineColor} opacity={0.16} />
        )}
        {lastY != null && (
          <circle
            cx={lastX}
            cy={lastY}
            r={2.4}
            fill={endColor ?? lineColor}
            stroke="var(--chakra-colors-bg-canvas, white)"
            strokeWidth={0.75}
          />
        )}
      </svg>
      {showValue && latest != null && (
        <Box
          as="span"
          fontFamily="heading"
          fontSize="xs"
          fontWeight="medium"
          color={valueColor ?? "charcoal.500"}
          fontVariantNumeric="tabular-nums"
          lineHeight="1"
        >
          {Math.round(latest * 100)}
        </Box>
      )}
    </Box>
  );
}
